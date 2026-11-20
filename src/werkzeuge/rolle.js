// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Rollen per Werkzeug (im Container: docker exec fah-proxy node /app/src/werkzeuge/rolle.js …) – dasselbe wie die Knöpfe
// der Oberfläche, für den Rollentausch ohne Anmeldung:
//   code              Kopplungscode dieser (Haupt-)Instanz ausgeben (30 min, einmal)
//   koppeln <code>    diese Instanz als Ersatz an die Haupt-Instanz koppeln (übernimmt deren Stand)
//   entkoppeln        diese Instanz wieder eigenständig (Haupt) machen – Daten bleiben
//   aktiv             UniFi-Weiterleitung auf diese Instanz stellen (nur wenn FAH-Proxy umgeschaltet ist)
// Nach koppeln/entkoppeln/aktiv den Container neu starten, damit der laufende Server den neuen Stand liest.

import { appOptionen, DATEN } from '../umgebung.js';

const [befehl, wert] = process.argv.slice(2);
const aus = (t) => process.stdout.write(`${t}\n`);

async function app() {
  const { App } = await import('../app.js');
  return App.starten({ ...appOptionen(), hintergrund: false });
}

try {
  if (befehl === 'code') {
    const { SpiegelHaupt } = await import('../spiegel/haupt.js');
    const o = appOptionen();
    const h = await SpiegelHaupt.laden({ daten: DATEN, uiUrl: o.uiUrl, uiZertDatei: o.uiZertDatei });
    const r = await h.codeErzeugen();
    aus(`Kopplungscode (gilt bis ${r.gueltig_bis}, nur einmal):\n${r.code}`);
  } else if (befehl === 'koppeln') {
    if (!wert) throw new Error('Kopplungscode fehlt: rolle.js koppeln <code>');
    const { verbinden } = await import('../spiegel/ersatz.js');
    const a = await app();
    const r = await verbinden(a, wert);
    a.protokoll.eintragen({ wer: 'werkzeug', aktion: 'spiegel.verbunden', ziel: a.einstellungen.lesen().spiegel.haupt_url });
    aus(`Gekoppelt: ${r.domains} Domains, ${r.konten} Konten, ${r.zertifikate} Zertifikate. Jetzt den Container neu starten.`);
  } else if (befehl === 'entkoppeln') {
    const { entkoppeln } = await import('../spiegel/ersatz.js');
    const a = await app();
    await entkoppeln(a);
    a.protokoll.eintragen({ wer: 'werkzeug', aktion: 'spiegel.entkoppelt' });
    aus('Entkoppelt – diese Instanz ist wieder Haupt-Instanz. Jetzt den Container neu starten.');
  } else if (befehl === 'aktiv') {
    const a = await app();
    const r = await a.aktivWerden('werkzeug');
    aus(`Aktiv: ${r.texte.length ? r.texte.join(' ') : 'war schon aktiv'} Jetzt den Container neu starten.`);
  } else {
    throw new Error('Befehle: code | koppeln <code> | entkoppeln | aktiv');
  }
  process.exit(0);
} catch (e) {
  process.stderr.write(`Fehler: ${e.message}\n`);
  process.exit(1);
}
