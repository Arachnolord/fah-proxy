// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eingabeprüfungen: Domain, Ziel, CIDR, IP-in-Netz. Alles, was hier durchgeht, landet später im Caddyfile – deshalb
// werden Einschleusungsversuche (Leerzeichen, Klammern, Zeilenumbrüche, Anführungszeichen) ausdrücklich abgelehnt.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { domainPruefen, zielPruefen, cidrPruefen, ipInNetz } from '../src/gemeinsam/pruefen.js';

const wirft = (fn, feld) => assert.throws(fn, (e) => e.code === 'E_EINGABE' && (!feld || e.details.feld === feld));

test('Domain: gültige Namen (klein, Punycode, Bindestrich), Normierung', () => {
  assert.equal(domainPruefen('Nextcloud.example.org'), 'nextcloud.example.org');
  assert.equal(domainPruefen('  fah-nas.example.org  '), 'fah-nas.example.org');
  assert.equal(domainPruefen('xn--mnchen-3ya.de'), 'xn--mnchen-3ya.de');
  assert.equal(domainPruefen('a.b'), 'a.b');
});

test('Domain: abgelehnt – Platzhalter, Leerzeichen, Klammern, Zeilenumbruch, einzelnes Label, Bindestrich am Rand, zu lang', () => {
  for (const d of ['*.example.org', 'a b.de', 'x.de {', 'x.de\nrespond 200', 'localhost', '-x.de', 'x-.de', 'x..de', '', 'ä.de', 'x.de#', `${'a'.repeat(64)}.de`, `${'a.'.repeat(130)}de`, 'x.de:443', 'http://x.de']) wirft(() => domainPruefen(d), 'domain');
});

test('Ziel: http/https mit Host und Port, Standardports, IPv6, Pfad; Normierung', () => {
  assert.deepEqual(zielPruefen('http://192.168.1.23:8080'), { scheme: 'http', host: '192.168.1.23', port: 8080, pfad: '', url: 'http://192.168.1.23:8080' });
  assert.deepEqual(zielPruefen('192.168.1.23:3456'), { scheme: 'http', host: '192.168.1.23', port: 3456, pfad: '', url: 'http://192.168.1.23:3456' }, 'ohne Schema = http');
  assert.equal(zielPruefen('https://192.168.1.23:9443').url, 'https://192.168.1.23:9443');
  assert.equal(zielPruefen('https://nas.local').port, 443);
  assert.equal(zielPruefen('http://NAS.local').port, 80);
  assert.equal(zielPruefen('http://NAS.local').host, 'nas.local');
  assert.equal(zielPruefen('http://[fd00::5]:81').host, '[fd00::5]');
  assert.equal(zielPruefen('http://192.168.1.23:8080/app/').pfad, '/app/');
});

test('Ziel: abgelehnt – Leerzeichen, Klammern, Anführungszeichen, Zugangsdaten, falsches Schema, Port außerhalb, Zeilenumbruch', () => {
  for (const z of ['http://x {', 'http://x:80 respond', 'http://u:p@x:80', 'ftp://x:21', 'http://x:0', 'http://x:65536', 'http://x:80\nfoo', 'http://"x":80', 'http://x:80/a b', 'http://x:80/{a}', '', 'http://', 'http://x:abc']) wirft(() => zielPruefen(z), 'ziel');
});

test('CIDR: IPv4/IPv6, einzelne Adresse = /32 bzw. /128, Normierung; abgelehnt: /33, Unsinn, Leerzeichen', () => {
  assert.equal(cidrPruefen('192.168.1.0/24'), '192.168.1.0/24');
  assert.equal(cidrPruefen(' 192.168.5.7 '), '192.168.5.7/32');
  assert.equal(cidrPruefen('fd00::/8'), 'fd00::/8');
  assert.equal(cidrPruefen('2001:db8::1'), '2001:db8::1/128');
  for (const c of ['10.0.0.0/33', '10.0.0/24', '300.1.1.1', 'abc', '10.0.0.0/24 10.0.1.0/24', 'fd00::/129', '']) wirft(() => cidrPruefen(c), 'netz');
});

test('IP in Netz: IPv4, IPv6, IPv4-gemappt, Grenzen', () => {
  assert.equal(ipInNetz('192.168.1.1', '192.168.1.0/24'), true);
  assert.equal(ipInNetz('192.168.2.1', '192.168.1.0/24'), false);
  assert.equal(ipInNetz('::ffff:192.168.5.20', '192.168.5.0/24'), true);
  assert.equal(ipInNetz('fd00::1', 'fd00::/8'), true);
  assert.equal(ipInNetz('fe80::1', 'fd00::/8'), false);
  assert.equal(ipInNetz('1.2.3.4', '0.0.0.0/0'), true);
  assert.equal(ipInNetz('1.2.3.4', 'fd00::/8'), false);
});
