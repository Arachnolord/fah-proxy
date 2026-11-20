// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Übersicht: Kennzahlen, Hinweise (Testbetrieb, Caddy), Suche/Filter, je Domain eine Karte mit Ampel (Ziel erreichbar),
// Schutz, Zertifikat, Zugriffen 24 h; „Domain anlegen“. Gruppiert nach Rubrik (auf-/zuklappbar),
// Umschalter Kacheln/Liste (beides merkt sich der Browser). Aktualisiert sich alle 30 s.

import { el, api, dialog, melden, zeit, datum, tageBis, modusZeigen } from '../app.js';
import { domainDialog, stufeAbzeichen } from './domain.js';

/** Was Kachel und Listenzeile über eine Domain zeigen. */
function angaben(d, ue) {
  const st = d.status; const z = d.zertifikat; const rest = z ? tageBis(z.bis) : null;
  const zgr = d.zugriffe || { anfragen: 0, f4xx: 0, f5xx: 0 };
  return {
    rest, zgr, sa: stufeAbzeichen(ue.schutzstufen, d.schutz),
    ampel: !d.aktiv ? '' : !st ? '' : st.ok ? 'gut' : 'schlecht',
    statusText: !d.aktiv ? 'abgeschaltet' : !st ? 'wird geprüft …' : st.ok ? `erreichbar · ${st.ms} ms` : `Domain an, aber: ${st.fehler} · seit ${zeit(st.seit)}`,
    zertText: !z || !z.bis ? (ue.modus === 'test' ? 'keins übernommen' : 'wird geholt') : `bis ${datum(z.bis)} (${z.aktiv === 'caddy' ? 'von FAH-Proxy geholt' : 'übernommen'})`,
    zugriffeText: `${zgr.anfragen}${zgr.f5xx ? ` · ${zgr.f5xx} Serverfehler` : ''}${zgr.f4xx ? ` · ${zgr.f4xx} abgewiesen` : ''}`,
  };
}

/** Listenansicht einer Gruppe: eine Zeile je Domain. */
function tabelle(ds, ue, neuLaden) {
  return el('div', { class: 'karte huelle' }, el('table', { class: 'tabelle domainliste' },
    el('thead', {}, el('tr', {}, ...['', 'Domain', 'Ziel', 'Schutz', 'Status', 'Zertifikat', 'Zugriffe 24 h', ''].map((x) => el('th', { text: x })))),
    el('tbody', {}, ...ds.map((d) => {
      const a = angaben(d, ue);
      return el('tr', { class: d.aktiv ? '' : 'aus' },
        el('td', {}, el('span', { class: `punkt ${a.ampel}`, attr: { 'aria-hidden': 'true' } })),
        el('td', {}, el('a', { href: `https://${d.domain}`, target: '_blank', rel: 'noopener noreferrer', text: d.domain })),
        el('td', { class: 'mono leise', text: d.ziel }),
        el('td', {}, el('span', { class: `marke-klein ${a.sa.klasse}`, text: a.sa.titel })),
        el('td', { class: a.ampel === 'schlecht' ? 'zahl-schlecht' : 'leise', text: a.statusText }),
        el('td', { class: a.rest !== null && a.rest < 14 ? 'zahl-warn' : 'leise', text: a.zertText }),
        el('td', { class: 'leise', text: a.zugriffeText }),
        el('td', {}, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Bearbeiten', on: { click: () => domainDialog({ d, uebersicht: ue, beiGespeichert: neuLaden }) } })));
    }))));
}

const merken = (k, v) => { try { localStorage.setItem(k, v); } catch { /* ohne Speicher */ } };
const erinnern = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function karte(d, ue, neuLaden) {
  const { rest, sa, ampel, statusText, zertText, zugriffeText } = angaben(d, ue);
  const abz = el('div', { class: 'abzeichen' }, el('span', { class: `marke-klein ${sa.klasse}`, text: sa.titel }));
  if ((d.pfade || []).length) abz.append(el('span', { class: 'marke-klein', text: `${d.pfade.length} Pfad-Regel${d.pfade.length > 1 ? 'n' : ''}` }));
  if (rest !== null && rest < 14) abz.append(el('span', { class: `marke-klein ${rest < 3 ? 'schlecht' : 'warn'}`, text: rest < 0 ? 'Zertifikat abgelaufen' : `Zertifikat noch ${rest} Tage` }));
  const knoepfe = el('div', { class: 'zeile ende' });
  knoepfe.append(el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Bearbeiten', on: { click: () => domainDialog({ d, uebersicht: ue, beiGespeichert: neuLaden }) } }));
  return el('article', { class: `karte domain${d.aktiv ? '' : ' aus'}` },
    el('div', { class: 'domain-kopf' }, el('span', { class: `punkt ${ampel}`, attr: { 'aria-hidden': 'true' } }), el('a', { href: `https://${d.domain}`, target: '_blank', rel: 'noopener noreferrer', text: d.domain })),
    el('div', { class: 'mono leise', text: `→ ${d.ziel}` }),
    abz,
    el('dl', { class: 'daten' }, el('dt', { text: 'Status' }), el('dd', { text: statusText }), el('dt', { text: 'Zertifikat' }), el('dd', { text: zertText }),
      el('dt', { text: 'Zugriffe 24 h' }), el('dd', { text: zugriffeText })),
    d.notiz ? el('p', { class: 'leise', text: d.notiz }) : null,
    knoepfe);
}

export async function zeigen(wurzel) {
  let ue = await api('GET', '/api/uebersicht');
  let filter = ''; let suche = '';
  const kopf = el('div');
  const hinweise = el('div');
  const kennzahlen = el('div', { class: 'kennzahlen' });
  const raster = el('div');
  let ansicht = erinnern('fp-ansicht') === 'liste' ? 'liste' : 'kacheln';
  const zu = new Set(String(erinnern('fp-rubriken-zu') || '').split('\n').filter(Boolean));
  const ansichtKnopf = (wert, text) => el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text, attr: { 'aria-pressed': String(ansicht === wert) }, on: { click: () => { ansicht = wert; merken('fp-ansicht', wert); umschalter.replaceChildren(ansichtKnopf('kacheln', 'Kacheln'), ansichtKnopf('liste', 'Liste')); zeichnen(); } } });
  const umschalter = el('div', { class: 'umschalter', attr: { role: 'group', 'aria-label': 'Ansicht' } }, ansichtKnopf('kacheln', 'Kacheln'), ansichtKnopf('liste', 'Liste'));
  const sucheEingabe = el('input', { type: 'search', class: 'suche', placeholder: 'Domain oder Ziel suchen …', attr: { 'aria-label': 'Suche' }, on: { input: () => { suche = sucheEingabe.value.trim().toLowerCase(); zeichnen(); } } });
  const filterWahl = el('select', { attr: { 'aria-label': 'Filter' }, on: { change: () => { filter = filterWahl.value; zeichnen(); } } },
    el('option', { value: '', text: 'Alle' }), el('option', { value: 'stoerung', text: 'Nur Störungen' }), el('option', { value: 'zert', text: 'Zertifikat < 14 Tage' }), el('option', { value: 'aus', text: 'Abgeschaltet' }));
  const neuLaden = async () => { try { ue = await api('GET', '/api/uebersicht'); zeichnen(); } catch { /* Anzeige bleibt */ } };
  const leiste = el('div', { class: 'zeile abstand-unten' }, sucheEingabe, filterWahl, umschalter,
    el('button', { class: 'knopf', type: 'button', text: '+ Domain anlegen', on: { click: () => domainDialog({ uebersicht: ue, beiGespeichert: neuLaden }) } }));
  wurzel.append(kopf, hinweise, kennzahlen, leiste, raster);

  function zeichnen() {
    modusZeigen(ue.modus, ue.rolle);
    const aktiv = ue.domains.filter((d) => d.aktiv);
    const gestoert = aktiv.filter((d) => d.status && !d.status.ok);
    const bald = ue.domains.filter((d) => d.zertifikat && d.zertifikat.bis && tageBis(d.zertifikat.bis) < 14);
    const anfragen = ue.domains.reduce((s, d) => s + (d.zugriffe ? d.zugriffe.anfragen : 0), 0);
    kopf.replaceChildren(el('h1', { text: 'Übersicht' }), el('p', { class: 'unter', text: `${ue.domains.length} Domains · FAH-Proxy ${ue.version}` }));
    hinweise.replaceChildren();
    if (ue.aktiv === false) hinweise.append(el('div', { class: 'hinweis warn' }, el('b', { text: 'Nicht aktiv: ' }), `Das Internet bedient gerade die andere Instanz${ue.aktiv_ip ? ` (${ue.aktiv_ip})` : ''}. Änderungen bitte dort machen – sie kommen automatisch hierher.`));
    else if (ue.modus === 'test') hinweise.append(el('div', { class: 'hinweis' }, el('b', { text: 'Noch nicht umgeschaltet: ' }), `UniFi leitet das Internet noch nicht an FAH-Proxy${ue.test_ports && ue.test_ports.https ? ` (Port ${ue.test_ports.https})` : ''} – das erledigt „Umschalten“.`));
    if (ue.caddy && ue.caddy.ok === false) hinweise.append(el('div', { class: 'hinweis schlecht', text: `Caddy hat die letzte Änderung abgelehnt: ${ue.caddy.fehler}` }));
    else if (ue.caddy && ue.caddy.ausstehend) hinweise.append(el('div', { class: 'hinweis warn', text: 'Caddy startet gerade – die Einstellungen werden übernommen, sobald er bereit ist.' }));
    const ohneZert = (ue.caddy && ue.caddy.hinweise || []).filter((h) => /Zertifikat/.test(h.text)).length;
    if (ohneZert && ue.modus === 'test') hinweise.append(el('div', { class: 'hinweis warn', text: `${ohneZert} Domain${ohneZert > 1 ? 's haben' : ' hat'} noch kein Zertifikat – ${ue.aktiv === false ? 'es kommt mit dem nächsten Abgleich von der aktiven Instanz' : 'Let\'s Encrypt stellt es nach dem Umschalten aus'}.` }));
    kennzahlen.replaceChildren(
      el('div', { class: 'kennzahl' }, el('b', { text: String(aktiv.length) }), el('span', { text: 'aktive Domains' })),
      el('div', { class: 'kennzahl' }, el('b', { text: String(aktiv.length - gestoert.length) }), el('span', { text: 'erreichbar' })),
      el('div', { class: 'kennzahl' }, el('b', { text: String(gestoert.length), class: gestoert.length ? 'zahl-schlecht' : '' }), el('span', { text: 'gestört' })),
      el('div', { class: 'kennzahl' }, el('b', { text: String(bald.length), class: bald.length ? 'zahl-warn' : '' }), el('span', { text: 'Zertifikate < 14 Tage' })),
      el('div', { class: 'kennzahl' }, el('b', { text: anfragen.toLocaleString('de-DE') }), el('span', { text: 'Anfragen 24 h' })));
    let liste = ue.domains;
    if (suche) liste = liste.filter((d) => d.domain.includes(suche) || d.ziel.includes(suche));
    if (filter === 'stoerung') liste = liste.filter((d) => d.aktiv && d.status && !d.status.ok);
    if (filter === 'zert') liste = liste.filter((d) => d.zertifikat && d.zertifikat.bis && tageBis(d.zertifikat.bis) < 14);
    if (filter === 'aus') liste = liste.filter((d) => !d.aktiv);
    // Störungen zuerst, dann alphabetisch
    liste = [...liste].sort((a, b) => Number(!!(b.aktiv && b.status && !b.status.ok)) - Number(!!(a.aktiv && a.status && !a.status.ok)) || a.domain.localeCompare(b.domain));
    // nach Rubrik gruppieren („Ohne Rubrik“ zuletzt); ohne Rubriken keine Überschriften
    const gruppen = new Map();
    for (const d of liste) { const r = d.rubrik || ''; if (!gruppen.has(r)) gruppen.set(r, []); gruppen.get(r).push(d); }
    const namen = [...gruppen.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'de')));
    const darstellen = (ds) => (ansicht === 'liste' ? tabelle(ds, ue, neuLaden) : el('div', { class: 'raster' }, ...ds.map((d) => karte(d, ue, neuLaden))));
    raster.replaceChildren(...(namen.some((n) => n) ? namen.map((n) => {
      const ds = gruppen.get(n);
      const stoerungen = ds.filter((d) => d.aktiv && d.status && !d.status.ok).length;
      const abschnitt = el('details', { class: 'rubrik', open: !zu.has(n), on: { toggle: () => { if (abschnitt.open) zu.delete(n); else zu.add(n); merken('fp-rubriken-zu', [...zu].join('\n')); } } },
        el('summary', {}, el('span', { class: 'rubrik-name', text: n || 'Ohne Rubrik' }), el('span', { class: 'leise', text: ` · ${ds.length} Domain${ds.length === 1 ? '' : 's'}` }), stoerungen ? el('span', { class: 'marke-klein schlecht', text: `${stoerungen} gestört` }) : null),
        darstellen(ds));
      return abschnitt;
    }) : [darstellen(liste)]));
    if (!ue.domains.length) raster.replaceChildren(el('div', { class: 'karte' }, el('h2', { text: 'Noch keine Domains' }), el('p', { class: 'leise', text: 'Lege die erste Domain an.' }), el('div', { class: 'zeile' }, el('button', { class: 'knopf', type: 'button', text: '+ Domain anlegen', on: { click: () => domainDialog({ uebersicht: ue, beiGespeichert: neuLaden }) } }))));
    else if (!liste.length) raster.replaceChildren(el('p', { class: 'leise', text: 'Nichts gefunden.' }));
  }
  zeichnen();
  const t = setInterval(() => { if (!document.contains(wurzel) || !wurzel.contains(raster)) { clearInterval(t); return; } neuLaden(); }, 30_000);
  void melden;
}
