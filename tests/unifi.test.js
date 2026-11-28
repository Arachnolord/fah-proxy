// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// UniFi: Umschalt-Plan (nur 80/443 aus bestehenden Regeln nehmen, Plex & Co. bleiben; FAH-Proxy-Regeln anlegen oder
// nachziehen), Rückweg aus der Sicherung, Client gegen eine UniFi-Attrappe (Anmeldung, CSRF, Zertifikats-Fingerabdruck),
// Ablauf mit Sicherung vor dem ersten Schreiben und automatischem Rückweg bei Fehler mitten drin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { umschaltPlan, aktivIp, NAME_HTTP, NAME_HTTPS } from '../src/unifi/plan.js';
import { UnifiClient } from '../src/unifi/client.js';
import { umschalten, aktivWechseln, fahProxyAuf443 } from '../src/unifi/ablauf.js';
/** Lebend-Prüfung im Test: nie echt ins Netz (auch Beispieladressen wie 192.168.1.x können echte Geräte sein). */
const NIE = async () => false;

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

const NPM_REGEL = Object.freeze({ _id: 'r1', site_id: 's1', name: 'NGINX REVERSE PROXY', enabled: true, pfwd_interface: 'wan', src: 'any', destination_ip: 'any', dst_port: '80,443,32400', fwd: '192.168.1.23', fwd_port: '80,443,32400', proto: 'tcp', log: false });
const ANDERE = Object.freeze({ _id: 'r2', site_id: 's1', name: 'Kamera', enabled: true, pfwd_interface: 'wan', src: 'any', dst_port: '8443', fwd: '192.168.1.50', fwd_port: '8443', proto: 'tcp', log: false });
const ZIEL = { ip: '192.168.1.23', http: 28080, https: 28443 };

/** Plan auf eine Regelliste anwenden (wie die Konsole es täte) – für Rundlauf-Tests. */
function simulieren(regeln, schritte) {
  let liste = structuredClone(regeln); let n = 0;
  for (const s of schritte) {
    if (s.art === 'aendern') liste = liste.map((r) => (r._id === s.id ? structuredClone(s.nachher) : r));
    else if (s.art === 'anlegen') liste.push({ ...structuredClone(s.regel), _id: `neu${++n}`, site_id: 's1' });
    else if (s.art === 'loeschen') liste = liste.filter((r) => r._id !== s.id);
  }
  return liste;
}
const sortiert = (l) => [...l].sort((a, b) => a.name.localeCompare(b.name));

test('Plan: aus der kombinierten Regel nur 80/443 herausnehmen (32400 bleibt), FAH-Proxy HTTP/HTTPS anlegen, fremde Regeln unberührt', () => {
  const p = umschaltPlan([NPM_REGEL, ANDERE], ZIEL);
  assert.equal(p.ausfuehrbar, true, JSON.stringify(p.probleme));
  assert.equal(p.schritte.length, 3);
  const [a, h, s] = p.schritte;
  assert.equal(a.art, 'aendern'); assert.equal(a.id, 'r1');
  assert.deepEqual(a.nachher, { ...NPM_REGEL, dst_port: '32400', fwd_port: '32400' });
  assert.match(a.text, /NGINX REVERSE PROXY.*32400/);
  assert.equal(h.art, 'anlegen');
  assert.deepEqual(h.regel, { name: NAME_HTTP, enabled: true, pfwd_interface: 'wan', src: 'any', destination_ip: 'any', dst_port: '80', fwd: '192.168.1.23', fwd_port: '28080', proto: 'tcp', log: false });
  assert.equal(s.regel.name, NAME_HTTPS); assert.equal(s.regel.dst_port, '443'); assert.equal(s.regel.fwd_port, '28443');
  assert.deepEqual(p.sicherung.regeln, [NPM_REGEL], 'nur berührte Regeln gesichert');
  // nach dem Umschalten nichts mehr zu tun
  const danach = simulieren([NPM_REGEL, ANDERE], p.schritte);
  assert.equal(umschaltPlan(danach, ZIEL).schritte.length, 0);
});

test('Plan: Regel nur mit 80/443 wird abgeschaltet statt gelöscht; abgeschaltete Regeln zählen nicht; Leerzeichen und abweichende Zielports', () => {
  const nur = { ...NPM_REGEL, _id: 'r3', name: 'Web', dst_port: '80, 443', fwd_port: '8080,8443' };
  const aus = { ...NPM_REGEL, _id: 'r4', name: 'Alt', enabled: false };
  const p = umschaltPlan([nur, aus], ZIEL);
  assert.equal(p.schritte[0].art, 'aendern');
  assert.deepEqual(p.schritte[0].nachher, { ...nur, enabled: false });
  assert.match(p.schritte[0].text, /abschalten/);
  assert.ok(!p.schritte.some((s) => s.id === 'r4'));
  const gemischt = { ...NPM_REGEL, _id: 'r5', name: 'Gemischt', dst_port: '80,443,32400', fwd_port: '8080,8443,32400' };
  assert.deepEqual(umschaltPlan([gemischt], ZIEL).schritte[0].nachher, { ...gemischt, dst_port: '32400', fwd_port: '32400' });
});

test('Plan: Bereich mit 80/443 oder unpassende Portlisten → nicht automatisch, klare Meldung', () => {
  const bereich = { ...NPM_REGEL, name: 'Alles', dst_port: '1-1000', fwd_port: '1-1000' };
  let p = umschaltPlan([bereich], ZIEL);
  assert.equal(p.ausfuehrbar, false);
  assert.match(p.probleme[0], /Alles.*1-1000.*von Hand/);
  const krumm = { ...NPM_REGEL, name: 'Krumm', dst_port: '80,443,32400', fwd_port: '8080' };
  p = umschaltPlan([krumm], ZIEL);
  assert.equal(p.ausfuehrbar, false);
  assert.match(p.probleme[0], /Krumm/);
  assert.equal(umschaltPlan([NPM_REGEL], { ...ZIEL, ip: '' }).ausfuehrbar, false, 'ohne Ziel-IP');
});

test('Plan: vorhandene FAH-Proxy-Regeln (anderes Ziel, z. B. Ersatz-Instanz) werden nachgezogen und gesichert', () => {
  const http = { ...NPM_REGEL, _id: 'f1', name: NAME_HTTP, dst_port: '80', fwd_port: '28080', fwd: '192.168.1.23' };
  const https = { ...NPM_REGEL, _id: 'f2', name: NAME_HTTPS, dst_port: '443', fwd_port: '28443', fwd: '192.168.1.23' };
  const rest = { ...NPM_REGEL, dst_port: '32400', fwd_port: '32400' };
  const ziel = { ip: '192.168.1.29', http: 28080, https: 28443 };
  const p = umschaltPlan([rest, http, https], ziel);
  assert.deepEqual(p.schritte.map((s) => [s.art, s.id]), [['aendern', 'f1'], ['aendern', 'f2']]);
  assert.equal(p.schritte[0].nachher.fwd, '192.168.1.29');
  assert.deepEqual(p.sicherung.regeln.map((r) => r._id), ['f1', 'f2']);
  assert.equal(umschaltPlan(simulieren([rest, http, https], p.schritte), ziel).schritte.length, 0);
});

/** UniFi-OS-Attrappe: /api/auth/login (fahproxy/richtig → TOKEN-Cookie + X-CSRF-Token), rest/portforward mit CSRF-Pflicht. */
async function unifiAttrappe(regeln, { fehlerBei = 0, dns = [], firewall = [] } = {}) {
  const z = { regeln: structuredClone(regeln), dns: structuredClone(dns), firewall: structuredClone(firewall), anmeldungen: 0, schreib: 0, tokenGueltig: true };
  const s = https.createServer({ key: await fs.readFile(path.join(FIX, 'test-privkey.pem')), cert: await fs.readFile(path.join(FIX, 'test-fullchain.pem')) }, (req, res) => {
    let b = ''; req.on('data', (x) => { b += x; });
    req.on('end', () => {
      const json = (status, obj, kopf = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...kopf }); res.end(JSON.stringify(obj)); };
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        const d = JSON.parse(b || '{}');
        z.versuche = (z.versuche || 0) + 1;
        if (d.username !== 'fahproxy' || d.password !== 'richtig') return json(401, { code: 'AUTHENTICATION_FAILED_INVALID_CREDENTIALS' });
        z.anmeldungen++; z.tokenGueltig = true;
        return json(200, { username: 'fahproxy' }, { 'Set-Cookie': 'TOKEN=t0k3n; path=/; samesite=none; secure; httponly', 'X-CSRF-Token': 'csrf-1' });
      }
      // v2-Schnittstelle wie die Konsole: lokale DNS-Einträge und Firewall-Regeln (Zonen), PUT verlangt CSRF, Statistik nur lesbar
      const v2 = /^\/proxy\/network\/v2\/api\/site\/default\/(static-dns|firewall-policies)(?:\/(\w+))?$/.exec(req.url);
      if (v2) {
        if (!/(^|; )TOKEN=t0k3n(;|$)/.test(req.headers.cookie || '') || !z.tokenGueltig) return json(401, { code: 'api.err.LoginRequired' });
        const liste = v2[1] === 'static-dns' ? z.dns : z.firewall;
        if (req.method === 'GET' && !v2[2]) return json(200, liste);
        if (req.headers['x-csrf-token'] !== 'csrf-1') return json(403, { code: 'api.err.InvalidCSRF' });
        if (req.method !== 'PUT' || !v2[2]) return json(405, { code: 'api.err.MethodNotAllowed' });
        z.schreib++;
        if (fehlerBei && z.schreib === fehlerBei) return json(400, { code: 'api.err.Invalid', message: 'Ungültige Regel' });
        const i = liste.findIndex((r) => r._id === v2[2]);
        if (i < 0) return json(404, { code: 'api.err.NotFound' });
        const d = JSON.parse(b || '{}');
        if ('hits' in d || 'last_hit' in d) return json(400, { code: 'api.err.ReadOnly', message: 'hits/last_hit sind nur lesbar' });
        liste[i] = { ...d, _id: v2[2] };
        return json(200, liste[i]);
      }
      const m = /^\/proxy\/network\/api\/s\/default\/rest\/portforward(?:\/(\w+))?$/.exec(req.url);
      if (!m) return json(404, {});
      if (!/(^|; )TOKEN=t0k3n(;|$)/.test(req.headers.cookie || '') || !z.tokenGueltig) return json(401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] });
      if (req.method === 'GET') return json(200, { meta: { rc: 'ok' }, data: z.regeln });
      if (req.headers['x-csrf-token'] !== 'csrf-1') return json(403, { meta: { rc: 'error', msg: 'api.err.InvalidCSRF' }, data: [] });
      z.schreib++;
      if (fehlerBei && z.schreib === fehlerBei) return json(400, { meta: { rc: 'error', msg: 'api.err.PortForwardConflict' }, data: [] });
      const d = b ? JSON.parse(b) : {};
      if (req.method === 'POST') { const neu = { ...d, _id: `n${z.schreib}`, site_id: 's1' }; z.regeln.push(neu); return json(200, { meta: { rc: 'ok' }, data: [neu] }); }
      const i = z.regeln.findIndex((r) => r._id === m[1]);
      if (i < 0) return json(400, { meta: { rc: 'error', msg: 'api.err.IdInvalid' }, data: [] });
      if (req.method === 'PUT') { z.regeln[i] = { ...d, _id: m[1], site_id: 's1' }; return json(200, { meta: { rc: 'ok' }, data: [z.regeln[i]] }); }
      z.regeln.splice(i, 1); return json(200, { meta: { rc: 'ok' }, data: [] });
    });
  });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const fingerabdruck = new crypto.X509Certificate(await fs.readFile(path.join(FIX, 'test-fullchain.pem'))).fingerprint256;
  return { url: `https://127.0.0.1:${s.address().port}`, z, fingerabdruck, zu: () => new Promise((r) => s.close(r)) };
}

test('Client: Anmeldung mit lokalem Konto, CSRF bei Schreibzugriffen, abgelaufene Sitzung → einmal neu anmelden, Fingerabdruck festnageln', async () => {
  const u = await unifiAttrappe([NPM_REGEL]);
  try {
    await assert.rejects(new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'falsch' }).weiterleitungen(), (f) => f.code === 'E_UNIFI' && /Anmeldung bei UniFi fehlgeschlagen/.test(f.message));
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    assert.deepEqual(await c.weiterleitungen(), [NPM_REGEL]);
    assert.equal(c.gesehen, u.fingerabdruck, 'Fingerabdruck der Konsole wird gemerkt');
    assert.equal((await c.aendern('r1', { ...NPM_REGEL, log: true })).log, true);
    u.z.tokenGueltig = false;
    assert.equal((await c.weiterleitungen()).length, 1);
    assert.equal(u.z.anmeldungen, 2);
    await assert.rejects(new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig', fingerabdruck: 'AA:BB' }).weiterleitungen(), (f) => f.code === 'E_UNIFI' && /Zertifikat der UniFi-Konsole hat sich geändert/.test(f.message));
    assert.equal(u.z.anmeldungen, 2, 'bei falschem Fingerabdruck geht kein Passwort raus');
    assert.equal((await new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig', fingerabdruck: u.fingerabdruck }).weiterleitungen()).length, 1);
    assert.throws(() => new UnifiClient({ url: 'http://192.168.1.1', benutzer: 'a', passwort: 'b' }), (f) => f.code === 'E_EINGABE');
    await assert.rejects(new UnifiClient({ url: 'https://127.0.0.1:9', benutzer: 'a', passwort: 'b', zeitlimit_ms: 2000 }).weiterleitungen(), (f) => f.code === 'E_UNIFI');
  } finally { await u.zu(); }
});

test('Ablauf: Sicherung vor dem ersten Schreiben, Umschalten, zweimal ändert nichts', async () => {
  const u = await unifiAttrappe([NPM_REGEL, ANDERE]);
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-'));
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    const r = await umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner , pruefen: NIE });
    assert.equal(r.ausgefuehrt, 3);
    const gesichert = JSON.parse(await fs.readFile(r.sicherungDatei, 'utf8'));
    assert.deepEqual(gesichert.regeln, [NPM_REGEL]);
    assert.equal(u.z.regeln.find((x) => x._id === 'r1').dst_port, '32400');
    assert.deepEqual(u.z.regeln.filter((x) => x.name.startsWith('FAH-Proxy')).map((x) => `${x.dst_port}>${x.fwd}:${x.fwd_port}`), ['80>192.168.1.23:28080', '443>192.168.1.23:28443']);
    assert.equal((await umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner , pruefen: NIE })).ausgefuehrt, 0, 'zweimal umschalten ändert nichts');
  } finally { await u.zu(); await fs.rm(ordner, { recursive: true, force: true }); }
});

test('Ablauf: Fehler nach Schritt 2 → automatischer Rückweg stellt alles her; nicht ausführbarer Plan schreibt nichts', async () => {
  const u = await unifiAttrappe([NPM_REGEL, ANDERE], { fehlerBei: 3 });
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-'));
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    await assert.rejects(umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner , pruefen: NIE }), (f) => f.code === 'E_UNIFI' && /Schritt 3/.test(f.message) && /zurückgestellt/.test(f.message) && /PortForwardConflict/.test(f.message));
    assert.deepEqual(sortiert(u.z.regeln), sortiert([NPM_REGEL, ANDERE]));
    const v = await unifiAttrappe([{ ...NPM_REGEL, dst_port: '1-1000', fwd_port: '1-1000' }]);
    const leer = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-'));
    try {
      await assert.rejects(umschalten(new UnifiClient({ url: v.url, benutzer: 'fahproxy', passwort: 'richtig' }), { ziel: ZIEL, sicherungOrdner: leer , pruefen: NIE }), (f) => f.code === 'E_EINGABE' && /von Hand/.test(f.message));
      assert.equal(v.z.schreib, 0);
      assert.deepEqual(await fs.readdir(leer), []);
    } finally { await v.zu(); await fs.rm(leer, { recursive: true, force: true }); }
  } finally { await u.zu(); await fs.rm(ordner, { recursive: true, force: true }); }
});

test('API: UniFi-Zugang verschlüsselt, Verbindung testen nagelt den Fingerabdruck fest, Vorschau, Übernehmen → live, Protokoll', async () => {
  const { App } = await import('../src/app.js');
  const http = await import('node:http');
  const u = await unifiAttrappe([NPM_REGEL, ANDERE]);
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-api-'));
  const caddy = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(); }); });
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const app = await App.starten({ daten: d, caddyUrl: `http://127.0.0.1:${caddy.address().port}`, caddyDaten: path.join(d, 'cd'), version: 'test', hintergrund: false, hostIp: '192.168.1.23', testPorts: { http: 28080, https: 28443 } });
  app.pruefen443 = NIE;
  const s = http.createServer(app.web.handler()); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const glas = new Map();
  const c = (m, p, body) => new Promise((ok, nein) => {
    const h = {}; if (glas.size) h.Cookie = [...glas].map(([n, v]) => `${n}=${v}`).join('; ');
    if (glas.has('fp_csrf')) h['X-FP-CSRF'] = glas.get('fp_csrf');
    const daten = body === undefined ? undefined : JSON.stringify(body);
    if (daten) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(daten); }
    const r = http.request({ host: '127.0.0.1', port: s.address().port, path: p, method: m, headers: h }, (res) => { for (const k of res.headers['set-cookie'] || []) { const [nv] = k.split(';'); const i = nv.indexOf('='); glas.set(nv.slice(0, i), decodeURIComponent(nv.slice(i + 1))); } let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => ok({ status: res.statusCode, j: JSON.parse(t || 'null') })); });
    r.on('error', nein); r.end(daten);
  });
  try {
    await c('POST', '/api/anmelden', { name: 'admin', passwort: 'admin' }); await c('POST', '/api/passwort', { neu: 'Sehr-Geheim-2026' });
    let r = await c('GET', '/api/umschalten');
    assert.equal(r.j.ergebnis.unifi.eingerichtet, false); assert.equal(r.j.ergebnis.plan, null);
    assert.equal(r.j.ergebnis.ziel.ip, '192.168.1.23', 'Ziel-IP aus HOST_IP vorbelegt');
    r = await c('PUT', '/api/einstellungen', { unifi: { url: u.url, benutzer: 'fahproxy', passwort: 'richtig' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.ergebnis.unifi.passwort, ''); assert.equal(r.j.ergebnis.unifi.passwort_gesetzt, true);
    assert.ok(!(await fs.readFile(path.join(d, 'einstellungen.json'), 'utf8')).includes('richtig'), 'Passwort verschlüsselt');
    assert.equal((await c('PUT', '/api/einstellungen', { unifi: { url: 'http://192.168.1.1' } })).j.fehler.code, 'E_EINGABE');
    assert.equal((await c('PUT', '/api/einstellungen', { unifi: { ziel_ip: '192.168.1' } })).j.fehler.code, 'E_EINGABE');
    r = await c('POST', '/api/unifi/testen');
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.ergebnis.fingerabdruck, u.fingerabdruck);
    assert.deepEqual(r.j.ergebnis.regeln.map((x) => [x.name, x.web]), [['NGINX REVERSE PROXY', true], ['Kamera', false]]);
    assert.equal(app.einstellungen.lesen().unifi.fingerabdruck, u.fingerabdruck);
    // Vorschau: nur lesen
    r = await c('GET', '/api/umschalten');
    assert.equal(r.j.ergebnis.plan.ausfuehrbar, true);
    assert.equal(r.j.ergebnis.plan.schritte.length, 3);
    assert.ok(r.j.ergebnis.plan.schritte.every((x) => typeof x.text === 'string' && x.bereich === 'weiterleitung'));
    assert.equal(u.z.schreib, 0, 'Vorschau schreibt nichts');
    assert.equal((await c('POST', '/api/umschalten/uebernehmen', {})).j.fehler.code, 'E_EINGABE', 'ohne Bestätigung nichts');
    r = await c('POST', '/api/umschalten/uebernehmen', { bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.ergebnis.modus, 'live'); assert.equal(app.einstellungen.lesen().modus, 'live');
    assert.equal(u.z.regeln.find((x) => x._id === 'r1').dst_port, '32400');
    r = await c('GET', '/api/umschalten');
    assert.equal(r.j.ergebnis.plan.schritte.length, 0); assert.equal('rueckweg' in r.j.ergebnis, false, 'kein „Zurück zum NPM“ mehr');
    const p = (await c('GET', '/api/protokoll')).j.ergebnis.map((e) => e.aktion);
    assert.ok(p.includes('umschalten.uebernommen'));
    // geänderte Adresse → Fingerabdruck vergessen; falscher Fingerabdruck → Fehler mit neuem Abdruck, „neu bestätigen“ nagelt neu fest
    await app.einstellungen.setzen({ unifi: { ...app.einstellungen.lesen().unifi, fingerabdruck: 'AA:BB' } });
    r = await c('POST', '/api/unifi/testen');
    assert.equal(r.j.fehler.code, 'E_UNIFI'); assert.equal(r.j.fehler.details.fingerabdruck, u.fingerabdruck);
    r = await c('POST', '/api/unifi/testen', { neu_bestaetigen: true });
    assert.equal(r.status, 200); assert.equal(app.einstellungen.lesen().unifi.fingerabdruck, u.fingerabdruck);
    await c('PUT', '/api/einstellungen', { unifi: { url: u.url.replace('127.0.0.1', 'localhost') } });
    assert.equal(app.einstellungen.lesen().unifi.fingerabdruck, '');
  } finally { app.stoppen(); await new Promise((r) => s.close(r)); await new Promise((r) => caddy.close(r)); await u.zu(); await fs.rm(d, { recursive: true, force: true }); }
});

// ---- Im Haus (lokales DNS) und Firewall-Sperren ----
const WILDCARD = Object.freeze({ _id: 'd2', enabled: true, key: '*.example.org', port: 0, priority: 0, record_type: 'A', ttl: 0, value: '192.168.1.23', weight: 0 });
const APEX = Object.freeze({ ...WILDCARD, _id: 'd1', key: 'example.org' });
const GEFAEHRDER = Object.freeze({ _id: 'f9', action: 'BLOCK', enabled: true, name: 'FAH Gefährder sperren (Dashboard)', predefined: false, protocol: 'tcp', hits: 96382, last_hit: 1791541799378, index: 10000,
  destination: { ips: ['192.168.1.23'], matching_target: 'IP', matching_target_type: 'SPECIFIC', port: '2222,443,80', port_matching_type: 'SPECIFIC', zone_id: 'z-homelab' },
  source: { ip_group_id: 'g1', matching_target: 'IP', matching_target_type: 'OBJECT', zone_id: 'z-extern' } });
const SSH = Object.freeze({ ...GEFAEHRDER, _id: 'f1', action: 'ALLOW', name: 'ALLOW SSH NAS', destination: { ...GEFAEHRDER.destination, port: '22' } });
const DOMAINS = ['fah-proxy.example.org', 'nextcloud.example.org'];
const ohneStatistik = (r) => { const k = structuredClone(r); delete k.hits; delete k.last_hit; return k; };
function simulierenAlles(stand, schritte) {
  const aus = { regeln: simulieren(stand.regeln, schritte.filter((s) => (s.bereich || 'weiterleitung') === 'weiterleitung')), dns: structuredClone(stand.dns), firewall: structuredClone(stand.firewall) };
  for (const s of schritte) if (s.bereich === 'dns' || s.bereich === 'firewall') aus[s.bereich] = aus[s.bereich].map((r) => (r._id === s.id ? structuredClone(s.nachher) : r));
  return aus;
}

test('Plan: Firewall-Sperre zum NAS bekommt 28443/28080 dazu (80/443 bleiben), DNS-Platzhalter aufs NAS wird abgeschaltet, Rest unberührt; zweimal ändert nichts', () => {
  const p = umschaltPlan([NPM_REGEL], ZIEL, { dns: [APEX, WILDCARD], firewall: [SSH, GEFAEHRDER], domains: DOMAINS });
  assert.equal(p.ausfuehrbar, true, JSON.stringify(p.probleme));
  assert.deepEqual(p.schritte.map((s) => `${s.bereich}:${s.art}:${s.id || s.regel.name}`), ['firewall:aendern:f9', 'weiterleitung:aendern:r1', `weiterleitung:anlegen:${NAME_HTTP}`, `weiterleitung:anlegen:${NAME_HTTPS}`, 'dns:aendern:d2']);
  assert.deepEqual(p.schritte[0].nachher, ohneStatistik({ ...GEFAEHRDER, destination: { ...GEFAEHRDER.destination, port: '2222,443,80,28443,28080' } }));
  assert.match(p.schritte[0].text, /FAH Gefährder sperren \(Dashboard\).*28443/);
  assert.deepEqual(p.schritte.at(-1).nachher, { ...WILDCARD, enabled: false });
  assert.match(p.schritte.at(-1).text, /\*\.example\.org.*192\.168\.1\.23/);
  assert.deepEqual(p.sicherung.dns, [WILDCARD]); assert.deepEqual(p.sicherung.firewall, [GEFAEHRDER]);
  const vorher = { regeln: [NPM_REGEL], dns: [APEX, WILDCARD], firewall: [SSH, GEFAEHRDER] };
  const danach = simulierenAlles(vorher, p.schritte);
  assert.equal(umschaltPlan(danach.regeln, ZIEL, { ...danach, domains: DOMAINS }).schritte.length, 0, 'zweimal ändert nichts');
});

test('Plan: welche DNS-Einträge und Firewall-Regeln betroffen sind – und welche nicht', () => {
  const dns = [
    { ...WILDCARD, _id: 'a', key: 'nextcloud.example.org', value: '192.168.1.50' }, // deckt eine Domain, zeigt woanders hin → aus
    { ...WILDCARD, _id: 'b', key: '*.anders.de' }, // deckt keine Domain
    { ...WILDCARD, _id: 'c', enabled: false }, // schon aus
  ];
  const fw = [
    { ...GEFAEHRDER, _id: 'g1', enabled: false },
    { ...GEFAEHRDER, _id: 'g2', destination: { ...GEFAEHRDER.destination, ips: ['192.168.1.50'] } },
    { ...GEFAEHRDER, _id: 'g3', destination: { ...GEFAEHRDER.destination, port_matching_type: 'ANY', port: undefined } },
    { ...GEFAEHRDER, _id: 'g4', protocol: 'udp' },
    { ...GEFAEHRDER, _id: 'g5', destination: { ...GEFAEHRDER.destination, port: '443' } },
    { ...GEFAEHRDER, _id: 'g6', predefined: true },
    { ...GEFAEHRDER, _id: 'g7', destination: { ...GEFAEHRDER.destination, port: '80,443,28080,28443' } },
  ];
  const p = umschaltPlan([], ZIEL, { dns, firewall: fw, domains: DOMAINS });
  const betroffen = p.schritte.filter((s) => s.bereich !== 'weiterleitung');
  assert.deepEqual(betroffen.map((s) => s.id), ['g5', 'a']);
  assert.equal(betroffen[0].nachher.destination.port, '443,28443');
  assert.equal(umschaltPlan([], ZIEL, { dns: [WILDCARD], firewall: [], domains: ['x.beispiel.de'] }).schritte.filter((s) => s.bereich === 'dns').length, 0, 'ohne passende Domain bleibt der Eintrag');
});

test('Ablauf: DNS und Firewall über die v2-Schnittstelle; Nachziehen im Live-Betrieb ergänzt die Sicherung (Stand vor dem ersten Umschalten bleibt)', async () => {
  const u = await unifiAttrappe([NPM_REGEL], { firewall: [GEFAEHRDER] });
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-'));
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    let r = await umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner, domains: DOMAINS , pruefen: NIE });
    assert.equal(r.ausgefuehrt, 4);
    assert.equal(u.z.firewall[0].destination.port, '2222,443,80,28443,28080');
    // so wie heute: der DNS-Platzhalter fällt erst nach dem Umschalten auf → Nachziehen
    u.z.dns.push(structuredClone(APEX), structuredClone(WILDCARD));
    r = await umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner, domains: DOMAINS , pruefen: NIE });
    assert.equal(r.ausgefuehrt, 1);
    assert.equal(u.z.dns.find((d) => d._id === 'd2').enabled, false);
    assert.equal(u.z.dns.find((d) => d._id === 'd1').enabled, true);
    const s = JSON.parse(await fs.readFile(r.sicherungDatei, 'utf8'));
    assert.deepEqual(s.regeln.map((x) => x._id), ['r1'], 'Stand vor dem ersten Umschalten bleibt in der Sicherung');
    assert.deepEqual(s.dns.map((x) => x._id), ['d2']); assert.deepEqual(s.firewall.map((x) => x._id), ['f9']);
    assert.equal(s.regeln[0].dst_port, '80,443,32400', 'Weiterleitung im Zustand vor dem ersten Umschalten');
  } finally { await u.zu(); await fs.rm(ordner, { recursive: true, force: true }); }
});

test('Ablauf: scheitert beim Nachziehen ein Schritt, nimmt der Rückweg nur diesen Lauf zurück – die Weiterleitungen des ersten Umschaltens bleiben', async () => {
  const u = await unifiAttrappe([NPM_REGEL, ANDERE], { fehlerBei: 4 });
  const ordner = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-unifi-'));
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    assert.equal((await umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner, domains: DOMAINS , pruefen: NIE })).ausgefuehrt, 3);
    const live = structuredClone(u.z.regeln);
    u.z.dns.push(structuredClone(WILDCARD));
    await assert.rejects(umschalten(c, { ziel: ZIEL, sicherungOrdner: ordner, domains: DOMAINS , pruefen: NIE }), (f) => f.code === 'E_UNIFI' && /Schritt 1/.test(f.message));
    assert.deepEqual(sortiert(u.z.regeln), sortiert(live), 'FAH-Proxy-Weiterleitungen und gekürzte NPM-Regel bleiben');
    assert.equal(u.z.dns[0].enabled, true);
  } finally { await u.zu(); await fs.rm(ordner, { recursive: true, force: true }); }
});

// ---- Fail-over: aktive Instanz wechseln ----
const MINI = { ip: '192.168.1.29', http: 28080, https: 28443 };
const GEF_LIVE = Object.freeze({ ...GEFAEHRDER, destination: { ...GEFAEHRDER.destination, port: '2222,443,80,28443,28080' } });
const LIVE_REGELN = Object.freeze([
  { ...NPM_REGEL, dst_port: '32400', fwd_port: '32400' },
  { ...NPM_REGEL, _id: 'h1', name: NAME_HTTP, dst_port: '80', fwd_port: '28080' },
  { ...NPM_REGEL, _id: 'h2', name: NAME_HTTPS, dst_port: '443', fwd_port: '28443' },
]);

test('Plan: Firewall-Sperre zur Partner-IP bekommt die eigene IP dazu (beide bleiben); SSH-Regel und fremde Ziele unberührt', () => {
  const ssh = { ...GEFAEHRDER, _id: 'f2', destination: { ...GEFAEHRDER.destination, port: '22' } };
  const p = umschaltPlan(LIVE_REGELN, MINI, { firewall: [GEF_LIVE, ssh], partnerIps: ['192.168.1.23'], domains: DOMAINS });
  const fw = p.schritte.filter((s) => s.bereich === 'firewall');
  assert.deepEqual(fw.map((s) => s.id), ['f9']);
  assert.deepEqual(fw[0].nachher.destination.ips, ['192.168.1.23', '192.168.1.29']);
  assert.equal(fw[0].nachher.destination.port, '2222,443,80,28443,28080');
  assert.match(fw[0].text, /192\.168\.1\.29/);
  assert.equal(umschaltPlan(LIVE_REGELN, MINI, { firewall: [GEF_LIVE], domains: DOMAINS }).schritte.filter((s) => s.bereich === 'firewall').length, 0, 'ohne Partner-IP kein Bezug');
  assert.equal(aktivIp(LIVE_REGELN), '192.168.1.23'); assert.equal(aktivIp([NPM_REGEL]), null);
});

test('aktivWechseln: nur FAH-Proxy-Regeln auf die eigene IP + Firewall ergänzen, keine Sicherung; ohne FAH-Proxy-Regeln nichts; Fehler → eigene Schritte zurück', async () => {
  let u = await unifiAttrappe(LIVE_REGELN, { firewall: [GEF_LIVE], dns: [{ ...WILDCARD, enabled: false }] });
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' });
    const r = await aktivWechseln(c, { ziel: MINI, partnerIps: ['192.168.1.23'], domains: DOMAINS });
    assert.equal(r.schritte.length, 3);
    assert.deepEqual(u.z.regeln.map((x) => `${x.name}>${x.fwd}:${x.fwd_port}`), ['NGINX REVERSE PROXY>192.168.1.23:32400', `${NAME_HTTP}>192.168.1.29:28080`, `${NAME_HTTPS}>192.168.1.29:28443`]);
    assert.deepEqual(u.z.firewall[0].destination.ips, ['192.168.1.23', '192.168.1.29']);
    assert.equal(aktivIp(u.z.regeln), '192.168.1.29');
    assert.equal((await aktivWechseln(c, { ziel: MINI, partnerIps: ['192.168.1.23'], domains: DOMAINS })).schritte.length, 0, 'zweimal ändert nichts');
    // zurück zum NAS: Firewall hat beide IPs schon → nur die Weiterleitungen
    const z = await aktivWechseln(c, { ziel: { ...MINI, ip: '192.168.1.23' }, partnerIps: ['192.168.1.29'], domains: DOMAINS });
    assert.deepEqual(z.schritte.map((s) => s.bereich), ['weiterleitung', 'weiterleitung']);
  } finally { await u.zu(); }
  u = await unifiAttrappe([NPM_REGEL]);
  try {
    await assert.rejects(aktivWechseln(new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' }), { ziel: MINI, partnerIps: ['192.168.1.23'], domains: DOMAINS }), (f) => f.code === 'E_EINGABE' && /noch nicht umgeschaltet/.test(f.message));
    assert.equal(u.z.schreib, 0);
  } finally { await u.zu(); }
  u = await unifiAttrappe(LIVE_REGELN, { firewall: [GEF_LIVE], fehlerBei: 3 });
  try {
    await assert.rejects(aktivWechseln(new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig' }), { ziel: MINI, partnerIps: ['192.168.1.23'], domains: DOMAINS }), (f) => f.code === 'E_UNIFI');
    assert.deepEqual(u.z.regeln.map((x) => x.fwd), ['192.168.1.23', '192.168.1.23', '192.168.1.23'], 'Weiterleitungen zurück aufs NAS');
    assert.deepEqual(u.z.firewall[0].destination.ips, ['192.168.1.23'], 'Firewall zurück');
  } finally { await u.zu(); }
});

// ---- Wache: automatisches Fail-over ----
async function wacheAufbau({ rolle, ich, partner, regeln, dns = [] }) {
  const { App } = await import('../src/app.js');
  const { Wache, PRUEF_MS } = await import('../src/spiegel/wache.js');
  const http = await import('node:http');
  const u = await unifiAttrappe(regeln, { firewall: [GEF_LIVE], dns });
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-wache-'));
  const caddy = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(); }); });
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const app = await App.starten({ daten: d, caddyUrl: `http://127.0.0.1:${caddy.address().port}`, caddyDaten: path.join(d, 'cd'), version: 'test', hintergrund: false, hostIp: ich, testPorts: { http: 28080, https: 28443 } });
  app.pruefen443 = NIE;
  await app.domains.anlegen({ domain: 'nextcloud.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'oeffentlich', herkunft: 'neu' });
  await fs.mkdir(path.join(app.zertOrdner, 'nextcloud.beispiel.de'), { recursive: true });
  await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(app.zertOrdner, 'nextcloud.beispiel.de', 'fullchain.pem'));
  await fs.copyFile(path.join(FIX, 'test-privkey.pem'), path.join(app.zertOrdner, 'nextcloud.beispiel.de', 'privkey.pem'));
  await app.einstellungen.setzen({ rolle, unifi: { url: u.url, benutzer: 'fahproxy', passwort: app.geheim.verschluesseln('richtig'), ziel_ip: ich }, spiegel: { ...app.einstellungen.lesen().spiegel, partner: rolle === 'ersatz' ? { ip: partner, http: 28080, https: 28443 } : null } });
  const lebt = { [partner]: true, caddy: true }; let uhr = Date.parse('2026-10-09T14:00:00Z');
  const proben = [];
  const ohneZert = new Set(); // Domains, für die der Rechner kein Zertifikat hat → der TLS-Aufbau scheitert wie bei Caddy
  const rueckgaben = []; let rueckgabeKlappt = true; const meldungen = [];
  const w = await Wache.laden(app, { pruefen: async ({ host, domain }) => { proben.push(`${host}/${domain}`); return !!lebt[host] && !ohneZert.has(domain); }, jetzt: () => uhr, partnerFuerHaupt: () => (rolle === 'haupt' ? { ip: partner, http: 28080, https: 28443 } : null),
    nachRueckgabe: async () => { meldungen.push(aktivIp(u.z.regeln)); },
    vorRueckgabe: async () => { rueckgaben.push(aktivIp(u.z.regeln)); if (!rueckgabeKlappt) throw new Error('Haupt nimmt nichts an'); } });
  app.wache = w;
  const takte = async (n = 1) => { for (let i = 0; i < n; i++) { uhr += PRUEF_MS; await w.takt(); } };
  const minute = (n = 1) => takte(n * Math.round(60_000 / PRUEF_MS));
  return { u, app, w, lebt, proben, ohneZert, minute, takte, rueckgaben, meldungen, rueckgabeScheitert: (j) => { rueckgabeKlappt = !j; }, protokoll: async () => (await app.protokoll.lesen(50)).map((e) => e.aktion), zu: async () => { app.stoppen(); await new Promise((r) => caddy.close(r)); await u.zu(); await fs.rm(d, { recursive: true, force: true }); } };
}
const aufNas = LIVE_REGELN; // Weiterleitungen zeigen auf 192.168.1.23
const aufMini = LIVE_REGELN.map((r) => (r.name.startsWith('FAH-Proxy') ? { ...r, fwd: '192.168.1.29' } : r));

test('Wache (Ersatz auf dem NAS): Haupt 1 Minute weg (4 Prüfungen à 15 s) → übernimmt (live); Haupt 10 Minuten stabil → gibt zurück (test); dazwischen nichts', async () => {
  const t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: aufMini });
  try {
    await t.minute();
    assert.equal(t.app.einstellungen.lesen().modus, 'test', 'passiv = test');
    assert.ok(t.proben.includes('192.168.1.29/nextcloud.beispiel.de') && t.proben.includes('caddy/nextcloud.beispiel.de'));
    t.lebt['192.168.1.29'] = false;
    await t.takte(3);
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.29', 'nach 3 Fehlschlägen (45 s) noch nicht');
    await t.takte();
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.23', 'nach 4 Fehlschlägen (1 Minute) übernommen');
    assert.match(t.w.stand().meldung, /seit 60 Sekunden/);
    assert.equal(t.app.einstellungen.lesen().modus, 'live');
    assert.ok((await t.protokoll()).includes('failover.uebernommen'));
    t.lebt['192.168.1.29'] = true;
    await t.minute(9);
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.23', 'erst nach 10 stabilen Minuten zurück');
    t.rueckgabeScheitert(true);
    const vorher = t.rueckgaben.length;
    await t.minute(2);
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.23', 'ohne gelungenen Abgleich zur Haupt-Instanz kein Zurückgeben');
    assert.ok(t.rueckgaben.length - vorher <= 2, `höchstens ein Rückgabe-Versuch je Minute (waren ${t.rueckgaben.length - vorher})`);
    assert.match(t.w.stand().meldung, /wartet/);
    t.rueckgabeScheitert(false);
    await t.minute();
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.29', 'zurückgegeben');
    assert.deepEqual(t.meldungen, ['192.168.1.29'], 'Haupt-Instanz genau einmal benachrichtigt, nach dem Umstellen');
    assert.equal(t.rueckgaben.at(-1), '192.168.1.23', 'Abgleich lief, solange die Ersatz-Instanz noch aktiv war');
    assert.equal(t.app.einstellungen.lesen().modus, 'test');
    assert.ok((await t.protokoll()).includes('failover.zurueck'));
    assert.equal(t.w.stand().partner_ok, true);
  } finally { await t.zu(); }
});

test('Wache schont die UniFi-Konsole: 30 Minuten Ausfall der Haupt-Instanz nach der Übernahme → höchstens alle 5 Minuten eine Anmeldung', async () => {
  const t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: aufMini });
  try {
    await t.minute();
    t.lebt['192.168.1.29'] = false;
    await t.minute();
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.23', 'übernommen');
    const anmeldungen = t.u.z.anmeldungen; const schreib = t.u.z.schreib;
    await t.minute(30);
    assert.ok(t.u.z.anmeldungen - anmeldungen <= 7, `Anmeldungen in 30 Minuten: ${t.u.z.anmeldungen - anmeldungen}`);
    assert.equal(t.u.z.schreib, schreib, 'kein weiterer Schreibzugriff');
  } finally { await t.zu(); }
});

test('Wache sperrt das UniFi-Konto nicht: Passwort veraltet → höchstens alle 5 Minuten ein Versuch; im Normalbetrieb der Ersatz-Instanz auch', async () => {
  const t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: aufMini });
  try {
    await t.minute(11);
    let versuche = t.u.z.versuche;
    await t.minute(30);
    assert.ok(t.u.z.versuche - versuche <= 7, `Anmeldungen in 30 Minuten als passive Ersatz-Instanz: ${t.u.z.versuche - versuche}`);
    const unifi = t.app.einstellungen.lesen().unifi;
    await t.app.einstellungen.setzen({ unifi: { ...unifi, passwort: t.app.geheim.verschluesseln('alt') } });
    t.w.neuLesen();
    versuche = t.u.z.versuche;
    await t.minute(30);
    assert.ok(t.u.z.versuche - versuche <= 7, `Fehlversuche in 30 Minuten: ${t.u.z.versuche - versuche}`);
    assert.match(t.w.stand().meldung, /UniFi nicht lesbar/);
    await t.app.einstellungen.setzen({ unifi });
    t.w.neuLesen();
    await t.takte();
    assert.ok(t.w.stand().aktiv, 'nach dem Korrigieren sofort wieder lesbar');
  } finally { await t.zu(); }
});

test('Wache schreibt ihren Stand lesbar nach daten/wache-stand.json (Lämpchen der Homepage): wer aktiv ist, ob der Partner antwortet', async () => {
  const t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: aufMini });
  const datei = path.join(t.app.daten, 'wache-stand.json');
  try {
    await t.minute();
    let st = JSON.parse(await fs.readFile(datei, 'utf8'));
    assert.deepEqual({ rolle: st.rolle, ich: st.ich.ip, partner: st.partner.ip, aktiv: st.aktiv_ip, partner_ok: st.partner_ok, selbst_ok: st.selbst_ok },
      { rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', aktiv: '192.168.1.29', partner_ok: true, selbst_ok: true });
    assert.equal((await fs.stat(datei)).mode & 0o777, 0o644, 'für die Homepage lesbar (keine Geheimnisse darin)');
    assert.ok(!Number.isNaN(Date.parse(st.zeit)));
    t.lebt['192.168.1.29'] = false;
    await t.minute();
    st = JSON.parse(await fs.readFile(datei, 'utf8'));
    assert.equal(st.aktiv_ip, '192.168.1.23'); assert.equal(st.partner_ok, false);
  } finally { await t.zu(); }
});

test('Wache: Haupt übernimmt und holt den DNS-Platzhalter zu sich, auch wenn die erste Domain hier noch kein Zertifikat hat (23.11.: neue dns-…-Domain, DNS blieb auf dem Ersatz)', async () => {
  const t = await wacheAufbau({ rolle: 'haupt', ich: '192.168.1.29', partner: '192.168.1.23', regeln: aufNas, dns: [{ ...WILDCARD, key: '*.beispiel.de', value: '192.168.1.23' }] });
  try {
    // FAH-Adblock legt während des Fail-overs eine Domain an, die alphabetisch vorn steht; im Testbetrieb holt Caddy dafür kein Zertifikat
    await t.app.domains.anlegen({ domain: 'dns-tablet.beispiel.de', ziel: '192.168.1.29:8053', schutz: 'oeffentlich', herkunft: 'neu' });
    t.ohneZert.add('dns-tablet.beispiel.de');
    t.lebt['192.168.1.29'] = true; t.lebt['192.168.1.23'] = false;
    await t.minute(2);
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.29', 'übernommen');
    assert.equal(t.u.z.dns[0].value, '192.168.1.29', 'DNS folgt der aktiven Instanz');
    assert.equal(t.u.z.dns[0].enabled, true);
    assert.ok(!t.proben.includes('192.168.1.29/dns-tablet.beispiel.de'), 'nie unter einer Domain ohne Zertifikat fragen');
  } finally { await t.zu(); }
});

test('Wache: Haupt übernimmt, wenn der aktive Ersatz ausfällt; nicht, wenn sie selbst krank ist, Fail-over aus ist oder noch nicht umgeschaltet ist; Ruhezeit nach einem Wechsel', async () => {
  let t = await wacheAufbau({ rolle: 'haupt', ich: '192.168.1.29', partner: '192.168.1.23', regeln: aufNas });
  try {
    t.lebt['192.168.1.23'] = false; t.lebt.caddy = false;
    await t.minute(4);
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.23', 'selbst krank → kein Wechsel');
    t.lebt.caddy = true;
    await t.minute();
    assert.equal(aktivIp(t.u.z.regeln), '192.168.1.29', 'selbst gesund → übernommen');
    assert.equal(t.app.einstellungen.lesen().modus, 'live');
    // Ruhezeit: der Partner kommt zurück und fällt gleich wieder aus – die Haupt-Instanz ist ohnehin aktiv, nichts passiert
    const schreib = t.u.z.schreib;
    t.lebt['192.168.1.23'] = true; await t.minute(2); t.lebt['192.168.1.23'] = false; await t.minute(4);
    assert.equal(t.u.z.schreib, schreib, 'Haupt aktiv → kein weiterer Schreibzugriff');
  } finally { await t.zu(); }
  t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: aufMini });
  try {
    await t.app.einstellungen.setzen({ failover: { an: false } });
    t.lebt['192.168.1.29'] = false; await t.minute(5);
    assert.equal(t.u.z.schreib, 0, 'Fail-over aus → nichts');
    assert.match(t.w.stand().meldung, /aus/);
  } finally { await t.zu(); }
  t = await wacheAufbau({ rolle: 'ersatz', ich: '192.168.1.23', partner: '192.168.1.29', regeln: [NPM_REGEL] });
  try {
    t.lebt['192.168.1.29'] = false; await t.minute(5);
    assert.equal(t.u.z.schreib, 0, 'nicht umgeschaltet → kein Fail-over');
    assert.equal(t.app.einstellungen.lesen().modus, 'test');
  } finally { await t.zu(); }
});

test('Plan + Ablauf: DNS-Eintrag auf einen Rechner, wo ein FAH-Proxy auf 443 antwortet (VPN-Zugriff, 09.10.), bleibt an', async () => {
  const p = umschaltPlan([NPM_REGEL], ZIEL, { dns: [APEX, WILDCARD], firewall: [], domains: DOMAINS, fahProxy443: ['192.168.1.23'] });
  assert.ok(!p.schritte.some((s) => s.bereich === 'dns'), 'Platzhalter aufs NAS bleibt');
  const dns = [WILDCARD, { ...WILDCARD, _id: 'x', key: 'nextcloud.example.org', value: '192.168.1.50' }, { ...WILDCARD, _id: 'y', enabled: false, value: '192.168.1.60' }, { ...WILDCARD, _id: 'z', record_type: 'CNAME', value: 'irgendwo' }, { ...WILDCARD, _id: 'w', key: '*.anders.de', value: '192.168.1.70' }];
  const gefragt = [];
  const ips = await fahProxyAuf443(dns, DOMAINS, async ({ host, port, domain }) => { gefragt.push(`${host}:${port}/${domain}`); return host === '192.168.1.23'; });
  assert.deepEqual(ips, ['192.168.1.23']);
  assert.deepEqual(gefragt.sort(), ['192.168.1.23:443/fah-proxy.example.org', '192.168.1.50:443/nextcloud.example.org'], 'nur aktive A-Einträge, die eine Domain decken, je Ziel einmal');
});

test('Plan + aktivWechseln: DNS-Eintrag folgt der aktiven Instanz, wenn sie selbst 443 annimmt (Haus/VPN zum Haupt-Proxy, im Fail-over zum Ersatz)', async () => {
  const MINI = { ip: '192.168.1.29', http: 28080, https: 28443 };
  // Mini-PC nimmt 443 an, Eintrag zeigt aufs NAS (Partner) → auf den Mini-PC umstellen
  let p = umschaltPlan(LIVE_REGELN, MINI, { dns: [APEX, WILDCARD], domains: DOMAINS, partnerIps: ['192.168.1.23'], fahProxy443: ['192.168.1.29', '192.168.1.23'] });
  const d = p.schritte.find((s) => s.bereich === 'dns');
  assert.equal(d.nachher.value, '192.168.1.29'); assert.equal(d.nachher.enabled, true); assert.match(d.text, /aktive Instanz 192\.168\.1\.29/);
  // nimmt die Ziel-Instanz 443 nicht an: Eintrag aufs NAS bleibt (dort antwortet ein FAH-Proxy), nichts abschalten
  p = umschaltPlan(LIVE_REGELN, MINI, { dns: [WILDCARD], domains: DOMAINS, partnerIps: ['192.168.1.23'], fahProxy443: ['192.168.1.23'] });
  assert.ok(!p.schritte.some((s) => s.bereich === 'dns'));
  // zeigt schon auf die aktive Instanz → nichts
  p = umschaltPlan(LIVE_REGELN, MINI, { dns: [{ ...WILDCARD, value: '192.168.1.29' }], domains: DOMAINS, partnerIps: ['192.168.1.23'], fahProxy443: ['192.168.1.29'] });
  assert.ok(!p.schritte.some((s) => s.bereich === 'dns'));
  // Fail-over über die Konsole: Weiterleitungen UND DNS gehen auf den Ersatz, zurück wieder auf den Mini-PC
  const u = await unifiAttrappe(LIVE_REGELN.map((r) => (r.name.startsWith('FAH-Proxy') ? { ...r, fwd: '192.168.1.29' } : r)), { dns: [{ ...WILDCARD, value: '192.168.1.29' }] });
  try {
    const c = new UnifiClient({ url: u.url, benutzer: 'fahproxy', passwort: 'richtig', fingerabdruck: u.fingerabdruck });
    const lebt = async ({ host }) => host === '192.168.1.23' || host === '192.168.1.29';
    await aktivWechseln(c, { ziel: ZIEL, partnerIps: ['192.168.1.29'], domains: DOMAINS, pruefen: lebt });
    assert.equal(aktivIp(u.z.regeln), '192.168.1.23'); assert.equal(u.z.dns[0].value, '192.168.1.23');
    await aktivWechseln(c, { ziel: MINI, partnerIps: ['192.168.1.23'], domains: DOMAINS, pruefen: lebt });
    assert.equal(aktivIp(u.z.regeln), '192.168.1.29'); assert.equal(u.z.dns[0].value, '192.168.1.29'); assert.equal(u.z.dns[0].enabled, true);
  } finally { await u.zu(); }
});
