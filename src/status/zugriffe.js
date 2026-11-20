// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zugriffe aus Caddys JSON-Protokoll: je Domain und Stunde Anfragen, 4xx, 5xx; ausgewertet werden die letzten 24 h.
// Die Datei wird ab der letzten Stelle nachgelesen; wird sie kleiner (Caddy rotiert), beginnt das Lesen von vorn.

import fs from 'node:fs/promises';

const STUNDE = 3600000;
const FENSTER = 24 * STUNDE;

export class Zugriffe {
  constructor({ jetzt = () => Date.now() } = {}) { this.jetzt = jetzt; this.eimer = new Map(); this.stelle = 0; this.rest = ''; this.inode = null; }

  zeilen(liste) {
    const grenze = this.jetzt() - FENSTER;
    for (const z of liste) {
      let o; try { o = JSON.parse(z); } catch { continue; }
      if (!o || !o.request || typeof o.status !== 'number' || typeof o.ts !== 'number') continue;
      const ms = o.ts * 1000;
      if (ms < grenze) continue;
      const host = String(o.request.host || '').toLowerCase().replace(/:\d+$/, '');
      if (!host) continue;
      const k = `${host}|${Math.floor(ms / STUNDE)}`;
      const e = this.eimer.get(k) || { n: 0, c4: 0, c5: 0 };
      e.n++; if (o.status >= 400 && o.status < 500) e.c4++; if (o.status >= 500) e.c5++;
      this.eimer.set(k, e);
    }
  }

  zusammenfassung() {
    const grenzStunde = Math.floor((this.jetzt() - FENSTER) / STUNDE);
    const aus = {};
    for (const [k, e] of this.eimer) {
      const [host, stunde] = k.split('|');
      if (Number(stunde) < grenzStunde) { this.eimer.delete(k); continue; }
      const s = aus[host] || (aus[host] = { anfragen: 0, f4xx: 0, f5xx: 0 });
      s.anfragen += e.n; s.f4xx += e.c4; s.f5xx += e.c5;
    }
    return aus;
  }

  /** Neue Zeilen der Protokolldatei auswerten (höchstens 8 MiB je Aufruf). */
  async nachlesen(datei) {
    let st; try { st = await fs.stat(datei); } catch { return; }
    if (st.size < this.stelle || (this.inode !== null && st.ino !== this.inode)) { this.stelle = 0; this.rest = ''; }
    this.inode = st.ino;
    if (st.size === this.stelle) return;
    const fh = await fs.open(datei, 'r');
    try {
      const laenge = Math.min(st.size - this.stelle, 8 * 1024 * 1024);
      const puffer = Buffer.alloc(laenge);
      const { bytesRead } = await fh.read(puffer, 0, laenge, this.stelle);
      this.stelle += bytesRead;
      const text = this.rest + puffer.subarray(0, bytesRead).toString('utf8');
      const teile = text.split('\n');
      this.rest = teile.pop();
      this.zeilen(teile);
    } finally { await fh.close(); }
  }
}
