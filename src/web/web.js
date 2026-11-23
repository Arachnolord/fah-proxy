// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Web-Kern der Oberfläche: Router, JSON-Antworten {ok, ergebnis|fehler}, Anmeldung mit Bremse und 2FA, Sitzungscookie
// (HttpOnly, Secure, SameSite=Strict), CSRF (Cookie fp_csrf + Kopf X-FP-CSRF, an die Sitzung gebunden), Herkunftsprüfung,
// Pflicht-Passwortwechsel, statische Dateien (no-cache + ETag) und Sicherheitskopfzeilen (strenge CSP).

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Fehler } from '../gemeinsam/fehler.js';
import { Sitzungen } from './sitzungen.js';
import { Bremse } from './bremse.js';

export const PUBLIC_STANDARD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
const SICHERHEIT = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const BODY_MAX = 1024 * 1024;
const OHNE_PFLICHTWECHSEL = new Set(['/api/ich', '/api/passwort', '/api/abmelden']);

export function cookiesLesen(kopf) {
  const aus = {};
  for (const teil of String(kopf || '').split(';')) { const i = teil.indexOf('='); if (i > 0) aus[teil.slice(0, i).trim()] = decodeURIComponent(teil.slice(i + 1).trim()); }
  return aus;
}
function cookie(name, wert, { httpOnly = true, maxAge = null } = {}) {
  return `${name}=${encodeURIComponent(wert)}; Path=/; Secure; SameSite=Strict${httpOnly ? '; HttpOnly' : ''}${maxAge !== null ? `; Max-Age=${maxAge}` : ''}`;
}
function gleich(a, b) { const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || '')); return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y); }

export class Web {
  constructor({ konten, daten, version = '?', publicOrdner = PUBLIC_STANDARD, bremse = new Bremse() }) {
    Object.assign(this, { konten, version, publicOrdner, bremse });
    this.sperre = null; // (pfad) → Meldung, wenn schreibende Anfragen gesperrt sind (Ersatz-Instanz)
    this.ichZusatz = () => ({}); // zusätzliche Felder für /api/ich (Modus, Rolle)
    this.sitzungenBereit = Sitzungen.laden(daten);
    this.routen = [];
    this.#eingebaut();
  }

  /** Route anlegen: pfad mit :platzhaltern; opts.sitzung 'keine'|'voll', opts.csrf (schreibend). */
  route(methode, pfad, opts, fn) {
    const namen = [];
    const re = new RegExp('^' + pfad.replace(/:([a-z_]+)/g, (_, n) => { namen.push(n); return '([^/]+)'; }) + '$');
    this.routen.push({ methode, re, namen, opts: { sitzung: 'voll', csrf: methode !== 'GET', ...opts }, fn });
  }

  #eingebaut() {
    this.route('POST', '/api/anmelden', { sitzung: 'keine', csrf: false }, async (ctx) => {
      const b = await ctx.body();
      const name = String(b.name || '').trim().toLowerCase();
      this.bremse.pruefen(ctx.ip, name);
      let k;
      try { k = await this.konten.pruefen(name, b.passwort, b.code); } catch (e) {
        if (!(e.details && e.details.code_noetig && !b.code)) this.bremse.fehler(ctx.ip, name);
        throw e;
      }
      if (k.rolle !== 'admin' && k.rolle !== 'dienst') throw new Fehler('E_RECHTE', 'Dieses Konto darf nur geschützte Seiten öffnen, nicht die Verwaltung');
      this.bremse.erfolg(ctx.ip, name);
      const s = await (await this.sitzungenBereit).erstellen({ name: k.name, rolle: k.rolle, art: 'ui' });
      ctx.cookies.push(cookie('fp_sitzung', s.id), cookie('fp_csrf', s.csrf, { httpOnly: false }));
      return { name: k.name, rolle: k.rolle, pflichtwechsel: k.pflichtwechsel };
    });
    this.route('POST', '/api/abmelden', { dienst: true }, async (ctx) => {
      await (await this.sitzungenBereit).beenden(ctx.sitzungsId);
      ctx.cookies.push(cookie('fp_sitzung', '', { maxAge: 0 }), cookie('fp_csrf', '', { httpOnly: false, maxAge: 0 }));
      return { abgemeldet: true };
    });
    this.route('GET', '/api/ich', {}, async (ctx) => {
      const k = this.konten.liste().find((x) => x.name === ctx.sitzung.name);
      return { ...this.ichZusatz(), name: ctx.sitzung.name, konto_rolle: ctx.sitzung.rolle, pflichtwechsel: !!(k && k.pflichtwechsel), totp: !!(k && k.totp), version: this.version };
    });
    this.route('POST', '/api/passwort', {}, async (ctx) => {
      const b = await ctx.body();
      const k = this.konten.liste().find((x) => x.name === ctx.sitzung.name);
      if (!(k && k.pflichtwechsel)) await this.konten.pruefen(ctx.sitzung.name, b.alt, b.code).catch(() => { throw new Fehler('E_EINGABE', 'Das bisherige Passwort stimmt nicht', { feld: 'alt' }); });
      await this.konten.passwortSetzen(ctx.sitzung.name, b.neu);
      return { geaendert: true };
    });
  }

  handler() {
    return (req, res) => { this.#bearbeiten(req, res).catch(() => { if (!res.headersSent) { res.writeHead(500); } res.end(); }); };
  }

  async #bearbeiten(req, res) {
    const url = new URL(req.url, 'http://x');
    const ip = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (!url.pathname.startsWith('/api/')) return this.#statisch(req, res, url.pathname);
    const ctx = { req, res, url, ip, params: {}, cookies: [], sitzung: null, sitzungsId: null, body: () => this.#body(req) };
    let antwort; let status = 200;
    try {
      const r = this.routen.find((x) => x.methode === req.method && x.re.test(url.pathname));
      if (!r) throw new Fehler('E_NICHT_GEFUNDEN', 'Unbekannte Adresse');
      r.namen.forEach((n, i) => { ctx.params[n] = decodeURIComponent(r.re.exec(url.pathname)[i + 1]); });
      if (req.method !== 'GET') {
        const site = req.headers['sec-fetch-site'];
        if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new Fehler('E_CSRF', 'Anfrage von fremder Herkunft abgelehnt');
      }
      if (r.opts.sitzung === 'voll') {
        const c = cookiesLesen(req.headers.cookie);
        const s = (await this.sitzungenBereit).holen(c.fp_sitzung, { art: 'ui' });
        if (!s) throw new Fehler('E_ANMELDUNG', 'Bitte anmelden');
        if (s.rolle !== 'admin' && !(s.rolle === 'dienst' && r.opts.dienst)) throw new Fehler('E_RECHTE', 'Keine Berechtigung');
        if (r.opts.csrf && !gleich(req.headers['x-fp-csrf'], s.csrf)) throw new Fehler('E_CSRF', 'Sicherheitsprüfung fehlgeschlagen – bitte die Seite neu laden');
        const k = this.konten.liste().find((x) => x.name === s.name);
        if (!k || k.gesperrt) throw new Fehler('E_ANMELDUNG', 'Bitte anmelden');
        if (k.pflichtwechsel && !OHNE_PFLICHTWECHSEL.has(url.pathname)) throw new Fehler('E_RECHTE', 'Bitte zuerst ein eigenes Passwort setzen', { pflichtwechsel: true });
        ctx.sitzung = s; ctx.sitzungsId = c.fp_sitzung;
      }
      if (req.method !== 'GET' && this.sperre) { const m = this.sperre(url.pathname); if (m) throw new Fehler('E_RECHTE', m, { ersatz: true }); }
      antwort = { ok: true, ergebnis: await r.fn(ctx) };
    } catch (e) {
      const f = Fehler.aus(e);
      status = f.status; antwort = { ok: false, fehler: f.toJSON() };
    }
    const kopf = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SICHERHEIT };
    if (ctx.cookies.length) kopf['Set-Cookie'] = ctx.cookies;
    res.writeHead(status, kopf);
    res.end(JSON.stringify(antwort));
  }

  async #body(req) {
    if (req._fpBody !== undefined) return req._fpBody;
    const teile = []; let laenge = 0;
    for await (const t of req) { laenge += t.length; if (laenge > BODY_MAX) throw new Fehler('E_EINGABE', 'Anfrage zu groß'); teile.push(t); }
    const text = Buffer.concat(teile).toString('utf8');
    try { req._fpBody = text ? JSON.parse(text) : {}; } catch { throw new Fehler('E_EINGABE', 'Ungültiges JSON'); }
    if (!req._fpBody || typeof req._fpBody !== 'object' || Array.isArray(req._fpBody)) throw new Fehler('E_EINGABE', 'Ungültige Anfrage');
    return req._fpBody;
  }

  async #statisch(req, res, pfad) {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const rel = pfad === '/' ? 'index.html' : decodeURIComponent(pfad).replace(/^\/+/, '');
    const datei = path.resolve(this.publicOrdner, rel);
    let st = null;
    if (datei.startsWith(this.publicOrdner + path.sep)) st = await fs.stat(datei).catch(() => null);
    if (!st || !st.isFile()) {
      // unbekannte Pfade ohne Endung → Einstiegsseite (Ansichten per #-Route), sonst 404
      if (!path.extname(rel)) return this.#statisch(req, res, '/');
      res.writeHead(404, SICHERHEIT); res.end(); return;
    }
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const kopf = { 'Content-Type': MIME[path.extname(datei)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ETag: etag, ...SICHERHEIT };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, kopf); res.end(); return; }
    const inhalt = await fs.readFile(datei);
    res.writeHead(200, { ...kopf, 'Content-Length': inhalt.length });
    res.end(req.method === 'HEAD' ? undefined : inhalt);
  }
}
