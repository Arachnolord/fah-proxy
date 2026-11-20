// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Anmeldegeheimnisse (übernommen aus FAH-NAS) – alles mit node:crypto, kein Fremdpaket:
//  - scrypt-Hashes (Web-Passwort, Wiederherstellungscodes) im Format scrypt$N$r$p$salz_b64$hash_b64
//  - Base32 (RFC 4648) für TOTP-Geheimnisse
//  - HOTP/TOTP nach RFC 4226 / RFC 6238 (SHA1, 6 Stellen, 30 s, ±1 Schritt)
//  - otpauth://-URI für Authenticator-Apps
//  - Wiederherstellungscodes (8 × 10 Zeichen), als scrypt-Hashes abgelegt, einmalig einlösbar

import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { Fehler } from './gemeinsam/fehler.js';

const scrypt = promisify(crypto.scrypt);

// ---------------------------------------------------------------------------
// scrypt-Hashes
// ---------------------------------------------------------------------------

export const HASH = Object.freeze({ N: 32768, r: 8, p: 1, laenge: 32, salzLaenge: 16 });
const MAXMEM = 64 * 1024 * 1024; // 128·N·r = 32 MiB; etwas Luft, sonst lehnt Node ab
const MUSTER_HASH = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/;

/** Erzeugt einen scrypt-Hash für ein Geheimnis (Passwort, Wiederherstellungscode). */
export async function hashErzeugen(klartext) {
  if (typeof klartext !== 'string' || klartext.length === 0) throw new Fehler('E_EINGABE', 'Geheimnis darf nicht leer sein');
  const salz = crypto.randomBytes(HASH.salzLaenge);
  const wert = await scrypt(klartext, salz, HASH.laenge, { N: HASH.N, r: HASH.r, p: HASH.p, maxmem: MAXMEM });
  return `scrypt$${HASH.N}$${HASH.r}$${HASH.p}$${salz.toString('base64')}$${Buffer.from(wert).toString('base64')}`;
}

/** Zerlegt einen Hash-Text; null, wenn das Format nicht passt. */
export function hashZerlegen(hash) {
  const m = typeof hash === 'string' ? MUSTER_HASH.exec(hash) : null;
  if (!m) return null;
  const N = Number(m[1]); const r = Number(m[2]); const p = Number(m[3]);
  if (!Number.isInteger(N) || N < 2 || (N & (N - 1)) !== 0 || r < 1 || p < 1) return null;
  const salz = Buffer.from(m[4], 'base64'); const wert = Buffer.from(m[5], 'base64');
  if (salz.length === 0 || wert.length === 0) return null;
  return { N, r, p, salz, wert };
}

let scheinPromise = null;
/** Ein fester Schein-Hash, damit Prüfungen gegen unbekannte Nutzer genauso lange dauern wie echte. */
export function scheinHash() {
  if (!scheinPromise) scheinPromise = hashErzeugen('fahproxy-schein-' + crypto.randomBytes(8).toString('hex'));
  return scheinPromise;
}

/**
 * Prüft ein Geheimnis gegen einen Hash – zeitkonstant (timingSafeEqual) und auch bei kaputtem Hash mit
 * voller scrypt-Rechenzeit, damit von außen nicht erkennbar ist, ob ein Eintrag existiert.
 */
export async function hashPruefen(klartext, hash) {
  let z = hashZerlegen(hash);
  let gueltig = true;
  if (!z) { z = hashZerlegen(await scheinHash()); gueltig = false; }
  const eingabe = typeof klartext === 'string' && klartext.length > 0 ? klartext : '\u0000';
  const wert = Buffer.from(await scrypt(eingabe, z.salz, z.wert.length, { N: z.N, r: z.r, p: z.p, maxmem: MAXMEM }));
  const gleich = crypto.timingSafeEqual(wert, z.wert);
  return gueltig && gleich;
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648)
// ---------------------------------------------------------------------------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Kodiert Bytes als Base32 (ohne Füllzeichen, wie Authenticator-Apps es erwarten; `mitFuellung` für RFC-Form). */
export function base32Kodieren(bytes, mitFuellung = false) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  let bits = 0; let wert = 0; let aus = '';
  for (const byte of b) {
    wert = (wert << 8) | byte; bits += 8;
    while (bits >= 5) { aus += ALPHABET[(wert >>> (bits - 5)) & 31]; bits -= 5; wert &= (1 << bits) - 1; }
  }
  if (bits > 0) aus += ALPHABET[(wert << (5 - bits)) & 31];
  if (mitFuellung) while (aus.length % 8 !== 0) aus += '=';
  return aus;
}

/** Dekodiert Base32 (Groß-/Kleinschreibung, Leerzeichen und Füllzeichen werden toleriert). */
export function base32Dekodieren(text) {
  const t = String(text ?? '').toUpperCase().replace(/[\s=]/g, '');
  const aus = []; let bits = 0; let wert = 0;
  for (const z of t) {
    const i = ALPHABET.indexOf(z);
    if (i < 0) throw new Fehler('E_EINGABE', 'Ungültiges Base32-Zeichen im Geheimnis', { feld: 'geheimnis' });
    wert = (wert << 5) | i; bits += 5;
    if (bits >= 8) { aus.push((wert >>> (bits - 8)) & 255); bits -= 8; wert &= (1 << bits) - 1; }
  }
  return Buffer.from(aus);
}

// ---------------------------------------------------------------------------
// HOTP / TOTP
// ---------------------------------------------------------------------------

export const TOTP = Object.freeze({ schritt_s: 30, stellen: 6, toleranz: 1, geheimnisBytes: 20 });

/** Neues zufälliges Geheimnis (20 Byte = 160 Bit, Base32). */
export function geheimnisErzeugen(bytes = TOTP.geheimnisBytes) {
  return base32Kodieren(crypto.randomBytes(bytes));
}

/** HOTP (RFC 4226) mit SHA1 – `geheimnis` als Buffer, `zaehler` ganze Zahl ≥ 0. */
export function hotp(geheimnis, zaehler, stellen = TOTP.stellen) {
  const puffer = Buffer.alloc(8);
  puffer.writeBigUInt64BE(BigInt(zaehler));
  const mac = crypto.createHmac('sha1', geheimnis).update(puffer).digest();
  const versatz = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[versatz] & 0x7f) << 24) | (mac[versatz + 1] << 16) | (mac[versatz + 2] << 8) | mac[versatz + 3];
  return String(bin % 10 ** stellen).padStart(stellen, '0');
}

/** TOTP (RFC 6238) für ein Base32-Geheimnis zu einer Unix-Zeit in Sekunden. */
export function totp(geheimnisBase32, zeit_s = Date.now() / 1000, schritt_s = TOTP.schritt_s, stellen = TOTP.stellen) {
  return hotp(base32Dekodieren(geheimnisBase32), Math.floor(zeit_s / schritt_s), stellen);
}

function zeitkonstantGleich(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Prüft einen eingegebenen Code mit ±`toleranz` Schritten. `letzterSchritt` verhindert die Wiederverwendung
 * eines schon benutzten Codes (Replay). Gibt {ok, schritt} zurück.
 */
export function codePruefen(geheimnisBase32, code, { jetzt_s = Date.now() / 1000, toleranz = TOTP.toleranz, schritt_s = TOTP.schritt_s, letzterSchritt = -1 } = {}) {
  const eingabe = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(eingabe)) return { ok: false, schritt: null };
  const geheimnis = base32Dekodieren(geheimnisBase32);
  const mitte = Math.floor(jetzt_s / schritt_s);
  let treffer = null;
  for (let d = -toleranz; d <= toleranz; d++) {
    const schritt = mitte + d;
    if (schritt < 0) continue;
    // absichtlich alle Schritte prüfen (kein frühes Ende), Zeit bleibt gleich
    if (zeitkonstantGleich(hotp(geheimnis, schritt), eingabe) && treffer === null) treffer = schritt;
  }
  if (treffer === null || treffer <= letzterSchritt) return { ok: false, schritt: null };
  return { ok: true, schritt: treffer };
}

function uriTeil(text) { return encodeURIComponent(String(text)).replace(/%40/g, '@'); }

/** otpauth://-URI für Authenticator-Apps (Aussteller „FAH-Proxy“). */
export function otpauthUri({ geheimnis, konto, aussteller = 'FAH-Proxy' }) {
  if (!/^[A-Z2-7]+$/.test(geheimnis || '')) throw new Fehler('E_EINGABE', 'Geheimnis ist kein Base32', { feld: 'geheimnis' });
  return `otpauth://totp/${uriTeil(aussteller)}:${uriTeil(konto)}?secret=${geheimnis}&issuer=${uriTeil(aussteller)}&algorithm=SHA1&digits=${TOTP.stellen}&period=${TOTP.schritt_s}`;
}

// ---------------------------------------------------------------------------
// Wiederherstellungscodes
// ---------------------------------------------------------------------------

export const WIEDERHERSTELLUNG = Object.freeze({ anzahl: 8, laenge: 10 });
// ohne verwechselbare Zeichen (0/o, 1/l/i)
const CODE_ZEICHEN = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Erzeugt Klartext-Codes (werden dem Nutzer genau einmal gezeigt). */
export function wiederherstellungscodesErzeugen(anzahl = WIEDERHERSTELLUNG.anzahl, laenge = WIEDERHERSTELLUNG.laenge) {
  const codes = [];
  while (codes.length < anzahl) {
    let c = '';
    for (let i = 0; i < laenge; i++) c += CODE_ZEICHEN[crypto.randomInt(CODE_ZEICHEN.length)];
    if (!codes.includes(c)) codes.push(c);
  }
  return codes;
}

/** Bringt eine Eingabe in die gespeicherte Form (klein, ohne Leerzeichen und Bindestriche). */
export function codeNormieren(eingabe) {
  return String(eingabe ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Hasht Klartext-Codes für die Ablage in users.json. */
export function wiederherstellungscodesHashen(codes) {
  return Promise.all(codes.map((c) => hashErzeugen(codeNormieren(c))));
}

/**
 * Löst einen Wiederherstellungscode ein: prüft gegen alle Hashes und gibt {ok, rest} zurück –
 * `rest` sind die verbleibenden Hashes ohne den verbrauchten (einmalig einlösbar).
 */
export async function wiederherstellungscodeEinloesen(hashes, eingabe) {
  const code = codeNormieren(eingabe);
  const liste = Array.isArray(hashes) ? hashes : [];
  if (code.length !== WIEDERHERSTELLUNG.laenge || liste.length === 0) {
    await hashPruefen(code || '\u0000', await scheinHash()); // gleiche Rechenzeit
    return { ok: false, rest: liste };
  }
  const ergebnisse = await Promise.all(liste.map((h) => hashPruefen(code, h)));
  const i = ergebnisse.indexOf(true);
  if (i < 0) return { ok: false, rest: liste };
  return { ok: true, rest: liste.filter((_h, j) => j !== i) };
}
