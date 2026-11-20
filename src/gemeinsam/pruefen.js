// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eingabeprüfungen. Alles, was hier durchgeht, steht später wörtlich im Caddyfile – deshalb nur enge Zeichenmengen
// (Whitelist), nie „gefährliche Zeichen entfernen“. Fehler: E_EINGABE mit details.feld.

import net from 'node:net';
import { Fehler } from './fehler.js';

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const HOSTNAME_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/; // Ziel-Hosts dürfen auch einteilig sein (z. B. „nas“, „caddy“)
const PFAD = /^\/[A-Za-z0-9._~\-/%]*$/;

function falsch(feld, meldung) { return new Fehler('E_EINGABE', meldung, { feld }); }

/** Domainname (öffentlich, mindestens zwei Labels, kein Platzhalter) → klein geschrieben. */
export function domainPruefen(eingabe) {
  const d = String(eingabe ?? '').trim().toLowerCase();
  const labels = d.split('.');
  if (!d || d.length > 253 || labels.length < 2 || !labels.every((l) => LABEL.test(l))) {
    throw falsch('domain', `„${String(eingabe ?? '').trim().slice(0, 80)}“ ist kein gültiger Domainname (z. B. nextcloud.beispiel.de)`);
  }
  return d;
}

/**
 * Ziel einer Weiterleitung: [http(s)://]host[:port][/pfad]. Host = IPv4, [IPv6] oder Hostname. Ohne Schema http,
 * ohne Port 80/443. Liefert {scheme, host, port, pfad, url}.
 */
export function zielPruefen(eingabe) {
  const roh = String(eingabe ?? '').trim();
  const fehler = () => falsch('ziel', `„${roh.slice(0, 80)}“ ist kein gültiges Ziel (z. B. http://192.168.1.23:8080)`);
  const m = /^(?:(https?):\/\/)?(\[[0-9A-Fa-f:.]+\]|[^\s/:[\]@"'{}<>\\]+)(?::(\d{1,5}))?(\/[^\s]*)?$/.exec(roh);
  if (!m) throw fehler();
  const scheme = (m[1] || 'http').toLowerCase();
  let host = m[2].toLowerCase();
  if (host.startsWith('[')) { if (net.isIPv6(host.slice(1, -1)) === false) throw fehler(); }
  else if (!net.isIPv4(host) && !host.split('.').every((l) => HOSTNAME_LABEL.test(l))) throw fehler();
  const port = m[3] === undefined ? (scheme === 'https' ? 443 : 80) : Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw fehler();
  const pfad = m[4] || '';
  if (pfad && !PFAD.test(pfad)) throw fehler();
  return { scheme, host, port, pfad, url: `${scheme}://${host}:${port}${pfad}` };
}

/** Netz oder einzelne Adresse → „adresse/präfix“ (einzelne IPv4 = /32, IPv6 = /128). */
export function cidrPruefen(eingabe) {
  const s = String(eingabe ?? '').trim();
  const m = /^([0-9A-Fa-f:.]+)(?:\/(\d{1,3}))?$/.exec(s);
  const fehler = () => falsch('netz', `„${s.slice(0, 60)}“ ist keine gültige Adresse bzw. kein Netz (z. B. 192.168.1.0/24)`);
  if (!m) throw fehler();
  const v = net.isIP(m[1]);
  if (!v) throw fehler();
  const max = v === 4 ? 32 : 128;
  const praefix = m[2] === undefined ? max : Number(m[2]);
  if (!Number.isInteger(praefix) || praefix < 0 || praefix > max) throw fehler();
  return `${v === 4 ? m[1] : m[1].toLowerCase()}/${praefix}`;
}

function ipZuBigInt(ip) {
  if (net.isIPv4(ip)) return { v: 4, n: ip.split('.').reduce((a, o) => (a << 8n) + BigInt(Number(o)), 0n) };
  // IPv6 ausschreiben (mit eingebettetem IPv4)
  let s = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const b = v4[1].split('.').map(Number); s = s.slice(0, -v4[1].length) + `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`; }
  const [links, rechts] = s.split('::');
  const l = links ? links.split(':') : []; const r = rechts !== undefined && rechts ? rechts.split(':') : [];
  const teile = rechts === undefined ? l : [...l, ...Array(8 - l.length - r.length).fill('0'), ...r];
  return { v: 6, n: teile.reduce((a, h) => (a << 16n) + BigInt(parseInt(h || '0', 16)), 0n) };
}

/** Liegt die Adresse im Netz? IPv4-gemappte IPv6-Adressen (::ffff:a.b.c.d) zählen als IPv4. */
export function ipInNetz(ip, cidr) {
  let adresse = String(ip || '').trim();
  const gemappt = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(adresse);
  if (gemappt) adresse = gemappt[1];
  const [netzAdr, praefixText] = cidr.split('/');
  if (!net.isIP(adresse) || !net.isIP(netzAdr)) return false;
  const a = ipZuBigInt(adresse); const n = ipZuBigInt(netzAdr);
  if (a.v !== n.v) return false;
  const breite = a.v === 4 ? 32n : 128n; const p = BigInt(Number(praefixText));
  if (p === 0n) return true;
  const maske = ((1n << p) - 1n) << (breite - p);
  return (a.n & maske) === (n.n & maske);
}
