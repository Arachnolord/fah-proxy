// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Geheimnisse (UniFi-Passwort, ntfy-Token, Spiegel-Schlüssel) AES-256-GCM-verschlüsselt. Der Schlüssel liegt in
// daten/geheim.key (32 Byte, 0600) und wird beim ersten Start angelegt. Format: „v1:<iv>:<tag>:<daten>“ (base64url).

import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { Fehler } from './fehler.js';

export class Geheim {
  constructor(schluessel) { this.schluessel = schluessel; }

  static async laden(datei) {
    let s;
    try { s = await fs.readFile(datei); } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      s = crypto.randomBytes(32);
      await fs.writeFile(datei, s, { mode: 0o600, flag: 'wx' }).catch(async (e2) => { if (e2.code === 'EEXIST') s = await fs.readFile(datei); else throw e2; });
    }
    if (s.length !== 32) throw new Fehler('E_DATEN', 'Der Geheimschlüssel (geheim.key) ist beschädigt', { datei });
    await fs.chmod(datei, 0o600).catch(() => {});
    return new Geheim(s);
  }

  verschluesseln(text) {
    if (!text) return '';
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.schluessel, iv);
    const daten = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${daten.toString('base64url')}`;
  }

  entschluesseln(blob) {
    if (!blob) return '';
    const m = /^v1:([\w-]+):([\w-]+):([\w-]*)$/.exec(String(blob));
    try {
      if (!m) throw new Error('Format');
      const d = crypto.createDecipheriv('aes-256-gcm', this.schluessel, Buffer.from(m[1], 'base64url'));
      d.setAuthTag(Buffer.from(m[2], 'base64url'));
      return Buffer.concat([d.update(Buffer.from(m[3], 'base64url')), d.final()]).toString('utf8');
    } catch {
      throw new Fehler('E_DATEN', 'Ein gespeichertes Geheimnis lässt sich nicht entschlüsseln (geheim.key gewechselt?) – bitte neu eingeben');
    }
  }
}
