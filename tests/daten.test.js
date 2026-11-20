// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Datenablage: JSON atomar, Geheimnisse verschlüsselt, Domains (anlegen/ändern/löschen mit Prüfung), Einstellungen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonLesen, jsonSchreiben } from '../src/gemeinsam/dateien.js';
import { Geheim } from '../src/gemeinsam/geheim.js';
import { Domains } from '../src/daten/domains.js';
import { Einstellungen } from '../src/daten/einstellungen.js';

async function ordner() { return fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-')); }

test('JSON: fehlende Datei → Standard; schreiben ist atomar (keine .tmp-Reste) und 0600; kaputtes JSON → E_DATEN statt Überschreiben', async () => {
  const d = await ordner();
  try {
    const f = path.join(d, 'x.json');
    assert.deepEqual(await jsonLesen(f, { a: 1 }), { a: 1 });
    await jsonSchreiben(f, { b: 2 });
    assert.deepEqual(await jsonLesen(f, null), { b: 2 });
    assert.deepEqual((await fs.readdir(d)).sort(), ['x.json']);
    assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
    await fs.writeFile(f, '{kaputt');
    await assert.rejects(jsonLesen(f, {}), (e) => e.code === 'E_DATEN');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Geheim: Schlüssel wird einmal angelegt (0600), verschlüsseln ist zufällig, entschlüsseln liefert den Text; fremder Schlüssel scheitert', async () => {
  const d = await ordner();
  try {
    const g = await Geheim.laden(path.join(d, 'geheim.key'));
    assert.equal((await fs.stat(path.join(d, 'geheim.key'))).mode & 0o777, 0o600);
    const a = g.verschluesseln('Passwort!'); const b = g.verschluesseln('Passwort!');
    assert.notEqual(a, b); assert.ok(!a.includes('Passwort'));
    assert.equal(g.entschluesseln(a), 'Passwort!');
    assert.equal((await Geheim.laden(path.join(d, 'geheim.key'))).entschluesseln(b), 'Passwort!', 'derselbe Schlüssel nach Neustart');
    const fremd = await Geheim.laden(path.join(d, 'anderer.key'));
    assert.throws(() => fremd.entschluesseln(a), (e) => e.code === 'E_DATEN');
    assert.equal(g.entschluesseln(''), '');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Domains: anlegen prüft und normiert, doppelte Domain abgelehnt, ändern/löschen, Liste sortiert, Datei überlebt Neustart', async () => {
  const d = await ordner();
  try {
    const dm = await Domains.laden(d);
    const a = await dm.anlegen({ domain: 'Nextcloud.example.org', ziel: '192.168.1.23:8080', schutz: 'oeffentlich' });
    assert.match(a.id, /^d[0-9a-f]{12}$/);
    assert.equal(a.domain, 'nextcloud.example.org'); assert.equal(a.ziel, 'http://192.168.1.23:8080');
    assert.equal(a.aktiv, true); assert.equal(a.ziel_tls_pruefen, false); assert.deepEqual(a.ip_liste, []); assert.equal(a.herkunft, 'neu');
    await assert.rejects(dm.anlegen({ domain: 'nextcloud.example.org', ziel: 'http://x:1', schutz: 'oeffentlich' }), (e) => e.code === 'E_EXISTIERT' && e.details.feld === 'domain');
    await assert.rejects(dm.anlegen({ domain: 'b.de', ziel: 'http://x:1', schutz: 'geheim' }), (e) => e.code === 'E_EINGABE' && e.details.feld === 'schutz');
    await assert.rejects(dm.anlegen({ domain: 'b.de', ziel: 'http://x:1', schutz: 'ipliste', ip_liste: [] }), (e) => e.code === 'E_EINGABE' && e.details.feld === 'ip_liste');
    const b = await dm.anlegen({ domain: 'abc.de', ziel: 'https://192.168.1.23:9443', schutz: 'ipliste', ip_liste: ['1.2.3.4', '10.0.0.0/8'] });
    assert.deepEqual(b.ip_liste, ['1.2.3.4/32', '10.0.0.0/8']);
    assert.deepEqual(dm.liste().map((x) => x.domain), ['abc.de', 'nextcloud.example.org']);
    const geaendert = await dm.aendern(a.id, { schutz: 'heimnetz', aktiv: false });
    assert.equal(geaendert.schutz, 'heimnetz'); assert.equal(geaendert.aktiv, false); assert.equal(geaendert.angelegt, a.angelegt);
    await assert.rejects(dm.aendern(a.id, { domain: 'abc.de' }), (e) => e.code === 'E_EXISTIERT');
    await assert.rejects(dm.aendern('dffffffffffff', { aktiv: true }), (e) => e.code === 'E_NICHT_GEFUNDEN');
    const neu = await Domains.laden(d);
    assert.equal(neu.liste().length, 2);
    await neu.loeschen(b.id);
    assert.deepEqual(neu.liste().map((x) => x.domain), ['nextcloud.example.org']);
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Einstellungen: Standardwerte (Heimnetz + VPN, Modus test), setzen prüft Netze/E-Mail/Modus und behält den Rest', async () => {
  const d = await ordner();
  try {
    const e = await Einstellungen.laden(d);
    const s = e.lesen();
    assert.deepEqual(s.heimnetz, ['192.168.1.0/24', '192.168.5.0/24']); assert.equal(s.modus, 'test'); assert.equal(s.rolle, 'haupt');
    await e.setzen({ heimnetz: ['192.168.1.0/24', '192.168.5.0/24', '172.16.0.1'], acme_email: 'ich@example.org' });
    assert.deepEqual(e.lesen().heimnetz, ['192.168.1.0/24', '192.168.5.0/24', '172.16.0.1/32']);
    await assert.rejects(e.setzen({ heimnetz: ['x'] }), (x) => x.code === 'E_EINGABE' && x.details.feld === 'heimnetz');
    await assert.rejects(e.setzen({ acme_email: 'keine-mail' }), (x) => x.code === 'E_EINGABE' && x.details.feld === 'acme_email');
    await assert.rejects(e.setzen({ modus: 'gefaehrlich' }), (x) => x.code === 'E_EINGABE' && x.details.feld === 'modus');
    assert.equal((await Einstellungen.laden(d)).lesen().acme_email, 'ich@example.org');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('Domains: HSTS standardmäßig an; Pfad-Regeln geprüft (nur sichere Zeichen, höchstens 20, Ziel gültig)', async () => {
  const d = await ordner();
  try {
    const dm = await Domains.laden(d);
    const a = await dm.anlegen({ domain: 'nc.beispiel.de', ziel: '192.168.1.23:8080', schutz: 'oeffentlich', pfade: [{ pfad: '/push/', ziel: '192.168.1.23:7867', praefix_entfernen: true }, { pfad: '/shell', ziel: 'http://192.168.1.23:3000' }] });
    assert.equal(a.hsts, true);
    assert.deepEqual(a.pfade, [{ pfad: '/push/', ziel: 'http://192.168.1.23:7867', praefix_entfernen: true }, { pfad: '/shell', ziel: 'http://192.168.1.23:3000', praefix_entfernen: false }]);
    assert.equal((await dm.aendern(a.id, { hsts: false })).hsts, false);
    for (const pfad of ['push', '/a b', '/x{', '/*', '/x;', '']) await assert.rejects(dm.anlegen({ domain: 'x.beispiel.de', ziel: 'x:1', pfade: [{ pfad, ziel: 'x:2' }] }), (e) => e.code === 'E_EINGABE' && e.details.feld === 'pfade');
    await assert.rejects(dm.anlegen({ domain: 'x.beispiel.de', ziel: 'x:1', pfade: [{ pfad: '/a', ziel: 'x y' }] }), (e) => e.code === 'E_EINGABE' && e.details.feld === 'pfade');
    await assert.rejects(dm.anlegen({ domain: 'x.beispiel.de', ziel: 'x:1', pfade: Array.from({ length: 21 }, (_, i) => ({ pfad: `/p${i}`, ziel: 'x:2' })) }), (e) => e.details.feld === 'pfade');
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});
