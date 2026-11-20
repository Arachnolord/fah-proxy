// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// JSON-Dateien lesen und atomar schreiben (tmp + fsync + rename, Rechte 0600). Kaputtes JSON wird gemeldet, nie
// stillschweigend mit dem Standard überschrieben.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Fehler } from './fehler.js';

export async function jsonLesen(datei, standard) {
  let text;
  try { text = await fs.readFile(datei, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return structuredClone(standard); throw e; }
  try { return JSON.parse(text); } catch (e) {
    throw new Fehler('E_DATEN', `Die Datei ${path.basename(datei)} ist beschädigt – bitte aus einer Sicherung zurückholen`, { datei, grund: e.message });
  }
}

export async function textSchreiben(datei, text, modus = 0o600) {
  await fs.mkdir(path.dirname(datei), { recursive: true });
  const tmp = `${datei}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fh = await fs.open(tmp, 'wx', modus);
  try { await fh.writeFile(text, 'utf8'); await fh.sync(); } finally { await fh.close(); }
  try { await fs.rename(tmp, datei); } catch (e) { await fs.rm(tmp, { force: true }); throw e; }
  await fs.chmod(datei, modus).catch(() => {});
}

export async function jsonSchreiben(datei, wert, modus = 0o600) {
  await textSchreiben(datei, JSON.stringify(wert, null, 2) + '\n', modus);
}
