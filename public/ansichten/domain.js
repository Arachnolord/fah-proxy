// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Domain anlegen/bearbeiten in einem Dialog: Name (Subdomain + Basis-Domain), Ziel (bekannte Ziele oder frei, mit
// Prüfknopf), Schutz als vier Kacheln, Erweitert (HSTS, Ziel-Zertifikat, Pfad-Regeln, Notiz, aktiv). Löschen mit Rückfrage.

import { el, api, dialog, feld, melden, fehlerZeigen } from '../app.js';

/** Feste Stufen als Rückfall, falls die Übersicht keine Liste mitbringt (die echten Kacheln verwaltet Einstellungen → Schutzstufen). */
const STUFEN_RUECKFALL = [
  { id: 'oeffentlich', art: 'oeffentlich', titel: 'Öffentlich', text: 'Jeder aus dem Internet kann die Seite öffnen.' },
  { id: 'heimnetz', art: 'netze', titel: 'Nur Heimnetz + VPN', text: 'Nur aus dem Heimnetz oder per WireGuard – alle anderen sehen „Kein Zugriff“.' },
  { id: 'ipliste', art: 'ipliste', titel: 'Eigene IP-Liste', text: 'Nur die Adressen und Netze, die du unten einträgst.' },
  { id: 'anmeldung', art: 'anmeldung', titel: 'Mit FAH-Anmeldung', text: 'FAH-Proxy zeigt vor der App eine Anmeldeseite (Konten unter Einstellungen).' },
];
/** Titel und Farbklasse des Abzeichens einer Stufe. */
export function stufeAbzeichen(stufen, id) {
  const s = (stufen || STUFEN_RUECKFALL).find((x) => x.id === id);
  if (!s) return { titel: 'Unbekannte Stufe', klasse: 'schlecht' };
  return { titel: s.titel, klasse: s.art === 'anmeldung' || s.art === 'netze_anmeldung' ? 'anmeldung' : s.art === 'netze' ? 'heimnetz' : s.art };
}

function pfadZeile(r = {}) {
  const pfad = el('input', { type: 'text', value: r.pfad || '', placeholder: '/push/', attr: { 'aria-label': 'Pfad' } });
  const ziel = el('input', { type: 'text', value: r.ziel || '', placeholder: 'http://192.168.1.23:7867', attr: { 'aria-label': 'Ziel des Pfads' } });
  const strip = el('input', { type: 'checkbox', checked: !!r.praefix_entfernen });
  const z = el('div', { class: 'pfadregel' }, pfad, ziel, el('label', { class: 'leise' }, strip, ' Pfad abschneiden'), el('button', { class: 'knopf knopf-leise knopf-klein', type: 'button', text: '✕', attr: { 'aria-label': 'Pfad-Regel entfernen' }, on: { click: () => z.remove() } }));
  z.wert = () => ({ pfad: pfad.value.trim(), ziel: ziel.value.trim(), praefix_entfernen: strip.checked });
  return z;
}

/** @param {{d?:object, uebersicht:object, beiGespeichert:()=>void}} o */
export function domainDialog({ d = null, uebersicht, beiGespeichert }) {
  const neu = !d;
  const form = el('form', { attr: { novalidate: true } });
  // Name
  const basis = uebersicht.basisdomains || [];
  const sub = el('input', { type: 'text', placeholder: 'z. B. nextcloud', autocomplete: 'off', attr: { spellcheck: 'false' } });
  const basisWahl = el('select', {}, ...basis.map((b) => el('option', { value: b, text: b })), el('option', { value: '', text: 'andere Domain …' }));
  const ganz = el('input', { type: 'text', value: d ? d.domain : '', placeholder: 'nextcloud.beispiel.de', autocomplete: 'off', attr: { spellcheck: 'false' } });
  let nameFeld;
  if (neu && basis.length) {
    const ganzFeld = el('div', { hidden: true }, ganz);
    basisWahl.addEventListener('change', () => { ganzFeld.hidden = basisWahl.value !== ''; sub.parentElement.hidden = basisWahl.value === ''; });
    nameFeld = el('div', { class: 'feld', attr: { 'data-feld': 'domain' } }, el('span', { class: 'titel', text: 'Adresse' }), el('div', { class: 'subdomain' }, sub, el('span', { text: '.' }), basisWahl), ganzFeld, el('p', { class: 'info', text: 'Die Adresse, unter der die App erreichbar sein soll.' }), el('p', { class: 'fehler', hidden: true }));
    nameFeld.fehler = (t) => { nameFeld.classList.toggle('falsch', !!t); const f = nameFeld.querySelector('.fehler'); f.hidden = !t; f.textContent = t || ''; };
  } else nameFeld = feld({ titel: 'Adresse', eingabe: ganz, info: 'Die Adresse, unter der die App erreichbar sein soll.', name: 'domain' });
  const domainWert = () => (neu && basis.length && basisWahl.value ? `${sub.value.trim()}.${basisWahl.value}` : ganz.value.trim());
  // Ziel
  const ziele = uebersicht.ziele || [];
  // Ziel: immer ein freies Textfeld (vorbelegt) – das Zertifikat hängt an der Adresse, nicht am Ziel; die Liste
  // bekannter Ziele füllt das Feld nur per Auswahl
  const zielFrei = el('input', { type: 'text', value: d ? d.ziel : '', placeholder: 'http://192.168.1.23:8080', autocomplete: 'off', attr: { spellcheck: 'false' } });
  const pruefErgebnis = el('span', { class: 'leise' });
  const zielWahl = el('select', { attr: { 'aria-label': 'Bekanntes Ziel übernehmen' } }, el('option', { value: '', text: 'Bekanntes Ziel übernehmen …' }), ...ziele.map((z) => el('option', { value: z.ziel, text: `${z.ziel}  (${z.domains.slice(0, 2).join(', ')}${z.domains.length > 2 ? ' …' : ''})` })));
  zielWahl.addEventListener('change', () => { if (zielWahl.value) { zielFrei.value = zielWahl.value; zielWahl.value = ''; pruefErgebnis.textContent = ''; zielFrei.focus(); } });
  zielFrei.addEventListener('input', () => { pruefErgebnis.textContent = ''; });
  const zielWert = () => zielFrei.value.trim();
  const pruefen = el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Ziel prüfen', on: { click: async () => {
    pruefErgebnis.textContent = 'prüfe …';
    try { const r = await api('POST', '/api/ziel/pruefen', { ziel: zielWert() }); pruefErgebnis.textContent = r.ok ? `✓ antwortet (${r.code}, ${r.ms} ms)` : `✗ ${r.fehler}`; } catch (e) { pruefErgebnis.textContent = `✗ ${e.message}`; }
  } } });
  const zielFeld = el('div', { class: 'feld', attr: { 'data-feld': 'ziel' } }, el('label', { text: 'Ziel (Gerät und Port der App)' }), zielFrei, ziele.length ? el('div', { class: 'abstand-oben' }, zielWahl) : null, el('div', { class: 'zeile abstand-oben' }, pruefen, pruefErgebnis), el('p', { class: 'info', text: 'Wohin FAH-Proxy die Anfragen weiterreicht, z. B. http://192.168.1.23:8080 – jederzeit änderbar, das Zertifikat hängt nur an der Adresse oben.' }), el('p', { class: 'fehler', hidden: true }));
  zielFeld.fehler = (t) => { zielFeld.classList.toggle('falsch', !!t); const f = zielFeld.querySelectorAll('.fehler')[0]; f.hidden = !t; f.textContent = t || ''; };
  // Rubrik: frei wählbar, Vorschläge aus den vorhandenen
  const rubrikListe = el('datalist', { id: `rubriken-${Math.random().toString(36).slice(2, 7)}` }, ...(uebersicht.rubriken || []).map((r) => el('option', { value: r })));
  const rubrik = el('input', { type: 'text', value: d ? d.rubrik || '' : '', maxLength: 40, placeholder: 'z. B. Medien', autocomplete: 'off', attr: { list: rubrikListe.id } });
  const rubrikFeld = feld({ titel: 'Rubrik', eingabe: rubrik, info: 'Domains mit derselben Rubrik stehen in der Übersicht zusammen. Leer = „Ohne Rubrik“.', name: 'rubrik' });
  rubrikFeld.append(rubrikListe);
  // Schutz
  const gruppe = `schutz-${Math.random().toString(36).slice(2, 7)}`;
  const ipListe = el('textarea', { placeholder: '85.1.2.3\n10.20.0.0/16', value: d ? (d.ip_liste || []).join('\n') : '' });
  const ipFeld = feld({ titel: 'Erlaubte Adressen und Netze', eingabe: ipListe, info: 'Eine Adresse oder ein Netz je Zeile, z. B. 85.1.2.3 oder 10.20.0.0/16.', name: 'ip_liste' });
  const stufen = uebersicht.schutzstufen || STUFEN_RUECKFALL;
  const istIpListe = () => (stufen.find((s) => s.id === schutzWert()) || {}).art === 'ipliste';
  const kacheln = el('div', { class: 'kacheln', attr: { role: 'radiogroup', 'aria-label': 'Schutz' } }, ...stufen.map((s) => el('label', { class: 'kachel-wahl' }, el('input', { type: 'radio', name: gruppe, value: s.id, checked: (d ? d.schutz : 'oeffentlich') === s.id, on: { change: () => { ipFeld.hidden = !istIpListe(); } } }), el('b', { text: s.titel }), el('span', { text: s.text }))));
  const schutzWert = () => (form.querySelector(`input[name="${gruppe}"]:checked`) || {}).value || 'oeffentlich';
  ipFeld.hidden = !istIpListe();
  const schutzFeld = el('div', { class: 'feld', attr: { 'data-feld': 'schutz' } }, el('span', { class: 'titel', text: 'Wer darf die Seite öffnen?' }), kacheln, el('p', { class: 'fehler', hidden: true }));
  // Erweitert
  const hsts = el('input', { type: 'checkbox', checked: d ? d.hsts !== false : true });
  const tlsPruefen = el('input', { type: 'checkbox', checked: d ? !!d.ziel_tls_pruefen : false });
  const aktiv = el('input', { type: 'checkbox', checked: d ? d.aktiv !== false : true });
  const notiz = el('input', { type: 'text', value: d ? d.notiz || '' : '', maxLength: 300 });
  const pfadListe = el('div', {}, ...((d && d.pfade) || []).map(pfadZeile));
  const erweitert = el('details', { class: 'erweitert', open: !!(d && ((d.pfade || []).length || d.hsts === false || !d.aktiv)) }, el('summary', { text: 'Erweitert' }),
    el('label', { class: 'schalter' }, aktiv, el('span', {}, el('b', { text: 'Aktiv' }), el('br'), el('span', { class: 'leise', text: 'Ausgeschaltet bleibt die Domain gespeichert, ist aber nicht erreichbar.' }))),
    el('label', { class: 'schalter' }, hsts, el('span', {}, el('b', { text: 'HSTS' }), el('br'), el('span', { class: 'leise', text: 'Browser merken sich, die Seite nur noch per HTTPS zu öffnen. Empfohlen.' }))),
    el('label', { class: 'schalter' }, tlsPruefen, el('span', {}, el('b', { text: 'Zertifikat des Ziels prüfen' }), el('br'), el('span', { class: 'leise', text: 'Nur bei HTTPS-Zielen mit echtem Zertifikat einschalten – Geräte im Heimnetz haben meist ein selbstsigniertes.' }))),
    el('div', { class: 'feld', attr: { 'data-feld': 'pfade' } }, el('span', { class: 'titel', text: 'Pfad-Regeln' }), pfadListe,
      el('div', {}, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: '+ Pfad-Regel', on: { click: () => pfadListe.append(pfadZeile()) } })),
      el('p', { class: 'info', text: 'Einzelne Pfade an ein anderes Ziel, z. B. /push/ für Nextcloud. „Pfad abschneiden“ reicht den Rest ohne den Pfad weiter.' }), el('p', { class: 'fehler', hidden: true })),
    feld({ titel: 'Notiz', eingabe: notiz, info: 'Nur für dich, z. B. wofür die Domain da ist.', name: 'notiz' }));
  const pf = erweitert.querySelector('[data-feld="pfade"]');
  pf.fehler = (t) => { pf.classList.toggle('falsch', !!t); const f = pf.querySelector('.fehler'); f.hidden = !t; f.textContent = t || ''; };
  schutzFeld.fehler = (t) => { const f = schutzFeld.querySelector('.fehler'); f.hidden = !t; f.textContent = t || ''; };
  form.append(nameFeld, zielFeld, rubrikFeld, schutzFeld, ipFeld, erweitert);

  const werte = () => ({ domain: domainWert(), ziel: zielWert(), rubrik: rubrik.value.trim(), schutz: schutzWert(), ip_liste: ipListe.value.split(/[\s,;]+/).filter(Boolean), hsts: hsts.checked, ziel_tls_pruefen: tlsPruefen.checked, aktiv: aktiv.checked, notiz: notiz.value, pfade: [...pfadListe.children].map((z) => z.wert()).filter((p) => p.pfad || p.ziel) });
  const speichern = async () => {
    for (const f of form.querySelectorAll('.feld')) if (f.fehler) f.fehler('');
    try {
      const r = neu ? await api('POST', '/api/domains', werte()) : await api('PUT', `/api/domains/${d.id}`, werte());
      melden(neu ? `${r.domain.domain} ist angelegt${r.caddy && r.caddy.ausstehend ? ' (Caddy startet noch)' : ''}` : `${r.domain.domain} ist gespeichert`, 'gut');
      beiGespeichert();
    } catch (e) { fehlerZeigen(e, form); return false; }
  };
  const knoepfe = [{ text: 'Abbrechen', art: 'knopf-zweit' }];
  if (!neu) knoepfe.unshift({ text: 'Löschen', art: 'knopf-gefahr', aktion: () => new Promise((fertig) => {
    dialog({ titel: `${d.domain} löschen?`, inhalt: el('p', { text: 'Die Domain ist danach über FAH-Proxy nicht mehr erreichbar. Die App selbst bleibt unberührt.' }), knoepfe: [{ text: 'Abbrechen', art: 'knopf-zweit', aktion: () => { fertig(false); } }, { text: 'Endgültig löschen', art: 'knopf-gefahr', aktion: async () => { await api('DELETE', `/api/domains/${d.id}`); melden(`${d.domain} gelöscht`, 'gut'); beiGespeichert(); fertig(true); } }] });
  }) });
  knoepfe.push({ text: neu ? 'Anlegen' : 'Speichern', aktion: speichern });
  const g = dialog({ titel: neu ? 'Domain anlegen' : `${d.domain} bearbeiten`, inhalt: form, knoepfe });
  form.addEventListener('submit', (ev) => { ev.preventDefault(); speichern().then((r) => { if (r !== false) g.schliessen(); }); });
  return g;
}
