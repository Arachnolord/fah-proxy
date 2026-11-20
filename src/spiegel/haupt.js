// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Haupt-Seite des Spiegels: Kopplungscode (Adresse + Fingerabdruck des eigenen UI-Zertifikats + Einmal-Schlüssel, 30 min,
// nur einmal; gehasht in daten/spiegel-codes.json, damit auch das Werkzeug rolle.js Codes erzeugen kann), gekoppelte Ersatz-Instanzen (nur der SHA-256 ihres Schlüssels wird gespeichert, daten/spiegel-ersatz.json)
// und der Stand, den sie alle 5 Minuten abholen: Domains, Einstellungen ohne Gerätespezifisches, Konten, das jeweils
// neueste Zertifikat je Domain (übernommen oder von Caddy geholt). Geheimnisse gehen entschlüsselt über die festgenagelte
// TLS-Verbindung – die Ersatz-Instanz verschlüsselt sie mit ihrem eigenen Schlüssel neu.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { standBauen, standAnwenden } from './stand.js';

const ZUGRIFFE_MAX = 1024 * 1024;
const portOk = (p) => Number.isInteger(p) && p > 0 && p < 65536;

export const CODE_PRAEFIX = 'FAHPROXY1.';
export const CODE_GUELTIG_MS = 30 * 60_000;
const hash = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

/** SHA-256-Fingerabdruck des eigenen Oberflächen-Zertifikats ('' ohne Zertifikat). */
export async function uiFingerabdruck(app) {
  if (!app.uiZertDatei) return '';
  try { return new crypto.X509Certificate(await fs.readFile(app.uiZertDatei)).fingerprint256; } catch { return ''; }
}
/** Oberfläche einer Ersatz-Instanz (Adresse + Fingerabdruck), wie sie sie selbst meldet → {url, fingerabdruck} oder null. */
function uiPruefen(ui) {
  if (!ui || !ui.url) return null;
  try { const u = new URL(String(ui.url)); if (u.protocol !== 'https:') return null; return { url: u.origin, fingerabdruck: /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(String(ui.fingerabdruck || '')) ? String(ui.fingerabdruck) : '' }; } catch { return null; }
}

export class SpiegelHaupt {
  constructor(datei, ersatz, app) {
    Object.assign(this, { datei, ersatz, app });
    this.codeDatei = path.join(app.daten, 'spiegel-codes.json'); // SHA-256 des Einmal-Schlüssels → bis (ms)
    this.jetzt = () => Date.now();
  }
  static async laden(app) {
    const datei = path.join(app.daten, 'spiegel-ersatz.json');
    const d = await jsonLesen(datei, { ersatz: [] });
    return new SpiegelHaupt(datei, Array.isArray(d.ersatz) ? d.ersatz : [], app);
  }
  async #speichern() { await jsonSchreiben(this.datei, { ersatz: this.ersatz }); }
  /** Offene Codes lesen (abgelaufene fallen weg) – immer frisch von der Platte, ein anderer Prozess kann sie angelegt haben. */
  async #codes() {
    const d = await jsonLesen(this.codeDatei, { codes: {} });
    return Object.fromEntries(Object.entries(d.codes || {}).filter(([, bis]) => Number(bis) > this.jetzt()));
  }

  /** @returns {Promise<{code:string, gueltig_bis:string}>} */
  async codeErzeugen() {
    if (!this.app.uiUrl || !this.app.uiZertDatei) throw new Fehler('E_DATEN', 'Adresse oder Zertifikat der Oberfläche unbekannt');
    const fingerabdruck = new crypto.X509Certificate(await fs.readFile(this.app.uiZertDatei)).fingerprint256;
    const schluessel = crypto.randomBytes(24).toString('base64url');
    const bis = this.jetzt() + CODE_GUELTIG_MS;
    const codes = await this.#codes(); codes[hash(schluessel)] = bis;
    await jsonSchreiben(this.codeDatei, { codes });
    return { code: CODE_PRAEFIX + Buffer.from(JSON.stringify({ u: this.app.uiUrl, f: fingerabdruck, k: schluessel })).toString('base64url'), gueltig_bis: new Date(bis).toISOString() };
  }

  /** Einmal-Schlüssel einlösen → dauerhafter Schlüssel der Ersatz-Instanz (nur einmal im Klartext). */
  async koppeln(schluessel, { name, ip, ui }) {
    const h = hash(schluessel); const codes = await this.#codes(); const gilt = h in codes;
    delete codes[h];
    await jsonSchreiben(this.codeDatei, { codes });
    if (!gilt) throw new Fehler('E_ANMELDUNG', 'Kopplungscode ungültig, abgelaufen oder schon benutzt – bitte am Haupt-FAH-Proxy einen neuen erzeugen');
    const token = crypto.randomBytes(32).toString('base64url');
    const e = { id: `e${crypto.randomBytes(6).toString('hex')}`, name: String(name || 'Ersatz-Instanz').slice(0, 80), ip: String(ip || ''), hash: hash(token), gekoppelt: new Date().toISOString(), letzter_abruf: null, ui: uiPruefen(ui) };
    this.ersatz.push(e);
    await this.#speichern();
    return { token, id: e.id };
  }

  /** Schlüssel einer Ersatz-Instanz prüfen (zeitkonstant) und den Abruf vermerken → Eintrag oder null; `ziel` = ihr Proxy-Ziel, `ui` = ihre Oberfläche. */
  async pruefen(token, ip, ziel = null, ui = null) {
    const h = Buffer.from(hash(token || ''));
    const e = this.ersatz.find((x) => crypto.timingSafeEqual(Buffer.from(x.hash), h));
    if (!e) return null;
    e.letzter_abruf = new Date().toISOString(); if (ip) e.ip = ip;
    if (ziel && net.isIPv4(ziel.ip) && portOk(ziel.http) && portOk(ziel.https)) e.ziel = { ip: ziel.ip, http: ziel.http, https: ziel.https };
    const u = uiPruefen(ui); if (u) e.ui = u;
    await this.#speichern();
    return e;
  }

  liste() { return this.ersatz.map(({ hash: _h, ui, ...rest }) => ({ ...rest, ui_url: ui ? ui.url : '', ui_fingerabdruck: ui ? ui.fingerabdruck : '' })); }

  /**
   * Neue Zeilen des eigenen Zugriffsprotokolls für die Ersatz-Instanz (sie legt sie für die Homepage auf dem NAS ab).
   * `kennung` = Inode der Datei beim letzten Abruf; ändert sie sich (Caddy hat rotiert) oder passt `ab` nicht, beginnt der
   * Abruf von vorn (höchstens das letzte MB). Liefert nur ganze Zeilen.
   */
  async zugriffe(kennung, ab) {
    const datei = path.join(this.app.daten, 'caddy', 'zugriffe.log');
    let st;
    try { st = await fs.stat(datei); } catch { return { kennung: '', ab: 0, bis: 0, text: '' }; }
    const k = String(st.ino);
    let start = Number(ab) || 0;
    if (k !== kennung || start > st.size || start < 0) start = Math.max(0, st.size - ZUGRIFFE_MAX);
    const laenge = Math.min(ZUGRIFFE_MAX, st.size - start);
    if (laenge <= 0) return { kennung: k, ab: start, bis: start, text: '' };
    const fd = await fs.open(datei, 'r');
    try {
      const puffer = Buffer.alloc(laenge);
      await fd.read(puffer, 0, laenge, start);
      const ende = puffer.lastIndexOf(0x0a) + 1;
      return { kennung: k, ab: start, bis: start + ende, text: puffer.subarray(0, ende).toString('utf8') };
    } finally { await fd.close(); }
  }

  async entfernen(id) {
    const vorher = this.ersatz.length;
    this.ersatz = this.ersatz.filter((x) => x.id !== id);
    if (this.ersatz.length === vorher) throw new Fehler('E_NICHT_GEFUNDEN', 'Diese Ersatz-Instanz gibt es nicht');
    await this.#speichern();
  }

  async stand() { return standBauen(this.app); }

  /**
   * Stand der Ersatz-Instanz annehmen – nur, wenn sie gerade aktiv ist (Fail-over) und diese Instanz nicht: dann hat sie
   * den neueren Stand (Änderungen während des Ausfalls). Wer aktiv ist, sagt die UniFi-Regel (frisch gelesen).
   */
  async standEmpfangen(s, absender) {
    const aktiv = await this.app.wache.aktivIp();
    if (aktiv === this.app.unifiZiel().ip) throw new Fehler('E_RECHTE', 'Diese Instanz ist selbst aktiv – sie nimmt keinen fremden Stand an');
    if (!absender || !absender.ip || aktiv !== absender.ip) throw new Fehler('E_RECHTE', 'Die Ersatz-Instanz ist nicht aktiv – sie holt den Stand von hier');
    return standAnwenden(this.app, s, { vomHaupt: false });
  }

}
