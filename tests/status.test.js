// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Status: Ziel erreichbar? (HTTP-Antwort < 500 = erreichbar), Zugriffe aus dem Caddy-JSON-Protokoll (24 h je Domain,
// 4xx/5xx), Caddy-verwaltete Zertifikate (Ablauf).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zielErreichbar, Pruefer } from '../src/status/pruefer.js';
import { Zugriffe } from '../src/status/zugriffe.js';
import { verwalteteZertifikate } from '../src/caddy/zertifikate.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

async function server(status) {
  const s = http.createServer((req, res) => { res.writeHead(status); res.end('x'); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, zu: () => new Promise((r) => s.close(r)) };
}

test('Ziel erreichbar: 200/401/404 ja, 502/503 nein (App kaputt), abgewiesen und Zeitüberschreitung nein, mit Antwortzeit', async () => {
  for (const [code, ok] of [[200, true], [401, true], [404, true], [503, false]]) {
    const s = await server(code);
    try { const r = await zielErreichbar(s.url); assert.equal(r.ok, ok, String(code)); assert.equal(r.code, code); assert.ok(r.ms >= 0); } finally { await s.zu(); }
  }
  const weg = await zielErreichbar('http://127.0.0.1:9', { zeitlimit_ms: 1500 });
  assert.equal(weg.ok, false); assert.match(weg.fehler, /^App vermutlich gestoppt oder deaktiviert/, 'verständlich: die App, nicht FAH-Proxy');
  const stumm = http.createServer(() => {}); await new Promise((r) => stumm.listen(0, '127.0.0.1', r));
  try { const r = await zielErreichbar(`http://127.0.0.1:${stumm.address().port}`, { zeitlimit_ms: 300 }); assert.equal(r.ok, false); assert.match(r.fehler, /^App antwortet nicht \(\d+ s ohne Antwort\)$/); } finally { stumm.closeAllConnections(); await new Promise((r) => stumm.close(r)); }
});

test('Prüfer: prüft aktive Domains, merkt „seit wann“ der Zustand gilt, meldet Wechsel', async () => {
  const s = await server(200);
  try {
    const wechsel = [];
    const domains = [{ domain: 'a.beispiel.de', ziel: s.url, aktiv: true }, { domain: 'b.beispiel.de', ziel: 'http://127.0.0.1:9', aktiv: true }, { domain: 'c.beispiel.de', ziel: s.url, aktiv: false }];
    const p = new Pruefer({ domains: () => domains, zeitlimit_ms: 1500, beiWechsel: (d, alt, neu) => wechsel.push([d, alt && alt.ok, neu.ok]) });
    await p.runde();
    const st = p.stand();
    assert.equal(st['a.beispiel.de'].ok, true); assert.equal(st['b.beispiel.de'].ok, false); assert.equal(st['c.beispiel.de'], undefined);
    const seit = st['a.beispiel.de'].seit;
    await p.runde();
    assert.equal(p.stand()['a.beispiel.de'].seit, seit, 'Zustand unverändert → seit bleibt');
    assert.deepEqual(wechsel.map((w) => w[0]).sort(), ['a.beispiel.de', 'b.beispiel.de'], 'nur die erste Feststellung zählt als Wechsel');
  } finally { await s.zu(); }
});

test('Zugriffe: Caddy-JSON-Zeilen je Domain und Stunde, 4xx/5xx, nur letzte 24 h, kaputte Zeilen übersprungen; Datei nachlesen und Rotation erkennen', async () => {
  const jetzt = Date.parse('2026-10-09T12:30:00Z');
  const zeile = (host, status, ts) => JSON.stringify({ level: 'info', ts: ts / 1000, logger: 'http.log.access.log0', msg: 'handled request', request: { remote_ip: '1.2.3.4', host, method: 'GET', uri: '/' }, status, duration: 0.01 });
  const z = new Zugriffe({ jetzt: () => jetzt });
  z.zeilen([zeile('a.beispiel.de', 200, jetzt - 60000), zeile('a.beispiel.de', 404, jetzt - 120000), zeile('a.beispiel.de', 502, jetzt - 3600000), zeile('b.beispiel.de', 200, jetzt - 25 * 3600000), 'kaputt', zeile('A.Beispiel.de:443', 200, jetzt - 1000)]);
  assert.deepEqual(z.zusammenfassung(), { 'a.beispiel.de': { anfragen: 4, f4xx: 1, f5xx: 1 } });
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-z-'));
  try {
    const datei = path.join(d, 'zugriffe.log');
    await fs.writeFile(datei, zeile('c.beispiel.de', 200, jetzt - 1000) + '\n');
    const z2 = new Zugriffe({ jetzt: () => jetzt });
    await z2.nachlesen(datei);
    await fs.appendFile(datei, zeile('c.beispiel.de', 500, jetzt - 500) + '\n' + zeile('c.beispiel.de', 200, jetzt));
    await z2.nachlesen(datei);
    assert.deepEqual(z2.zusammenfassung()['c.beispiel.de'], { anfragen: 2, f4xx: 0, f5xx: 1 }, 'unvollständige letzte Zeile wartet');
    await fs.writeFile(datei, zeile('c.beispiel.de', 200, jetzt) + '\n'); // rotiert (kleiner)
    await z2.nachlesen(datei);
    assert.equal(z2.zusammenfassung()['c.beispiel.de'].anfragen, 3);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Caddy-verwaltete Zertifikate: Ablauf je Domain aus dem Caddy-Datenordner', async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-cv-'));
  try {
    const o = path.join(d, 'caddy', 'certificates', 'acme-v02.api.letsencrypt.org-directory', 'nextcloud.beispiel.de');
    await fs.mkdir(o, { recursive: true });
    await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(o, 'nextcloud.beispiel.de.crt'));
    const m = await verwalteteZertifikate(d);
    assert.equal(m.get('nextcloud.beispiel.de').bis.getUTCFullYear(), 2036);
    assert.equal((await verwalteteZertifikate('/gibt/es/nicht')).size, 0);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
