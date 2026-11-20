// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ziel-Prüfung: Antwortet das Ziel einer Domain? Eine HTTP-Antwort < 500 zählt als erreichbar (401/404 heißt: die App
// läuft), 5xx, Abweisung und Zeitüberschreitung als Störung. HTTPS-Ziele ohne Zertifikatsprüfung (selbstsigniert im LAN).
// Der Prüfer läuft im Takt über alle aktiven Domains (höchstens 5 gleichzeitig) und meldet Zustandswechsel.

import http from 'node:http';
import https from 'node:https';
import { zielPruefen } from '../gemeinsam/pruefen.js';

// Klartext aus Sicht der App hinter der Domain (FAH-Proxy selbst läuft ja – sonst gäbe es diese Meldung nicht)
const GRUENDE = { ECONNREFUSED: 'App vermutlich gestoppt oder deaktiviert (Port abgewiesen)', EHOSTUNREACH: 'Gerät der App nicht erreichbar – ausgeschaltet oder offline?',
  ENETUNREACH: 'Netz zum Gerät der App nicht erreichbar', ENOTFOUND: 'Name des Ziels nicht auflösbar – Tippfehler im Ziel?', ECONNRESET: 'App hat die Verbindung abgebrochen' };

/** @returns {Promise<{ok:boolean, code:number|null, ms:number, fehler:string|null}>} */
export function zielErreichbar(ziel, { zeitlimit_ms = 5000 } = {}) {
  const z = zielPruefen(ziel);
  const start = Date.now();
  return new Promise((ok) => {
    let fertig = false;
    const ende = (r) => { if (!fertig) { fertig = true; ok({ ms: Date.now() - start, ...r }); } };
    const modul = z.scheme === 'https' ? https : http;
    const host = z.host.replace(/^\[|\]$/g, '');
    const req = modul.request({ host, port: z.port, path: z.pfad || '/', method: 'GET', rejectUnauthorized: false, headers: { 'User-Agent': 'FAH-Proxy-Statuspruefung' } }, (res) => {
      ende({ ok: res.statusCode < 500, code: res.statusCode, fehler: res.statusCode >= 500 ? `App meldet Fehler ${res.statusCode}` : null });
      res.destroy();
    });
    req.setTimeout(zeitlimit_ms, () => { ende({ ok: false, code: null, fehler: `App antwortet nicht (${Math.round(zeitlimit_ms / 1000)} s ohne Antwort)` }); req.destroy(); });
    req.on('error', (e) => ende({ ok: false, code: null, fehler: GRUENDE[e.code] || `App nicht erreichbar (${e.code || e.message})` }));
    req.end();
  });
}

export class Pruefer {
  /** @param {{domains:()=>Array, zeitlimit_ms?:number, beiWechsel?:(domain, alt, neu)=>void, gleichzeitig?:number}} o */
  constructor({ domains, zeitlimit_ms = 5000, beiWechsel = () => {}, gleichzeitig = 5 }) {
    Object.assign(this, { domains, zeitlimit_ms, beiWechsel, gleichzeitig });
    this.zustand = new Map(); this.timer = null; this.laeuft = false;
  }

  stand() { return Object.fromEntries(this.zustand); }

  async runde() {
    if (this.laeuft) return;
    this.laeuft = true;
    try {
      const liste = this.domains().filter((d) => d.aktiv !== false);
      const aktiv = new Set(liste.map((d) => d.domain));
      for (const k of [...this.zustand.keys()]) if (!aktiv.has(k)) this.zustand.delete(k);
      const warteschlange = [...liste];
      const arbeiter = async () => {
        for (let d = warteschlange.shift(); d; d = warteschlange.shift()) {
          let r;
          try { r = await zielErreichbar(d.ziel, { zeitlimit_ms: this.zeitlimit_ms }); } catch (e) { r = { ok: false, code: null, ms: 0, fehler: e.message }; }
          const alt = this.zustand.get(d.domain);
          const jetzt = new Date().toISOString();
          const neu = { ...r, geprueft: jetzt, seit: alt && alt.ok === r.ok ? alt.seit : jetzt };
          this.zustand.set(d.domain, neu);
          if (!alt || alt.ok !== r.ok) { try { this.beiWechsel(d.domain, alt || null, neu); } catch { /* egal */ } }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.gleichzeitig, liste.length || 1) }, arbeiter));
    } finally { this.laeuft = false; }
  }

  starten(takt_ms = 60_000) { this.stoppen(); this.runde().catch(() => {}); this.timer = setInterval(() => this.runde().catch(() => {}), takt_ms); this.timer.unref?.(); }
  stoppen() { if (this.timer) clearInterval(this.timer); this.timer = null; }
}
