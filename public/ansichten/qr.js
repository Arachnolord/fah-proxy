// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Eigener QR-Code-Encoder (ISO/IEC 18004) ohne Fremdbibliothek: Byte-Modus, Fehlerkorrektur-Stufe M,
// Versionen 1–10 (bis 213 Byte – reicht für otpauth-URIs). Reed-Solomon über GF(256), 8 Masken mit Bewertung,
// Format- und Versionsinformation per BCH. Reine Funktionen; das Zeichnen auf Canvas ist getrennt.

// ---------------------------------------------------------------------------------------------------------------
// GF(256) mit dem QR-Polynom x^8 + x^4 + x^3 + x^2 + 1 (0x11d)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tabellen() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

export function gfMul(a, b) { if (a === 0 || b === 0) return 0; return EXP[LOG[a] + LOG[b]]; }

/** Generatorpolynom für n Fehlerkorrektur-Codewörter (Koeffizienten höchster Grad zuerst, monisch). */
export function generatorpolynom(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const neu = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { neu[j] ^= g[j]; neu[j + 1] ^= gfMul(g[j], EXP[i]); }
    g = neu;
  }
  return g;
}

/** Reed-Solomon-Fehlerkorrektur: n Codewörter zu einem Datenblock. */
export function fehlerkorrektur(daten, n) {
  const g = generatorpolynom(n);
  const rest = new Array(n).fill(0);
  for (const d of daten) {
    const faktor = d ^ rest.shift();
    rest.push(0);
    if (faktor !== 0) for (let j = 0; j < n; j++) rest[j] ^= gfMul(g[j + 1], faktor);
  }
  return rest;
}

// ---------------------------------------------------------------------------------------------------------------
// Tabellen für Stufe M, Versionen 1–10: ec = EC-Codewörter je Block, bloecke = [[Anzahl, Datenlänge], …]

export const BLOECKE_M = Object.freeze({
  1: { ec: 10, bloecke: [[1, 16]] },
  2: { ec: 16, bloecke: [[1, 28]] },
  3: { ec: 26, bloecke: [[1, 44]] },
  4: { ec: 18, bloecke: [[2, 32]] },
  5: { ec: 24, bloecke: [[2, 43]] },
  6: { ec: 16, bloecke: [[4, 27]] },
  7: { ec: 18, bloecke: [[4, 31]] },
  8: { ec: 22, bloecke: [[2, 38], [2, 39]] },
  9: { ec: 22, bloecke: [[3, 36], [2, 37]] },
  10: { ec: 26, bloecke: [[4, 43], [1, 44]] },
});

const AUSRICHTUNG = Object.freeze({
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
});

export function datenCodewoerter(version) { return BLOECKE_M[version].bloecke.reduce((s, [n, l]) => s + n * l, 0); }
export function gesamtCodewoerter(version) { const b = BLOECKE_M[version]; return datenCodewoerter(version) + b.ec * b.bloecke.reduce((s, [n]) => s + n, 0); }
export function zaehlerBits(version) { return version <= 9 ? 8 : 16; }
/** Wie viele Bytes passen (Byte-Modus) in diese Version bei Stufe M? */
export function kapazitaetBytes(version) { return Math.floor((datenCodewoerter(version) * 8 - 4 - zaehlerBits(version)) / 8); }

export function versionWaehlen(byteAnzahl) {
  for (let v = 1; v <= 10; v++) if (kapazitaetBytes(v) >= byteAnzahl) return v;
  throw new Error('Text zu lang für QR-Version 10 (max. 213 Byte)');
}

// ---------------------------------------------------------------------------------------------------------------
// BCH: Formatinformation (15 Bit) und Versionsinformation (18 Bit)

const EC_BITS = Object.freeze({ L: 0b01, M: 0b00, Q: 0b11, H: 0b10 });

export function formatBits(stufe, maske) {
  const daten = (EC_BITS[stufe] << 3) | maske;
  let rest = daten;
  for (let i = 0; i < 10; i++) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
  return ((daten << 10) | rest) ^ 0x5412;
}

export function versionBits(version) {
  let rest = version;
  for (let i = 0; i < 12; i++) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
  return (version << 12) | rest;
}

// ---------------------------------------------------------------------------------------------------------------
// Bitstrom: Modus 0100, Zähler, Daten, Abschluss, Füllbytes

export function bitstrom(bytes, version) {
  const bits = [];
  const schreib = (wert, n) => { for (let i = n - 1; i >= 0; i--) bits.push((wert >>> i) & 1); };
  schreib(0b0100, 4);
  schreib(bytes.length, zaehlerBits(version));
  for (const b of bytes) schreib(b, 8);
  const kapazitaet = datenCodewoerter(version) * 8;
  schreib(0, Math.min(4, kapazitaet - bits.length));
  while (bits.length % 8) bits.push(0);
  const fuell = [0xec, 0x11];
  for (let i = 0; bits.length < kapazitaet; i ^= 1) schreib(fuell[i], 8);
  const woerter = [];
  for (let i = 0; i < bits.length; i += 8) woerter.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  return woerter;
}

/** Teilt in Blöcke, berechnet EC und verschachtelt zu einer Codewortfolge. */
export function verschachteln(datenwoerter, version) {
  const { ec, bloecke } = BLOECKE_M[version];
  const bl = [];
  let pos = 0;
  for (const [anzahl, laenge] of bloecke) for (let i = 0; i < anzahl; i++) { const d = datenwoerter.slice(pos, pos + laenge); pos += laenge; bl.push({ daten: d, ec: fehlerkorrektur(d, ec) }); }
  const aus = [];
  const maxDaten = Math.max(...bl.map((b) => b.daten.length));
  for (let i = 0; i < maxDaten; i++) for (const b of bl) if (i < b.daten.length) aus.push(b.daten[i]);
  for (let i = 0; i < ec; i++) for (const b of bl) aus.push(b.ec[i]);
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------
// Matrix

function neueMatrix(groesse) { return Array.from({ length: groesse }, () => new Uint8Array(groesse)); }

/** Zeichnet Funktionsmuster; gibt {module, funktion} zurück (funktion = 1 wo kein Datenmodul liegen darf). */
function funktionsmuster(version) {
  const g = version * 4 + 17;
  const module = neueMatrix(g);
  const funktion = neueMatrix(g);
  const setze = (x, y, dunkel) => { if (x < 0 || y < 0 || x >= g || y >= g) return; module[y][x] = dunkel ? 1 : 0; funktion[y][x] = 1; };
  // Suchmuster mit Trennlinie (9×9, beschnitten)
  const sucher = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      setze(cx + dx, cy + dy, d !== 2 && d !== 4);
    }
  };
  sucher(3, 3); sucher(g - 4, 3); sucher(3, g - 4);
  // Taktmuster
  for (let i = 8; i < g - 8; i++) { setze(6, i, i % 2 === 0); setze(i, 6, i % 2 === 0); }
  // Ausrichtungsmuster
  const pos = AUSRICHTUNG[version];
  for (const cy of pos) for (const cx of pos) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === g - 7) || (cx === g - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setze(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Platz für Formatinformation (wird später gesetzt) + dunkles Modul; (8,6) und (6,8) gehören dem Taktmuster
  for (let i = 0; i < 9; i++) { if (i === 6) continue; setze(8, i, false); setze(i, 8, false); }
  for (let i = 0; i < 8; i++) { setze(g - 1 - i, 8, false); setze(8, g - 1 - i, false); }
  setze(8, g - 8, true);
  // Versionsinformation
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = g - 11 + (i % 3); const b = Math.floor(i / 3);
      setze(a, b, bit); setze(b, a, bit);
    }
  }
  return { module, funktion, groesse: g };
}

function formatSetzen(module, groesse, stufe, maske) {
  const bits = formatBits(stufe, maske);
  const bit = (i) => (bits >>> i) & 1;
  const setze = (x, y, d) => { module[y][x] = d; };
  for (let i = 0; i <= 5; i++) setze(8, i, bit(i));
  setze(8, 7, bit(6)); setze(8, 8, bit(7)); setze(7, 8, bit(8));
  for (let i = 9; i < 15; i++) setze(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) setze(groesse - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) setze(8, groesse - 15 + i, bit(i));
  setze(8, groesse - 8, 1);
}

/** Legt die Codewörter im Zickzack ab (rechts unten beginnend, Spalte 6 überspringen). */
function datenAblegen(module, funktion, groesse, codewoerter) {
  const bits = [];
  for (const w of codewoerter) for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1);
  let i = 0;
  for (let rechts = groesse - 1; rechts >= 1; rechts -= 2) {
    if (rechts === 6) rechts = 5;
    for (let senk = 0; senk < groesse; senk++) {
      for (let j = 0; j < 2; j++) {
        const x = rechts - j;
        const aufwaerts = ((rechts + 1) & 2) === 0;
        const y = aufwaerts ? groesse - 1 - senk : senk;
        if (!funktion[y][x] && i < bits.length) { module[y][x] = bits[i]; i++; }
        // Restbits bleiben 0
      }
    }
  }
}

export function maskeBit(maske, x, y) {
  switch (maske) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: throw new Error('Maske 0–7');
  }
}

function maskeAnwenden(module, funktion, groesse, maske) {
  for (let y = 0; y < groesse; y++) for (let x = 0; x < groesse; x++) if (!funktion[y][x] && maskeBit(maske, x, y)) module[y][x] ^= 1;
}

/** Strafpunkte nach ISO 18004 (Läufe, 2×2-Blöcke, Sucher-ähnliche Muster, Dunkelanteil). */
export function strafpunkte(module, groesse) {
  let s = 0;
  const linie = (holen) => {
    const zeile = new Array(groesse);
    for (let i = 0; i < groesse; i++) zeile[i] = holen(i);
    // Regel 1: Läufe ≥ 5
    let lauf = 1;
    for (let i = 1; i <= groesse; i++) {
      if (i < groesse && zeile[i] === zeile[i - 1]) { lauf++; continue; }
      if (lauf >= 5) s += 3 + (lauf - 5);
      lauf = 1;
    }
    // Regel 3: 1011101 mit 4 hellen Modulen davor oder danach
    for (let i = 0; i + 7 <= groesse; i++) {
      if (zeile[i] && !zeile[i + 1] && zeile[i + 2] && zeile[i + 3] && zeile[i + 4] && !zeile[i + 5] && zeile[i + 6]) {
        const vor = i >= 4 && !zeile[i - 1] && !zeile[i - 2] && !zeile[i - 3] && !zeile[i - 4];
        const nach = i + 11 <= groesse && !zeile[i + 7] && !zeile[i + 8] && !zeile[i + 9] && !zeile[i + 10];
        if (vor) s += 40;
        if (nach) s += 40;
      }
    }
  };
  for (let y = 0; y < groesse; y++) linie((x) => module[y][x]);
  for (let x = 0; x < groesse; x++) linie((y) => module[y][x]);
  // Regel 2: 2×2-Blöcke
  for (let y = 0; y + 1 < groesse; y++) for (let x = 0; x + 1 < groesse; x++) {
    const a = module[y][x];
    if (a === module[y][x + 1] && a === module[y + 1][x] && a === module[y + 1][x + 1]) s += 3;
  }
  // Regel 4: Dunkelanteil
  let dunkel = 0;
  for (let y = 0; y < groesse; y++) for (let x = 0; x < groesse; x++) dunkel += module[y][x];
  const gesamt = groesse * groesse;
  const k = Math.ceil(Math.abs(dunkel * 20 - gesamt * 10) / gesamt) - 1;
  s += Math.max(0, k) * 10;
  return s;
}

/**
 * Erzeugt einen QR-Code (Stufe M) aus Text (UTF-8).
 * @returns {{version:number, groesse:number, maske:number, module:Uint8Array[], format:number, funktion:Uint8Array[]}}
 */
export function qrErzeugen(text, { maske: erzwungeneMaske } = {}) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : Uint8Array.from(text);
  const version = versionWaehlen(bytes.length);
  const codewoerter = verschachteln(bitstrom(bytes, version), version);
  const { module: basis, funktion, groesse } = funktionsmuster(version);
  datenAblegen(basis, funktion, groesse, codewoerter);
  let beste = null;
  const kandidaten = erzwungeneMaske !== undefined ? [erzwungeneMaske] : [0, 1, 2, 3, 4, 5, 6, 7];
  for (const m of kandidaten) {
    const module = basis.map((z) => Uint8Array.from(z));
    maskeAnwenden(module, funktion, groesse, m);
    formatSetzen(module, groesse, 'M', m);
    const punkte = strafpunkte(module, groesse);
    if (!beste || punkte < beste.punkte) beste = { module, maske: m, punkte };
  }
  return { version, groesse, maske: beste.maske, module: beste.module, format: formatBits('M', beste.maske), funktion, stufe: 'M' };
}

/** Textraster (für Tests und Konsolen): dunkel = ██, hell = zwei Leerzeichen. */
export function qrAlsText(qr, dunkel = '██', hell = '  ') {
  return qr.module.map((z) => Array.from(z, (m) => (m ? dunkel : hell)).join('')).join('\n');
}

/** Zeichnet den Code auf ein Canvas (Ruhezone 4 Module). Farben aus CSS-Variablen unabhängig – immer schwarz auf weiß. */
export function qrZeichnen(canvas, qr, pixelJeModul = 5, rand = 4) {
  const g = qr.groesse + rand * 2;
  canvas.width = g * pixelJeModul; canvas.height = g * pixelJeModul;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas ohne 2D-Kontext');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.groesse; y++) for (let x = 0; x < qr.groesse; x++) if (qr.module[y][x]) ctx.fillRect((x + rand) * pixelJeModul, (y + rand) * pixelJeModul, pixelJeModul, pixelJeModul);
  return canvas;
}
