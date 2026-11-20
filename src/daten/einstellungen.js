// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen (daten/einstellungen.json). Geheimnisse (UniFi-Passwort, ntfy-Token, Spiegel-Schlüssel) stehen hier
// nur verschlüsselt (gemeinsam/geheim.js); lesen() gibt sie nie im Klartext heraus.

import net from 'node:net';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { cidrPruefen, zielPruefen } from '../gemeinsam/pruefen.js';
import { schutzPruefen } from './schutzstufen.js';

export const STANDARD = Object.freeze({
  heimnetz: ['192.168.1.0/24', '192.168.5.0/24'],
  acme_email: '',
  modus: 'test',
  rolle: 'haupt',
  ntfy: { url: '', thema: '', token: '' },
  unifi: { url: '', benutzer: '', passwort: '', ziel_ip: '', fingerabdruck: '' },
  spiegel: { haupt_url: '', fingerabdruck: '', schluessel: '', letzter_abgleich: null, letzter_fehler: null, partner: null },
  failover: { an: true },
  sperrseite: { an: false },
  schutz: { texte: {}, eigene: [] },
  anmeldung: { sitzung_tage: 30 },
  // Lese-Zugang der FAH-Homepage (nur der SHA-256 des Schlüssels; wird mit der Partner-Instanz abgeglichen)
  homepage: { lese_hash: '', erzeugt: null },
});

const EMAIL = /^[^\s@<>"'{}]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export class Einstellungen {
  constructor(datei, werte) { this.datei = datei; this.werte = werte; }

  static async laden(ordner) {
    const datei = path.join(ordner, 'einstellungen.json');
    const d = await jsonLesen(datei, {});
    const w = structuredClone(STANDARD);
    for (const [k, v] of Object.entries(d || {})) {
      if (!(k in w)) continue;
      w[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof w[k] === 'object' && !Array.isArray(w[k]) ? { ...w[k], ...v } : v;
    }
    return new Einstellungen(datei, w);
  }

  /** Alle Werte (Geheimnisse bleiben verschlüsselt – für die Oberfläche `fuerOberflaeche` nehmen). */
  lesen() { return structuredClone(this.werte); }

  /** Ohne Geheimnisse, mit „gesetzt“-Kennzeichen. */
  fuerOberflaeche() {
    const w = this.lesen();
    w.ntfy = { ...w.ntfy, token: '', token_gesetzt: !!this.werte.ntfy.token };
    w.unifi = { ...w.unifi, passwort: '', passwort_gesetzt: !!this.werte.unifi.passwort };
    w.spiegel = { ...w.spiegel, schluessel: '', gekoppelt: !!this.werte.spiegel.schluessel };
    w.homepage = { gesetzt: !!this.werte.homepage.lese_hash, erzeugt: this.werte.homepage.erzeugt || null };
    return w;
  }

  async setzen(teil) {
    const w = this.lesen();
    if (teil.heimnetz !== undefined) {
      const liste = Array.isArray(teil.heimnetz) ? teil.heimnetz : String(teil.heimnetz).split(/[\s,;]+/);
      try { w.heimnetz = [...new Set(liste.map((x) => String(x).trim()).filter(Boolean).map(cidrPruefen))]; } catch (f) { throw new Fehler('E_EINGABE', f.message, { feld: 'heimnetz' }); }
      if (!w.heimnetz.length) throw new Fehler('E_EINGABE', 'Mindestens ein Heimnetz angeben', { feld: 'heimnetz' });
    }
    if (teil.acme_email !== undefined) {
      const m = String(teil.acme_email).trim();
      if (m && !EMAIL.test(m)) throw new Fehler('E_EINGABE', 'Bitte eine gültige E-Mail-Adresse eingeben (oder leer lassen)', { feld: 'acme_email' });
      w.acme_email = m;
    }
    if (teil.modus !== undefined) {
      if (!['test', 'live'].includes(teil.modus)) throw new Fehler('E_EINGABE', 'Modus muss „test“ oder „live“ sein', { feld: 'modus' });
      w.modus = teil.modus;
    }
    if (teil.rolle !== undefined) {
      if (!['haupt', 'ersatz'].includes(teil.rolle)) throw new Fehler('E_EINGABE', 'Rolle muss „haupt“ oder „ersatz“ sein', { feld: 'rolle' });
      w.rolle = teil.rolle;
    }
    if (teil.ntfy !== undefined) {
      const n = { ...w.ntfy, ...teil.ntfy };
      if (n.url) { try { zielPruefen(n.url); } catch { throw new Fehler('E_EINGABE', 'ntfy-Adresse ungültig (z. B. https://ntfy.beispiel.de)', { feld: 'ntfy.url' }); } }
      if (n.thema && !/^[A-Za-z0-9_-]{1,64}$/.test(n.thema)) throw new Fehler('E_EINGABE', 'ntfy-Thema: nur Buchstaben, Ziffern, _ und -', { feld: 'ntfy.thema' });
      w.ntfy = { url: String(n.url || ''), thema: String(n.thema || ''), token: String(n.token || '') };
    }
    if (teil.unifi !== undefined) {
      const n = { ...w.unifi, ...teil.unifi };
      if (n.url) {
        let u = null; try { u = new URL(String(n.url).trim()); } catch { /* unten */ }
        if (!u || u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '')) throw new Fehler('E_EINGABE', 'UniFi-Adresse: https:// und die Adresse der Konsole, z. B. https://192.168.1.1', { feld: 'unifi.url' });
        n.url = u.origin;
      }
      if (n.ziel_ip && !net.isIPv4(String(n.ziel_ip).trim())) throw new Fehler('E_EINGABE', 'IP-Adresse dieses Rechners im Heimnetz, z. B. 192.168.1.23', { feld: 'unifi.ziel_ip' });
      if (String(n.benutzer || '').length > 64) throw new Fehler('E_EINGABE', 'Benutzername zu lang', { feld: 'unifi.benutzer' });
      // neue Adresse → Fingerabdruck beim nächsten „Verbindung testen“ neu festnageln
      if (teil.unifi.fingerabdruck === undefined && (n.url || '') !== (w.unifi.url || '')) n.fingerabdruck = '';
      w.unifi = { url: String(n.url || ''), benutzer: String(n.benutzer || '').trim(), passwort: String(n.passwort || ''), ziel_ip: String(n.ziel_ip || '').trim(), fingerabdruck: String(n.fingerabdruck || '') };
    }
    if (teil.spiegel !== undefined) w.spiegel = { ...w.spiegel, ...teil.spiegel };
    if (teil.homepage !== undefined) {
      const h = teil.homepage && typeof teil.homepage === 'object' ? teil.homepage : {};
      w.homepage = { lese_hash: /^[0-9a-f]{64}$/.test(String(h.lese_hash || '')) ? String(h.lese_hash) : '', erzeugt: h.lese_hash && h.erzeugt ? String(h.erzeugt) : null };
    }
    if (teil.failover !== undefined) w.failover = { an: !!(teil.failover && teil.failover.an) };
    if (teil.sperrseite !== undefined) w.sperrseite = { an: !!(teil.sperrseite && teil.sperrseite.an) };
    if (teil.schutz !== undefined) w.schutz = schutzPruefen(teil.schutz);
    if (teil.anmeldung !== undefined) {
      const tage = Number(teil.anmeldung.sitzung_tage);
      if (!Number.isInteger(tage) || tage < 1 || tage > 365) throw new Fehler('E_EINGABE', 'Sitzungsdauer: 1 bis 365 Tage', { feld: 'anmeldung.sitzung_tage' });
      w.anmeldung = { sitzung_tage: tage };
    }
    this.werte = w;
    await jsonSchreiben(this.datei, w);
    return this.lesen();
  }
}
