// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Wache für das automatische Fail-over zwischen Haupt- und Ersatz-Instanz (beide führen sie, alle 15 Sekunden):
// - prüft den Partner wie ein Besucher (TLS mit SNI einer Domain mit Zertifikat auf Partner-IP:HTTPS-Port, jede HTTP-Antwort
//   zählt) und sich selbst (caddy:443 im eigenen Compose-Netz),
// - aktiv ist, wohin die UniFi-Regel „FAH-Proxy HTTPS“ zeigt (alle 5 Minuten gelesen; nur wenn eine Entscheidung ansteht,
//   höchstens einmal je Minute – die Prüfungen selbst laufen direkt zwischen den Instanzen, nicht über die Konsole),
// - übernimmt, wenn der Partner aktiv ist und 4 Prüfungen in Folge (≈ 1 Minute) nicht antwortet, sie selbst gesund ist
//   und der letzte Wechsel mindestens 10 Minuten her ist,
// - gibt als Ersatz-Instanz zurück, wenn die Haupt-Instanz 10 Minuten durchgehend antwortet (Versuch höchstens je Minute),
// - stellt den Modus passend: aktiv = live (Let's Encrypt möglich), passiv = test.
// Jeder Wechsel kommt ins Protokoll und per ntfy. Ohne FAH-Proxy-Regeln (noch nicht umgeschaltet) wird nie geschaltet.
// Der Stand (wer aktiv ist, ob der Partner antwortet – nur IPs, keine Geheimnisse) steht lesbar in daten/wache-stand.json
// (bei Änderung, sonst jede Minute neu) – daraus zeigt die Homepage ihr Lämpchen je Instanz.

import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { aktivIp } from '../unifi/plan.js';
import { aktivWechseln } from '../unifi/ablauf.js';
import { abgleichen, wechselMelden } from './ersatz.js';
import { datenwegPruefen } from '../gemeinsam/datenweg.js';

export const PRUEF_MS = 15_000;
export const FEHLER_FUER_WECHSEL = 4;
export const RUHE_MS = 10 * 60_000;
export const UNIFI_MS = 5 * 60_000;
/** Steht eine Entscheidung an (Übernehmen/Zurückgeben), UniFi höchstens so oft lesen; ebenso oft ein Rückgabe-Versuch. */
export const ENTSCHEIDUNG_MS = 60_000;

export { datenwegPruefen };

export class Wache {
  constructor(app, datei, gespeichert, { pruefen, jetzt, partnerFuerHaupt, vorRueckgabe, nachRueckgabe }) {
    Object.assign(this, { app, datei, pruefen, jetzt, partnerFuerHaupt, vorRueckgabe, nachRueckgabe });
    this.z = { fehler_folge: 0, fehler_seit: null, gesund_seit: null, partner_ok: null, selbst_ok: null, aktiv: null, letzter_wechsel: gespeichert.letzter_wechsel || 0, rueckgabe_versuch: 0, rueckgabe_fehler: null, unifi_fehlversuch: 0, meldung: '' };
  }
  static async laden(app, { pruefen = datenwegPruefen, jetzt = () => Date.now(), partnerFuerHaupt = null, vorRueckgabe = () => abgleichen(app), nachRueckgabe = () => wechselMelden(app) } = {}) {
    const datei = path.join(app.daten, 'failover.json');
    return new Wache(app, datei, await jsonLesen(datei, {}), { pruefen, jetzt, partnerFuerHaupt, vorRueckgabe, nachRueckgabe });
  }

  /** Die andere Instanz meldet einen Wechsel: zwischengespeicherte aktive Instanz verwerfen, der nächste Takt liest UniFi. */
  neuLesen() { this.z.aktiv = null; this.z.unifi_fehlversuch = 0; }

  stand() {
    const e = this.app.einstellungen.lesen();
    return { an: !!(e.failover && e.failover.an), rolle: e.rolle, ich: this.app.unifiZiel(), partner: this.#partner(e), ...this.z,
      gesund_seit: this.z.gesund_seit ? new Date(this.z.gesund_seit).toISOString() : null,
      letzter_wechsel: this.z.letzter_wechsel ? new Date(this.z.letzter_wechsel).toISOString() : null,
      aktiv: this.z.aktiv ? { ip: this.z.aktiv.ip, gelesen: new Date(this.z.aktiv.zeit).toISOString() } : null };
  }

  /** Partner: für die Ersatz-Instanz die Haupt-Instanz (aus dem Spiegel), für die Haupt-Instanz die zuletzt gemeldete Ersatz-Instanz. */
  #partner(e) {
    if (e.rolle === 'ersatz') return e.spiegel && e.spiegel.partner ? e.spiegel.partner : null;
    if (this.partnerFuerHaupt) return this.partnerFuerHaupt();
    const mitZiel = this.app.spiegelHaupt.liste().filter((x) => x.ziel).sort((a, b) => String(b.letzter_abruf || '').localeCompare(String(a.letzter_abruf || '')));
    return mitZiel.length ? mitZiel[0].ziel : null;
  }

  /** Eine aktive Domain, für die ein Zertifikat da ist (sonst scheitert schon der TLS-Aufbau beim Partner). */
  async #pruefDomain() {
    const zert = await this.app.zertifikate();
    const d = this.app.domains.liste().find((x) => x.aktiv !== false && zert[x.domain] && zert[x.domain].bis);
    return d ? d.domain : null;
  }

  async #modus(soll) {
    if (this.app.einstellungen.lesen().modus === soll) return;
    await this.app.einstellungen.setzen({ modus: soll });
    await this.app.anwender.anwenden().catch((e) => process.stderr.write(`[fah-proxy] Wache: Caddy ${e.message}\n`));
  }

  /** IP der aktiven Instanz (UniFi-Regel „FAH-Proxy HTTPS“) – zwischengespeichert, älter als `frisch_ms` neu gelesen. */
  async aktivIp({ frisch_ms = UNIFI_MS } = {}) {
    if (!this.z.aktiv || this.jetzt() - this.z.aktiv.zeit >= frisch_ms) this.z.aktiv = { ip: aktivIp(await this.app.unifiClient().weiterleitungen()), zeit: this.jetzt() };
    return this.z.aktiv.ip;
  }

  async takt() {
    try { await this.#taktInnen(); } finally { await this.#standSchreiben().catch(() => {}); }
  }

  async #standSchreiben() {
    const e = this.app.einstellungen.lesen();
    const p = this.#partner(e);
    const inhalt = { rolle: e.rolle, fail_over_an: !!(e.failover && e.failover.an), ich: { ip: this.app.unifiZiel().ip || null },
      partner: p && p.ip ? { ip: p.ip } : null, aktiv_ip: this.z.aktiv ? this.z.aktiv.ip : null,
      partner_ok: this.z.partner_ok, selbst_ok: this.z.selbst_ok, meldung: this.z.meldung };
    const kennung = JSON.stringify(inhalt); const jetzt = this.jetzt();
    if (kennung === this.geschrieben && jetzt - (this.geschrieben_zeit || 0) < ENTSCHEIDUNG_MS) return;
    await jsonSchreiben(path.join(this.app.daten, 'wache-stand.json'), { zeit: new Date(jetzt).toISOString(), ...inhalt }, 0o644);
    this.geschrieben = kennung; this.geschrieben_zeit = jetzt;
  }

  async #taktInnen() {
    const e = this.app.einstellungen.lesen();
    const jetzt = this.jetzt();
    if (!(e.failover && e.failover.an)) { this.z.meldung = 'Automatisches Fail-over ist aus.'; return; }
    const ich = this.app.unifiZiel(); const partner = this.#partner(e);
    if (!partner || !partner.ip || !ich.ip) { this.z.meldung = 'Noch keine zweite Instanz gekoppelt.'; return; }
    const domain = await this.#pruefDomain();
    if (!domain) { this.z.meldung = 'Keine Domain mit Zertifikat zum Prüfen.'; return; }
    const [partnerOk, selbstOk] = await Promise.all([this.pruefen({ host: partner.ip, port: partner.https, domain }), this.pruefen({ host: 'caddy', port: 443, domain })]);
    Object.assign(this.z, { partner_ok: partnerOk, selbst_ok: selbstOk });
    if (partnerOk) { this.z.fehler_folge = 0; this.z.fehler_seit = null; if (!this.z.gesund_seit) this.z.gesund_seit = jetzt; }
    else { this.z.fehler_folge += 1; if (!this.z.fehler_seit) this.z.fehler_seit = jetzt - PRUEF_MS; this.z.gesund_seit = null; }
    const verdacht = this.z.fehler_folge >= FEHLER_FUER_WECHSEL;
    const rueckgabeReif = e.rolle === 'ersatz' && this.z.gesund_seit !== null && jetzt - this.z.gesund_seit >= RUHE_MS && jetzt - this.z.rueckgabe_versuch >= ENTSCHEIDUNG_MS;
    // UniFi nur öfter lesen, wenn wirklich etwas zu entscheiden ist (Partner aktiv und weg, oder Rückgabe fällig)
    const entscheiden = (verdacht && (!this.z.aktiv || this.z.aktiv.ip !== ich.ip)) || (rueckgabeReif && this.z.aktiv?.ip === ich.ip);
    const abstand = entscheiden ? ENTSCHEIDUNG_MS : UNIFI_MS;
    if (!this.z.aktiv || jetzt - this.z.aktiv.zeit >= abstand) {
      // Nach einem Fehlversuch den Abstand einhalten: Im 15-s-Takt sperrt die Konsole das Konto für beide Instanzen
      if (jetzt - this.z.unifi_fehlversuch < abstand) return;
      try { this.z.aktiv = { ip: aktivIp(await this.app.unifiClient().weiterleitungen()), zeit: jetzt }; this.z.unifi_fehlversuch = 0; } catch (err) { this.z.unifi_fehlversuch = jetzt; this.z.meldung = `UniFi nicht lesbar: ${Fehler.aus(err).message}`; return; }
    }
    const aktiv = this.z.aktiv.ip;
    if (!aktiv) { this.z.meldung = 'FAH-Proxy ist in UniFi noch nicht umgeschaltet – kein Fail-over.'; await this.#modus('test'); return; }
    await this.#modus(aktiv === ich.ip ? 'live' : 'test');
    const ruhig = jetzt - this.z.letzter_wechsel >= RUHE_MS;
    if (aktiv === partner.ip && verdacht && selbstOk && ruhig) {
      await this.#wechseln(ich, partner, 'uebernommen', `Die andere Instanz (${partner.ip}) antwortet seit ${Math.round((jetzt - this.z.fehler_seit) / 1000)} Sekunden nicht – diese Instanz (${ich.ip}) bedient jetzt das Internet.`);
    } else if (rueckgabeReif && aktiv === ich.ip && ruhig) {
      // erst die Änderungen aus der Ausfallzeit zur Haupt-Instanz, dann zurückgeben – sonst gingen sie verloren
      this.z.rueckgabe_versuch = jetzt;
      try { await this.vorRueckgabe(); } catch (err) { this.z.meldung = this.z.rueckgabe_fehler = `Zurückgeben wartet: Abgleich zur Haupt-Instanz gescheitert (${Fehler.aus(err).message})`; return; }
      this.z.rueckgabe_fehler = null;
      await this.#wechseln(partner, ich, 'zurueck', `Die Haupt-Instanz (${partner.ip}) läuft wieder stabil, hat die Änderungen der Ausfallzeit bekommen und bedient das Internet wieder.`);
    } else {
      this.z.meldung = aktiv !== ich.ip ? `Die andere Instanz (${aktiv}) bedient das Internet.`
        : this.z.rueckgabe_fehler && this.z.gesund_seit !== null ? this.z.rueckgabe_fehler : 'Diese Instanz bedient das Internet.';
    }
  }

  async #wechseln(ziel, anderer, art, text) {
    const domains = this.app.domains.liste().filter((d) => d.aktiv !== false).map((d) => d.domain);
    try {
      await aktivWechseln(this.app.unifiClient(), { ziel, partnerIps: [anderer.ip], domains, pruefen: this.pruefen });
    } catch (err) {
      this.z.meldung = `Wechsel gescheitert: ${Fehler.aus(err).message}`;
      this.app.protokoll.eintragen({ wer: 'fail-over', aktion: 'failover.fehlgeschlagen', details: { fehler: this.z.meldung } });
      return;
    }
    const jetzt = this.jetzt();
    this.z.letzter_wechsel = jetzt; this.z.aktiv = { ip: ziel.ip, zeit: jetzt }; this.z.meldung = text;
    await jsonSchreiben(this.datei, { letzter_wechsel: jetzt });
    await this.#modus(ziel.ip === this.app.unifiZiel().ip ? 'live' : 'test');
    this.app.protokoll.eintragen({ wer: 'fail-over', aktion: `failover.${art}`, details: { felder: [text] } });
    // die Haupt-Instanz weiß es so in Sekunden statt erst bei ihrer nächsten UniFi-Abfrage (bis 5 min)
    if (art === 'zurueck') await Promise.resolve().then(() => this.nachRueckgabe()).catch((err) => process.stderr.write(`[fah-proxy] Wache: Meldung an die Haupt-Instanz: ${err.message}\n`));
    await this.app.ntfy.nachricht({ titel: art === 'uebernommen' ? 'FAH-Proxy: Fail-over' : 'FAH-Proxy: zurück auf der Haupt-Instanz', text, prio: art === 'uebernommen' ? 4 : 3, tags: [art === 'uebernommen' ? 'warning' : 'white_check_mark'] }).catch(() => {});
  }
}
