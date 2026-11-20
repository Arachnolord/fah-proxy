// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Verdrahtung: Daten, Konten, Caddy-Anwender, Prüfer, Zugriffe, Web + API. Ohne `hintergrund` (Tests) laufen keine
// Takte. Pfade so, wie Caddy sie im eigenen Container sieht (CADDY_PFADE) – im fah-proxy-Container liegt dasselbe unter
// <daten>/caddy und <daten>/zertifikate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Geheim } from './gemeinsam/geheim.js';
import { Fehler } from './gemeinsam/fehler.js';
import { UnifiClient } from './unifi/client.js';
import { SpiegelHaupt } from './spiegel/haupt.js';
import { abgleichen as spiegelAbgleichen, spiegelWarnung, zugriffeHolen, ABGLEICH_MS } from './spiegel/ersatz.js';
import { Wache, PRUEF_MS } from './spiegel/wache.js';
import { aktivWechseln } from './unifi/ablauf.js';
import { Domains } from './daten/domains.js';
import { Einstellungen } from './daten/einstellungen.js';
import { Konten } from './daten/konten.js';
import { Protokoll } from './daten/protokoll.js';
import { Anwender } from './caddy/laden.js';
import { zertifikateFinden, verwalteteZertifikate } from './caddy/zertifikate.js';
import { LIVE_ZERT_MINDEST_TAGE } from './caddy/caddyfile.js';
import { Pruefer } from './status/pruefer.js';
import { Ntfy, warnungenErmitteln } from './status/ntfy.js';
import { Zugriffe } from './status/zugriffe.js';
import { Web } from './web/web.js';
import { apiRegistrieren } from './web/api.js';
import { Anmeldung } from './web/anmeldung.js';

/** Was die gerade nicht aktive Instanz noch schreiben darf: anmelden, umschalten, UniFi testen, abgleichen/entkoppeln, prüfen. */
const PASSIV_ERLAUBT = new Set(['/api/anmelden', '/api/abmelden', '/api/spiegel/stand', '/api/spiegel/wechsel', '/api/spiegel/koppeln', '/api/umschalten/uebernehmen', '/api/unifi/testen', '/api/spiegel/abgleichen', '/api/spiegel/entkoppeln', '/api/ziel/pruefen', '/api/ntfy/test',
  '/api/spiegel/code', '/api/spiegel/verbinden', '/api/spiegel/partner', '/api/spiegel/import']);
export const CADDY_PFADE = Object.freeze({ zertifikate: '/fahproxy/zertifikate', protokoll: '/fahproxy/caddy/zugriffe.log', intern: 'fah-proxy:8081' });

export class App {
  static async starten({ daten, caddyUrl = 'http://caddy:2019', caddyDaten = '/caddy-daten', version = '?', hintergrund = true, testPorts = {}, hostIp = '', uiUrl = '', uiZertDatei = '' }) {
    const a = new App();
    Object.assign(a, { daten, caddyDaten, version, testPorts, hostIp, uiUrl, uiZertDatei, timer: [], sicherungOrdner: path.join(daten, 'unifi-sicherung') });
    await fs.mkdir(path.join(daten, 'caddy'), { recursive: true });
    await fs.mkdir(path.join(daten, 'zertifikate'), { recursive: true, mode: 0o700 });
    a.geheim = await Geheim.laden(path.join(daten, 'geheim.key'));
    a.domains = await Domains.laden(daten);
    a.einstellungen = await Einstellungen.laden(daten);
    a.konten = await Konten.laden(daten, a.geheim);
    a.protokoll = new Protokoll(daten);
    a.zertOrdner = path.join(daten, 'zertifikate');
    a.anwender = new Anwender({ domains: a.domains, einstellungen: a.einstellungen, pfade: { ...CADDY_PFADE, sperrseite: hostIp ? `http://${hostIp}:8053` : '' }, caddyfile: path.join(daten, 'caddy', 'Caddyfile'), zertOrdner: a.zertOrdner, caddyUrl });
    a.zugriffe = new Zugriffe();
    a.ntfy = await Ntfy.laden(daten, { einstellungen: a.einstellungen, geheim: a.geheim });
    a.pruefer = new Pruefer({ domains: () => a.domains.liste(), beiWechsel: (d, alt, neu) => a.beiWechsel(d, alt, neu) });
    a.web = new Web({ konten: a.konten, daten, version });
    a.web.sperre = (pfad) => (!a.istAktiv() && !PASSIV_ERLAUBT.has(pfad) ? `Diese Instanz ist gerade nicht aktiv – Änderungen bitte an der aktiven Instanz${a.wache.z.aktiv && a.wache.z.aktiv.ip ? ` (${a.wache.z.aktiv.ip})` : ''} machen, sie kommen automatisch hierher.` : null);
    a.web.ichZusatz = () => { const e = a.einstellungen.lesen(); return { modus: e.modus, rolle: e.rolle, aktiv: a.istAktiv(), aktiv_ip: a.wache.z.aktiv ? a.wache.z.aktiv.ip : null }; };
    a.spiegelHaupt = await SpiegelHaupt.laden(a);
    a.wache = await Wache.laden(a);
    a.anmeldung = new Anmeldung({ konten: a.konten, sitzungenBereit: a.web.sitzungenBereit, bremse: a.web.bremse, domains: a.domains, einstellungen: a.einstellungen });
    apiRegistrieren(a);
    if (hintergrund) a.#takte();
    return a;
  }

  /**
   * Interner Port 8081 (nur im Compose-Netz): /_fah/gesund für den Healthcheck – nur direkt, nicht über Caddy (sonst
   * stünde er unter jeder geschützten Domain im Internet) –, alles andere ist die FAH-Anmeldung.
   */
  internerHandler() {
    const anmeldung = this.anmeldung.handler();
    return (req, res) => {
      if (req.url === '/_fah/gesund' && !req.headers['x-forwarded-for']) {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, version: this.version, caddy: this.anwender.stand() }));
        return;
      }
      anmeldung(req, res);
    };
  }
  /** ntfy-Regeln anwenden (Takt 60 s). Die Ersatz-Instanz warnt nur vor veraltetem Abgleich – Ziele meldet die Haupt-Instanz. */
  async warnen(jetzt = Date.now()) {
    const e = this.einstellungen.lesen();
    if (e.rolle === 'ersatz') { const w = spiegelWarnung(e, jetzt); await this.ntfy.abgleichen(w ? [w] : []); return; }
    await this.ntfy.abgleichen(warnungenErmitteln({ domains: this.domains.liste(), status: this.pruefer.stand(), zertifikate: await this.zertifikate(), jetzt }));
  }
  /** Wohin die Konsole 80/443 leiten soll: Ziel-IP aus den Einstellungen (sonst HOST_IP) und die eigenen Proxy-Ports. */
  unifiZiel() {
    const u = this.einstellungen.lesen().unifi;
    return { ip: u.ziel_ip || this.hostIp || '', http: this.testPorts.http || null, https: this.testPorts.https || null };
  }
  /** Client mit dem gespeicherten Zugang; fingerabdruck '' = neu festnageln (nur auf ausdrückliche Bestätigung). */
  unifiClient({ fingerabdruck } = {}) {
    const u = this.einstellungen.lesen().unifi;
    if (!(u.url && u.benutzer && u.passwort)) throw new Fehler('E_EINGABE', 'Erst die UniFi-Konsole eintragen (Einstellungen → UniFi)', { feld: 'unifi.url' });
    return new UnifiClient({ url: u.url, benutzer: u.benutzer, passwort: this.geheim.entschluesseln(u.passwort), fingerabdruck: fingerabdruck ?? u.fingerabdruck });
  }
  /**
   * Ist diese Instanz die aktive (nur sie ist änderbar)? Maßgeblich ist die UniFi-Regel (Wache); solange die noch nicht
   * gelesen ist oder es noch keine FAH-Proxy-Weiterleitung gibt, gilt die Haupt-Instanz als aktiv.
   */
  istAktiv() {
    const e = this.einstellungen.lesen();
    // nur mit einem Partner zählt die UniFi-Regel – eine allein laufende (oder entkoppelte) Instanz ist immer änderbar
    const gekoppelt = e.rolle === 'ersatz' ? !!e.spiegel.schluessel : this.spiegelHaupt.liste().length > 0;
    const a = this.wache && this.wache.z.aktiv;
    if (gekoppelt && a && a.ip) return a.ip === this.unifiZiel().ip;
    return e.rolle !== 'ersatz';
  }
  /** Diese Instanz von Hand aktiv machen (Werkzeug rolle.js aktiv / Rollentausch): UniFi-Weiterleitungen hierher, Modus live. */
  async aktivWerden(wer = 'system') {
    const partner = this.wache.stand().partner;
    const r = await aktivWechseln(this.unifiClient(), { ziel: this.unifiZiel(), partnerIps: partner && partner.ip ? [partner.ip] : [], domains: this.domains.liste().filter((d) => d.aktiv !== false).map((d) => d.domain) });
    await this.einstellungen.setzen({ modus: 'live' });
    await this.anwender.anwenden().catch(() => {});
    const texte = r.schritte.map((s) => s.text);
    this.protokoll.eintragen({ wer, aktion: 'failover.uebernommen', details: { felder: texte.length ? texte : ['war schon aktiv'] } });
    return { texte };
  }
  /** Statuswechsel einer Domain ins Protokoll (Warnungen per ntfy macht `warnen` mit 5 Minuten Geduld). */
  beiWechsel(domain, alt, neu) {
    if (alt) this.protokoll.eintragen({ wer: 'system', aktion: neu.ok ? 'ziel.wieder_erreichbar' : 'ziel.gestoert', ziel: domain, details: neu.fehler ? { fehler: neu.fehler } : null });
  }

  #takte() {
    const anwenden = () => this.anwender.anwenden().catch((e) => process.stderr.write(`[fah-proxy] Caddy: ${e.message}\n`));
    anwenden();
    // solange Caddy beim Start noch nicht da war: alle 15 s erneut laden; täglich neu (Zertifikats-Auswahl im Modus live)
    this.timer.push(setInterval(() => { if (this.anwender.stand().ausstehend) anwenden(); }, 15_000));
    this.timer.push(setInterval(anwenden, 24 * 3600_000));
    this.pruefer.starten(60_000);
    const lesen = () => this.zugriffe.nachlesen(path.join(this.daten, 'caddy', 'zugriffe.log')).catch(() => {});
    lesen(); this.timer.push(setInterval(lesen, 30_000));
    const warnen = () => this.warnen().catch((e) => process.stderr.write(`[fah-proxy] Warnungen: ${e.message}\n`));
    this.timer.push(setInterval(warnen, 60_000));
    const spiegeln = () => {
      const e = this.einstellungen.lesen();
      if (e.rolle === 'ersatz' && e.spiegel.schluessel) spiegelAbgleichen(this).catch((err) => process.stderr.write(`[fah-proxy] Spiegel: ${err.message}\n`));
    };
    this.timer.push(setTimeout(spiegeln, 10_000), setInterval(spiegeln, ABGLEICH_MS));
    // Fail-over-Wache (beide Rollen) und Zugriffe der Haupt-Instanz für die Homepage (nur Ersatz)
    let wacheLaeuft = false;
    const wachen = () => { if (wacheLaeuft) return; wacheLaeuft = true; this.wache.takt().catch((err) => process.stderr.write(`[fah-proxy] Wache: ${err.message}\n`)).finally(() => { wacheLaeuft = false; }); };
    this.timer.push(setTimeout(wachen, 20_000), setInterval(wachen, PRUEF_MS));
    const holen = () => zugriffeHolen(this).catch((err) => process.stderr.write(`[fah-proxy] Zugriffe holen: ${err.message}\n`));
    this.timer.push(setInterval(holen, 30_000));
    for (const t of this.timer) t.unref?.();
  }

  stoppen() { for (const t of this.timer) clearInterval(t); this.timer = []; this.pruefer.stoppen(); }

  /** Zertifikate je Domain: übernommene und von Caddy geholte, dazu welches gerade gilt. */
  async zertifikate() {
    const ueb = await zertifikateFinden(this.zertOrdner);
    const caddy = await verwalteteZertifikate(this.caddyDaten);
    const live = this.einstellungen.lesen().modus === 'live';
    const aus = {};
    for (const d of this.domains.liste()) {
      const u = ueb.get(d.domain); const c = caddy.get(d.domain);
      const uGilt = u && (!live || (u.bis.getTime() - Date.now()) / 86400000 > LIVE_ZERT_MINDEST_TAGE);
      const aktiv = uGilt ? 'uebernommen' : (live && c ? 'caddy' : null);
      aus[d.domain] = { uebernommen: u ? u.bis.toISOString() : null, caddy: c ? c.bis.toISOString() : null, aktiv, bis: aktiv === 'uebernommen' ? u.bis.toISOString() : aktiv === 'caddy' ? c.bis.toISOString() : null };
    }
    return aus;
  }

}
