// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Protokoll: wer hat wann was geändert, dazu Störungen und Erholungen der Ziele (neueste zuerst, 200 Einträge).

import { el, api, zeit } from '../app.js';

const TEXT = {
  'domain.angelegt': 'Domain angelegt', 'domain.geaendert': 'Domain geändert', 'domain.geloescht': 'Domain gelöscht',
  'npm.uebernommen': 'Aus dem NPM übernommen', 'einstellungen.geaendert': 'Einstellungen geändert',
  'ziel.gestoert': 'Ziel gestört', 'ziel.wieder_erreichbar': 'Ziel wieder erreichbar',
  'umschalten.uebernommen': 'Auf FAH-Proxy umgeschaltet', 'umschalten.ohne_unifi': 'Umgeschaltet (ohne UniFi)', 'umschalten.zurueck': 'Zurück zum NPM geschaltet', 'umschalten.fehlgeschlagen': 'Umschalten gescheitert',
  'schutz.angelegt': 'Schutz-Kachel angelegt', 'schutz.geaendert': 'Schutz-Kachel geändert', 'schutz.geloescht': 'Schutz-Kachel gelöscht',
  'zertifikate.vom_ersatz': 'Zertifikate von der Ersatz-Instanz übernommen',
  'failover.uebernommen': 'Fail-over: übernommen', 'failover.zurueck': 'Fail-over: zurückgegeben', 'failover.fehlgeschlagen': 'Fail-over gescheitert',
  'spiegel.gekoppelt': 'Ersatz-Instanz gekoppelt', 'spiegel.entfernt': 'Ersatz-Instanz entfernt', 'spiegel.verbunden': 'Als Ersatz gekoppelt',
  'spiegel.entkoppelt': 'Ersatz-Kopplung gelöst', 'spiegel.abgeglichen': 'Vom Haupt abgeglichen', 'konto.angelegt': 'Konto angelegt', 'konto.geaendert': 'Konto geändert', 'konto.geloescht': 'Konto gelöscht',
};

function details(e) {
  if (!e.details) return '';
  const d = e.details;
  if (d.fehler) return d.fehler;
  if (e.aktion === 'npm.uebernommen') return `${d.angelegt} neu, ${d.aktualisiert} aktualisiert, ${d.zertifikate} Zertifikate`;
  if (d.felder) return d.felder.join(', ');
  if (d.vorher) return `vorher: ${d.vorher.ziel} (${d.vorher.schutz})`;
  if (d.ziel) return d.ziel;
  return '';
}

export async function zeigen(wurzel) {
  const liste = await api('GET', '/api/protokoll');
  wurzel.append(el('h1', { text: 'Protokoll' }), el('p', { class: 'unter', text: 'Änderungen und Störungen, neueste zuerst.' }));
  if (!liste.length) { wurzel.append(el('p', { class: 'leise', text: 'Noch keine Einträge.' })); return; }
  wurzel.append(el('div', { class: 'karte huelle' }, el('table', { class: 'tabelle' },
    el('thead', {}, el('tr', {}, el('th', { text: 'Zeit' }), el('th', { text: 'Wer' }), el('th', { text: 'Was' }), el('th', { text: 'Domain' }), el('th', { text: 'Einzelheiten' }))),
    el('tbody', {}, ...liste.map((e) => el('tr', {}, el('td', { text: zeit(e.zeit) }), el('td', { text: e.wer }), el('td', { text: TEXT[e.aktion] || e.aktion }), el('td', { class: 'mono', text: e.ziel || '' }), el('td', { class: 'leise', text: details(e) })))))));
}
