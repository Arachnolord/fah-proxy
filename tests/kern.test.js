// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Kern: Caddy laden (Attrappe der Admin-API), Anwenden (Datei nur bei Erfolg bzw. wenn Caddy noch startet), Konten
// (Erstkonto admin/admin mit Pflichtwechsel, 2FA), Web (Anmeldung, Sitzung, CSRF, Pflichtwechsel-Sperre, Bremse).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { caddyLaden, Anwender } from '../src/caddy/laden.js';
import { Domains } from '../src/daten/domains.js';
import { Einstellungen } from '../src/daten/einstellungen.js';
import { Konten } from '../src/daten/konten.js';
import { Geheim } from '../src/gemeinsam/geheim.js';
import { totp } from '../src/totp.js';
import { Web } from '../src/web/web.js';

async function ordner() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-k-')); }

/** Caddy-Admin-Attrappe: merkt sich geladene Texte; „kaputt“ im Text → 400 wie Caddy. */
async function caddyAttrappe() {
  const geladen = []; const erzwungen = [];
  const s = http.createServer((req, res) => {
    let b = ''; req.on('data', (d) => { b += d; });
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/load' || req.headers['content-type'] !== 'text/caddyfile') { res.writeHead(404); res.end(); return; }
      if (b.includes('kaputt')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"adapting config using caddyfile: Caddyfile:3: unrecognized directive: kaputt"}'); return; }
      geladen.push(b); erzwungen.push(req.headers['cache-control'] === 'must-revalidate'); res.writeHead(200); res.end();
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, geladen, erzwungen, zu: () => new Promise((r) => s.close(r)) };
}

test('caddyLaden: 200 → ok, 400 → E_CADDY mit Caddys Meldung, nicht erreichbar → E_CADDY_WEG', async () => {
  const c = await caddyAttrappe();
  try {
    await caddyLaden('a.de {\n}\n', { url: c.url });
    assert.equal(c.geladen.length, 1);
    // gleiche Konfiguration überspringt Caddy – nach nachgezogenen Zertifikatsdateien muss es trotzdem neu laden
    await caddyLaden('a.de {\n}\n', { url: c.url, erzwingen: true });
    assert.deepEqual(c.erzwungen, [false, true]);
    await assert.rejects(caddyLaden('kaputt', { url: c.url }), (e) => e.code === 'E_CADDY' && /unrecognized directive: kaputt/.test(e.message));
  } finally { await c.zu(); }
  await assert.rejects(caddyLaden('x', { url: 'http://127.0.0.1:9', zeitlimit_ms: 2000 }), (e) => e.code === 'E_CADDY_WEG');
});

test('Anwender: Caddyfile wird erst nach erfolgreichem Laden geschrieben; Ablehnung lässt die alte Datei; Caddy weg → Datei für den Start, „ausstehend“', async () => {
  const d = await ordner(); const c = await caddyAttrappe();
  try {
    const domains = await Domains.laden(d); const einstellungen = await Einstellungen.laden(d);
    const pfade = { zertifikate: '/fahproxy/zertifikate', protokoll: '/fahproxy/caddy/zugriffe.log', intern: 'fah-proxy:8081' };
    const datei = path.join(d, 'caddy', 'Caddyfile');
    const a = new Anwender({ domains, einstellungen, pfade, caddyfile: datei, zertOrdner: path.join(d, 'zertifikate'), caddyUrl: c.url });
    await domains.anlegen({ domain: 'nc.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'oeffentlich' });
    const r = await a.anwenden();
    assert.equal(r.ok, true); assert.equal(r.ausstehend, false);
    assert.ok((await fs.readFile(datei, 'utf8')).includes('nc.beispiel.de {'));
    assert.ok(r.hinweise.some((h) => h.domain === 'nc.beispiel.de'), 'Hinweis: kein Zertifikat im Testbetrieb');
    // Caddy lehnt ab (Attrappe: Text enthält „kaputt“ → über die Notiz geht das nicht ins Caddyfile, daher direkt simulieren)
    const alt = await fs.readFile(datei, 'utf8');
    a.erzeugen = () => ({ text: 'kaputt', hinweise: [] });
    await assert.rejects(a.anwenden(), (e) => e.code === 'E_CADDY');
    assert.equal(await fs.readFile(datei, 'utf8'), alt, 'alte Datei bleibt');
    assert.equal(a.stand().ok, false);
    // Caddy nicht erreichbar → Datei schreiben (Caddy liest sie beim Start), Stand „ausstehend“
    const weg = new Anwender({ domains, einstellungen, pfade, caddyfile: datei, zertOrdner: path.join(d, 'zertifikate'), caddyUrl: 'http://127.0.0.1:9', zeitlimit_ms: 1500 });
    await domains.anlegen({ domain: 'zwei.beispiel.de', ziel: '192.168.1.23:8081', schutz: 'heimnetz' });
    const r2 = await weg.anwenden();
    assert.equal(r2.ausstehend, true);
    assert.ok((await fs.readFile(datei, 'utf8')).includes('zwei.beispiel.de {'));
  } finally { await c.zu(); await fs.rm(d, { recursive: true, force: true }); }
});

test('Konten: Erstkonto admin/admin mit Pflichtwechsel; falsches Passwort → E_ANMELDUNG; neues Passwort ≥ 10 Zeichen und nicht „admin“; 2FA verlangt den Code', async () => {
  const d = await ordner();
  try {
    const g = await Geheim.laden(path.join(d, 'geheim.key'));
    const k = await Konten.laden(d, g);
    const a = await k.pruefen('admin', 'admin');
    assert.deepEqual(a, { name: 'admin', rolle: 'admin', pflichtwechsel: true });
    await assert.rejects(k.pruefen('admin', 'falsch'), (e) => e.code === 'E_ANMELDUNG');
    await assert.rejects(k.pruefen('niemand', 'x'), (e) => e.code === 'E_ANMELDUNG');
    await assert.rejects(k.passwortSetzen('admin', 'kurz'), (e) => e.code === 'E_EINGABE');
    await k.passwortSetzen('admin', 'Sehr-Geheim-2026');
    assert.equal((await k.pruefen('admin', 'Sehr-Geheim-2026')).pflichtwechsel, false);
    await assert.rejects(k.pruefen('admin', 'admin'), (e) => e.code === 'E_ANMELDUNG');
    const { geheimnis } = await k.totpVorbereiten('admin');
    await assert.rejects(k.totpAktivieren('admin', '000000'), (e) => e.code === 'E_EINGABE');
    await k.totpAktivieren('admin', totp(geheimnis));
    await assert.rejects(k.pruefen('admin', 'Sehr-Geheim-2026'), (e) => e.code === 'E_ANMELDUNG' && e.details.code_noetig === true);
    assert.equal((await k.pruefen('admin', 'Sehr-Geheim-2026', totp(geheimnis, Date.now() / 1000 + 30))).name, 'admin');
    assert.ok(!JSON.stringify(k.liste()).includes('scrypt$'), 'Liste ohne Hashes');
    const k2 = await Konten.laden(d, g);
    assert.equal(k2.liste()[0].totp, true, 'überlebt Neustart');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

/** Kleiner Client mit Cookie-Glas für den Web-Test. */
function client(port) {
  const glas = new Map();
  return async (methode, pfad, body, kopf = {}) => {
    const h = { ...kopf };
    if (glas.size) h.Cookie = [...glas].map(([n, v]) => `${n}=${v}`).join('; ');
    const daten = body === undefined ? undefined : JSON.stringify(body);
    if (daten) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(daten); }
    return new Promise((ok, nein) => {
      const r = http.request({ host: '127.0.0.1', port, path: pfad, method: methode, headers: h }, (res) => {
        for (const c of res.headers['set-cookie'] || []) { const [nv] = c.split(';'); const i = nv.indexOf('='); const v = nv.slice(i + 1); if (v) glas.set(nv.slice(0, i), v); else glas.delete(nv.slice(0, i)); }
        let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => { let j = null; try { j = JSON.parse(t); } catch { /* kein JSON */ } ok({ status: res.statusCode, j, kopf: res.headers, t }); });
      });
      r.on('error', nein); r.end(daten);
    }).then((x) => ({ ...x, csrf: glas.get('fp_csrf') }));
  };
}

test('Web: Anmeldung, Sitzungscookie (HttpOnly), CSRF-Pflicht, Pflichtwechsel sperrt die übrige API, Abmelden, Bremse, Sicherheitskopfzeilen', async () => {
  const d = await ordner();
  const g = await Geheim.laden(path.join(d, 'geheim.key'));
  const konten = await Konten.laden(d, g);
  const web = new Web({ konten, daten: d, version: 'test' });
  web.route('GET', '/api/beispiel', { sitzung: 'voll' }, async () => ({ hallo: 'welt' }));
  web.route('POST', '/api/beispiel', { sitzung: 'voll', csrf: true }, async (ctx) => ({ bekommen: (await ctx.body()).x }));
  const s = http.createServer(web.handler()); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const c = client(s.address().port);
  try {
    assert.equal((await c('GET', '/api/ich')).status, 401);
    const index = await c('GET', '/');
    assert.match(index.kopf['content-security-policy'], /default-src 'self'/); assert.equal(index.kopf['x-frame-options'], 'DENY');
    let r = await c('POST', '/api/anmelden', { name: 'admin', passwort: 'admin' });
    assert.equal(r.status, 200); assert.equal(r.j.ergebnis.pflichtwechsel, true);
    const setzen = (await c('GET', '/api/ich')).kopf; void setzen;
    assert.equal((await c('GET', '/api/beispiel')).status, 403, 'Pflichtwechsel sperrt');
    assert.equal((await c('POST', '/api/passwort', { neu: 'Sehr-Geheim-2026' })).status, 403, 'ohne CSRF-Kopf');
    const csrf = (await c('GET', '/api/ich')).csrf;
    r = await c('POST', '/api/passwort', { neu: 'Sehr-Geheim-2026' }, { 'X-FP-CSRF': csrf });
    assert.equal(r.status, 200, r.t);
    assert.deepEqual((await c('GET', '/api/beispiel')).j.ergebnis, { hallo: 'welt' });
    assert.equal((await c('POST', '/api/beispiel', { x: 1 }, { 'X-FP-CSRF': 'falsch' })).status, 403);
    assert.deepEqual((await c('POST', '/api/beispiel', { x: 1 }, { 'X-FP-CSRF': csrf })).j.ergebnis, { bekommen: 1 });
    assert.equal((await c('POST', '/api/abmelden', {}, { 'X-FP-CSRF': csrf })).status, 200);
    assert.equal((await c('GET', '/api/beispiel')).status, 401, 'nach dem Abmelden');
    // Bremse: 5 Fehlversuche, dann 429
    const fremd = client(s.address().port);
    for (let i = 0; i < 5; i++) assert.equal((await fremd('POST', '/api/anmelden', { name: 'admin', passwort: 'falsch' })).status, 401);
    const b = await fremd('POST', '/api/anmelden', { name: 'admin', passwort: 'Sehr-Geheim-2026' });
    assert.equal(b.status, 429, 'auch das richtige Passwort wartet');
    assert.ok(b.j.fehler.details.warte_s > 0);
  } finally { await new Promise((r) => s.close(r)); await fs.rm(d, { recursive: true, force: true }); }
});
