// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Sitzungen: Oberfläche (art „ui“, 12 h ohne Aktivität) und FAH-Anmeldung vor geschützten Domains (art „fah“, an die
// Domain gebunden, Dauer aus den Einstellungen). Gespeichert wird nur der SHA-256 der Sitzungskennung – wer die Datei
// liest, kann damit keine Sitzung übernehmen. FAH-Sitzungen überleben einen Neustart (daten/sitzungen.json).

import path from 'node:path';
import crypto from 'node:crypto';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';

export const UI_LEERLAUF_MS = 12 * 3600 * 1000;
const hash = (id) => crypto.createHash('sha256').update(String(id)).digest('hex');

export class Sitzungen {
  constructor(datei, eintraege) { this.datei = datei; this.eintraege = eintraege; this.speichernLaeuft = null; }

  static async laden(ordner) {
    const datei = path.join(ordner, 'sitzungen.json');
    const d = await jsonLesen(datei, { sitzungen: {} });
    const s = new Sitzungen(datei, new Map(Object.entries(d.sitzungen || {})));
    s.aufraeumen();
    return s;
  }

  aufraeumen() { const jetzt = Date.now(); for (const [k, v] of this.eintraege) if (v.bis <= jetzt) this.eintraege.delete(k); }

  async #speichern() {
    const fah = Object.fromEntries([...this.eintraege].filter(([, v]) => v.art === 'fah'));
    await jsonSchreiben(this.datei, { sitzungen: fah });
  }

  /** @returns {{id:string, csrf:string}} Kennung nur einmal im Klartext (fürs Cookie). */
  async erstellen({ name, rolle, art = 'ui', domain = null, dauer_ms = UI_LEERLAUF_MS }) {
    this.aufraeumen();
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    this.eintraege.set(hash(id), { name, rolle, art, domain, csrf, bis: Date.now() + dauer_ms, dauer_ms, erstellt: Date.now() });
    if (art === 'fah') await this.#speichern();
    return { id, csrf };
  }

  /** Gültige Sitzung (UI-Sitzungen verlängern sich bei Benutzung) oder null. */
  holen(id, { art = 'ui', domain = null } = {}) {
    if (!id) return null;
    const s = this.eintraege.get(hash(id));
    if (!s || s.bis <= Date.now() || s.art !== art || (art === 'fah' && s.domain !== domain)) return null;
    if (art === 'ui') s.bis = Date.now() + s.dauer_ms;
    return s;
  }

  async beenden(id) { const h = hash(id); const s = this.eintraege.get(h); this.eintraege.delete(h); if (s && s.art === 'fah') await this.#speichern(); }

  async beendenFuer(name) {
    let fah = false;
    for (const [k, v] of this.eintraege) if (v.name === name) { if (v.art === 'fah') fah = true; this.eintraege.delete(k); }
    if (fah) await this.#speichern();
  }
}
