// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Warnungen per ntfy: Ziel länger als 5 Minuten nicht erreichbar, Zertifikat unter 14 Tagen (der Ersatz-Abgleich kommt
// mit der Ersatz-Instanz dazu). Je Ereignis höchstens eine Nachricht pro Stunde – auch wenn es flattert –, Entwarnung nur
// nach einer gesendeten Warnung. Der Zustand (offene Warnungen, letzter Versand) steht in daten/ntfy-stand.json, damit
// ein Neustart oder Update nicht alles erneut meldet. Versand als JSON an die Wurzel des ntfy-Servers (Umlaute sicher).

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';

export const SPERRE_MS = 3600_000;
export const ZIEL_WARTE_MS = 5 * 60_000;
export const ZERT_TAGE = 14;
const datum = (iso) => new Date(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });

/**
 * Regeln auswerten (rein): je aktive Domain höchstens zwei Einträge ziel:<domain> und zert:<domain>.
 * @returns {Array<{schluessel:string, aktiv:boolean, titel:string, text:string, prio:number, tags:string[], entwarnung:{titel,text,prio,tags}}>}
 */
export function warnungenErmitteln({ domains, status, zertifikate, jetzt = Date.now() }) {
  const aus = [];
  for (const d of domains.filter((x) => x.aktiv !== false)) {
    const s = status[d.domain];
    if (s) {
      const minuten = Math.floor((jetzt - Date.parse(s.seit)) / 60_000);
      aus.push({
        schluessel: `ziel:${d.domain}`, aktiv: !s.ok && jetzt - Date.parse(s.seit) >= ZIEL_WARTE_MS,
        titel: `FAH-Proxy: App hinter ${d.domain} antwortet nicht`, text: `Seit ${minuten} Minuten: ${s.fehler || 'keine Antwort'}. Ziel: ${d.ziel}`, prio: 4, tags: ['warning'],
        entwarnung: { titel: `FAH-Proxy: ${d.domain} wieder erreichbar`, text: `Das Ziel ${d.ziel} antwortet wieder.`, prio: 3, tags: ['white_check_mark'] },
      });
    }
    const z = zertifikate[d.domain];
    if (z && z.bis) {
      const tage = Math.floor((Date.parse(z.bis) - jetzt) / 86_400_000);
      aus.push({
        schluessel: `zert:${d.domain}`, aktiv: tage < ZERT_TAGE,
        titel: `FAH-Proxy: Zertifikat ${d.domain} läuft ab`, text: `Noch ${Math.max(tage, 0)} Tage gültig (bis ${datum(z.bis)}).`, prio: tage < 3 ? 5 : 4, tags: ['lock'],
        entwarnung: { titel: `FAH-Proxy: Zertifikat ${d.domain} erneuert`, text: `Gültig bis ${datum(z.bis)}.`, prio: 3, tags: ['white_check_mark'] },
      });
    }
  }
  return aus;
}

/** Eine Nachricht senden ({url, thema, token} mit Klartext-Token: „tk_…“ → Bearer, „Benutzer:Passwort“ → Basic). */
export function ntfySenden({ url, thema, token }, { titel, text, prio = 3, tags = [] }, { zeitlimit_ms = 10_000 } = {}) {
  return new Promise((ok, nein) => {
    let ziel;
    try { ziel = new URL(`${String(url).replace(/\/+$/, '')}/`); } catch { nein(new Fehler('E_NTFY', 'ntfy-Adresse ungültig')); return; }
    const body = JSON.stringify({ topic: thema, title: titel, message: text, priority: prio, tags });
    const kopf = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    if (token) kopf.Authorization = token.includes(':') ? `Basic ${Buffer.from(token).toString('base64')}` : `Bearer ${token}`;
    const req = (ziel.protocol === 'https:' ? https : http).request(ziel, { method: 'POST', headers: kopf }, (res) => {
      res.resume();
      res.on('end', () => (res.statusCode >= 200 && res.statusCode < 300 ? ok() : nein(new Fehler('E_NTFY', `ntfy antwortet mit ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? ' – Token oder Zugangsdaten prüfen' : ''}`))));
    });
    req.setTimeout(zeitlimit_ms, () => req.destroy(new Error('Zeitüberschreitung')));
    req.on('error', (e) => nein(new Fehler('E_NTFY', `ntfy nicht erreichbar (${e.code || e.message})`)));
    req.end(body);
  });
}

export class Ntfy {
  constructor(datei, { einstellungen, geheim, senden, jetzt }, stand) {
    Object.assign(this, { datei, einstellungen, geheim, senden, jetzt });
    this.offen = new Set(stand.offen || []);
    this.zuletzt = new Map(Object.entries(stand.zuletzt || {}));
  }
  static async laden(ordner, { einstellungen, geheim, senden = ntfySenden, jetzt = () => Date.now() }) {
    const datei = path.join(ordner, 'ntfy-stand.json');
    return new Ntfy(datei, { einstellungen, geheim, senden, jetzt }, await jsonLesen(datei, {}));
  }
  konfiguriert() { const n = this.einstellungen.lesen().ntfy; return !!(n.url && n.thema); }
  #ziel() {
    const n = this.einstellungen.lesen().ntfy;
    return { url: n.url, thema: n.thema, token: n.token ? this.geheim.entschluesseln(n.token) : '' };
  }
  async #speichern() { await jsonSchreiben(this.datei, { offen: [...this.offen], zuletzt: Object.fromEntries(this.zuletzt) }); }
  /** Sofort senden (Testknopf) – wirft E_NTFY. */
  async nachricht(n) {
    if (!this.konfiguriert()) throw new Fehler('E_EINGABE', 'Erst ntfy-Adresse und Thema eintragen und speichern', { feld: 'ntfy.url' });
    await this.senden(this.#ziel(), n);
  }
  /** Warnung: 'aus' | 'offen' (schon gemeldet) | 'gesperrt' (< 1 h seit der letzten) | 'gesendet' | 'fehler'. */
  async melden(schluessel, n) {
    if (!this.konfiguriert()) return 'aus';
    if (this.offen.has(schluessel)) return 'offen';
    if (this.jetzt() - (this.zuletzt.get(schluessel) || 0) < SPERRE_MS) return 'gesperrt';
    this.zuletzt.set(schluessel, this.jetzt());
    try { await this.senden(this.#ziel(), n); } catch (e) {
      await this.#speichern();
      process.stderr.write(`[fah-proxy] ntfy: ${e.message}\n`);
      return 'fehler';
    }
    this.offen.add(schluessel);
    await this.#speichern();
    return 'gesendet';
  }
  /** Entwarnung nur, wenn vorher gewarnt wurde: 'aus' | 'nichts' | 'gesendet' | 'fehler'. */
  async entwarnen(schluessel, n) {
    if (!this.konfiguriert()) return 'aus';
    if (!this.offen.delete(schluessel)) return 'nichts';
    await this.#speichern();
    try { await this.senden(this.#ziel(), n); } catch (e) { process.stderr.write(`[fah-proxy] ntfy: ${e.message}\n`); return 'fehler'; }
    return 'gesendet';
  }
  /** Ergebnis von warnungenErmitteln anwenden; offene Warnungen ohne Eintrag (Domain weg/inaktiv) still vergessen. */
  async abgleichen(warnungen) {
    const bekannt = new Set(warnungen.map((w) => w.schluessel));
    let geaendert = false;
    for (const k of [...this.offen]) if (!bekannt.has(k)) { this.offen.delete(k); geaendert = true; }
    if (geaendert) await this.#speichern();
    for (const w of warnungen) {
      if (w.aktiv) await this.melden(w.schluessel, w); else await this.entwarnen(w.schluessel, w.entwarnung);
    }
  }
}
