// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// HTTPS-Anfrage an ein Gegenüber mit selbstsigniertem Zertifikat (UniFi-Konsole, Haupt-FAH-Proxy): erst die TLS-Verbindung
// aufbauen und den SHA-256-Fingerabdruck prüfen, dann auf GENAU dieser Verbindung die Anfrage senden – ein falsches
// Gegenüber bekommt so weder Passwort noch Schlüssel. Ohne festgenagelten Abdruck (erstes Verbinden) wird nur gemerkt.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { Fehler } from './fehler.js';

/**
 * @param {{url:string, fingerabdruck?:string, methode?:string, pfad:string, kopf?:object, body?:string, zeitlimit_ms?:number,
 *   code:string, meldungen:{zeit:string, netz:string, zertifikat:string, anfrage:string}}} o
 *   code = Fehlercode (E_UNIFI, E_SPIEGEL); in netz/anfrage wird {grund} ersetzt.
 * @returns {Promise<{status:number, kopf:object, text:string, gesehen:string}>}
 */
export function festgenagelteAnfrage({ url, fingerabdruck = '', methode = 'GET', pfad, kopf = {}, body, zeitlimit_ms = 15000, code, meldungen }) {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, ''); const port = Number(u.port || 443);
  const grund = (text, e) => text.replace('{grund}', e.code || e.message);
  return new Promise((ok, nein) => {
    const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const uhr = setTimeout(() => { s.destroy(); nein(new Fehler(code, meldungen.zeit)); }, zeitlimit_ms);
    s.once('error', (e) => { clearTimeout(uhr); nein(new Fehler(code, grund(meldungen.netz, e))); });
    s.once('secureConnect', () => {
      clearTimeout(uhr);
      const gesehen = s.getPeerCertificate().fingerprint256 || '';
      if (fingerabdruck && gesehen !== fingerabdruck) { s.destroy(); nein(new Fehler(code, meldungen.zertifikat, { fingerabdruck: gesehen })); return; }
      const k = { Host: u.host, Accept: 'application/json', ...kopf };
      if (body !== undefined) Object.assign(k, { 'Content-Type': k['Content-Type'] || 'application/json', 'Content-Length': Buffer.byteLength(body) });
      const req = http.request({ method: methode, path: pfad, headers: k, createConnection: () => s }, (res) => {
        let t = ''; res.setEncoding('utf8');
        res.on('data', (x) => { t += x; });
        res.on('end', () => ok({ status: res.statusCode, kopf: res.headers, text: t, gesehen }));
      });
      req.setTimeout(zeitlimit_ms, () => req.destroy(new Error('Zeitüberschreitung')));
      req.on('error', (e) => nein(new Fehler(code, grund(meldungen.anfrage, e))));
      req.end(body);
    });
  });
}
