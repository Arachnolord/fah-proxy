// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// FAH-Anmeldung vor geschützten Domains (interner Server, Caddy fragt per forward_auth): ohne Sitzung → Anmeldeseite mit
// Rücksprung (nur Pfade desselben Hosts), gültige Sitzung → 200 + X-FAH-Nutzer, Sitzung an die Domain gebunden,
// Domain-Rechte, 2FA in zwei Schritten, Pflichtwechsel-Konten abgewiesen, Bremse, fremde Herkunft, Abmelden.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';
import { totp } from '../src/totp.js';

const G = 'geheim.beispiel.de'; const A = 'andere.beispiel.de';

async function aufbau() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-anm-'));
  const caddy = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(); }); });
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const app = await App.starten({ daten: d, caddyUrl: `http://127.0.0.1:${caddy.address().port}`, caddyDaten: path.join(d, 'caddy-daten'), version: 'test', hintergrund: false });
  for (const domain of [G, A]) await app.domains.anlegen({ domain, ziel: '192.168.1.23:8080', schutz: 'anmeldung' });
  await app.domains.anlegen({ domain: 'offen.beispiel.de', ziel: '192.168.1.23:8081', schutz: 'oeffentlich' });
  await app.konten.anlegen({ name: 'anna', passwort: 'Anna-Passwort-1', rolle: 'nutzer', domains: [] });
  await app.konten.anlegen({ name: 'bernd', passwort: 'Bernd-Passwort-1', rolle: 'nutzer', domains: [A] });
  let s;
  try { s = http.createServer(app.internerHandler()); } catch (e) { app.stoppen(); caddy.close(); await fs.rm(d, { recursive: true, force: true }); throw e; }
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  /** Anfrage wie von Caddy: Host = geschützte Domain, X-Forwarded-For = Client. */
  const c = (methode, pfad, { host = G, cookie = '', form = null, kopf = {}, ip = '203.0.113.7' } = {}) => new Promise((ok, nein) => {
    const h = { Host: host, ...(ip ? { 'X-Forwarded-For': ip } : {}), ...kopf };
    if (cookie) h.Cookie = cookie;
    const body = form ? new URLSearchParams(form).toString() : undefined;
    if (body !== undefined) { h['Content-Type'] = 'application/x-www-form-urlencoded'; h['Content-Length'] = Buffer.byteLength(body); }
    const r = http.request({ host: '127.0.0.1', port: s.address().port, path: pfad, method: methode, headers: h }, (res) => {
      let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => ok({ status: res.statusCode, kopf: res.headers, text: t }));
    });
    r.on('error', nein); r.end(body);
  });
  const sitzungAus = (r) => { const k = (r.kopf['set-cookie'] || []).find((x) => x.startsWith('__Host-fah_sitzung=')); return k ? k.split(';')[0] : null; };
  return { d, app, c, sitzungAus, zu: async () => { app.stoppen(); await new Promise((r) => s.close(r)); await new Promise((r) => caddy.close(r)); await fs.rm(d, { recursive: true, force: true }); } };
}

test('ohne Sitzung → 302 zur Anmeldeseite mit Rücksprung; unbekannte oder nicht geschützte Domain → 403', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('GET', '/_fah/pruefen', { kopf: { 'X-Forwarded-Uri': '/seite?x=1&y=ä' } });
    assert.equal(r.status, 302);
    assert.equal(r.kopf.location, `/_fah/anmelden?zurueck=${encodeURIComponent('/seite?x=1&y=ä')}`);
    r = await u.c('GET', '/_fah/pruefen', { host: 'GEHEIM.beispiel.de:28443', kopf: { 'X-Forwarded-Uri': '/' } });
    assert.equal(r.status, 302, 'Großschreibung und Port im Host-Kopf');
    assert.equal((await u.c('GET', '/_fah/pruefen', { host: 'offen.beispiel.de' })).status, 403);
    assert.equal((await u.c('GET', '/_fah/pruefen', { host: 'fremd.beispiel.de' })).status, 403);
    r = await u.c('GET', '/_fah/anmelden?zurueck=%2Fseite');
    assert.equal(r.status, 200);
    assert.match(r.kopf['content-type'], /text\/html/);
    assert.match(r.kopf['content-security-policy'], /default-src 'none'/);
    assert.equal(r.kopf['cache-control'], 'no-store');
    assert.match(r.text, /name="passwort"/);
    assert.match(r.text, /geheim\.beispiel\.de/);
    assert.equal((await u.c('GET', '/_fah/stil.css')).status, 200);
    assert.equal((await u.c('GET', '/_fah/gibtsnicht')).status, 404);
    // Gesundheit nur direkt (Healthcheck im Container), nicht über eine geschützte Domain aus dem Internet
    assert.equal((await u.c('GET', '/_fah/gesund')).status, 404);
    r = await u.c('GET', '/_fah/gesund', { ip: null });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).ok, true);
  } finally { await u.zu(); }
});

test('Anmelden → Sitzungscookie (__Host-, HttpOnly, Secure, SameSite=Lax, Dauer aus den Einstellungen) → 200 + X-FAH-Nutzer; Sitzung gilt nur für diese Domain', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/_fah/anmelden', { form: { name: 'Anna', passwort: 'Anna-Passwort-1', zurueck: '/seite?x=1' }, kopf: { Origin: `https://${G}` } });
    assert.equal(r.status, 303, r.text);
    assert.equal(r.kopf.location, '/seite?x=1');
    const roh = r.kopf['set-cookie'].find((x) => x.startsWith('__Host-fah_sitzung='));
    for (const teil of ['Path=/', 'Secure', 'HttpOnly', 'SameSite=Lax', `Max-Age=${30 * 86400}`]) assert.ok(roh.includes(teil), `${teil} fehlt: ${roh}`);
    assert.ok(!/Domain=/i.test(roh));
    const cookie = u.sitzungAus(r);
    r = await u.c('GET', '/_fah/pruefen', { cookie });
    assert.equal(r.status, 200);
    assert.equal(r.kopf['x-fah-nutzer'], 'anna');
    assert.equal((await u.c('GET', '/_fah/pruefen', { cookie, host: A })).status, 302, 'Cookie einer anderen Domain gilt nicht');
    // Konto gesperrt → Sitzung zählt nicht mehr
    await u.app.konten.aendern('anna', { gesperrt: true });
    assert.equal((await u.c('GET', '/_fah/pruefen', { cookie })).status, 302);
  } finally { await u.zu(); }
});

test('Rücksprung nur auf Pfade desselben Hosts – keine offene Weiterleitung', async () => {
  const u = await aufbau();
  try {
    for (const [zurueck, erwartet] of [['//boese.de/x', '/'], ['https://boese.de', '/'], ['/\\boese.de', '/'], ['/_fah/abmelden', '/'], ['javascript:alert(1)', '/'], ['/ok?a=1#t', '/ok?a=1#t'], ['', '/']]) {
      await u.app.web.bremse.erfolg('203.0.113.7', 'anna');
      const r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1', zurueck } });
      assert.equal(r.status, 303, `${zurueck}: ${r.text.slice(0, 200)}`);
      assert.equal(r.kopf.location, erwartet, zurueck);
    }
    // Rücksprung landet als verstecktes Feld HTML-maskiert in der Seite
    const r = await u.c('GET', `/_fah/anmelden?zurueck=${encodeURIComponent('/"><script>x</script>')}`);
    assert.ok(!r.text.includes('<script>x'), 'Rücksprung muss maskiert sein');
  } finally { await u.zu(); }
});

test('Konto ohne Recht auf die Domain → 403 ohne Cookie; Recht entzogen → pruefen 403', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/_fah/anmelden', { form: { name: 'bernd', passwort: 'Bernd-Passwort-1', zurueck: '/' } });
    assert.equal(r.status, 403);
    assert.equal(u.sitzungAus(r), null);
    assert.match(r.text, /darf diese Seite nicht öffnen/);
    r = await u.c('POST', '/_fah/anmelden', { host: A, form: { name: 'bernd', passwort: 'Bernd-Passwort-1', zurueck: '/' } });
    assert.equal(r.status, 303);
    const cookie = u.sitzungAus(r);
    assert.equal((await u.c('GET', '/_fah/pruefen', { host: A, cookie })).status, 200);
    await u.app.konten.aendern('bernd', { domains: [G] });
    r = await u.c('GET', '/_fah/pruefen', { host: A, cookie });
    assert.equal(r.status, 403);
    assert.match(r.text, /darf diese Seite nicht öffnen/);
  } finally { await u.zu(); }
});

test('2FA: Passwort richtig → zweiter Schritt (Code), falscher Code abgewiesen, richtiger Code → Sitzung', async () => {
  const u = await aufbau();
  try {
    const { geheimnis } = await u.app.konten.totpVorbereiten('anna');
    await u.app.konten.totpAktivieren('anna', totp(geheimnis));
    // Schritt verbraucht: für die Anmeldung den Code des nächsten Zeitfensters nehmen
    let r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1', zurueck: '/x' } });
    assert.equal(r.status, 200);
    assert.equal(u.sitzungAus(r), null);
    assert.match(r.text, /name="code"/);
    assert.ok(!r.text.includes('Anna-Passwort-1'), 'Passwort darf nicht in der Seite stehen');
    const schritt = /name="schritt" value="([^"]+)"/.exec(r.text)[1];
    r = await u.c('POST', '/_fah/code', { form: { schritt, code: '000000' } });
    assert.equal(r.status, 401);
    assert.match(r.text, /Code stimmt nicht/);
    r = await u.c('POST', '/_fah/code', { form: { schritt, code: totp(geheimnis, Date.now() / 1000 + 30) } });
    assert.equal(r.status, 303, r.text);
    assert.equal(r.kopf.location, '/x');
    assert.equal((await u.c('GET', '/_fah/pruefen', { cookie: u.sitzungAus(r) })).kopf['x-fah-nutzer'], 'anna');
    // Schritt-Kennung ist verbraucht und gilt nur auf ihrer Domain
    assert.equal((await u.c('POST', '/_fah/code', { form: { schritt, code: totp(geheimnis) } })).status, 401);
  } finally { await u.zu(); }
});

test('Erstkonto mit Pflichtwechsel abgewiesen; Bremse nach Fehlversuchen; fremde Herkunft abgewiesen; Abmelden beendet die Sitzung', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/_fah/anmelden', { form: { name: 'admin', passwort: 'admin', zurueck: '/' } });
    assert.equal(r.status, 403);
    assert.match(r.text, /eigenes Passwort/);
    r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1' }, kopf: { Origin: 'https://boese.de' } });
    assert.equal(r.status, 403);
    r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1' }, kopf: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(r.status, 403);
    for (let i = 0; i < 5; i++) r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'falsch' }, ip: '198.51.100.9' });
    r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1' }, ip: '198.51.100.9' });
    assert.equal(r.status, 429);
    assert.match(r.text, /Sekunden warten/);
    u.app.web.bremse.erfolg('198.51.100.9', 'anna');
    r = await u.c('POST', '/_fah/anmelden', { form: { name: 'anna', passwort: 'Anna-Passwort-1', zurueck: '/' } });
    const cookie = u.sitzungAus(r);
    r = await u.c('GET', '/_fah/abmelden', { cookie });
    assert.equal(r.status, 200);
    assert.ok(r.kopf['set-cookie'].some((x) => x.startsWith('__Host-fah_sitzung=;') && x.includes('Max-Age=0')));
    assert.equal((await u.c('GET', '/_fah/pruefen', { cookie })).status, 302);
  } finally { await u.zu(); }
});
