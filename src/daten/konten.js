// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Konten (daten/konten.json): Oberfläche (Rolle admin) und FAH-Anmeldung vor geschützten Domains (Rolle nutzer: nur
// Anmeldung, keine Oberfläche; `domains` leer = alle Domains mit Schutz „Anmeldung“). Passwörter als scrypt-Hash,
// TOTP-Geheimnis verschlüsselt (gemeinsam/geheim.js). Erstkonto admin/admin mit Pflichtwechsel.

import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { domainPruefen } from '../gemeinsam/pruefen.js';
import { hashErzeugen, hashPruefen, geheimnisErzeugen, codePruefen, otpauthUri, TOTP } from '../totp.js';

const NAME = /^[a-z0-9._-]{2,32}$/;
export const PASSWORT_MIN = 10;
const UNBEKANNT = 'Name oder Passwort stimmt nicht';

export class Konten {
  constructor(datei, geheim, konten) { this.datei = datei; this.geheim = geheim; this.konten = konten; this.vorbereitet = new Map(); }

  static async laden(ordner, geheim) {
    const datei = path.join(ordner, 'konten.json');
    const d = await jsonLesen(datei, null);
    if (d && Array.isArray(d.konten) && d.konten.length) return new Konten(datei, geheim, d.konten);
    const k = new Konten(datei, geheim, [{ name: 'admin', hash: await hashErzeugen('admin'), rolle: 'admin', pflichtwechsel: true, totp: null, letzterSchritt: -1, domains: [], gesperrt: false }]);
    await k.#speichern();
    return k;
  }

  async #speichern() { await jsonSchreiben(this.datei, { konten: this.konten }); }

  #holen(name) {
    const k = this.konten.find((x) => x.name === name);
    if (!k) throw new Fehler('E_NICHT_GEFUNDEN', `Das Konto „${name}“ gibt es nicht`, { feld: 'name' });
    return k;
  }

  liste() { return this.konten.map((k) => ({ name: k.name, rolle: k.rolle, pflichtwechsel: !!k.pflichtwechsel, totp: !!(k.totp && k.totp.aktiv), domains: [...(k.domains || [])], gesperrt: !!k.gesperrt })); }

  /** Anmeldung prüfen. Mit aktiver 2FA ohne Code: E_ANMELDUNG mit details.code_noetig. */
  async pruefen(name, passwort, code) {
    const k = this.konten.find((x) => x.name === String(name || '').trim().toLowerCase());
    const ok = await hashPruefen(String(passwort ?? ''), k ? k.hash : null);
    if (!k || !ok || k.gesperrt) throw new Fehler('E_ANMELDUNG', UNBEKANNT);
    if (k.totp && k.totp.aktiv) {
      if (!code) throw new Fehler('E_ANMELDUNG', 'Bitte den Code aus der Authenticator-App eingeben', { code_noetig: true });
      return this.codeBestaetigen(k.name, code);
    }
    return { name: k.name, rolle: k.rolle, pflichtwechsel: !!k.pflichtwechsel };
  }
  /** Zweiter Schritt (Passwort wurde schon geprüft): TOTP-Code eines Kontos mit aktiver 2FA, jeder Code nur einmal. */
  async codeBestaetigen(name, code) {
    const k = this.konten.find((x) => x.name === name);
    if (!k || k.gesperrt || !(k.totp && k.totp.aktiv)) throw new Fehler('E_ANMELDUNG', UNBEKANNT);
    const r = codePruefen(this.geheim.entschluesseln(k.totp.geheimnis), String(code ?? ''), { letzterSchritt: k.letzterSchritt ?? -1 });
    if (!r || !r.ok) throw new Fehler('E_ANMELDUNG', 'Der Code stimmt nicht', { code_noetig: true });
    k.letzterSchritt = r.schritt; await this.#speichern();
    return { name: k.name, rolle: k.rolle, pflichtwechsel: !!k.pflichtwechsel };
  }

  async passwortSetzen(name, neu) {
    const k = this.#holen(name);
    const p = String(neu ?? '');
    if (p.length < PASSWORT_MIN) throw new Fehler('E_EINGABE', `Das Passwort braucht mindestens ${PASSWORT_MIN} Zeichen`, { feld: 'neu' });
    if (p.toLowerCase() === 'admin' || p.toLowerCase() === k.name) throw new Fehler('E_EINGABE', 'Bitte ein eigenes Passwort wählen', { feld: 'neu' });
    k.hash = await hashErzeugen(p); k.pflichtwechsel = false;
    await this.#speichern();
  }

  async anlegen({ name, passwort, rolle = 'nutzer', domains = [] }) {
    const n = String(name || '').trim().toLowerCase();
    if (!NAME.test(n)) throw new Fehler('E_EINGABE', 'Name: 2–32 Zeichen aus a–z, 0–9, Punkt, Bindestrich, Unterstrich', { feld: 'name' });
    if (this.konten.some((x) => x.name === n)) throw new Fehler('E_EXISTIERT', `Das Konto „${n}“ gibt es schon`, { feld: 'name' });
    if (!['admin', 'nutzer'].includes(rolle)) throw new Fehler('E_EINGABE', 'Rolle muss admin oder nutzer sein', { feld: 'rolle' });
    let liste;
    try { liste = [...new Set((domains || []).map(domainPruefen))]; } catch (f) { throw new Fehler('E_EINGABE', f.message, { feld: 'domains' }); }
    if (String(passwort ?? '').length < PASSWORT_MIN) throw new Fehler('E_EINGABE', `Das Passwort braucht mindestens ${PASSWORT_MIN} Zeichen`, { feld: 'passwort' });
    this.konten.push({ name: n, hash: await hashErzeugen(String(passwort)), rolle, pflichtwechsel: false, totp: null, letzterSchritt: -1, domains: liste, gesperrt: false });
    await this.#speichern();
    return this.liste().find((x) => x.name === n);
  }

  async aendern(name, { rolle, domains, gesperrt }) {
    const k = this.#holen(name);
    if (rolle !== undefined) {
      if (!['admin', 'nutzer'].includes(rolle)) throw new Fehler('E_EINGABE', 'Rolle muss admin oder nutzer sein', { feld: 'rolle' });
      if (k.rolle === 'admin' && rolle !== 'admin' && this.konten.filter((x) => x.rolle === 'admin' && !x.gesperrt).length <= 1) throw new Fehler('E_EINGABE', 'Mindestens ein Admin muss bleiben', { feld: 'rolle' });
      k.rolle = rolle;
    }
    if (domains !== undefined) { try { k.domains = [...new Set(domains.map(domainPruefen))]; } catch (f) { throw new Fehler('E_EINGABE', f.message, { feld: 'domains' }); } }
    if (gesperrt !== undefined) {
      if (gesperrt && k.rolle === 'admin' && this.konten.filter((x) => x.rolle === 'admin' && !x.gesperrt).length <= 1) throw new Fehler('E_EINGABE', 'Den letzten Admin kann man nicht sperren', { feld: 'gesperrt' });
      k.gesperrt = !!gesperrt;
    }
    await this.#speichern();
    return this.liste().find((x) => x.name === name);
  }

  async loeschen(name) {
    const k = this.#holen(name);
    if (k.rolle === 'admin' && this.konten.filter((x) => x.rolle === 'admin').length <= 1) throw new Fehler('E_EINGABE', 'Den letzten Admin kann man nicht löschen', { feld: 'name' });
    this.konten = this.konten.filter((x) => x.name !== name);
    await this.#speichern();
  }

  /** Darf das Konto die geschützte Domain öffnen? (nutzer mit leerer Liste: alle) */
  darfDomain(name, domain) {
    const k = this.konten.find((x) => x.name === name);
    if (!k || k.gesperrt) return false;
    return k.rolle === 'admin' || !(k.domains || []).length || k.domains.includes(domain);
  }

  async totpVorbereiten(name) {
    const k = this.#holen(name);
    const geheimnis = geheimnisErzeugen(TOTP.geheimnisBytes);
    this.vorbereitet.set(k.name, geheimnis);
    return { geheimnis, uri: otpauthUri({ geheimnis, konto: k.name, aussteller: 'FAH-Proxy' }) };
  }

  async totpAktivieren(name, code) {
    const k = this.#holen(name);
    const geheimnis = this.vorbereitet.get(k.name);
    const r = geheimnis ? codePruefen(geheimnis, String(code ?? '')) : null;
    if (!r || !r.ok) throw new Fehler('E_EINGABE', 'Der Code stimmt nicht – bitte die Uhrzeit des Telefons prüfen und erneut versuchen', { feld: 'code' });
    k.totp = { aktiv: true, geheimnis: this.geheim.verschluesseln(geheimnis) }; k.letzterSchritt = r.schritt;
    this.vorbereitet.delete(k.name);
    await this.#speichern();
  }

  /** Für den Spiegel: Konten mit Hash und entschlüsseltem 2FA-Geheimnis (geht nur an die gekoppelte Ersatz-Instanz). */
  fuerSpiegel() {
    return this.konten.map((k) => ({ ...structuredClone(k), totp: k.totp && k.totp.aktiv ? { aktiv: true, geheimnis: this.geheim.entschluesseln(k.totp.geheimnis) } : null }));
  }
  /** Spiegel übernehmen (Ersatz-Instanz): prüfen, 2FA mit dem eigenen Schlüssel neu verschlüsseln, ganz ersetzen. */
  async spiegelUebernehmen(liste) {
    const neu = liste.map((k) => {
      if (!k || !NAME.test(String(k.name)) || !['admin', 'nutzer'].includes(k.rolle) || typeof k.hash !== 'string') throw new Fehler('E_SPIEGEL', 'Ungültiges Konto im Spiegel – nicht übernommen');
      return { name: k.name, hash: k.hash, rolle: k.rolle, pflichtwechsel: !!k.pflichtwechsel, totp: k.totp && k.totp.aktiv ? { aktiv: true, geheimnis: this.geheim.verschluesseln(String(k.totp.geheimnis)) } : null,
        letzterSchritt: Number.isInteger(k.letzterSchritt) ? k.letzterSchritt : -1, domains: Array.isArray(k.domains) ? k.domains.map(String) : [], gesperrt: !!k.gesperrt };
    });
    if (!neu.some((k) => k.rolle === 'admin' && !k.gesperrt)) throw new Fehler('E_SPIEGEL', 'Der Spiegel enthält keinen Admin – nicht übernommen');
    this.konten = neu;
    await this.#speichern();
  }
  async totpAus(name) { const k = this.#holen(name); k.totp = null; k.letzterSchritt = -1; await this.#speichern(); }
}
