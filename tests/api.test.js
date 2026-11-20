// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// API der Oberfläche: Domains anlegen/ändern/löschen (Caddy lädt sofort; lehnt Caddy ab, wird die Änderung
// zurückgenommen), Übersicht mit Status/Zertifikat/Zugriffen, Einstellungen, Protokoll; keine NPM-Anbindung mehr.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { App } from '../src/app.js';


async function caddyAttrappe() {
  const geladen = [];
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (d) => { b += d; }); req.on('end', () => { if (b.includes('verboten.beispiel.de')) { res.writeHead(400); res.end('{"error":"abgelehnt"}'); return; } geladen.push(b); res.writeHead(200); res.end(); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, geladen, zu: () => new Promise((r) => s.close(r)) };
}

async function aufbau() {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-api-'));
  const caddy = await caddyAttrappe();
  const app = await App.starten({ daten: d, caddyUrl: caddy.url, caddyDaten: path.join(d, 'caddy-daten'), version: 'test', hintergrund: false });
  app.pruefen443 = async () => false; // nie echt ins Netz
  const s = http.createServer(app.web.handler()); await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const glas = new Map();
  const c = async (methode, pfad, body) => {
    const h = {}; if (glas.size) h.Cookie = [...glas].map(([n, v]) => `${n}=${v}`).join('; ');
    if (glas.has('fp_csrf')) h['X-FP-CSRF'] = glas.get('fp_csrf');
    const daten = body === undefined ? undefined : JSON.stringify(body);
    if (daten) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(daten); }
    return new Promise((ok, nein) => { const r = http.request({ host: '127.0.0.1', port: s.address().port, path: pfad, method: methode, headers: h }, (res) => { for (const k of res.headers['set-cookie'] || []) { const [nv] = k.split(';'); const i = nv.indexOf('='); glas.set(nv.slice(0, i), decodeURIComponent(nv.slice(i + 1))); } let t = ''; res.on('data', (x) => { t += x; }); res.on('end', () => ok({ status: res.statusCode, j: JSON.parse(t || 'null') })); }); r.on('error', nein); r.end(daten); });
  };
  await c('POST', '/api/anmelden', { name: 'admin', passwort: 'admin' });
  await c('POST', '/api/passwort', { neu: 'Sehr-Geheim-2026' });
  return { d, caddy, app, c, zu: async () => { app.stoppen(); await new Promise((r) => s.close(r)); await caddy.zu(); await fs.rm(d, { recursive: true, force: true }); } };
}

test('Domain anlegen → Caddy lädt sofort; ändern, löschen; Caddy lehnt ab → Änderung zurückgenommen, Fehler sichtbar; Protokoll', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/api/domains', { domain: 'nc.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'heimnetz' });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    const id = r.j.ergebnis.domain.id;
    assert.ok(u.caddy.geladen.at(-1).includes('nc.beispiel.de {'));
    assert.ok(u.caddy.geladen.at(-1).includes('not remote_ip 192.168.1.0/24 192.168.5.0/24'));
    r = await u.c('PUT', `/api/domains/${id}`, { schutz: 'oeffentlich' });
    assert.equal(r.j.ergebnis.domain.schutz, 'oeffentlich');
    assert.ok(!u.caddy.geladen.at(-1).includes('not remote_ip'));
    // Caddy lehnt ab (Attrappe: verboten.beispiel.de) → nicht gespeichert
    r = await u.c('POST', '/api/domains', { domain: 'verboten.beispiel.de', ziel: '192.168.1.23:1', schutz: 'oeffentlich' });
    assert.equal(r.status, 502); assert.equal(r.j.fehler.code, 'E_CADDY');
    assert.ok(!(await u.c('GET', '/api/uebersicht')).j.ergebnis.domains.some((x) => x.domain === 'verboten.beispiel.de'));
    const alt = (await u.c('GET', '/api/uebersicht')).j.ergebnis.domains.find((x) => x.id === id);
    r = await u.c('PUT', `/api/domains/${id}`, { domain: 'verboten.beispiel.de' });
    assert.equal(r.status, 502);
    assert.equal((await u.c('GET', '/api/uebersicht')).j.ergebnis.domains.find((x) => x.id === id).domain, alt.domain, 'Umbenennung zurückgenommen');
    r = await u.c('POST', '/api/domains', { domain: 'kaputt', ziel: 'x', schutz: 'oeffentlich' });
    assert.equal(r.status, 400); assert.equal(r.j.fehler.details.feld, 'domain');
    assert.equal((await u.c('DELETE', `/api/domains/${id}`)).status, 200);
    assert.ok(!u.caddy.geladen.at(-1).includes('nc.beispiel.de {'));
    const p = (await u.c('GET', '/api/protokoll')).j.ergebnis;
    assert.deepEqual(p.slice(0, 3).map((x) => x.aktion), ['domain.geloescht', 'domain.geaendert', 'domain.angelegt']);
    assert.equal(p[0].wer, 'admin');
  } finally { await u.zu(); }
});

test('Übersicht: Domains mit Status/Zertifikat/Zugriffen, Basis-Domains und bekannte Ziele für den Anlege-Dialog, Modus; Einstellungen ändern lädt Caddy neu', async () => {
  const u = await aufbau();
  try {
    await u.c('POST', '/api/domains', { domain: 'nc.example.org', ziel: '192.168.1.23:8080', schutz: 'oeffentlich' });
    await u.c('POST', '/api/domains', { domain: 'vault.example.org', ziel: '192.168.1.23:8222', schutz: 'heimnetz' });
    await fs.mkdir(path.join(u.d, 'zertifikate', 'nc.example.org'), { recursive: true });
    const ue = (await u.c('GET', '/api/uebersicht')).j.ergebnis;
    assert.equal(ue.modus, 'test');
    assert.deepEqual(ue.basisdomains, ['example.org']);
    assert.deepEqual(ue.ziele.map((z) => z.ziel).sort(), ['http://192.168.1.23:8080', 'http://192.168.1.23:8222']);
    const nc = ue.domains.find((x) => x.domain === 'nc.example.org');
    assert.ok('status' in nc && 'zertifikat' in nc && 'zugriffe' in nc);
    assert.equal(ue.caddy.ok, true);
    const e = await u.c('PUT', '/api/einstellungen', { heimnetz: ['192.168.1.0/24'] });
    assert.equal(e.status, 200);
    assert.ok(u.caddy.geladen.at(-1).includes('not remote_ip 192.168.1.0/24\n'));
    const g = (await u.c('GET', '/api/einstellungen')).j.ergebnis;
    assert.deepEqual(g.heimnetz, ['192.168.1.0/24']); assert.ok(!('npm_vorhanden' in g) && !('npm_pfad' in g), 'keine NPM-Angaben mehr');
    assert.equal((await u.c('PUT', '/api/einstellungen', { modus: 'live' })).status, 400, 'Modus nur über „Umschalten“');
  } finally { await u.zu(); }
});

test('NPM ist raus: Übernahme, Vergleich und „Zurück zum NPM“ gibt es nicht mehr', async () => {
  const u = await aufbau();
  try {
    for (const [m, p] of [['GET', '/api/npm/vorschau'], ['POST', '/api/npm/uebernehmen'], ['POST', '/api/vergleich'], ['POST', '/api/umschalten/zurueck']]) {
      assert.equal((await u.c(m, p, m === 'POST' ? { bestaetigt: true } : undefined)).status, 404, `${m} ${p}`);
    }
  } finally { await u.zu(); }
});

test('Konten: anlegen, ändern, sperren beendet Sitzungen, Passwort setzen, 2FA einrichten/aus, löschen; eigenes Konto geschützt; Protokoll', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/api/konten', { name: 'Anna', passwort: 'Anna-Passwort-1', rolle: 'nutzer', domains: ['geheim.beispiel.de'] });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.deepEqual(r.j.ergebnis, { name: 'anna', rolle: 'nutzer', pflichtwechsel: false, totp: false, domains: ['geheim.beispiel.de'], gesperrt: false });
    assert.equal((await u.c('POST', '/api/konten', { name: 'anna', passwort: 'Anna-Passwort-1' })).j.fehler.code, 'E_EXISTIERT');
    r = await u.c('GET', '/api/konten');
    assert.deepEqual(r.j.ergebnis.map((k) => k.name), ['admin', 'anna']);
    assert.ok(!JSON.stringify(r.j).includes('hash'), 'keine Hashes in der Antwort');
    // Sitzung von anna (FAH-Anmeldung) endet beim Sperren
    const sitzungen = await u.app.web.sitzungenBereit;
    const s = await sitzungen.erstellen({ name: 'anna', rolle: 'nutzer', art: 'fah', domain: 'geheim.beispiel.de', dauer_ms: 60_000 });
    r = await u.c('PUT', '/api/konten/anna', { domains: [], gesperrt: true });
    assert.equal(r.j.ergebnis.gesperrt, true); assert.deepEqual(r.j.ergebnis.domains, []);
    assert.equal(sitzungen.holen(s.id, { art: 'fah', domain: 'geheim.beispiel.de' }), null);
    r = await u.c('POST', '/api/konten/anna/passwort', { neu: 'kurz' });
    assert.equal(r.j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('POST', '/api/konten/anna/passwort', { neu: 'Anna-Neu-Passwort' })).status, 200);
    await u.app.konten.aendern('anna', { gesperrt: false });
    assert.equal((await u.app.konten.pruefen('anna', 'Anna-Neu-Passwort')).name, 'anna');
    // 2FA für anna einrichten (Admin übergibt den QR-Code)
    r = await u.c('POST', '/api/konten/anna/2fa');
    assert.match(r.j.ergebnis.uri, /^otpauth:\/\/totp\//);
    const { totp } = await import('../src/totp.js');
    assert.equal((await u.c('POST', '/api/konten/anna/2fa/aktivieren', { code: '000000' })).j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('POST', '/api/konten/anna/2fa/aktivieren', { code: totp(r.j.ergebnis.geheimnis) })).status, 200);
    assert.equal((await u.c('GET', '/api/konten')).j.ergebnis.find((k) => k.name === 'anna').totp, true);
    assert.equal((await u.c('DELETE', '/api/konten/anna/2fa')).status, 200);
    assert.equal((await u.c('GET', '/api/konten')).j.ergebnis.find((k) => k.name === 'anna').totp, false);
    // eigenes Konto: nicht löschen, nicht sperren, nicht herabstufen, Passwort nur mit dem bisherigen
    assert.equal((await u.c('DELETE', '/api/konten/admin')).j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('PUT', '/api/konten/admin', { gesperrt: true })).j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('PUT', '/api/konten/admin', { rolle: 'nutzer' })).j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('POST', '/api/konten/admin/passwort', { neu: 'Anders-Geheim-2026' })).j.fehler.code, 'E_EINGABE');
    assert.equal((await u.c('DELETE', '/api/konten/anna')).status, 200);
    assert.equal((await u.c('DELETE', '/api/konten/gibtsnicht')).status, 404);
    const p = (await u.c('GET', '/api/protokoll')).j.ergebnis.map((e) => e.aktion);
    for (const a of ['konto.angelegt', 'konto.geaendert', 'konto.geloescht']) assert.ok(p.includes(a), a);
    assert.ok(!JSON.stringify((await u.c('GET', '/api/protokoll')).j).includes('Anna-Neu-Passwort'));
  } finally { await u.zu(); }
});

test('ntfy: Token nur verschlüsselt gespeichert und nie ausgegeben, Testnachricht, Warnung bei gestörtem Ziel über die App', async () => {
  const u = await aufbau();
  const empfangen = [];
  const ntfy = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { empfangen.push({ auth: req.headers.authorization, body: JSON.parse(b) }); res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${ntfy.address().port}`;
    assert.equal((await u.c('POST', '/api/ntfy/test')).j.fehler.code, 'E_EINGABE', 'ohne Einstellungen');
    let r = await u.c('PUT', '/api/einstellungen', { ntfy: { url, thema: 'fah-proxy', token: 'tk_geheim123' } });
    assert.equal(r.status, 200, JSON.stringify(r.j));
    assert.equal(r.j.ergebnis.ntfy.token, ''); assert.equal(r.j.ergebnis.ntfy.token_gesetzt, true);
    assert.ok(!(await fs.readFile(path.join(u.d, 'einstellungen.json'), 'utf8')).includes('tk_geheim123'), 'Token verschlüsselt');
    assert.equal((await u.c('POST', '/api/ntfy/test')).status, 200);
    assert.equal(empfangen[0].auth, 'Bearer tk_geheim123');
    assert.equal(empfangen[0].body.topic, 'fah-proxy');
    // ohne Token-Feld bleibt der Token, token_loeschen entfernt ihn
    r = await u.c('PUT', '/api/einstellungen', { ntfy: { url, thema: 'fah-proxy-2' } });
    assert.equal(r.j.ergebnis.ntfy.token_gesetzt, true); assert.equal(r.j.ergebnis.ntfy.thema, 'fah-proxy-2');
    // Warnung über die App: Ziel seit 6 Minuten gestört
    await u.c('POST', '/api/domains', { domain: 'weg.beispiel.de', ziel: '192.168.1.23:9', schutz: 'oeffentlich' });
    u.app.pruefer.zustand.set('weg.beispiel.de', { ok: false, code: null, ms: 0, fehler: 'Verbindung abgewiesen – läuft die App?', geprueft: new Date().toISOString(), seit: new Date(Date.now() - 6 * 60_000).toISOString() });
    await u.app.warnen();
    assert.match(empfangen.at(-1).body.title, /App hinter weg\.beispiel\.de antwortet nicht/);
    r = await u.c('PUT', '/api/einstellungen', { ntfy: { token_loeschen: true } });
    assert.equal(r.j.ergebnis.ntfy.token_gesetzt, false);
    assert.ok(!JSON.stringify((await u.c('GET', '/api/protokoll')).j).includes('tk_geheim123'));
  } finally { await new Promise((r) => ntfy.close(r)); await u.zu(); }
});

test('Rubrik je Domain: getrimmt, höchstens 40 Zeichen, bleibt bei anderen Änderungen; Übersicht liefert die vorhandenen Rubriken für die Auswahl', async () => {
  const u = await aufbau();
  try {
    let r = await u.c('POST', '/api/domains', { domain: 'a.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'oeffentlich', rubrik: '  Medien  ' });
    assert.equal(r.j.ergebnis.domain.rubrik, 'Medien');
    const id = r.j.ergebnis.domain.id;
    await u.c('POST', '/api/domains', { domain: 'b.beispiel.de', ziel: '192.168.1.23:8081', schutz: 'oeffentlich', rubrik: 'Netzwerk' });
    await u.c('POST', '/api/domains', { domain: 'c.beispiel.de', ziel: '192.168.1.23:8082', schutz: 'oeffentlich' });
    r = await u.c('PUT', `/api/domains/${id}`, { ziel: '192.168.1.23:9090' });
    assert.equal(r.j.ergebnis.domain.rubrik, 'Medien', 'bleibt bei anderen Änderungen');
    r = await u.c('PUT', `/api/domains/${id}`, { rubrik: 'x'.repeat(60) });
    assert.equal(r.j.ergebnis.domain.rubrik.length, 40);
    r = await u.c('GET', '/api/uebersicht');
    assert.deepEqual(r.j.ergebnis.rubriken, ['Netzwerk', 'x'.repeat(40)]);
    assert.equal(r.j.ergebnis.domains.find((d) => d.domain === 'c.beispiel.de').rubrik, '');
  } finally { await u.zu(); }
});

test('Ohne UniFi (anderer Router): nach Bestätigung live bzw. zurück in Bereitschaft; mit eingetragener UniFi-Konsole nicht', async () => {
  const u = await aufbau();
  try {
    assert.equal((await u.c('POST', '/api/umschalten/ohne-unifi', {})).j.fehler.code, 'E_EINGABE', 'ohne Bestätigung nichts');
    let r = await u.c('POST', '/api/umschalten/ohne-unifi', { bestaetigt: true });
    assert.equal(r.status, 200, JSON.stringify(r.j)); assert.equal(r.j.ergebnis.modus, 'live');
    assert.equal(u.app.einstellungen.lesen().modus, 'live');
    r = await u.c('POST', '/api/umschalten/ohne-unifi', { bestaetigt: true, live: false });
    assert.equal(r.j.ergebnis.modus, 'test'); assert.equal(u.app.einstellungen.lesen().modus, 'test');
    const p = (await u.c('GET', '/api/protokoll')).j.ergebnis.map((e) => e.aktion);
    assert.ok(p.includes('umschalten.ohne_unifi'));
    await u.c('PUT', '/api/einstellungen', { unifi: { url: 'https://127.0.0.1:9', benutzer: 'a', passwort: 'b' } });
    r = await u.c('POST', '/api/umschalten/ohne-unifi', { bestaetigt: true });
    assert.equal(r.j.fehler.code, 'E_EINGABE'); assert.equal(u.app.einstellungen.lesen().modus, 'test');
  } finally { await u.zu(); }
});
