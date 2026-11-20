// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Bremse gegen Passwortraten: je IP und je Kontoname. Ab dem 5. Fehlversuch wächst die Wartezeit (2, 4, 8 … höchstens
// 300 Sekunden); in der Wartezeit wird auch ein richtiges Passwort nicht geprüft. Erfolg setzt den Zähler zurück.

import { Fehler } from '../gemeinsam/fehler.js';

export const FREI = 4;
export const MAX_WARTE_S = 300;

export class Bremse {
  constructor({ jetzt = () => Date.now() } = {}) { this.zaehler = new Map(); this.jetzt = jetzt; }

  #schluessel(ip, name) { return [`ip:${ip}`, `name:${String(name || '').toLowerCase()}`]; }

  /** Wirft E_BREMSE mit details.warte_s, solange eine Wartezeit läuft. */
  pruefen(ip, name) {
    const jetzt = this.jetzt();
    let warte = 0;
    for (const k of this.#schluessel(ip, name)) { const z = this.zaehler.get(k); if (z && z.bis > jetzt) warte = Math.max(warte, Math.ceil((z.bis - jetzt) / 1000)); }
    if (warte > 0) throw new Fehler('E_BREMSE', `Zu viele Fehlversuche – bitte ${warte} Sekunden warten`, { warte_s: warte });
  }

  fehler(ip, name) {
    const jetzt = this.jetzt();
    for (const k of this.#schluessel(ip, name)) {
      const z = this.zaehler.get(k) || { n: 0, bis: 0 };
      z.n += 1;
      if (z.n > FREI) z.bis = jetzt + Math.min(MAX_WARTE_S, 2 ** (z.n - FREI)) * 1000;
      this.zaehler.set(k, z);
    }
    if (this.zaehler.size > 10000) this.zaehler.clear();
  }

  erfolg(ip, name) { for (const k of this.#schluessel(ip, name)) this.zaehler.delete(k); }
}
