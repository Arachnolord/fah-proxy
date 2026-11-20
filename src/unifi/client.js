// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// UniFi-OS-Konsole (UCG/UDM), klassische Network-API mit lokalem Konto: POST /api/auth/login → Cookie TOKEN + X-CSRF-Token,
// danach /proxy/network/api/s/<site>/rest/portforward. API-Schlüssel reichen für Portweiterleitungen nicht (09.10. geprüft).
// Die Konsole hat meist ein selbstsigniertes Zertifikat: Jede Verbindung wird erst aufgebaut und ihr Fingerabdruck
// geprüft (festgenagelt nach dem ersten „Verbindung testen“), erst dann geht auf DIESER Verbindung die Anfrage raus –
// ein falsches Gegenüber bekommt also nie das Passwort. Abgelaufene Sitzung → einmal neu anmelden.

import { Fehler } from '../gemeinsam/fehler.js';
import { festgenagelteAnfrage } from '../gemeinsam/festgenagelt.js';

function csrfAusToken(cookie) {
  try { return JSON.parse(Buffer.from(cookie.slice('TOKEN='.length).split('.')[1], 'base64url').toString('utf8')).csrfToken || ''; } catch { return ''; }
}

export class UnifiClient {
  /** @param {{url:string, benutzer:string, passwort:string, site?:string, fingerabdruck?:string, zeitlimit_ms?:number}} o */
  constructor({ url, benutzer, passwort, site = 'default', fingerabdruck = '', zeitlimit_ms = 15000 }) {
    let u;
    try { u = new URL(String(url)); } catch { throw new Fehler('E_EINGABE', 'UniFi-Adresse ungültig (z. B. https://192.168.1.1)', { feld: 'unifi.url' }); }
    if (u.protocol !== 'https:') throw new Fehler('E_EINGABE', 'Die UniFi-Adresse muss mit https:// beginnen', { feld: 'unifi.url' });
    Object.assign(this, { benutzer: String(benutzer || ''), passwort: String(passwort || ''), site, fingerabdruck, zeitlimit_ms });
    this.hostKopf = u.host;
    this.cookie = ''; this.csrf = ''; this.gesehen = '';
  }

  async #roh(methode, pfad, body) {
    const kopf = {};
    if (this.cookie) kopf.Cookie = this.cookie;
    if (this.csrf && methode !== 'GET') kopf['X-CSRF-Token'] = this.csrf;
    const r = await festgenagelteAnfrage({
      url: `https://${this.hostKopf}`, fingerabdruck: this.fingerabdruck, methode, pfad, kopf, body: body === undefined ? undefined : JSON.stringify(body), zeitlimit_ms: this.zeitlimit_ms, code: 'E_UNIFI',
      meldungen: {
        zeit: 'Die UniFi-Konsole antwortet nicht (Zeitüberschreitung)', netz: 'Die UniFi-Konsole ist nicht erreichbar ({grund})', anfrage: 'UniFi-Anfrage fehlgeschlagen ({grund})',
        zertifikat: 'Das Zertifikat der UniFi-Konsole hat sich geändert – aus Sicherheit abgebrochen. War das gewollt (neues Zertifikat), unter Einstellungen → UniFi „Verbindung testen“ neu bestätigen.',
      },
    });
    this.gesehen = r.gesehen;
    let json = null; try { json = r.text ? JSON.parse(r.text) : null; } catch { /* kein JSON */ }
    return { status: r.status, kopf: r.kopf, json };
  }

  async anmelden() {
    const r = await this.#roh('POST', '/api/auth/login', { username: this.benutzer, password: this.passwort, remember: false });
    if (r.status === 429) throw new Fehler('E_UNIFI', 'Die UniFi-Konsole bremst Anmeldungen – bitte ein paar Minuten warten');
    if (r.status !== 200) throw new Fehler('E_UNIFI', 'Anmeldung bei UniFi fehlgeschlagen – lokales Konto und Passwort prüfen (Konten mit 2FA oder UI-Konten gehen nicht)');
    const token = [].concat(r.kopf['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('TOKEN='));
    if (!token) throw new Fehler('E_UNIFI', 'Die Konsole hat keine Sitzung geliefert – ist das eine UniFi-OS-Konsole (UCG, UDM, Cloud Key Gen2)?');
    this.cookie = token;
    this.csrf = r.kopf['x-csrf-token'] || csrfAusToken(token);
  }

  async #api(methode, pfad, body, nochmal = true) {
    if (!this.cookie) await this.anmelden();
    const r = await this.#roh(methode, `/proxy/network/api/s/${encodeURIComponent(this.site)}${pfad}`, body);
    if (r.kopf['x-updated-csrf-token']) this.csrf = r.kopf['x-updated-csrf-token'];
    if (r.status === 401 && nochmal) { this.cookie = ''; return this.#api(methode, pfad, body, false); }
    const meta = r.json && r.json.meta;
    if (r.status >= 400 || !r.json || (meta && meta.rc !== 'ok')) throw new Fehler('E_UNIFI', `UniFi lehnt ab: ${(meta && meta.msg) || `HTTP ${r.status}`}`, { status: r.status });
    return Array.isArray(r.json.data) ? r.json.data : [];
  }

  /** v2-Schnittstelle (lokale DNS-Einträge, Firewall-Regeln der Zonen-Firewall): reines JSON ohne meta-Hülle. */
  async #v2(methode, pfad, body, nochmal = true) {
    if (!this.cookie) await this.anmelden();
    const r = await this.#roh(methode, `/proxy/network/v2/api/site/${encodeURIComponent(this.site)}${pfad}`, body);
    if (r.kopf['x-updated-csrf-token']) this.csrf = r.kopf['x-updated-csrf-token'];
    if (r.status === 401 && nochmal) { this.cookie = ''; return this.#v2(methode, pfad, body, false); }
    if (r.status >= 400 || r.json === null) throw new Fehler('E_UNIFI', `UniFi lehnt ab: ${(r.json && (r.json.message || r.json.code)) || `HTTP ${r.status}`}`, { status: r.status });
    return r.json;
  }

  weiterleitungen() { return this.#api('GET', '/rest/portforward'); }
  async dnsEintraege() { const d = await this.#v2('GET', '/static-dns'); return Array.isArray(d) ? d : []; }
  dnsAendern(id, eintrag) { return this.#v2('PUT', `/static-dns/${encodeURIComponent(id)}`, eintrag); }
  async firewallRegeln() { const d = await this.#v2('GET', '/firewall-policies'); return Array.isArray(d) ? d : []; }
  firewallAendern(id, regel) { return this.#v2('PUT', `/firewall-policies/${encodeURIComponent(id)}`, regel); }
  async aendern(id, regel) { return (await this.#api('PUT', `/rest/portforward/${encodeURIComponent(id)}`, regel))[0] || null; }
  async anlegen(regel) { return (await this.#api('POST', '/rest/portforward', regel))[0] || null; }
  async loeschen(id) { await this.#api('DELETE', `/rest/portforward/${encodeURIComponent(id)}`); }
}
