// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ersatz-Instanz: Kopplungscode (Adresse + Fingerabdruck + Einmal-Schlüssel) gilt nur einmal, falscher Fingerabdruck →
// Abbruch ohne dass der Schlüssel rausgeht, Abgleich übernimmt Domains, Konten (2FA neu verschlüsselt), Einstellungen
// (ohne Gerätespezifisches) und das jeweils neueste Zertifikat, Ersatz sperrt Änderungen außer Umschalten, Entfernen am
// Haupt beendet den Abgleich, Warnung bei veraltetem Abgleich.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.js';
import { totp } from '../src/totp.js';
import { codeLesen, spiegelWarnung } from '../src/spiegel/ersatz.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const ND = 'nextcloud.beispiel.de';

async function instanz(name, { tls = false } = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), `fahproxy-${name}-`));
  const geladen = [];
  const caddy = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { geladen.push(b); res.writeHead(200); res.end(); }); });
  await new Promise((r) => caddy.listen(0, '127.0.0.1', r));
  const app = await App.starten({ daten: d, caddyUrl: `http://127.0.0.1:${caddy.address().port}`, caddyDaten: path.join(d, 'caddy-daten'), version: 'test', hintergrund: false, hostIp: name === 'haupt' ? '192.168.1.23' : '192.168.1.29', testPorts: { http: 28080, https: 28443 } });
  const s = tls ? https.createServer({ key: await fs.readFile(path.join(FIX, 'test-privkey.pem')), cert: await fs.readFile(path.join(FIX, 'test-fullchain.pem')) }, app.web.handler()) : http.createServer(app.web.handler());
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  if (tls) { app.uiUrl = `https://127.0.0.1:${s.address().port}`; app.uiZertDatei = path.join(FIX, 'test-fullchain.pem'); }
  const glas = new Map();
  const c = (m, p, body, { ohneSitzung = false, kopf = {} } = {}) => new Promise((ok, nein) => {
    const h = { ...kopf };
    if (!ohneSitzung && glas.size) h.Cookie = [...glas].map(([n, v]) => `${n}=${v}`).join('; ');
    if (!ohneSitzung && glas.has('fp_csrf')) h['X-FP-CSRF'] = glas.get('fp_csrf');
    const daten = body === undefined ? undefined : JSON.stringify(body);
    if (daten) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(daten); }
    const r = (tls ? https : http).request({ host: '127.0.0.1', port: s.address().port, path: p, method: m, headers: h, rejectUnauthorized: false }, (res) => {
      if (!ohneSitzung) for (const k of res.headers['set-cookie'] || []) { const [nv] = k.split(';'); const i = nv.indexOf('='); glas.set(nv.slice(0, i), decodeURIComponent(nv.slice(i + 1))); }
      let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => ok({ status: res.statusCode, j: JSON.parse(t || 'null') }));
    });
    r.on('error', nein); r.end(daten);
  });
  await c('POST', '/api/anmelden', { name: 'admin', passwort: 'admin' });
  await c('POST', '/api/passwort', { neu: `${name}-Passwort-2026` });
  return { d, app, c, geladen, zu: async () => { app.stoppen(); await new Promise((r) => s.close(r)); await new Promise((r) => caddy.close(r)); await fs.rm(d, { recursive: true, force: true }); } };
}

test('Kopplung: falscher Fingerabdruck bricht ab, Code gilt einmal; Abgleich übernimmt Domains, Konten mit 2FA, Einstellungen, neuestes Zertifikat; Ersatz sperrt Änderungen', async () => {
  const h = await instanz('haupt', { tls: true }); const e = await instanz('ersatz');
  try {
    await h.c('POST', '/api/domains', { domain: ND, ziel: '192.168.1.23:8080', schutz: 'heimnetz' });
    await h.c('POST', '/api/konten', { name: 'anna', passwort: 'Anna-Passwort-1', rolle: 'nutzer' });
    const { geheimnis } = (await h.c('POST', '/api/konten/anna/2fa')).j.ergebnis;
    await h.c('POST', '/api/konten/anna/2fa/aktivieren', { code: totp(geheimnis) });
    await h.c('PUT', '/api/einstellungen', { ntfy: { url: 'https://ntfy.beispiel.de', thema: 'fah', token: 'tk_geheim' }, unifi: { url: 'https://127.0.0.1:9', benutzer: 'fahproxy', passwort: 'unifi-pw', ziel_ip: '192.168.1.23' } });
    // übernommenes Zertifikat (bis 2036) und ein von Caddy geholtes (bis 2038) – das neuere gewinnt
    await fs.mkdir(path.join(h.d, 'zertifikate', ND), { recursive: true });
    await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(h.d, 'zertifikate', ND, 'fullchain.pem'));
    await fs.copyFile(path.join(FIX, 'test-privkey.pem'), path.join(h.d, 'zertifikate', ND, 'privkey.pem'));
    const le = path.join(h.d, 'caddy-daten', 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', ND);
    await fs.mkdir(le, { recursive: true });
    await fs.copyFile(path.join(FIX, 'test-neu-fullchain.pem'), path.join(le, `${ND}.crt`));
    await fs.copyFile(path.join(FIX, 'test-neu-privkey.pem'), path.join(le, `${ND}.key`));

    let r = await h.c('POST', '/api/spiegel/code', {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const code = r.j.ergebnis.code; const k = codeLesen(code);
    assert.equal(k.url, h.app.uiUrl); assert.match(k.fingerabdruck, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    const falsch = `FAHPROXY1.${Buffer.from(JSON.stringify({ u: k.url, f: 'AA:BB', k: k.schluessel })).toString('base64url')}`;
    r = await e.c('POST', '/api/spiegel/verbinden', { code: falsch });
    assert.equal(r.j.fehler.code, 'E_SPIEGEL'); assert.match(r.j.fehler.meldung, /Zertifikat/);
    assert.equal(e.app.einstellungen.lesen().rolle, 'haupt');
    assert.equal((await e.c('POST', '/api/spiegel/verbinden', { code: 'Quatsch' })).j.fehler.code, 'E_EINGABE');
    r = await e.c('POST', '/api/spiegel/verbinden', { code });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(e.app.einstellungen.lesen().rolle, 'ersatz');
    assert.equal((await h.c('POST', '/api/spiegel/koppeln', { schluessel: k.schluessel }, { ohneSitzung: true })).status, 401, 'Code nur einmal');

    assert.deepEqual(e.app.domains.liste().map((x) => x.domain), [ND]);
    assert.deepEqual(e.app.konten.liste(), h.app.konten.liste());
    assert.equal((await e.app.konten.pruefen('anna', 'Anna-Passwort-1', totp(geheimnis, Date.now() / 1000 + 30))).name, 'anna', '2FA auf der Ersatz-Instanz');
    assert.equal(await fs.readFile(path.join(e.d, 'zertifikate', ND, 'fullchain.pem'), 'utf8'), await fs.readFile(path.join(FIX, 'test-neu-fullchain.pem'), 'utf8'));
    assert.equal((await fs.stat(path.join(e.d, 'zertifikate', ND, 'privkey.pem'))).mode & 0o777, 0o600);
    const es = e.app.einstellungen.lesen();
    assert.equal(e.app.geheim.entschluesseln(es.ntfy.token), 'tk_geheim');
    assert.equal(e.app.geheim.entschluesseln(es.unifi.passwort), 'unifi-pw');
    assert.equal(es.unifi.ziel_ip, '', 'Ziel-IP bleibt gerätespezifisch');
    assert.equal(es.modus, 'test');
    assert.ok(e.geladen.at(-1).includes(`${ND} {`), 'Caddy der Ersatz-Instanz neu geladen');

    // Änderung am Haupt → Abgleich holt sie
    await h.c('POST', '/api/domains', { domain: 'neu.beispiel.de', ziel: '192.168.1.23:8081', schutz: 'oeffentlich' });
    assert.equal((await e.c('POST', '/api/spiegel/abgleichen', {})).status, 200);
    assert.ok(e.app.domains.liste().some((x) => x.domain === 'neu.beispiel.de'));
    assert.ok(e.app.einstellungen.lesen().spiegel.letzter_abgleich);

    // Ersatz sperrt Änderungen, Lesen und Umschalten bleiben
    r = await e.c('POST', '/api/domains', { domain: 'x.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' });
    assert.equal(r.status, 403); assert.match(r.j.fehler.meldung, /nicht aktiv/);
    assert.equal((await e.c('PUT', '/api/einstellungen', { acme_email: 'a@b.de' })).status, 403);
    assert.equal((await e.c('POST', '/api/konten', { name: 'x', passwort: 'xxxxxxxxxxxx' })).status, 403);
    assert.equal((await e.c('GET', '/api/uebersicht')).status, 200);
    r = await e.c('POST', '/api/umschalten/uebernehmen', { bestaetigt: true });
    assert.notEqual(r.j.fehler && r.j.fehler.code, 'E_RECHTE', 'Übernehmen bleibt möglich');
    assert.equal((await e.c('GET', '/api/ich')).j.ergebnis.rolle, 'ersatz');
    assert.equal((await e.c('GET', '/api/spiegel', undefined, { kopf: { Authorization: 'Bearer x' } })).status, 403, 'eine Ersatz-Instanz gibt keinen Spiegel heraus');

    // Haupt: Liste mit letztem Abruf; Entfernen → Ersatz bekommt eine klare Meldung
    r = await h.c('GET', '/api/spiegel/ersatz');
    assert.equal(r.j.ergebnis.length, 1); assert.ok(r.j.ergebnis[0].letzter_abruf);
    assert.ok(!JSON.stringify(r.j).includes('hash'));
    await h.c('DELETE', `/api/spiegel/ersatz/${r.j.ergebnis[0].id}`);
    r = await e.c('POST', '/api/spiegel/abgleichen', {});
    assert.equal(r.j.fehler.code, 'E_SPIEGEL'); assert.match(r.j.fehler.meldung, /neu koppeln/);
    // Entkoppeln: wieder eigenständig, Daten bleiben
    assert.equal((await e.c('POST', '/api/spiegel/entkoppeln', {})).status, 200);
    assert.equal(e.app.einstellungen.lesen().rolle, 'haupt');
    assert.equal(e.app.domains.liste().length, 2);
    assert.equal((await e.c('POST', '/api/domains', { domain: 'x.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' })).status, 200);
  } finally { await h.zu(); await e.zu(); }
});

test('Spiegel-Abruf ohne gültigen Schlüssel → 401; Kopplungscode verfällt', async () => {
  const h = await instanz('haupt', { tls: true });
  try {
    assert.equal((await h.c('GET', '/api/spiegel', undefined, { ohneSitzung: true })).status, 401);
    assert.equal((await h.c('GET', '/api/spiegel', undefined, { ohneSitzung: true, kopf: { Authorization: 'Bearer falsch' } })).status, 401);
    const { code } = (await h.c('POST', '/api/spiegel/code', {})).j.ergebnis;
    h.app.spiegelHaupt.jetzt = () => Date.now() + 31 * 60_000;
    assert.equal((await h.c('POST', '/api/spiegel/koppeln', { schluessel: codeLesen(code).schluessel }, { ohneSitzung: true })).status, 401);
  } finally { await h.zu(); }
});

test('Warnung: Abgleich älter als 1 Stunde (oder nie) → aktiv, frisch → Entwarnung; ungekoppelt → nichts', () => {
  const jetzt = Date.parse('2026-10-09T12:00:00Z');
  const e = (spiegel) => ({ rolle: 'ersatz', spiegel: { haupt_url: 'https://192.168.1.23:28181', schluessel: 'v1:x', ...spiegel } });
  assert.equal(spiegelWarnung(e({ letzter_abgleich: '2026-10-09T10:30:00Z' }), jetzt).aktiv, true);
  assert.match(spiegelWarnung(e({ letzter_abgleich: '2026-10-09T10:30:00Z' }), jetzt).text, /192\.168\.1\.23/);
  assert.equal(spiegelWarnung(e({ letzter_abgleich: null }), jetzt).aktiv, true);
  assert.equal(spiegelWarnung(e({ letzter_abgleich: '2026-10-09T11:50:00Z' }), jetzt).aktiv, false);
  assert.equal(spiegelWarnung({ rolle: 'haupt', spiegel: {} }, jetzt), null);
});

test('Kopplungscodes liegen gehasht in daten/spiegel-codes.json: ein Code aus einem zweiten Prozess (Werkzeug rolle.js) gilt beim laufenden Server', async () => {
  const h = await instanz('haupt', { tls: true });
  try {
    const { SpiegelHaupt } = await import('../src/spiegel/haupt.js');
    const werkzeug = await SpiegelHaupt.laden(h.app); // eigener „Prozess“ mit derselben Datenablage
    const { code } = await werkzeug.codeErzeugen();
    const datei = await fs.readFile(path.join(h.d, 'spiegel-codes.json'), 'utf8');
    assert.ok(!datei.includes(codeLesen(code).schluessel), 'nur der Hash steht in der Datei');
    const r = await h.c('POST', '/api/spiegel/koppeln', { schluessel: codeLesen(code).schluessel, name: 'Probe' }, { ohneSitzung: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal((await h.c('POST', '/api/spiegel/koppeln', { schluessel: codeLesen(code).schluessel }, { ohneSitzung: true })).status, 401, 'nur einmal');
  } finally { await h.zu(); }
});

test('Werkzeug rolle.js code: gibt im Container einen gültigen Kopplungscode mit Adresse aus HOST_IP/UI_PORT aus', async () => {
  const { execFileSync } = await import('node:child_process');
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-rolle-'));
  try {
    await fs.mkdir(path.join(d, 'ui-tls'), { recursive: true });
    await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(d, 'ui-tls', 'cert.pem'));
    const aus = execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'werkzeuge', 'rolle.js'), 'code'], { env: { ...process.env, DATEN: d, HOST_IP: '192.168.1.29', UI_PORT: '28181' }, encoding: 'utf8' });
    const code = /FAHPROXY1\.\S+/.exec(aus)[0];
    assert.equal(codeLesen(code).url, 'https://192.168.1.29:28181');
    assert.ok((await fs.readFile(path.join(d, 'spiegel-codes.json'), 'utf8')).length > 10);
    assert.throws(() => execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'werkzeuge', 'rolle.js'), 'quatsch'], { env: { ...process.env, DATEN: d }, stdio: 'pipe' }));
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Spiegel bringt Proxy-Ziel der Haupt-Instanz, Fail-over-Schalter; die Ersatz-Instanz meldet ihr eigenes Ziel', async () => {
  const h = await instanz('haupt', { tls: true }); const e = await instanz('ersatz');
  try {
    assert.equal((await h.c('PUT', '/api/einstellungen', { failover: { an: false } })).status, 200);
    const { code } = (await h.c('POST', '/api/spiegel/code', {})).j.ergebnis;
    assert.equal((await e.c('POST', '/api/spiegel/verbinden', { code })).status, 200);
    const es = e.app.einstellungen.lesen();
    assert.deepEqual(es.spiegel.partner, { ip: '192.168.1.23', http: 28080, https: 28443 });
    assert.equal(es.failover.an, false);
    const liste = (await h.c('GET', '/api/spiegel/ersatz')).j.ergebnis;
    assert.deepEqual(liste[0].ziel, { ip: '192.168.1.29', http: 28080, https: 28443 });
  } finally { await h.zu(); await e.zu(); }
});

test('Partner-Zugriffe: die Ersatz-Instanz holt neue Zeilen des Zugriffsprotokolls der Haupt-Instanz (für die Homepage), halbe Zeilen später, nach dem Rotieren von vorn', async () => {
  const { zugriffeHolen } = await import('../src/spiegel/ersatz.js');
  const h = await instanz('haupt', { tls: true }); const e = await instanz('ersatz');
  try {
    const log = path.join(h.d, 'caddy', 'zugriffe.log'); const ziel = path.join(e.d, 'caddy', 'partner-zugriffe.log');
    await fs.writeFile(log, '{"n":1}\n{"n":2}\n');
    const { code } = (await h.c('POST', '/api/spiegel/code', {})).j.ergebnis;
    await e.c('POST', '/api/spiegel/verbinden', { code });
    await zugriffeHolen(e.app);
    assert.equal(await fs.readFile(ziel, 'utf8'), '{"n":1}\n{"n":2}\n');
    assert.equal((await fs.stat(ziel)).mode & 0o777, 0o644, 'die Homepage muss lesen können');
    await fs.appendFile(log, '{"n":3}\n{"halb"');
    await zugriffeHolen(e.app);
    assert.equal(await fs.readFile(ziel, 'utf8'), '{"n":1}\n{"n":2}\n{"n":3}\n');
    await fs.appendFile(log, ':1}\n');
    await zugriffeHolen(e.app);
    assert.ok((await fs.readFile(ziel, 'utf8')).endsWith('{"n":3}\n{"halb":1}\n'));
    await fs.rm(log); await fs.writeFile(log, '{"n":9}\n'); // Caddy rotiert: neue Datei
    await zugriffeHolen(e.app);
    assert.ok((await fs.readFile(ziel, 'utf8')).endsWith('{"halb":1}\n{"n":9}\n'));
    assert.equal((await h.c('GET', '/api/spiegel/zugriffe?ab=0', undefined, { ohneSitzung: true })).status, 401);
  } finally { await h.zu(); await e.zu(); }
});

test('Abgleich folgt der aktiven Instanz: Ersatz aktiv → dort änderbar, Haupt gesperrt, Ersatz überträgt Neues/Geändertes/Gelöschtes (inkl. Zertifikat) zum Haupt; zurück beim Haupt → umgekehrt', async () => {
  const h = await instanz('haupt', { tls: true }); const e = await instanz('ersatz');
  const aktiv = (ip) => { for (const x of [h, e]) x.app.wache.z.aktiv = { ip, zeit: Date.now() }; };
  try {
    aktiv('192.168.1.23');
    const a = (await h.c('POST', '/api/domains', { domain: 'a.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'oeffentlich' })).j.ergebnis.domain;
    const b = (await h.c('POST', '/api/domains', { domain: ND, ziel: '192.168.1.23:8081', schutz: 'oeffentlich' })).j.ergebnis.domain;
    await fs.mkdir(path.join(h.d, 'zertifikate', ND), { recursive: true });
    await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(h.d, 'zertifikate', ND, 'fullchain.pem'));
    await fs.copyFile(path.join(FIX, 'test-privkey.pem'), path.join(h.d, 'zertifikate', ND, 'privkey.pem'));
    const { code } = (await h.c('POST', '/api/spiegel/code', {})).j.ergebnis;
    assert.equal((await e.c('POST', '/api/spiegel/verbinden', { code })).status, 200);
    assert.equal((await e.c('POST', '/api/domains', { domain: 'x.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' })).status, 403, 'passive Ersatz-Instanz ist gesperrt');
    // Fail-over: die Ersatz-Instanz bedient das Internet
    aktiv('192.168.1.29');
    let r = await h.c('POST', '/api/domains', { domain: 'x.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' });
    assert.equal(r.status, 403); assert.match(r.j.fehler.meldung, /nicht aktiv/);
    assert.equal((await e.c('POST', '/api/domains', { domain: 'neu.beispiel.de', ziel: '192.168.1.23:7000', schutz: 'heimnetz' })).status, 200);
    assert.equal((await e.c('PUT', `/api/domains/${a.id}`, { ziel: '192.168.1.23:9999' })).status, 200);
    assert.equal((await e.c('DELETE', `/api/domains/${b.id}`)).status, 200);
    assert.equal((await e.c('POST', '/api/schutzstufen', { titel: 'Büro', text: '', art: 'netze', netze: ['85.1.2.0/24'] })).status, 200);
    r = await e.c('POST', '/api/spiegel/abgleichen', {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const hd = h.app.domains.liste();
    assert.deepEqual(hd.map((d) => d.domain).sort(), ['a.beispiel.de', 'neu.beispiel.de']);
    assert.equal(hd.find((d) => d.domain === 'a.beispiel.de').ziel, 'http://192.168.1.23:9999');
    await assert.rejects(fs.access(path.join(h.d, 'zertifikate', ND)), 'Zertifikat der gelöschten Domain ist beim Haupt weg');
    assert.ok(h.app.einstellungen.lesen().schutz.eigene.some((s) => s.titel === 'Büro'));
    assert.equal(h.app.einstellungen.lesen().rolle, 'haupt', 'Rollen bleiben');
    // Haupt hält sich selbst für aktiv → nimmt keinen Stand an
    h.app.wache.z.aktiv = { ip: '192.168.1.23', zeit: Date.now() };
    r = await e.c('POST', '/api/spiegel/abgleichen', {});
    assert.equal(r.j.fehler.code, 'E_SPIEGEL'); assert.match(r.j.fehler.meldung, /selbst aktiv/);
    // Rückgabe: Haupt aktiv, Ersatz wieder gesperrt und zieht vom Haupt
    aktiv('192.168.1.23');
    assert.equal((await e.c('POST', '/api/domains', { domain: 'y.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' })).status, 403);
    assert.equal((await h.c('POST', '/api/domains', { domain: 'zurueck.beispiel.de', ziel: '192.168.1.23:7100', schutz: 'oeffentlich' })).status, 200);
    assert.equal((await e.c('POST', '/api/spiegel/abgleichen', {})).status, 200);
    assert.ok(e.app.domains.liste().some((d) => d.domain === 'zurueck.beispiel.de'));
    assert.equal((await e.c('GET', '/api/ich')).j.ergebnis.aktiv, false);
    assert.equal((await h.c('GET', '/api/ich')).j.ergebnis.aktiv, true);
  } finally { await h.zu(); await e.zu(); }
});

test('Nach der Rückgabe meldet die Ersatz-Instanz den Wechsel – die Haupt-Instanz liest UniFi sofort neu statt erst nach 5 Minuten; Fremde dürfen das nicht', async () => {
  const h = await instanz('haupt', { tls: true }); const e = await instanz('ersatz');
  try {
    const { code } = (await h.c('POST', '/api/spiegel/code', {})).j.ergebnis;
    assert.equal((await e.c('POST', '/api/spiegel/verbinden', { code })).status, 200);
    h.app.wache.z.aktiv = { ip: '192.168.1.23', zeit: Date.now() };
    const { wechselMelden } = await import('../src/spiegel/ersatz.js');
    await wechselMelden(e.app);
    assert.equal(h.app.wache.z.aktiv, null, 'zwischengespeicherte aktive Instanz verworfen → nächster Takt liest UniFi');
    h.app.wache.z.aktiv = { ip: '192.168.1.23', zeit: Date.now() };
    const r = await h.c('POST', '/api/spiegel/wechsel', {}, { ohneSitzung: true });
    assert.equal(r.status, 401); assert.notEqual(h.app.wache.z.aktiv, null, 'ohne gültigen Schlüssel nichts');
  } finally { await h.zu(); await e.zu(); }
});

test('Koppeln von einer Oberfläche: frisch installierte Instanz wird Haupt und holt sich zuerst den Stand des Partners; der Partner wird Fail-over und meldet seine Oberfläche', async () => {
  const alt = await instanz('haupt', { tls: true }); const neu = await instanz('neu', { tls: true });
  try {
    await alt.c('POST', '/api/domains', { domain: ND, ziel: '192.168.1.23:8080', schutz: 'heimnetz' });
    await alt.c('POST', '/api/konten', { name: 'anna', passwort: 'Anna-Passwort-1', rolle: 'nutzer' });
    let r = await neu.c('POST', '/api/spiegel/partner', { rolle: 'haupt', url: alt.app.uiUrl, name: 'admin', passwort: 'falsch-falsch-1', bestaetigt: true });
    assert.equal(r.status, 400); assert.equal(r.j.fehler.details.feld, 'passwort');
    assert.equal(neu.app.domains.liste().length, 0, 'nichts passiert');
    r = await neu.c('POST', '/api/spiegel/partner', { rolle: 'haupt', url: neu.app.uiUrl, name: 'admin', passwort: 'x', bestaetigt: true });
    assert.equal(r.j.fehler.details.feld, 'url', 'eigene Adresse abgelehnt');
    r = await neu.c('POST', '/api/spiegel/partner', { rolle: 'haupt', url: alt.app.uiUrl, name: 'admin', passwort: 'haupt-Passwort-2026', bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.ergebnis, { rolle: 'haupt', partner: alt.app.uiUrl, uebernommen: 'vom Partner', konten_neu: true });
    assert.deepEqual(neu.app.domains.liste().map((x) => x.domain), [ND], 'leere Instanz hat den Stand des Partners');
    assert.ok(neu.app.konten.liste().some((k) => k.name === 'anna'));
    assert.equal(neu.app.einstellungen.lesen().rolle, 'haupt');
    const a = alt.app.einstellungen.lesen();
    assert.equal(a.rolle, 'ersatz'); assert.equal(a.spiegel.haupt_url, neu.app.uiUrl);
    assert.deepEqual(alt.app.domains.liste().map((x) => x.domain), [ND], 'Partner behält alles');
    const liste = neu.app.spiegelHaupt.liste();
    assert.equal(liste.length, 1); assert.equal(liste[0].ui_url, alt.app.uiUrl); assert.match(liste[0].ui_fingerabdruck, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    // Rollen tauschen von der Fail-over-Seite: sie wird Haupt (befüllt → nichts übernommen), die andere Fail-over
    r = await alt.c('POST', '/api/spiegel/partner', { rolle: 'haupt', url: neu.app.uiUrl, name: 'admin', passwort: 'haupt-Passwort-2026', bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ergebnis.uebernommen, null);
    assert.equal(alt.app.einstellungen.lesen().rolle, 'haupt'); assert.equal(neu.app.einstellungen.lesen().rolle, 'ersatz');
    assert.equal(neu.app.einstellungen.lesen().spiegel.haupt_url, alt.app.uiUrl);
    assert.equal(alt.app.spiegelHaupt.liste().length, 1, 'alter Eintrag desselben Partners ersetzt');
  } finally { await alt.zu(); await neu.zu(); }
});

test('Koppeln als Fail-over mit leerem Partner: der Partner bekommt zuerst den Stand von hier und wird Haupt – nichts geht verloren; leerer Stand überschreibt nie eine befüllte Instanz', async () => {
  const voll = await instanz('haupt', { tls: true }); const leer = await instanz('neu', { tls: true });
  try {
    await voll.c('POST', '/api/domains', { domain: ND, ziel: '192.168.1.23:8080', schutz: 'heimnetz' });
    let r = await voll.c('POST', '/api/spiegel/partner', { rolle: 'ersatz', url: leer.app.uiUrl, name: 'admin', passwort: 'neu-Passwort-2026', bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ergebnis.uebernommen, 'zum Partner');
    assert.deepEqual(leer.app.domains.liste().map((x) => x.domain), [ND]);
    assert.deepEqual(voll.app.domains.liste().map((x) => x.domain), [ND]);
    assert.equal(voll.app.einstellungen.lesen().rolle, 'ersatz'); assert.equal(leer.app.einstellungen.lesen().rolle, 'haupt');
    // leerer Haupt (z. B. alle Domains gelöscht oder falsch gekoppelt) → der Abgleich lässt die Domains der Fail-over-Instanz stehen
    await leer.app.domains.ersetzen([]);
    r = await voll.c('POST', '/api/spiegel/abgleichen', {});
    assert.equal(r.j.fehler.code, 'E_SPIEGEL'); assert.match(r.j.fehler.meldung, /keine Domains/);
    assert.deepEqual(voll.app.domains.liste().map((x) => x.domain), [ND]);
    // Import nur auf einer leeren Instanz
    r = await voll.c('POST', '/api/spiegel/import', { stand: {} });
    assert.equal(r.status, 400); assert.match(r.j.fehler.meldung, /schon Domains/);
  } finally { await voll.zu(); await leer.zu(); }
});

test('Lese-Code der Homepage: Stand (Rolle, Partner, Wache, Domain-Ziele) und Zugriffe nur mit Code; gilt nach dem Abgleich auch an der Fail-over-Instanz', async () => {
  const h = await instanz('haupt', { tls: true }); const e = await instanz('neu', { tls: true });
  try {
    await h.c('POST', '/api/domains', { domain: ND, ziel: 'http://192.168.1.23:8080', schutz: 'heimnetz' });
    let r = await h.c('POST', '/api/homepage/code', {});
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const code = r.j.ergebnis.code; assert.ok(code.startsWith('FAHPROXYLESE1.'));
    const k = JSON.parse(Buffer.from(code.slice('FAHPROXYLESE1.'.length), 'base64url').toString('utf8'));
    assert.equal(k.u, h.app.uiUrl); assert.match(k.f, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    assert.ok(!JSON.stringify(h.app.einstellungen.lesen()).includes(k.k), 'Schlüssel nur gehasht');
    for (let i = 0; i < 12; i++) assert.equal((await h.c('GET', '/api/homepage/stand', undefined, { ohneSitzung: true, kopf: { Authorization: 'Bearer falsch' } })).status, 401);
    r = await h.c('GET', '/api/homepage/stand', undefined, { ohneSitzung: true, kopf: { Authorization: `Bearer ${k.k}` } });
    assert.equal(r.status, 200, `nach 12 falschen Abfragen keine Sperre für den richtigen Code: ${JSON.stringify(r.j)}`);
    assert.equal(r.j.ergebnis.app, 'fah-proxy'); assert.equal(r.j.ergebnis.rolle, 'haupt'); assert.equal(r.j.ergebnis.ich.ui_url, h.app.uiUrl);
    assert.deepEqual(r.j.ergebnis.ziele, [{ host: ND, server: '192.168.1.23', port: 8080, aktiv: true }]);
    await fs.writeFile(path.join(h.d, 'caddy', 'zugriffe.log'), '{"a":1}\n{"b":2}\n');
    r = await h.c('GET', '/api/homepage/zugriffe?kennung=&ab=0', undefined, { ohneSitzung: true, kopf: { Authorization: `Bearer ${k.k}` } });
    assert.equal(r.j.ergebnis.text, '{"a":1}\n{"b":2}\n');
    // koppeln → Fail-over kennt den Code, Partner-Angaben auf beiden Seiten
    r = await e.c('POST', '/api/spiegel/partner', { rolle: 'ersatz', url: h.app.uiUrl, name: 'admin', passwort: 'haupt-Passwort-2026', bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    r = await e.c('GET', '/api/homepage/stand', undefined, { ohneSitzung: true, kopf: { Authorization: `Bearer ${k.k}` } });
    assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ergebnis.rolle, 'ersatz');
    assert.equal(r.j.ergebnis.partner.ui_url, h.app.uiUrl); assert.equal(r.j.ergebnis.partner.fingerabdruck, k.f);
    r = await h.c('GET', '/api/homepage/stand', undefined, { ohneSitzung: true, kopf: { Authorization: `Bearer ${k.k}` } });
    assert.equal(r.j.ergebnis.partner.ui_url, e.app.uiUrl);
    assert.equal((await h.c('DELETE', '/api/homepage/code')).status, 200);
    assert.equal((await h.c('GET', '/api/homepage/stand', undefined, { ohneSitzung: true, kopf: { Authorization: `Bearer ${k.k}` } })).status, 401);
  } finally { await h.zu(); await e.zu(); }
});
