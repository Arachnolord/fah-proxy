// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Caddyfile an die Caddy-Admin-API (nur im Compose-Netz, caddy:2019) schicken und anwenden. Reihenfolge: erzeugen →
// POST /load (text/caddyfile, ohne Verbindungsabbruch) → erst bei Erfolg die Datei schreiben, mit der Caddy startet.
// Lehnt Caddy ab, bleibt alles beim Alten (E_CADDY mit Caddys Meldung). Ist Caddy noch nicht da (Start), wird die
// Datei geschrieben – Caddy liest sie beim Start – und der Stand heißt „ausstehend“.

import { Fehler } from '../gemeinsam/fehler.js';
import { textSchreiben } from '../gemeinsam/dateien.js';
import { caddyfileErzeugen } from './caddyfile.js';
import { zertifikateFinden } from './zertifikate.js';

export async function caddyLaden(text, { url = 'http://caddy:2019', zeitlimit_ms = 15000, erzwingen = false } = {}) {
  let r;
  // erzwingen: Caddy überspringt eine unveränderte Konfiguration – „must-revalidate“ lädt trotzdem (neue Zertifikatsdateien)
  const kopf = { 'Content-Type': 'text/caddyfile', ...(erzwingen ? { 'Cache-Control': 'must-revalidate' } : {}) };
  try {
    r = await fetch(`${url}/load`, { method: 'POST', headers: kopf, body: text, signal: AbortSignal.timeout(zeitlimit_ms) });
  } catch (e) {
    throw new Fehler('E_CADDY_WEG', 'Caddy ist gerade nicht erreichbar – die Einstellungen werden beim Start übernommen', { grund: String(e && (e.cause?.code || e.message)) });
  }
  if (r.ok) return true;
  let meldung = await r.text().catch(() => '');
  try { meldung = JSON.parse(meldung).error || meldung; } catch { /* Text */ }
  throw new Fehler('E_CADDY', `Caddy hat die Konfiguration abgelehnt: ${String(meldung).slice(0, 500)}`, { status: r.status });
}

export class Anwender {
  /**
   * @param {{domains, einstellungen, pfade:{zertifikate,protokoll,intern}, caddyfile:string, zertOrdner:string, caddyUrl?:string, zeitlimit_ms?:number}} o
   */
  constructor({ domains, einstellungen, pfade, caddyfile, zertOrdner, caddyUrl = 'http://caddy:2019', zeitlimit_ms = 15000 }) {
    Object.assign(this, { domains, einstellungen, pfade, caddyfile, zertOrdner, caddyUrl, zeitlimit_ms });
    this.letzter = { zeit: null, ok: null, ausstehend: false, fehler: null, hinweise: [] };
    this.kette = Promise.resolve();
  }

  /** Text erzeugen (im Test ersetzbar). */
  erzeugen(zertifikate) {
    return caddyfileErzeugen({ domains: this.domains.liste(), einstellungen: this.einstellungen.lesen(), zertifikate, pfade: this.pfade });
  }

  stand() { return structuredClone(this.letzter); }

  /** Nacheinander anwenden (gleichzeitige Änderungen überholen sich nicht). */
  anwenden({ erzwingen = false } = {}) {
    const lauf = this.kette.then(() => this.#anwenden(erzwingen));
    this.kette = lauf.catch(() => {});
    return lauf;
  }

  async #anwenden(erzwingen) {
    const zertifikate = await zertifikateFinden(this.zertOrdner);
    const { text, hinweise } = this.erzeugen(zertifikate);
    try {
      await caddyLaden(text, { url: this.caddyUrl, zeitlimit_ms: this.zeitlimit_ms, erzwingen });
      await textSchreiben(this.caddyfile, text, 0o644);
      this.letzter = { zeit: new Date().toISOString(), ok: true, ausstehend: false, fehler: null, hinweise };
    } catch (e) {
      const f = Fehler.aus(e);
      if (f.code !== 'E_CADDY_WEG') { this.letzter = { zeit: new Date().toISOString(), ok: false, ausstehend: false, fehler: f.message, hinweise }; throw f; }
      await textSchreiben(this.caddyfile, text, 0o644);
      this.letzter = { zeit: new Date().toISOString(), ok: true, ausstehend: true, fehler: null, hinweise };
    }
    return this.stand();
  }
}
