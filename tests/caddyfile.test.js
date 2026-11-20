// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Caddyfile-Erzeugung (reine Funktion) und Zertifikate lesen.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { caddyfileErzeugen } from '../src/caddy/caddyfile.js';
import { zertifikatLesen, zertifikateFinden } from '../src/caddy/zertifikate.js';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const JETZT = new Date('2026-10-09T12:00:00Z');
const TAG = 86400000;
const PFADE = { zertifikate: '/fahproxy/zertifikate', protokoll: '/fahproxy/zugriffe.log', intern: 'fah-proxy:8081' };
const EINST = { heimnetz: ['192.168.1.0/24', '192.168.5.0/24'], acme_email: 'ich@beispiel.de', modus: 'test' };
const dom = (domain, weiteres = {}) => ({ id: 'd' + domain.length.toString(16).padStart(12, '0'), domain, ziel: 'http://192.168.1.23:8080', schutz: 'oeffentlich', ip_liste: [], aktiv: true, ziel_tls_pruefen: false, ...weiteres });
const zert = (tage) => ({ bis: new Date(JETZT.getTime() + tage * TAG) });
/** Site-Block einer Domain aus dem Text schneiden. */
function block(text, domain) {
  const i = text.indexOf(`\n${domain} {\n`); assert.ok(i >= 0, `Block ${domain} fehlt`);
  return text.slice(i + 1, text.indexOf('\n}\n', i) + 2);
}

test('Kopf: Admin nur intern (origins caddy:2019), E-Mail, nur HTTP/1+2, Modus test ohne Zertifikats-Automatik, Zugriffsprotokoll als JSON', () => {
  const { text } = caddyfileErzeugen({ domains: [], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT });
  assert.match(text, /\n\tadmin caddy:2019 \{\n\t\torigins caddy:2019\n\t\}/, 'Admin nur an der eigenen Adresse im Compose-Netz – sonst prüft Caddy den Host-Kopf nicht');
  assert.match(text, /\n\temail ich@beispiel\.de\n/);
  assert.match(text, /\n\tauto_https disable_certs\n/);
  assert.match(text, /protocols h1 h2/);
  assert.match(text, /\(fah_protokoll\) \{[\s\S]*output file \/fahproxy\/zugriffe\.log[\s\S]*mode 0644[\s\S]*format json/, 'Protokoll für FAH-Proxy lesbar');
  const live = caddyfileErzeugen({ domains: [], einstellungen: { ...EINST, modus: 'live', acme_email: '' }, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }).text;
  assert.doesNotMatch(live, /auto_https/); assert.doesNotMatch(live, /\temail/);
});

test('Öffentlich: Weiterleitung zum Ziel; übernommenes Zertifikat im Test immer, live nur bei > 30 Tagen; ohne Zertifikat im Test ein Hinweis', () => {
  const d = [dom('nc.beispiel.de'), dom('alt.beispiel.de'), dom('ohne.beispiel.de')];
  const z = new Map([['nc.beispiel.de', zert(60)], ['alt.beispiel.de', zert(10)]]);
  const t = caddyfileErzeugen({ domains: d, einstellungen: EINST, zertifikate: z, pfade: PFADE, jetzt: JETZT });
  const nc = block(t.text, 'nc.beispiel.de');
  assert.match(nc, /\timport fah_protokoll\n/);
  assert.match(nc, /\ttls \/fahproxy\/zertifikate\/nc\.beispiel\.de\/fullchain\.pem \/fahproxy\/zertifikate\/nc\.beispiel\.de\/privkey\.pem\n/);
  assert.match(nc, /reverse_proxy http:\/\/192\.168\.1\.23:8080/);
  assert.match(block(t.text, 'alt.beispiel.de'), /\ttls /, 'Test: auch bald ablaufende Zertifikate nutzen');
  assert.ok(t.hinweise.some((h) => h.domain === 'ohne.beispiel.de' && /kein Zertifikat/i.test(h.text)));
  const live = caddyfileErzeugen({ domains: d, einstellungen: { ...EINST, modus: 'live' }, zertifikate: z, pfade: PFADE, jetzt: JETZT });
  assert.match(block(live.text, 'nc.beispiel.de'), /\ttls /);
  assert.doesNotMatch(block(live.text, 'alt.beispiel.de'), /\ttls /, 'live: < 30 Tage → Caddy holt selbst');
  assert.ok(!live.hinweise.some((h) => h.domain === 'ohne.beispiel.de'), 'live: Caddy holt das Zertifikat');
});

test('Schutz Heimnetz und IP-Liste: Fremde bekommen 403, Weiterleitung nur im handle danach', () => {
  const t = caddyfileErzeugen({ domains: [dom('a.beispiel.de', { schutz: 'heimnetz' }), dom('b.beispiel.de', { schutz: 'ipliste', ip_liste: ['1.2.3.4/32', '10.0.0.0/8'] })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }).text;
  const a = block(t, 'a.beispiel.de');
  assert.match(a, /@fah_fremd not remote_ip 192\.168\.1\.0\/24 192\.168\.5\.0\/24\n/);
  assert.match(a, /handle @fah_fremd \{\n\t\trespond "[^"\n]+" 403\n\t\}/);
  assert.match(a, /handle \{\n\t\treverse_proxy http:\/\/192\.168\.1\.23:8080\n\t\}/);
  assert.match(block(t, 'b.beispiel.de'), /@fah_fremd not remote_ip 1\.2\.3\.4\/32 10\.0\.0\.0\/8\n/);
});

test('Schutz Anmeldung: /_fah/* an FAH-Proxy, sonst forward_auth vor der Weiterleitung', () => {
  const t = caddyfileErzeugen({ domains: [dom('c.beispiel.de', { schutz: 'anmeldung' })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }).text;
  const c = block(t, 'c.beispiel.de');
  assert.match(c, /handle \/_fah\/\* \{\n\t\treverse_proxy fah-proxy:8081\n\t\}/);
  assert.match(c, /forward_auth fah-proxy:8081 \{\n\t\t\turi \/_fah\/pruefen\n\t\t\tcopy_headers X-FAH-Nutzer\n\t\t\}\n\t\treverse_proxy http:\/\/192\.168\.1\.23:8080/);
});

test('HTTPS-Ziel ohne Zertifikatsprüfung, Ziel mit Pfad, abgeschaltete Domain fehlt, Reihenfolge stabil', () => {
  const t = caddyfileErzeugen({ domains: [dom('z.beispiel.de', { ziel: 'https://192.168.1.23:9443' }), dom('p.beispiel.de', { ziel: 'http://192.168.1.23:8080/app/' }), dom('aus.beispiel.de', { aktiv: false }), dom('s.beispiel.de', { ziel: 'https://intern.beispiel.de:443', ziel_tls_pruefen: true })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }).text;
  assert.match(block(t, 'z.beispiel.de'), /\treverse_proxy https:\/\/192\.168\.1\.23:9443 \{\n\t\ttransport http \{\n\t\t\ttls_insecure_skip_verify\n\t\t\}\n\t\}/);
  assert.doesNotMatch(block(t, 's.beispiel.de'), /tls_insecure_skip_verify/);
  assert.match(block(t, 'p.beispiel.de'), /\trewrite \* \/app\{uri\}\n\treverse_proxy http:\/\/192\.168\.1\.23:8080\n/);
  assert.ok(!t.includes('aus.beispiel.de'));
  assert.ok(t.indexOf('p.beispiel.de {') < t.indexOf('s.beispiel.de {') && t.indexOf('s.beispiel.de {') < t.indexOf('z.beispiel.de {'), 'alphabetisch');
});

test('Einschleusung: ein ungeprüft gespeicherter Eintrag mit Steuerzeichen wird erneut geprüft und abgelehnt', () => {
  const boese = [dom('x.de', { ziel: 'http://192.168.1.23:80 {\n}\nrespond 200' })];
  assert.throws(() => caddyfileErzeugen({ domains: boese, einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }), (e) => e.code === 'E_EINGABE');
  assert.throws(() => caddyfileErzeugen({ domains: [dom('x.de\n:80')], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }), (e) => e.code === 'E_EINGABE');
  assert.throws(() => caddyfileErzeugen({ domains: [dom('x.de', { schutz: 'ipliste', ip_liste: ['1.2.3.4 } respond 200'] })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }), (e) => e.code === 'E_EINGABE');
});

test('Zertifikate: Namen und Ablauf aus PEM; Ordner je Domain, nur passende Zertifikate (SAN deckt die Domain), kaputte übersprungen', async () => {
  const pem = await fs.readFile(path.join(FIX, 'test-fullchain.pem'), 'utf8');
  const z = zertifikatLesen(pem);
  assert.deepEqual(z.namen, ['nextcloud.beispiel.de', 'www.beispiel.de']);
  assert.ok(z.bis instanceof Date && z.bis.getUTCFullYear() >= 2036);
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'fahproxy-z-'));
  try {
    for (const name of ['nextcloud.beispiel.de', 'falsch.beispiel.de']) {
      await fs.mkdir(path.join(d, name));
      await fs.copyFile(path.join(FIX, 'test-fullchain.pem'), path.join(d, name, 'fullchain.pem'));
      await fs.copyFile(path.join(FIX, 'test-privkey.pem'), path.join(d, name, 'privkey.pem'));
    }
    await fs.mkdir(path.join(d, 'kaputt.beispiel.de')); await fs.writeFile(path.join(d, 'kaputt.beispiel.de', 'fullchain.pem'), 'kein pem');
    const m = await zertifikateFinden(d);
    assert.deepEqual([...m.keys()], ['nextcloud.beispiel.de']);
    assert.equal(m.get('nextcloud.beispiel.de').bis.getTime(), z.bis.getTime());
  } finally { await fs.rm(d, { recursive: true, force: true }); }
});

test('HSTS je Domain und Pfad-Regeln: handle_path entfernt das Präfix (Nextcloud /push/), handle behält es (/shell); auch hinter Schutzstufen', () => {
  const t = caddyfileErzeugen({ domains: [
    dom('nc.beispiel.de', { hsts: true, pfade: [{ pfad: '/push/', ziel: 'http://192.168.1.23:7867', praefix_entfernen: true }] }),
    dom('ug.beispiel.de', { hsts: false, schutz: 'heimnetz', ziel: 'https://192.168.1.23:9443', pfade: [{ pfad: '/shell', ziel: 'http://192.168.1.23:3000', praefix_entfernen: false }] }),
  ], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }).text;
  const nc = block(t, 'nc.beispiel.de');
  assert.match(nc, /\theader Strict-Transport-Security "max-age=63072000"\n/);
  assert.match(nc, /\thandle_path \/push\/\* \{\n\t\treverse_proxy http:\/\/192\.168\.1\.23:7867\n\t\}\n\thandle \{\n\t\treverse_proxy http:\/\/192\.168\.1\.23:8080\n\t\}/);
  const ug = block(t, 'ug.beispiel.de');
  assert.doesNotMatch(ug, /Strict-Transport-Security/);
  assert.match(ug, /\thandle \{\n\t\thandle \/shell\* \{\n\t\t\treverse_proxy http:\/\/192\.168\.1\.23:3000\n\t\t\}\n\t\thandle \{\n\t\t\treverse_proxy https:\/\/192\.168\.1\.23:9443 \{/);
  assert.throws(() => caddyfileErzeugen({ domains: [dom('x.de', { pfade: [{ pfad: '/a {', ziel: 'http://x:1' }] })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT }), (e) => e.code === 'E_EINGABE');
});

test('Wartungsseite: jede Domain zeigt bei 502/503/504 (Ziel weg) eine freundliche Seite statt eines Fehlers; ohne geschweifte Klammern im Text (Caddy-Platzhalter)', () => {
  const { text } = caddyfileErzeugen({ domains: [dom('a.beispiel.de'), dom('b.beispiel.de', { schutz: 'heimnetz' })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT });
  const schnipsel = /\n\(fah_wartung\) \{\n([\s\S]*?)\n\}\n/.exec(text);
  assert.ok(schnipsel, 'Schnipsel (fah_wartung) fehlt');
  assert.match(schnipsel[1], /^\thandle_errors 502 503 504 \{$/m);
  assert.match(schnipsel[1], /header Content-Type "text\/html; charset=utf-8"/);
  assert.match(schnipsel[1], /respond <<SEITE\n[\s\S]*Wartung[\s\S]*\n\t\tSEITE 503/);
  const seite = /respond <<SEITE\n([\s\S]*?)\n\t\tSEITE 503/.exec(schnipsel[1])[1];
  assert.ok(!/[{}]/.test(seite.replace(/\{http\.request\.host\}/g, '')), 'außer {http.request.host} keine Klammern im Seitentext');
  for (const d of ['a.beispiel.de', 'b.beispiel.de']) assert.match(text, new RegExp(`${d.replace(/\./g, '\\.')} \\{\\n\\timport fah_protokoll\\n\\timport fah_wartung\\n`));
});

test('Lebenszeichen für die Fail-over-Wache: /_fah/lebt beantwortet Caddy selbst mit 204, ohne Protokollzeile, in jeder Domain', () => {
  const { text } = caddyfileErzeugen({ domains: [dom('a.beispiel.de'), dom('b.beispiel.de', { schutz: 'anmeldung' })], einstellungen: EINST, zertifikate: new Map(), pfade: PFADE, jetzt: JETZT });
  assert.match(text, /\n\(fah_lebt\) \{\n\thandle \/_fah\/lebt \{\n\t\tlog_skip\n\t\trespond 204\n\t\}\n\}\n/);
  for (const d of ['a.beispiel.de', 'b.beispiel.de']) assert.match(text, new RegExp(`${d.replace(/\./g, '\\.')} \\{\\n\\timport fah_protokoll\\n\\timport fah_wartung\\n\\timport fah_lebt\\n`));
});

test('Sperrseite: nur im Live-Betrieb, mit Abfrage beim Adblocker, nur aus dem Heimnetz', () => {
  const einstellungen = { modus: 'live', heimnetz: ['192.168.1.0/24', '192.168.5.0/24'], acme_email: '', sperrseite: { an: true } };
  const pfade = { ...PFADE, sperrseite: 'http://192.168.1.29:8053' };
  const { text } = caddyfileErzeugen({ domains: [], einstellungen, zertifikate: new Map(), pfade });
  assert.match(text, /on_demand_tls \{\n\t\task http:\/\/192\.168\.1\.29:8053\/api\/sperrseite\/pruefe\n\t\}/);
  assert.match(text, /https:\/\/ \{\n\ttls \{\n\t\tissuer internal\n\t\ton_demand\n\t\}/);
  assert.match(text, /not remote_ip 192\.168\.1\.0\/24 192\.168\.5\.0\/24/);
  assert.match(text, /header_up X-Sperr-Domain \{host\}/);
  assert.doesNotMatch(caddyfileErzeugen({ domains: [], einstellungen: { ...einstellungen, sperrseite: { an: false } }, zertifikate: new Map(), pfade }).text, /on_demand|sperrseite/);
  // Die Ersatz-Instanz läuft im Testbetrieb und liefert die Seite genauso
  assert.match(caddyfileErzeugen({ domains: [], einstellungen: { ...einstellungen, modus: 'test' }, zertifikate: new Map(), pfade }).text, /on_demand_tls/);
  assert.throws(() => caddyfileErzeugen({ domains: [], einstellungen, zertifikate: new Map(), pfade: { ...PFADE, sperrseite: 'http://x y:1' } }), /Sperrseite/);
});
