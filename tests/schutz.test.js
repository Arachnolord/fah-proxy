// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Schutzstufen (Kacheln „Wer darf die Seite öffnen?“): feste Stufen mit änderbaren Texten, Heimnetz-Netze und Anmeldedauer
// an der Kachel, eigene Stufen „Nur diese Netze“ und „Diese Netze direkt, sonst FAH-Anmeldung“ – im Caddyfile, in der
// FAH-Anmeldung, über die API (anlegen, ändern, löschen nur ungenutzt) und im Spiegel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { stufenListe, stufeFinden, brauchtAnmeldung, eigeneStufePruefen, FESTE } from '../src/daten/schutzstufen.js';
import { caddyfileErzeugen } from '../src/caddy/caddyfile.js';
import { App } from '../src/app.js';

const E = (schutz = { texte: {}, eigene: [] }) => ({ heimnetz: ['192.168.1.0/24', '192.168.5.0/24'], acme_email: '', modus: 'test', anmeldung: { sitzung_tage: 30 }, schutz });
const BUERO = { id: 's0000abcd', art: 'netze', titel: 'Heimnetz + Büro', text: 'Heimnetz, VPN und das Büro.', netze: ['192.168.1.0/24', '85.1.2.0/24'] };
const MISCH = { id: 's0000beef', art: 'netze_anmeldung', titel: 'Heimnetz frei, sonst Anmeldung', text: 'Zuhause direkt, unterwegs mit FAH-Anmeldung.', netze: ['192.168.1.0/24', '192.168.5.0/24'] };
const PFADE = { zertifikate: '/z', protokoll: '/fahproxy/caddy/zugriffe.log', intern: 'fah-proxy:8081' };
const dom = (domain, schutz) => ({ id: 'd' + domain.length.toString(16).padStart(12, '0'), domain, ziel: 'http://192.168.1.23:8080', schutz, ip_liste: [], aktiv: true, ziel_tls_pruefen: false });
function block(text, domain) { const i = text.indexOf(`\n${domain} {\n`); assert.ok(i >= 0, domain); return text.slice(i + 1, text.indexOf('\n}\n', i) + 2); }

test('Modell: feste Stufen mit überschriebenen Texten, Heimnetz-Netze aus den Einstellungen, eigene Stufen dahinter; Prüfungen', () => {
  const e = E({ texte: { heimnetz: { titel: 'Nur Zuhause', text: 'Heimnetz und VPN.' } }, eigene: [BUERO, MISCH] });
  const l = stufenListe(e);
  assert.deepEqual(l.map((s) => s.id), ['oeffentlich', 'heimnetz', 'ipliste', 'anmeldung', 's0000abcd', 's0000beef']);
  assert.equal(l[1].titel, 'Nur Zuhause'); assert.deepEqual(l[1].netze, ['192.168.1.0/24', '192.168.5.0/24']); assert.equal(l[1].fest, true);
  assert.equal(l[0].titel, FESTE[0].titel, 'ohne Überschreibung der Standardtext');
  assert.equal(stufeFinden(e, 's0000beef').art, 'netze_anmeldung');
  assert.equal(stufeFinden(e, 's00000000'), null);
  assert.equal(brauchtAnmeldung(stufeFinden(e, 'anmeldung')), true); assert.equal(brauchtAnmeldung(stufeFinden(e, 's0000beef')), true); assert.equal(brauchtAnmeldung(stufeFinden(e, 's0000abcd')), false);
  assert.throws(() => eigeneStufePruefen({ titel: '', art: 'netze', netze: ['10.0.0.0/8'] }), (f) => f.details.feld === 'titel');
  assert.throws(() => eigeneStufePruefen({ titel: 'X', art: 'quatsch', netze: ['10.0.0.0/8'] }), (f) => f.details.feld === 'art');
  assert.throws(() => eigeneStufePruefen({ titel: 'X', art: 'netze', netze: [] }), (f) => f.details.feld === 'netze');
  assert.throws(() => eigeneStufePruefen({ titel: 'X', art: 'netze', netze: ['10.0.0.0/33'] }), (f) => f.details.feld === 'netze');
  assert.deepEqual(eigeneStufePruefen({ titel: ' Büro ', text: '', art: 'netze', netze: '85.1.2.3\n10.0.0.0/8' }), { titel: 'Büro', text: '', art: 'netze', netze: ['85.1.2.3/32', '10.0.0.0/8'] });
});

test('Caddyfile: eigene Netze-Stufe sperrt Fremde, Misch-Stufe lässt das Heimnetz direkt durch und verlangt sonst die FAH-Anmeldung; unbekannte Stufe sperrt alles', () => {
  const e = E({ texte: {}, eigene: [BUERO, MISCH] });
  const { text, hinweise } = caddyfileErzeugen({ domains: [dom('b.beispiel.de', 's0000abcd'), dom('m.beispiel.de', 's0000beef'), dom('x.beispiel.de', 's00000bad')], einstellungen: e, zertifikate: new Map(), pfade: PFADE });
  const b = block(text, 'b.beispiel.de');
  assert.match(b, /@fah_fremd not remote_ip 192\.168\.1\.0\/24 85\.1\.2\.0\/24\n\thandle @fah_fremd \{\n\t\trespond "Kein Zugriff[^"]*" 403/);
  assert.match(b, /\thandle \{\n\t\treverse_proxy http:\/\/192\.168\.1\.23:8080/);
  const m = block(text, 'm.beispiel.de');
  assert.match(m, /\thandle \/_fah\/\* \{\n\t\treverse_proxy fah-proxy:8081\n\t\}/);
  assert.match(m, /\t@fah_drinnen remote_ip 192\.168\.1\.0\/24 192\.168\.5\.0\/24\n\thandle @fah_drinnen \{\n\t\treverse_proxy http:\/\/192\.168\.1\.23:8080/);
  assert.match(m, /\thandle \{\n\t\tforward_auth fah-proxy:8081 \{\n\t\t\turi \/_fah\/pruefen/);
  const x = block(text, 'x.beispiel.de');
  assert.match(x, /respond "Kein Zugriff[^"]*" 403/); assert.doesNotMatch(x, /reverse_proxy/);
  assert.ok(hinweise.some((h) => h.domain === 'x.beispiel.de'));
});

async function aufbau() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-schutz-'));
  const geladen = [];
  const caddy = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { geladen.push(b); res.writeHead(200); res.end(); }); });
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const app = await App.starten({ daten: d, caddyUrl: `http://127.0.0.1:${caddy.address().port}`, caddyDaten: path.join(d, 'cd'), version: 'test', hintergrund: false });
  const s = http.createServer(app.web.handler()); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const glas = new Map();
  const c = (m, p, body, kopf = {}) => new Promise((ok, nein) => {
    const h = { ...kopf }; if (glas.size) h.Cookie = [...glas].map(([n, v]) => `${n}=${v}`).join('; ');
    if (glas.has('fp_csrf')) h['X-FP-CSRF'] = glas.get('fp_csrf');
    const daten = body === undefined ? undefined : JSON.stringify(body);
    if (daten) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(daten); }
    const r = http.request({ host: '127.0.0.1', port: s.address().port, path: p, method: m, headers: h }, (res) => { for (const k of res.headers['set-cookie'] || []) { const [nv] = k.split(';'); const i = nv.indexOf('='); glas.set(nv.slice(0, i), decodeURIComponent(nv.slice(i + 1))); } let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => ok({ status: res.statusCode, j: JSON.parse(t || 'null') })); });
    r.on('error', nein); r.end(daten);
  });
  await c('POST', '/api/anmelden', { name: 'admin', passwort: 'admin' }); await c('POST', '/api/passwort', { neu: 'Sehr-Geheim-2026' });
  return { d, app, c, geladen, zu: async () => { app.stoppen(); await new Promise((r) => s.close(r)); await new Promise((r) => caddy.close(r)); await fs.rm(d, { recursive: true, force: true }); } };
}

test('API: Stufen mit aktueller Einstellung und Nutzung; Texte und Heimnetz-Netze an der Kachel ändern; eigene anlegen, an Domains nutzen, löschen nur ungenutzt; Protokoll', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('GET', '/api/schutzstufen');
    assert.equal(r.status, 200);
    assert.deepEqual(r.j.ergebnis.map((s) => s.id), ['oeffentlich', 'heimnetz', 'ipliste', 'anmeldung']);
    assert.match(r.j.ergebnis.find((s) => s.id === 'anmeldung').einstellung, /30 Tage/);
    assert.match(r.j.ergebnis.find((s) => s.id === 'heimnetz').einstellung, /192\.168\.1\.0\/24/);
    r = await u.c('PUT', '/api/schutzstufen/heimnetz', { titel: 'Nur Zuhause', text: 'Heimnetz und VPN.', netze: ['192.168.1.0/24', '192.168.5.0/24', '10.0.20.0/24'] });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(u.app.einstellungen.lesen().heimnetz, ['192.168.1.0/24', '192.168.5.0/24', '10.0.20.0/24']);
    assert.equal((await u.c('PUT', '/api/schutzstufen/anmeldung', { sitzung_tage: 7 })).status, 200);
    assert.equal(u.app.einstellungen.lesen().anmeldung.sitzung_tage, 7);
    assert.equal((await u.c('PUT', '/api/schutzstufen/oeffentlich', { netze: ['10.0.0.0/8'] })).j.fehler.code, 'E_EINGABE', 'Öffentlich hat keine Netze');
    r = await u.c('POST', '/api/schutzstufen', { titel: 'Heimnetz frei, sonst Anmeldung', text: 'Zuhause direkt.', art: 'netze_anmeldung', netze: ['192.168.1.0/24'] });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const id = r.j.ergebnis.id; assert.match(id, /^s[0-9a-f]{8}$/);
    assert.equal((await u.c('POST', '/api/domains', { domain: 'm.beispiel.de', ziel: '192.168.1.23:8080', schutz: id })).status, 200);
    assert.ok(u.geladen.at(-1).includes('@fah_drinnen remote_ip 192.168.1.0/24'));
    assert.equal((await u.c('POST', '/api/domains', { domain: 'y.beispiel.de', ziel: '192.168.1.23:8080', schutz: 's00000bad' })).j.fehler.code, 'E_EINGABE', 'unbekannte Stufe');
    r = await u.c('GET', '/api/schutzstufen');
    assert.equal(r.j.ergebnis.find((s) => s.id === id).domains, 1);
    assert.equal(r.j.ergebnis.find((s) => s.id === 'heimnetz').titel, 'Nur Zuhause');
    assert.equal((await u.c('DELETE', `/api/schutzstufen/${id}`)).j.fehler.code, 'E_EINGABE', 'in Benutzung');
    assert.equal((await u.c('DELETE', '/api/schutzstufen/heimnetz')).j.fehler.code, 'E_EINGABE', 'feste Stufen bleiben');
    r = await u.c('PUT', `/api/schutzstufen/${id}`, { netze: ['192.168.1.0/24', '192.168.5.0/24'] });
    assert.ok(u.geladen.at(-1).includes('@fah_drinnen remote_ip 192.168.1.0/24 192.168.5.0/24'), 'Domains mit der Stufe werden neu geladen');
    const dom = (await u.c('GET', '/api/uebersicht')).j.ergebnis.domains.find((x) => x.domain === 'm.beispiel.de');
    await u.c('PUT', `/api/domains/${dom.id}`, { schutz: 'heimnetz' });
    assert.equal((await u.c('DELETE', `/api/schutzstufen/${id}`)).status, 200);
    assert.ok((await u.c('GET', '/api/uebersicht')).j.ergebnis.schutzstufen.some((s) => s.id === 'heimnetz' && s.titel === 'Nur Zuhause'));
    const p = (await u.c('GET', '/api/protokoll')).j.ergebnis.map((x) => x.aktion);
    for (const a of ['schutz.angelegt', 'schutz.geaendert', 'schutz.geloescht']) assert.ok(p.includes(a), a);
  } finally { await u.zu(); }
});

test('FAH-Anmeldung gilt auch für die Misch-Stufe (Anmeldeseite statt „nicht geschützt“)', async () => {
  const u = await aufbau();
  try {
    const id = (await u.c('POST', '/api/schutzstufen', { titel: 'Misch', text: '', art: 'netze_anmeldung', netze: ['192.168.1.0/24'] })).j.ergebnis.id;
    await u.c('POST', '/api/domains', { domain: 'm.beispiel.de', ziel: '192.168.1.23:8080', schutz: id });
    const s = http.createServer(u.app.internerHandler()); await new Promise((r) => s.listen(0, '127.0.0.1', r));
    try {
      const status = await new Promise((ok) => http.get({ host: '127.0.0.1', port: s.address().port, path: '/_fah/pruefen', headers: { Host: 'm.beispiel.de', 'X-Forwarded-For': '203.0.113.5', 'X-Forwarded-Uri': '/' } }, (res) => { res.resume(); ok(res.statusCode); }));
      assert.equal(status, 302);
    } finally { await new Promise((r) => s.close(r)); }
  } finally { await u.zu(); }
});
