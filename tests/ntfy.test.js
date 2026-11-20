// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// ntfy-Warnungen: Regeln (Ziel > 5 min weg, Zertifikat < 14 Tage), höchstens eine Nachricht je Ereignis und Stunde,
// Entwarnung nur nach einer Warnung, Zustand übersteht einen Neustart, Versand als JSON mit Token oder Benutzer:Passwort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { warnungenErmitteln, Ntfy, ntfySenden, SPERRE_MS } from '../src/status/ntfy.js';
import { Geheim } from '../src/gemeinsam/geheim.js';

const JETZT = Date.parse('2026-10-09T12:00:00Z');
const vor = (min) => new Date(JETZT - min * 60_000).toISOString();
const inTagen = (t) => new Date(JETZT + t * 86_400_000).toISOString();

test('Regeln: Ziel erst nach 5 Minuten gestört gemeldet, Zertifikat unter 14 Tagen, inaktive Domains ohne Einträge', () => {
  const domains = [
    { domain: 'a.de', ziel: 'http://192.168.1.23:1' }, { domain: 'b.de', ziel: 'http://192.168.1.23:2' },
    { domain: 'c.de', ziel: 'http://192.168.1.23:3' }, { domain: 'aus.de', ziel: 'http://192.168.1.23:4', aktiv: false },
  ];
  const status = {
    'a.de': { ok: false, fehler: 'Verbindung abgewiesen – läuft die App?', seit: vor(6) },
    'b.de': { ok: false, fehler: 'Zeitüberschreitung', seit: vor(4) },
    'c.de': { ok: true, seit: vor(60) },
    'aus.de': { ok: false, fehler: 'weg', seit: vor(60) },
  };
  const zertifikate = { 'a.de': { bis: inTagen(10) }, 'b.de': { bis: inTagen(20) }, 'c.de': { bis: null }, 'aus.de': { bis: inTagen(1) } };
  const w = Object.fromEntries(warnungenErmitteln({ domains, status, zertifikate, jetzt: JETZT }).map((x) => [x.schluessel, x]));
  assert.equal(w['ziel:a.de'].aktiv, true);
  assert.match(w['ziel:a.de'].titel, /App hinter a\.de antwortet nicht/);
  assert.match(w['ziel:a.de'].text, /Verbindung abgewiesen/);
  assert.match(w['ziel:a.de'].entwarnung.titel, /a\.de wieder erreichbar/);
  assert.equal(w['ziel:b.de'].aktiv, false, 'erst 4 Minuten');
  assert.equal(w['ziel:c.de'].aktiv, false);
  assert.equal(w['zert:a.de'].aktiv, true);
  assert.match(w['zert:a.de'].text, /10 Tage/);
  assert.equal(w['zert:b.de'].aktiv, false);
  assert.equal(w['zert:c.de'], undefined, 'ohne Zertifikat keine Regel');
  assert.ok(!Object.keys(w).some((k) => k.endsWith('aus.de')));
});

async function aufbau({ ntfy = { url: 'https://ntfy.beispiel.de', thema: 'fah', token: '' } } = {}) {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-ntfy-'));
  const geheim = await Geheim.laden(path.join(d, 'geheim.key'));
  const werte = { ntfy: { ...ntfy, token: ntfy.token ? geheim.verschluesseln(ntfy.token) : '' } };
  const einstellungen = { lesen: () => structuredClone(werte) };
  const gesendet = []; let uhr = JETZT;
  const senden = async (ziel, n) => { gesendet.push({ ziel, n }); };
  const laden = () => Ntfy.laden(d, { einstellungen, geheim, senden, jetzt: () => uhr });
  return { d, gesendet, laden, weiter: (ms) => { uhr += ms; }, zu: () => fs.rm(d, { recursive: true, force: true }) };
}

test('ohne Adresse/Thema: nichts senden, kein Fehler', async () => {
  const u = await aufbau({ ntfy: { url: '', thema: '', token: '' } });
  try {
    const n = await u.laden();
    assert.equal(n.konfiguriert(), false);
    assert.equal(await n.melden('ziel:a.de', { titel: 't', text: 'x' }), 'aus');
    assert.equal(u.gesendet.length, 0);
  } finally { await u.zu(); }
});

test('höchstens eine Nachricht je Ereignis und Stunde; Entwarnung nur nach Warnung; Zustand übersteht Neustart; Token entschlüsselt', async () => {
  const u = await aufbau({ ntfy: { url: 'https://ntfy.beispiel.de/', thema: 'fah', token: 'tk_geheim' } });
  try {
    let n = await u.laden();
    const w = { titel: 'a.de nicht erreichbar', text: 'weg', prio: 4, tags: ['warning'] };
    const e = { titel: 'a.de wieder erreichbar', text: 'da', prio: 3, tags: ['white_check_mark'] };
    assert.equal(await n.entwarnen('ziel:a.de', e), 'nichts', 'ohne vorherige Warnung keine Entwarnung');
    assert.equal(await n.melden('ziel:a.de', w), 'gesendet');
    assert.equal(u.gesendet[0].ziel.token, 'tk_geheim');
    assert.equal(u.gesendet[0].ziel.url, 'https://ntfy.beispiel.de/');
    assert.equal(await n.melden('ziel:a.de', w), 'offen');
    n = await u.laden(); // Neustart
    assert.equal(await n.melden('ziel:a.de', w), 'offen', 'nach Neustart nicht erneut');
    assert.equal(await n.entwarnen('ziel:a.de', e), 'gesendet');
    assert.equal(u.gesendet.length, 2);
    u.weiter(10 * 60_000);
    assert.equal(await n.melden('ziel:a.de', w), 'gesperrt', 'Flattern: keine zweite Warnung in derselben Stunde');
    assert.equal(await n.melden('zert:a.de', w), 'gesendet', 'anderes Ereignis zählt getrennt');
    u.weiter(SPERRE_MS);
    assert.equal(await n.melden('ziel:a.de', w), 'gesendet');
    // Abgleich: aktive melden, erholte entwarnen, verschwundene Domains still vergessen
    await n.abgleichen([{ schluessel: 'ziel:a.de', aktiv: false, entwarnung: e }]);
    assert.equal(u.gesendet.at(-1).n.titel, e.titel);
    assert.equal(await n.entwarnen('zert:a.de', e), 'nichts', 'zert:a.de war nicht in der Liste → still vergessen');
  } finally { await u.zu(); }
});

test('Versand: JSON an die Wurzel des ntfy-Servers, Token als Bearer, Benutzer:Passwort als Basic; Fehlerstatus → E_NTFY', async () => {
  const anfragen = []; let antwort = 200;
  const s = http.createServer((req, res) => { let b = ''; req.on('data', (x) => { b += x; }); req.on('end', () => { anfragen.push({ methode: req.method, pfad: req.url, auth: req.headers.authorization, typ: req.headers['content-type'], body: JSON.parse(b) }); res.writeHead(antwort); res.end('{}'); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${s.address().port}`;
  try {
    await ntfySenden({ url, thema: 'fah', token: 'tk_abc' }, { titel: 'Zertifikat läuft ab', text: 'Noch 3 Tage – bitte prüfen', prio: 5, tags: ['lock'] });
    assert.deepEqual(anfragen[0], { methode: 'POST', pfad: '/', auth: 'Bearer tk_abc', typ: 'application/json', body: { topic: 'fah', title: 'Zertifikat läuft ab', message: 'Noch 3 Tage – bitte prüfen', priority: 5, tags: ['lock'] } });
    await ntfySenden({ url: `${url}/`, thema: 'fah', token: 'fabian:pass:wort' }, { titel: 't', text: 'x' });
    assert.equal(anfragen[1].auth, `Basic ${Buffer.from('fabian:pass:wort').toString('base64')}`);
    await ntfySenden({ url, thema: 'fah', token: '' }, { titel: 't', text: 'x' });
    assert.equal(anfragen[2].auth, undefined);
    antwort = 403;
    await assert.rejects(ntfySenden({ url, thema: 'fah', token: 'tk_falsch' }, { titel: 't', text: 'x' }), (f) => f.code === 'E_NTFY' && /403/.test(f.message));
  } finally { await new Promise((r) => s.close(r)); }
});
