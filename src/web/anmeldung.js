// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// FAH-Anmeldung vor Domains mit Schutz „Mit FAH-Anmeldung“ – läuft auf dem internen Port 8081, den nur Caddy erreicht.
// Caddy fragt per forward_auth /_fah/pruefen (Host = geschützte Domain, Cookie des Browsers): gültige Sitzung → 200 mit
// X-FAH-Nutzer (Caddy reicht ihn an die App weiter), sonst 302 zur Anmeldeseite derselben Domain. Sitzungscookie
// __Host-fah_sitzung je Domain (HttpOnly, Secure, SameSite=Lax), serverseitig an Domain und Konto gebunden. Mit 2FA
// zwei Schritte (das Passwort steht nie in der Seite). Seiten ohne Skripte, alles maskiert, Rücksprung nur auf Pfade
// desselben Hosts. Die Client-Adresse für die Bremse kommt aus X-Forwarded-For – Caddy setzt den Kopf selbst und
// verwirft, was der Client mitschickt.

import crypto from 'node:crypto';
import { Fehler } from '../gemeinsam/fehler.js';
import { cookiesLesen } from './web.js';
import { stufeFinden, brauchtAnmeldung } from '../daten/schutzstufen.js';

export const COOKIE = '__Host-fah_sitzung';
const SCHRITT_MS = 5 * 60_000;
const SCHRITT_VERSUCHE = 5;
const FORM_MAX = 8 * 1024;
const PFADE = new Set(['/_fah/pruefen', '/_fah/anmelden', '/_fah/code', '/_fah/abmelden']);
const KOPF = {
  'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const STIL = `:root{color-scheme:light dark;--grund:#f3f5f7;--karte:#fff;--rand:#d8dde3;--text:#1b1f24;--leise:#5d6772;--akzent:#13867a;--akzent-text:#fff;--fehler:#c0392b}
@media (prefers-color-scheme:dark){:root{--grund:#15181d;--karte:#1e2229;--rand:#343a44;--text:#e7eaee;--leise:#9aa3ae;--akzent:#2bb3a3;--akzent-text:#0b1f1d;--fehler:#f0605d}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--grund);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
.karte{width:100%;max-width:380px;background:var(--karte);border:1px solid var(--rand);border-radius:12px;padding:28px}
.marke{font-size:13px;font-weight:700;letter-spacing:.06em;color:var(--akzent)}
h1{font-size:22px;margin:4px 0 2px}
.domain{margin:0 0 20px;color:var(--leise);overflow-wrap:anywhere}
label{display:block;margin:0 0 14px;font-size:14px;color:var(--leise)}
input{display:block;width:100%;margin-top:4px;padding:10px 12px;font:inherit;color:var(--text);background:var(--grund);border:1px solid var(--rand);border-radius:8px}
input:focus{outline:2px solid var(--akzent);outline-offset:1px}
button{width:100%;margin-top:4px;padding:11px;font:inherit;font-weight:600;color:var(--akzent-text);background:var(--akzent);border:0;border-radius:8px;cursor:pointer}
.fehler{margin:0 0 16px;color:var(--fehler)}
a{color:var(--akzent)}
`;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const hostVon = (req) => String(req.headers.host || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');

/** Rücksprungziel: nur ein Pfad auf demselben Host (kein //, kein \, keine Steuerzeichen, nicht /_fah/), sonst „/“. */
export function ruecksprung(z) {
  const s = String(z ?? '');
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/_fah/') || s.length > 2000 || /[\u0000-\u001f\u007f\\]/.test(s)) return '/';
  return s;
}
/** Für den Location-Kopf: Nicht-ASCII prozentkodieren (Kopfzeilen sind Latin-1). */
const location = (pfad) => pfad.replace(/[^\x21-\x7e]/g, (c) => encodeURIComponent(c));

function clientIp(req) {
  const liste = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return liste.at(-1) || String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
/** Formulare nur von derselben Seite (Sec-Fetch-Site bzw. Origin), sonst könnte eine fremde Seite anmelden lassen. */
function herkunftOk(req, host) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'none') return false;
  const o = req.headers.origin;
  if (o === undefined) return true;
  try { return new URL(o).hostname.toLowerCase() === host; } catch { return false; }
}
async function formLesen(req) {
  const teile = []; let n = 0;
  for await (const t of req) { n += t.length; if (n > FORM_MAX) throw new Fehler('E_EINGABE', 'Anfrage zu groß'); teile.push(t); }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(teile).toString('utf8')));
}
function seite({ titel, domain, inhalt }) {
  return '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + `<meta name="robots" content="noindex"><title>${esc(titel)} · ${esc(domain)}</title><link rel="stylesheet" href="/_fah/stil.css"></head>`
    + `<body><main class="karte"><div class="marke">FAH-PROXY</div><h1>${esc(titel)}</h1><p class="domain">${esc(domain)}</p>${inhalt}</main></body></html>`;
}
const fehlerZeile = (f) => (f ? `<p class="fehler" role="alert">${esc(f)}</p>` : '');

export class Anmeldung {
  constructor({ konten, sitzungenBereit, bremse, domains, einstellungen, jetzt = () => Date.now() }) {
    Object.assign(this, { konten, sitzungenBereit, bremse, domains, einstellungen, jetzt });
    this.schritte = new Map(); // Kennung des 2FA-Schritts → {name, domain, zurueck, bis, versuche}
  }

  handler() {
    return (req, res) => {
      this.#bearbeiten(req, res).catch((e) => {
        const f = Fehler.aus(e);
        if (!res.headersSent) res.writeHead(f.status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(f.status < 500 ? f.message : 'Interner Fehler');
      });
    };
  }

  async #bearbeiten(req, res) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/_fah/stil.css' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'max-age=3600', 'X-Content-Type-Options': 'nosniff' }); res.end(STIL); return; }
    const host = hostVon(req);
    if (!PFADE.has(p)) return this.#seite(res, 404, host, { titel: 'Nicht gefunden', text: 'Diese Seite gibt es nicht.' });
    const eintrag = this.domains.liste().find((d) => d.domain === host && d.aktiv !== false);
    const domain = eintrag && brauchtAnmeldung(stufeFinden(this.einstellungen.lesen(), eintrag.schutz)) ? host : null;
    if (!domain) return this.#seite(res, 403, host, { titel: 'Kein Zugang', text: 'Diese Adresse ist nicht mit FAH-Anmeldung geschützt.' });
    if (p === '/_fah/pruefen') return this.#pruefen(req, res, domain);
    if (p === '/_fah/abmelden') return this.#abmelden(req, res, domain);
    if (p === '/_fah/anmelden' && req.method === 'GET') return this.#formular(res, domain, { zurueck: ruecksprung(url.searchParams.get('zurueck')) });
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return; }
    if (!herkunftOk(req, domain)) return this.#seite(res, 403, domain, { titel: 'Abgelehnt', text: 'Die Anfrage kam von einer fremden Seite.' });
    const form = await formLesen(req);
    return p === '/_fah/anmelden' ? this.#anmelden(req, res, domain, form) : this.#code(req, res, domain, form);
  }

  async #pruefen(req, res, domain) {
    const s = (await this.sitzungenBereit).holen(cookiesLesen(req.headers.cookie)[COOKIE], { art: 'fah', domain });
    const k = s && this.konten.liste().find((x) => x.name === s.name);
    if (!k || k.gesperrt || k.pflichtwechsel) {
      res.writeHead(302, { Location: `/_fah/anmelden?zurueck=${encodeURIComponent(ruecksprung(req.headers['x-forwarded-uri'] || '/'))}`, 'Cache-Control': 'no-store' });
      res.end(); return;
    }
    if (!this.konten.darfDomain(k.name, domain)) return this.#keinRecht(res, domain, k.name);
    // Immer setzen: so überschreibt Caddy (copy_headers) einen vom Client mitgeschickten X-FAH-Nutzer sicher.
    res.writeHead(200, { 'X-FAH-Nutzer': k.name, 'Cache-Control': 'no-store' });
    res.end();
  }

  async #anmelden(req, res, domain, form) {
    const ip = clientIp(req); const name = String(form.name || '').trim().toLowerCase(); const zurueck = ruecksprung(form.zurueck);
    try { this.bremse.pruefen(ip, name); } catch (e) { return this.#formular(res, domain, { zurueck, name, fehler: Fehler.aus(e).message, status: 429 }); }
    let k;
    try { k = await this.konten.pruefen(name, form.passwort, null); } catch (e) {
      const f = Fehler.aus(e);
      if (f.details && f.details.code_noetig) return this.#schrittBeginnen(res, domain, name, zurueck);
      this.bremse.fehler(ip, name);
      return this.#formular(res, domain, { zurueck, name, fehler: f.message, status: f.status });
    }
    return this.#abschliessen(res, domain, k, ip, zurueck);
  }

  #schrittBeginnen(res, domain, name, zurueck) {
    const jetzt = this.jetzt();
    for (const [id, st] of this.schritte) if (st.bis <= jetzt) this.schritte.delete(id);
    if (this.schritte.size > 1000) this.schritte.clear();
    const id = crypto.randomBytes(24).toString('base64url');
    this.schritte.set(id, { name, domain, zurueck, bis: jetzt + SCHRITT_MS, versuche: 0 });
    return this.#codeFormular(res, domain, { schritt: id });
  }

  async #code(req, res, domain, form) {
    const ip = clientIp(req); const id = String(form.schritt || ''); const st = this.schritte.get(id);
    if (!st || st.bis <= this.jetzt() || st.domain !== domain) {
      if (st && st.domain === domain) this.schritte.delete(id);
      return this.#formular(res, domain, { zurueck: '/', fehler: 'Die Anmeldung ist abgelaufen – bitte erneut anmelden.', status: 401 });
    }
    try { this.bremse.pruefen(ip, st.name); } catch (e) { return this.#codeFormular(res, domain, { schritt: id, fehler: Fehler.aus(e).message, status: 429 }); }
    let k;
    try { k = await this.konten.codeBestaetigen(st.name, form.code); } catch (e) {
      this.bremse.fehler(ip, st.name);
      if (++st.versuche >= SCHRITT_VERSUCHE) { this.schritte.delete(id); return this.#formular(res, domain, { zurueck: st.zurueck, name: st.name, fehler: 'Zu viele falsche Codes – bitte erneut anmelden.', status: 401 }); }
      return this.#codeFormular(res, domain, { schritt: id, fehler: Fehler.aus(e).message, status: 401 });
    }
    this.schritte.delete(id);
    return this.#abschliessen(res, domain, k, ip, st.zurueck);
  }

  async #abschliessen(res, domain, k, ip, zurueck) {
    if (k.pflichtwechsel) return this.#seite(res, 403, domain, { titel: 'Erst Passwort ändern', text: 'Dieses Konto hat noch das Startpasswort. Bitte zuerst in der FAH-Proxy-Oberfläche ein eigenes Passwort setzen.' });
    if (!this.konten.darfDomain(k.name, domain)) return this.#keinRecht(res, domain, k.name);
    this.bremse.erfolg(ip, k.name);
    const tage = Number(this.einstellungen.lesen().anmeldung.sitzung_tage) || 30;
    const s = await (await this.sitzungenBereit).erstellen({ name: k.name, rolle: k.rolle, art: 'fah', domain, dauer_ms: tage * 86_400_000 });
    res.writeHead(303, { Location: location(zurueck), 'Set-Cookie': `${COOKIE}=${s.id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${tage * 86_400}`, 'Cache-Control': 'no-store' });
    res.end();
  }

  async #abmelden(req, res, domain) {
    const id = cookiesLesen(req.headers.cookie)[COOKIE];
    if (id) await (await this.sitzungenBereit).beenden(id);
    res.writeHead(200, { ...KOPF, 'Set-Cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0` });
    res.end(seite({ titel: 'Abgemeldet', domain, inhalt: '<p>Du bist abgemeldet.</p><p><a href="/_fah/anmelden">Wieder anmelden</a></p>' }));
  }

  #keinRecht(res, domain, name) {
    return this.#seite(res, 403, domain, { titel: 'Kein Zugang', text: `Das Konto „${name}“ darf diese Seite nicht öffnen.`, abmelden: true });
  }

  #seite(res, status, domain, { titel, text, abmelden = false }) {
    res.writeHead(status, KOPF);
    res.end(seite({ titel, domain, inhalt: `<p>${esc(text)}</p>${abmelden ? '<p><a href="/_fah/abmelden">Mit einem anderen Konto anmelden</a></p>' : ''}` }));
  }

  #formular(res, domain, { zurueck = '/', name = '', fehler = '', status = 200 }) {
    res.writeHead(status, KOPF);
    res.end(seite({ titel: 'Anmelden', domain, inhalt: `${fehlerZeile(fehler)}<form method="post" action="/_fah/anmelden">`
      + `<input type="hidden" name="zurueck" value="${esc(zurueck)}">`
      + `<label>Name<input name="name" autocomplete="username" autocapitalize="none" spellcheck="false" required value="${esc(name)}"${name ? '' : ' autofocus'}></label>`
      + `<label>Passwort<input name="passwort" type="password" autocomplete="current-password" required${name ? ' autofocus' : ''}></label>`
      + '<button type="submit">Anmelden</button></form>' }));
  }

  #codeFormular(res, domain, { schritt, fehler = '', status = 200 }) {
    res.writeHead(status, KOPF);
    res.end(seite({ titel: 'Bestätigen', domain, inhalt: `${fehlerZeile(fehler)}<form method="post" action="/_fah/code">`
      + `<input type="hidden" name="schritt" value="${esc(schritt)}">`
      + '<label>Code aus der Authenticator-App<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" required autofocus></label>'
      + '<button type="submit">Bestätigen</button></form>' }));
  }
}
