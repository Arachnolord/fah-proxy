// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Oberfläche statisch prüfen: keine HTML-Einschleusung (innerHTML & Co.), keine Inline-Skripte/-Handler/-Stile (die CSP
// verbietet sie), Kopfkommentar, Syntax, Importziele vorhanden, Umlaute statt Ersatzschreibweisen in Texten.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(WURZEL, 'public');

async function dateien(ordner, endung) {
  const aus = [];
  for (const e of await fs.readdir(ordner, { withFileTypes: true })) {
    const p = path.join(ordner, e.name);
    if (e.isDirectory()) aus.push(...await dateien(p, endung)); else if (p.endsWith(endung)) aus.push(p);
  }
  return aus;
}

test('Oberfläche: keine HTML-Einschleusung, kein eval, keine Inline-Stile; Kopfkommentar; Syntax; Importziele vorhanden', async () => {
  const js = await dateien(PUBLIC, '.js');
  assert.ok(js.length >= 6);
  for (const f of js) {
    const t = await fs.readFile(f, 'utf8');
    const name = path.relative(WURZEL, f);
    assert.doesNotMatch(t, /\.(innerHTML|outerHTML)\s*=|insertAdjacentHTML|document\.write|\beval\(|new Function\(/, name);
    assert.doesNotMatch(t, /\bstyle:\s*['"`]/, `${name}: Inline-Stil (CSP)`);
    assert.match(t, /Erdacht und programmiert von Fabian Hammer/, `${name}: Kopfkommentar`);
    execFileSync(process.execPath, ['--check', f]);
    for (const m of t.matchAll(/(?:import\(|from )\s*'(\.[^']+)'/g)) await fs.access(path.resolve(path.dirname(f), m[1]));
  }
});

test('index.html: keine Inline-Skripte oder -Handler, Skript als Modul, Stil und Symbol vorhanden', async () => {
  const t = await fs.readFile(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.doesNotMatch(t, /<script(?![^>]*\bsrc=)[^>]*>/, 'kein Inline-Skript');
  assert.doesNotMatch(t, /\son[a-z]+=/i, 'keine Inline-Handler');
  assert.doesNotMatch(t, /\sstyle=/i, 'keine Inline-Stile');
  assert.match(t, /<script type="module" src="app.js"><\/script>/);
  for (const d of ['stil.css', 'symbol.svg', 'app.js']) await fs.access(path.join(PUBLIC, d));
});

test('Texte mit echten Umlauten (keine ae/oe/ue-Ersatzschreibweisen in sichtbaren Texten)', async () => {
  const verdaechtig = /\b(fuer|ueber|Aenderung|Loeschen|oeffnen|zurueck|waehlen|pruefen|Schluessel)\b/;
  const zeichenketten = /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
  for (const f of await dateien(PUBLIC, '.js')) {
    for (const z of (await fs.readFile(f, 'utf8')).split('\n')) {
      if (/^\s*(import|\/\/|\*)/.test(z)) continue;
      for (const [k] of z.matchAll(zeichenketten)) if (!/^['"`](\/api\/|#\/|\.\/)/.test(k) && !/^['"`][a-z_]+(\.[a-z_]+)+['"`]$/.test(k)) assert.doesNotMatch(k, verdaechtig, `${path.relative(WURZEL, f)}: ${k.slice(0, 100)}`);
    }
  }
});

test('Exportierte Funktionen anderer Module werden nur mit Import benutzt (sonst ReferenceError erst im Browser)', async () => {
  const dateienListe = await dateien(PUBLIC, '.js');
  const inhalt = new Map(await Promise.all(dateienListe.map(async (f) => [f, await fs.readFile(f, 'utf8')])));
  const exporte = new Set();
  for (const t of inhalt.values()) for (const m of t.matchAll(/export (?:async )?(?:function|const|class) ([A-Za-z_$][\w$]*)/g)) exporte.add(m[1]);
  for (const [f, t] of inhalt) {
    const bekannt = new Set();
    for (const m of t.matchAll(/import \{([^}]+)\} from/g)) for (const n of m[1].split(',')) bekannt.add(n.trim().split(/\s+as\s+/).pop());
    for (const m of t.matchAll(/(?:function|const|let|class) ([A-Za-z_$][\w$]*)/g)) bekannt.add(m[1]);
    const code = t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, "''");
    for (const name of exporte) if (!bekannt.has(name) && new RegExp(`(?<![\\w$.])${name.replace('$', '\\$')}(?![\\w$:])`).test(code)) assert.fail(`${path.relative(WURZEL, f)}: ${name} ohne Import`);
  }
});

test('Jeder benutzte Eingabetyp hat einen Stil (sonst sieht das Feld anders aus als die übrigen)', async () => {
  const css = await fs.readFile(path.join(PUBLIC, 'stil.css'), 'utf8');
  const ohneEigenenRahmen = new Set(['checkbox', 'radio', 'hidden', 'file']);
  for (const f of await dateien(PUBLIC, '.js')) {
    for (const m of (await fs.readFile(f, 'utf8')).matchAll(/el\('input', \{[^}]*?type: '([a-z]+)'/g)) {
      if (!ohneEigenenRahmen.has(m[1])) assert.ok(css.includes(`input[type=${m[1]}]`), `${path.relative(WURZEL, f)}: input type=${m[1]} ohne Stil`);
    }
  }
});

test('Domain-Dialog: das Ziel ist immer ein freies, vorbelegtes Textfeld – die Liste bekannter Ziele füllt es nur', async () => {
  const t = await fs.readFile(path.join(PUBLIC, 'ansichten', 'domain.js'), 'utf8');
  assert.match(t, /const zielFrei = el\('input', \{[^}]*value: d \? d\.ziel : ''/, 'Textfeld mit dem bisherigen Ziel vorbelegt');
  assert.match(t, /const zielWert = \(\) => zielFrei\.value\.trim\(\);/, 'gespeichert wird immer das Textfeld');
  assert.doesNotMatch(t, /zielFreiHuelle\.hidden/, 'das Textfeld wird nie versteckt');
});
