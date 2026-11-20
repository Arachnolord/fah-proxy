// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Änderungsprotokoll (daten/protokoll.jsonl): wer hat wann was geändert. Je Zeile ein JSON-Objekt; beim Lesen die
// neuesten zuerst. Ab 5 MiB wird die Datei auf die letzten 2000 Einträge gekürzt.

import fs from 'node:fs/promises';
import path from 'node:path';
import { textSchreiben } from '../gemeinsam/dateien.js';

const MAX_BYTES = 5 * 1024 * 1024;

export class Protokoll {
  constructor(ordner) { this.datei = path.join(ordner, 'protokoll.jsonl'); this.kette = Promise.resolve(); }

  eintragen({ wer = 'system', aktion, ziel = null, details = null }) {
    const zeile = JSON.stringify({ zeit: new Date().toISOString(), wer, aktion, ziel, ...(details ? { details } : {}) }) + '\n';
    this.kette = this.kette.then(async () => {
      await fs.appendFile(this.datei, zeile, { mode: 0o600 });
      const st = await fs.stat(this.datei);
      if (st.size > MAX_BYTES) await textSchreiben(this.datei, (await this.#zeilen()).slice(-2000).join('\n') + '\n');
    }).catch(() => {});
    return this.kette;
  }

  async #zeilen() { try { return (await fs.readFile(this.datei, 'utf8')).split('\n').filter(Boolean); } catch { return []; } }

  async lesen(anzahl = 200) {
    await this.kette;
    const aus = [];
    for (const z of (await this.#zeilen()).reverse()) { try { aus.push(JSON.parse(z)); } catch { /* kaputte Zeile */ } if (aus.length >= anzahl) break; }
    return aus;
  }
}
