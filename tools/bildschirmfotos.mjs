// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bildschirmfotos für docs/screenshots/ (README „So sieht es aus“) – und dabei eine Bedienprobe der Oberfläche.
//
//   node tools/bildschirmfotos.mjs              Fotos neu machen (nach jeder sichtbaren Änderung)
//   node tools/bildschirmfotos.mjs --nur-probe  nur bedienen und prüfen, keine Fotos schreiben
//   … --breiten /tmp/ordner                     zusätzlich jede Ansicht schmal (720) und breit (2200) dorthin – zum Ansehen
//
// Nie die echte Instanz: Eine Wegwerf-Instanz (die App wie in den Tests, ohne Takte) mit ERFUNDENEN Daten läuft aus
// einem Temp-Ordner auf 127.0.0.1 – Domains *.heim.example.org, Ziele 192.168.1.x, Konto max.mustermann. Nichts geht ins
// Netz: Caddy ist eine Attrappe, UniFi-Konsole, Zielprüfung, Zertifikate und Zugriffe liefern feste Demo-Werte, die
// Fail-over-Instanz gibt es nur als Eintrag. Der Browser ist Chromium headless (Playwright-Zwischenspeicher, sonst
// FAHPROXY_CHROME), gedrosselt mit taskpolicy -b, bedient über das DevTools-Protokoll (Node ≥ 22: WebSocket eingebaut).
// Bedient wird wie von Hand: Anmelden, Domain anlegen, Liste/Kacheln, Domain bearbeiten, alle Ansichten – jede Stufe
// wird geprüft, dazu schmal (720 px) und breit (2200 px) ohne seitliches Überlaufen.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { App } from '../src/app.js';

const HIER = path.dirname(fileURLToPath(import.meta.url));
const WURZEL = path.join(HIER, '..');
const ZIEL = path.join(WURZEL, 'docs', 'screenshots');
const NUR_PROBE = process.argv.includes('--nur-probe');
const BREITEN = process.argv.includes('--breiten') ? process.argv[process.argv.indexOf('--breiten') + 1] : null;
const BREITE = 1440, HOEHE = 900, SKALA = 1;
const warte = (ms) => new Promise((r) => setTimeout(r, ms));
let fehler = 0;
const pruefe = (ok, was) => { console.log((ok ? '  ✔ ' : '  ✖ ') + was); if (!ok) fehler++; };

// ---------------------------------------------------------------------------------------------------------------
// 1. Demo-Daten (alles erfunden)

const HOST = '192.168.1.20', PARTNER = '192.168.1.21';
const ADMIN_PW = 'Demo-Passwort-2026';
const MIN = 60_000, STD = 60 * MIN, TAG = 24 * STD;
const vor = (ms) => new Date(Date.now() - ms).toISOString();
const DOMAINS = [
  { domain: 'cloud.heim.example.org', ziel: 'http://192.168.1.20:11000', rubrik: 'Cloud', schutz: 'oeffentlich', notiz: 'Dateien, Kalender, Kontakte' },
  { domain: 'fotos.heim.example.org', ziel: 'http://192.168.1.21:2283', rubrik: 'Medien', schutz: 'oeffentlich' },
  { domain: 'medien.heim.example.org', ziel: 'http://192.168.1.20:8096', rubrik: 'Medien', schutz: 'oeffentlich' },
  { domain: 'haus.heim.example.org', ziel: 'http://192.168.1.30:8123', rubrik: 'Smart Home', schutz: 'heimnetz' },
  { domain: 'kamera.heim.example.org', ziel: 'http://192.168.1.40:8080', rubrik: 'Smart Home', schutz: 'ipliste', ip_liste: ['203.0.113.7'] },
  { domain: 'git.heim.example.org', ziel: 'http://192.168.1.10:3300', rubrik: 'Werkzeuge', schutz: 'heimnetz' },
  { domain: 'nas.heim.example.org', ziel: 'https://192.168.1.10:8443', rubrik: 'Werkzeuge', schutz: 'anmeldung' },
  { domain: 'status.heim.example.org', ziel: 'http://192.168.1.10:3001', rubrik: 'Werkzeuge', schutz: 'oeffentlich' },
];
// die eine Domain, die die Bedienprobe über den Dialog anlegt
const NEU = { sub: 'wiki', domain: 'wiki.heim.example.org', ziel: 'http://192.168.1.22:3000', rubrik: 'Werkzeuge' };
// Antwortzeit (ms), Zertifikat gültig noch (Tage), Anfragen 24 h – kamera ist gestört
const WERTE = {
  'cloud.heim.example.org': [12, 71, 1843, 12], 'fotos.heim.example.org': [18, 64, 962, 4], 'medien.heim.example.org': [9, 64, 2310, 0],
  'haus.heim.example.org': [21, 52, 488, 2], 'kamera.heim.example.org': [null, 33, 0, 0], 'git.heim.example.org': [7, 80, 214, 1],
  'nas.heim.example.org': [15, 45, 57, 3], 'status.heim.example.org': [6, 71, 1290, 0], 'wiki.heim.example.org': [11, 89, 0, 0],
};
const GESTOERT_SEIT = vor(40 * MIN);
const PROTOKOLL = [
  ...DOMAINS.filter((d) => d.domain !== 'kamera.heim.example.org').map((d, i) => [6 * TAG + 30 * MIN - i * 2 * MIN, 'admin', 'domain.angelegt', d.domain, { ziel: d.ziel, schutz: d.schutz }]),
  [6 * TAG, 'admin', 'umschalten.uebernommen', null, { felder: [`Neue Regel „FAH-Proxy HTTP“: Port 80 → ${HOST}:28080.`, `Neue Regel „FAH-Proxy HTTPS“: Port 443 → ${HOST}:28443.`] }],
  [6 * TAG - 9 * MIN, 'spiegel', 'spiegel.gekoppelt', 'Fail-over (NAS)', { ziel: PARTNER }],
  [5 * TAG, 'admin', 'konto.angelegt', 'max.mustermann', { felder: ['Rolle nutzer'] }],
  [4 * TAG, 'system', 'ziel.gestoert', 'fotos.heim.example.org', { fehler: 'App vermutlich gestoppt oder deaktiviert (Port abgewiesen)' }],
  [4 * TAG - 6 * MIN, 'system', 'ziel.wieder_erreichbar', 'fotos.heim.example.org', null],
  [2 * TAG, 'admin', 'domain.angelegt', 'kamera.heim.example.org', { ziel: 'http://192.168.1.40:8080', schutz: 'ipliste' }],
  [2 * TAG - 3 * MIN, 'admin', 'einstellungen.geaendert', null, { felder: ['ntfy'] }],
  [1 * TAG, 'admin', 'domain.geaendert', 'git.heim.example.org', { vorher: { domain: 'git.heim.example.org', ziel: 'http://192.168.1.10:3000', schutz: 'heimnetz', aktiv: true } }],
  [40 * MIN, 'system', 'ziel.gestoert', 'kamera.heim.example.org', { fehler: 'Gerät der App nicht erreichbar – ausgeschaltet oder offline?' }],
];

/** Caddy-Attrappe: nimmt jede Konfiguration an (POST /load), damit Anlegen und Ändern durchgehen. */
async function caddyAttrappe() {
  const s = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end(); }); });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${s.address().port}`, zu: () => new Promise((r) => s.close(r)) };
}

/** Platzhalter-Konsole: FAH-Proxy ist schon umgeschaltet (80/443 → diese Instanz), DNS *.heim.example.org zeigt hierher. */
const UNIFI = {
  gesehen: '5A:1F:9C:3E:77:D2:08:B4:61:CE:93:2A:F0:4D:18:A7:6B:E5:3C:90:12:7F:D8:44:AB:69:05:C1:3E:F2:87:5D',
  async weiterleitungen() {
    const r = (id, name, dst, fwd_port, fwd = HOST, proto = 'tcp') => ({ _id: id, name, enabled: true, pfwd_interface: 'wan', src: 'any', dst_port: dst, fwd, fwd_port, proto, log: false });
    return [r('pf1', 'FAH-Proxy HTTP', '80', '28080'), r('pf2', 'FAH-Proxy HTTPS', '443', '28443'), r('pf3', 'WireGuard', '51820', '51820', '192.168.1.1', 'udp')];
  },
  async dnsEintraege() { return [{ _id: 'dns1', key: '*.heim.example.org', record_type: 'A', value: HOST, enabled: true }]; },
  async firewallRegeln() { return []; },
};

async function demoBauen(daten, caddyUrl) {
  // Protokoll-Vorgeschichte der letzten Tage (vor dem Start, damit die Zeiten stimmen)
  const zeilen = PROTOKOLL.sort((a, b) => b[0] - a[0]).map(([alter, wer, aktion, ziel, details]) => JSON.stringify({ zeit: vor(alter), wer, aktion, ziel, ...(details ? { details } : {}) }));
  await mkdir(daten, { recursive: true });
  await writeFile(path.join(daten, 'protokoll.jsonl'), zeilen.join('\n') + '\n', { mode: 0o600 });

  const version = readFileSync(path.join(WURZEL, 'BUILD_VERSION'), 'utf8').trim();
  const app = await App.starten({ daten, caddyUrl, caddyDaten: path.join(daten, 'caddy-daten'), version, hintergrund: false, testPorts: { http: 28080, https: 28443 }, hostIp: HOST });

  // nichts ins Netz: Lebend-Prüfung, Zielprüfung, UniFi, Zertifikate und Zugriffe aus den Demo-Werten
  app.pruefen443 = async ({ host }) => host === HOST || host === PARTNER;
  app.unifiClient = () => UNIFI;
  const zustand = app.pruefer.zustand;
  app.pruefer.runde = async () => {};
  app.pruefer.stand = () => {
    for (const d of app.domains.liste()) {
      if (zustand.has(d.domain)) continue;
      const [ms] = WERTE[d.domain] || [10];
      zustand.set(d.domain, ms === null
        ? { ok: false, code: null, ms: 5000, fehler: 'Gerät der App nicht erreichbar – ausgeschaltet oder offline?', geprueft: vor(20_000), seit: GESTOERT_SEIT }
        : { ok: true, code: 200, ms, fehler: null, geprueft: vor(20_000), seit: vor(6 * TAG) });
    }
    return Object.fromEntries(zustand);
  };
  app.zertifikate = async () => Object.fromEntries(app.domains.liste().map((d) => {
    const bis = new Date(Date.now() + (WERTE[d.domain] || [0, 90])[1] * TAG).toISOString();
    return [d.domain, { uebernommen: null, caddy: bis, aktiv: 'caddy', bis }];
  }));
  app.zugriffe.zusammenfassung = () => Object.fromEntries(Object.entries(WERTE).map(([d, w]) => [d, { anfragen: w[2], f4xx: w[3], f5xx: 0 }]));

  // Einstellungen: live über UniFi, Fail-over an, Warnungen per ntfy
  await app.einstellungen.setzen({
    modus: 'live', acme_email: 'max.mustermann@example.com', failover: { an: true },
    ntfy: { url: 'https://ntfy.example.org', thema: 'fah-proxy', token: '' },
    unifi: { url: 'https://192.168.1.1', benutzer: 'fah-proxy', passwort: app.geheim.verschluesseln('Demo-Passwort'), ziel_ip: HOST, fingerabdruck: UNIFI.gesehen },
  });
  // Konten: admin mit eigenem Passwort, ein Nutzer für die FAH-Anmeldung
  await app.konten.passwortSetzen('admin', ADMIN_PW);
  await app.konten.anlegen({ name: 'max.mustermann', passwort: 'Demo-Passwort-Max', rolle: 'nutzer', domains: ['nas.heim.example.org'] });
  // Domains
  for (const d of DOMAINS) await app.domains.anlegen({ ...d, herkunft: 'neu' });
  await app.anwender.anwenden();
  // gekoppelte Fail-over-Instanz (nur der Eintrag) und Wache: diese Instanz bedient das Internet, der Partner antwortet
  app.spiegelHaupt.ersatz.push({ id: 'e5f1c2a9b7d3', name: 'Fail-over (NAS)', ip: PARTNER, hash: crypto.randomBytes(32).toString('hex'),
    gekoppelt: vor(6 * TAG - 9 * MIN), letzter_abruf: vor(2 * MIN), ui: { url: `https://${PARTNER}:28181`, fingerabdruck: 'C3:8E:41:0B:D9:72:5F:A6:1D:E4:93:08:7B:2C:F5:60:9A:3D:B1:47:E8:0C:56:2F:D7:94:6A:13:B8:C0:75:E9' },
    ziel: { ip: PARTNER, http: 28080, https: 28443 } });
  Object.assign(app.wache.z, { aktiv: { ip: HOST, zeit: Date.now() }, partner_ok: true, selbst_ok: true, gesund_seit: Date.now() - 6 * TAG, meldung: 'Diese Instanz bedient das Internet.' });
  return app;
}

// ---------------------------------------------------------------------------------------------------------------
// 2. Browser (Chromium headless über das DevTools-Protokoll)

function chromeFinden() {
  if (process.env.FAHPROXY_CHROME) return { bin: process.env.FAHPROXY_CHROME, args: ['--headless=new'] };
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const ordner = existsSync(cache) ? readdirSync(cache).sort().reverse() : [];
  for (const d of ordner.filter((n) => n.startsWith('chromium_headless_shell-'))) {
    const p = path.join(cache, d, 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell');
    if (existsSync(p)) return { bin: p, args: [] };
  }
  for (const d of ordner.filter((n) => n.startsWith('chromium-'))) {
    const p = path.join(cache, d, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (existsSync(p)) return { bin: p, args: ['--headless=new'] };
  }
  throw new Error('Kein Chromium gefunden – FAHPROXY_CHROME=<Pfad zu einem Chrome> setzen');
}

async function browserStarten(profil) {
  const { bin, args } = chromeFinden();
  const kind = spawn('/usr/sbin/taskpolicy', ['-b', bin, ...args, '--use-mock-keychain', '--remote-debugging-port=0', `--user-data-dir=${profil}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--mute-audio', '--disable-gpu', '--lang=de-DE', 'about:blank'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  const adresse = await new Promise((ok, nein) => {
    let puffer = '';
    const zeit = setTimeout(() => nein(new Error('Chromium meldet sich nicht')), 20_000);
    kind.stderr.on('data', (d) => { puffer += d; const m = puffer.match(/DevTools listening on (ws:\/\/\S+)/); if (m) { clearTimeout(zeit); ok(m[1]); } });
    kind.on('exit', (c) => nein(new Error('Chromium beendet: ' + c)));
  });
  const ws = new WebSocket(adresse);
  await new Promise((ok, nein) => { ws.onopen = ok; ws.onerror = nein; });
  let n = 0; const offen = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && offen.has(d.id)) { const p = offen.get(d.id); offen.delete(d.id); d.error ? p.nein(new Error(d.error.message)) : p.ok(d.result); } };
  const senden = (method, params = {}, sessionId) => { const id = ++n; ws.send(JSON.stringify({ id, method, params, sessionId })); return new Promise((ok, nein) => offen.set(id, { ok, nein })); };
  const { targetId } = await senden('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await senden('Target.attachToTarget', { targetId, flatten: true });
  const s = (method, params) => senden(method, params, sessionId);
  await s('Page.enable'); await s('Runtime.enable');
  // dunkles Farbschema wie am Rechner des Betreibers (die Oberfläche folgt prefers-color-scheme)
  await s('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  const seite = {
    async js(ausdruck) {
      const r = await s('Runtime.evaluate', { expression: ausdruck, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error('JS: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    },
    async bis(ausdruck, was, ms = 15_000) {
      const ende = Date.now() + ms;
      for (;;) { if (await seite.js(ausdruck).catch(() => false)) return true; if (Date.now() > ende) throw new Error('Zeitüberschreitung: ' + was); await warte(100); }
    },
    async groesse(w, h = HOEHE, mobil = false) { await s('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: SKALA, mobile: mobil }); await warte(250); },
    async gehe(url, bereit, was) { await s('Page.navigate', { url }); await seite.bis(bereit, was); await warte(400); },
    async foto(name, ordner = ZIEL) {
      if (NUR_PROBE && ordner === ZIEL) return;
      // Fokusrahmen und Meldungen (z. B. „… ist angelegt“) gehören nicht ins Bild
      await seite.js("document.activeElement && document.activeElement.blur && document.activeElement.blur(), document.getElementById('meldungen').replaceChildren(), true");
      await warte(250);
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(ordner, name), Buffer.from(data, 'base64'));
      console.log('  📷 ' + (ordner === ZIEL ? 'docs/screenshots/' : ordner + '/') + name);
    },
  };
  return { seite, ende: async () => { try { ws.close(); } catch { /* weg */ } kind.kill('SIGTERM'); await new Promise((r) => { kind.once('exit', r); setTimeout(r, 3000); }); } };
}

// Im Browser: Knopf nach Text klicken, Feld füllen (wie Tippen), Text der Seite
const JS_HILFEN = `
window.__knopf = (text, wurzel = document) => { const b = [...wurzel.querySelectorAll('button')].find((x) => x.textContent.trim() === text && !x.disabled); if (!b) return false; b.click(); return true; };
window.__fuellen = (el, wert) => { el.focus(); el.value = wert; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; };
window.__text = () => document.body.innerText;
window.__ueberlauf = () => document.documentElement.scrollWidth > window.innerWidth + 1;
window.__einzeilig = (td) => { const r = document.createRange(); r.selectNodeContents(td); return r.getClientRects().length <= 1; };
true`;
const ansichtBereit = (titel) => `(() => { const h = document.querySelector('#inhalt h1'); return !!h && h.textContent.trim() === ${JSON.stringify(titel)} && !document.querySelector('#inhalt .leise')?.textContent.startsWith('Lese '); })()`;

// ---------------------------------------------------------------------------------------------------------------
// 3. Ablauf

async function hauptlauf() {
  const basis = await mkdtemp(path.join(os.tmpdir(), 'fah-proxy-demo-'));
  const profil = await mkdtemp(path.join(os.tmpdir(), 'fah-proxy-chrome-'));
  let caddy, app, server, browser;
  try {
    console.log('→ Demo-Daten in ' + basis);
    caddy = await caddyAttrappe();
    app = await demoBauen(path.join(basis, 'daten'), caddy.url);
    server = http.createServer(app.web.handler());
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/`;
    console.log('→ Probe-Instanz ' + url);
    if (!NUR_PROBE) await mkdir(ZIEL, { recursive: true });

    browser = await browserStarten(profil);
    const p = browser.seite;
    await p.groesse(BREITE);

    console.log('Anmelden');
    await p.gehe(url, "!!document.querySelector('form.anmelden input[type=password]')", 'Anmeldeseite');
    await p.js(JS_HILFEN);
    await p.js(`(() => { const f = document.querySelector('form.anmelden'); __fuellen(f.querySelector('input[autocomplete=username]'), 'admin'); __fuellen(f.querySelector('input[type=password]'), ${JSON.stringify(ADMIN_PW)}); f.requestSubmit(); return true; })()`);
    await p.bis(`!document.querySelector('.kopf').hidden && document.querySelectorAll('.domain-kopf').length >= ${DOMAINS.length}`, 'Übersicht nach dem Anmelden');
    await warte(400);
    pruefe((await p.js("document.getElementById('modus').textContent")).startsWith('Live'), 'Kopf zeigt „Live“');
    const t1 = await p.js('__text()');
    pruefe(/8\s*aktive Domains/.test(t1) && /7\s*erreichbar/.test(t1) && /1\s*gestört/.test(t1), 'Kennzahlen: 8 aktiv, 7 erreichbar, 1 gestört');
    pruefe(t1.includes('kamera.heim.example.org') && t1.includes('Gerät der App nicht erreichbar'), 'gestörte Domain mit Grund sichtbar');
    // Kacheln (Standard) – höher aufnehmen, damit mehrere Rubriken zu sehen sind
    await p.groesse(BREITE, 1350);
    await p.foto('1-uebersicht.png');
    await p.groesse(BREITE);

    console.log('Domain anlegen (Dialog)');
    pruefe(await p.js("__knopf('+ Domain anlegen')"), 'Knopf „+ Domain anlegen“');
    await p.bis("!!document.querySelector('.dialog input[placeholder=\"z. B. nextcloud\"]')", 'Dialog „Domain anlegen“');
    await p.js(`(() => { const d = document.querySelector('.dialog');
      __fuellen(d.querySelector('input[placeholder="z. B. nextcloud"]'), ${JSON.stringify(NEU.sub)});
      __fuellen(d.querySelector('input[placeholder="http://192.168.1.23:8080"]'), ${JSON.stringify(NEU.ziel)});
      __fuellen(d.querySelector('[data-feld="rubrik"] input'), ${JSON.stringify(NEU.rubrik)});
      d.querySelector('input[type=radio][value="heimnetz"]').click(); return true; })()`);
    pruefe(await p.js("document.querySelector('.dialog select').value === 'heim.example.org'"), 'Basis-Domain heim.example.org vorgewählt');
    pruefe(await p.js("__knopf('Anlegen', document.querySelector('.dialog'))"), 'Knopf „Anlegen“');
    await p.bis(`!document.querySelector('.dialog') && document.body.innerText.includes(${JSON.stringify(NEU.domain)})`, 'neue Domain in der Übersicht');
    pruefe(true, `${NEU.domain} angelegt und sichtbar`);
    const neu = app.domains.liste().find((d) => d.domain === NEU.domain);
    pruefe(neu && neu.ziel === NEU.ziel && neu.schutz === 'heimnetz' && neu.rubrik === NEU.rubrik, 'gespeichert mit Ziel, Schutz „Nur Heimnetz + VPN“ und Rubrik');

    console.log('Liste');
    pruefe(await p.js("__knopf('Liste')"), 'Umschalter „Liste“');
    await p.bis("document.querySelectorAll('#inhalt table tbody tr').length >= 9", 'Listenansicht');
    await warte(300);
    await p.foto('2-liste.png');

    console.log('Domain bearbeiten');
    pruefe(await p.js("(() => { const z = [...document.querySelectorAll('#inhalt tbody tr')].find((r) => r.textContent.includes('cloud.heim.example.org')); return !!z && __knopf('Bearbeiten', z); })()"), '„Bearbeiten“ bei cloud.heim.example.org');
    await p.bis("[...document.querySelectorAll('.dialog h2')].some((h) => h.textContent.includes('cloud.heim.example.org bearbeiten'))", 'Dialog „bearbeiten“');
    pruefe(await p.js("document.querySelector('.dialog input[type=radio][value=\"oeffentlich\"]').checked"), 'Schutz „Öffentlich“ ist gewählt');
    await p.foto('3-domain-bearbeiten.png');
    await p.js("__knopf('✕', document.querySelector('.dialog'))");
    await p.bis("!document.querySelector('.dialog')", 'Dialog zu');
    pruefe(await p.js("__knopf('Kacheln')"), 'zurück zu „Kacheln“');
    await p.bis("document.querySelectorAll('.domain-kopf').length >= 9", 'Kachelansicht');

    console.log('Einstellungen');
    await p.gehe(url + '#/einstellungen', `${ansichtBereit('Einstellungen')} && document.body.innerText.includes('Schutzstufen') && document.body.innerText.includes('Fail-over (NAS)')`, 'Einstellungen');
    await p.js(JS_HILFEN);
    const t4 = await p.js('__text()');
    pruefe(t4.includes('Rolle: Haupt-Instanz') && t4.includes('Nur Heimnetz + VPN'), 'Rolle und Schutzstufen sichtbar');
    await p.groesse(BREITE, 1300);
    await p.foto('4-einstellungen.png');
    await p.groesse(BREITE);

    console.log('Protokoll');
    await p.gehe(url + '#/protokoll', `${ansichtBereit('Protokoll')} && document.querySelectorAll('#inhalt tbody tr').length >= 10`, 'Protokoll');
    await p.js(JS_HILFEN);
    pruefe(await p.js(`(() => { const z = document.querySelector('#inhalt tbody tr'); return !!z && z.textContent.includes(${JSON.stringify(NEU.domain)}) && z.textContent.includes('Domain angelegt') && z.textContent.includes('admin'); })()`), 'neueste Zeile: Domain angelegt von admin');
    pruefe(await p.js("[...document.querySelectorAll('#inhalt tbody tr')].every((z) => __einzeilig(z.children[0]) && __einzeilig(z.children[3]))"), 'Zeit und Domain je Zeile ohne Umbruch');
    await p.foto('5-protokoll.png');

    console.log('Umschalten');
    await p.gehe(url + '#/umschalten', `${ansichtBereit('Umschalten')} && document.body.innerText.includes('Vorher prüfen')`, 'Umschalten');
    await p.js(JS_HILFEN);
    const t6 = await p.js('__text()');
    pruefe(t6.includes('Diese Instanz ist live'), 'Stand „Diese Instanz ist live“');
    pruefe(t6.includes(`Ersatz-Instanz ${PARTNER}: antwortet`), 'Fail-over-Partner antwortet');
    pruefe(t6.includes('UniFi-Konsole verbunden') && t6.includes('Alle Domains haben ein Zertifikat'), 'Checkliste: UniFi verbunden, alle Zertifikate da');
    pruefe(!t6.includes('UniFi:'), 'keine UniFi-Fehlermeldung');
    await p.foto('6-umschalten.png');

    console.log('Schmal und breit');
    for (const [ansicht, titel] of [['uebersicht', 'Übersicht'], ['umschalten', 'Umschalten'], ['einstellungen', 'Einstellungen'], ['protokoll', 'Protokoll'], ['hilfe', 'Hilfe']]) {
      for (const w of [720, 2200]) {
        await p.groesse(w);
        await p.gehe(`${url}#/${ansicht}`, ansichtBereit(titel), titel);
        await p.js(JS_HILFEN);
        pruefe(!(await p.js('__ueberlauf()')), `${titel} bei ${w} px ohne seitliches Überlaufen`);
        if (BREITEN) { await mkdir(BREITEN, { recursive: true }); await p.foto(`${ansicht}-${w}.png`, BREITEN); }
      }
    }

    console.log('Handy');
    await p.groesse(390, 844, true);
    await p.gehe(url + '#/uebersicht', `${ansichtBereit('Übersicht')} && document.querySelectorAll('.domain-kopf').length >= 9`, 'Übersicht am Handy');
    await p.js(JS_HILFEN);
    pruefe(!(await p.js('__ueberlauf()')), 'Handy (390 px) ohne seitliches Überlaufen');
    await p.foto('7-handy.png');
  } finally {
    if (browser) await browser.ende();
    if (server) await new Promise((r) => server.close(r));
    if (app) app.stoppen();
    if (caddy) await caddy.zu();
    await rm(basis, { recursive: true, force: true });
    await rm(profil, { recursive: true, force: true });
  }
}

hauptlauf().then(() => {
  console.log(fehler ? `\n✖ ${fehler} Prüfung(en) fehlgeschlagen` : '\n✔ Bedienprobe bestanden' + (NUR_PROBE ? '' : ', Fotos in docs/screenshots/'));
  process.exit(fehler ? 1 : 0);
}).catch((e) => { console.error('\n✖ ' + e.message); process.exit(1); });
