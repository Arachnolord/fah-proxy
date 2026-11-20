// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen → Schutzstufen: die Kacheln „Wer darf die Seite öffnen?“ mit aktueller Einstellung und Nutzung. Feste
// Kacheln: Titel und Text änderbar, dazu die Heimnetz-Netze bzw. die Dauer der Anmeldung. Eigene Kacheln: „Nur diese
// Netze“ oder „Diese Netze direkt, alle anderen mit FAH-Anmeldung“ – löschen geht nur, wenn keine Domain sie nutzt.

import { el, api, feld, melden, dialog, fehlerZeigen } from '../app.js';

const ARTEN = { netze: 'Nur diese Netze', netze_anmeldung: 'Diese Netze direkt, alle anderen mit FAH-Anmeldung' };

export async function schutzAbschnitt(wurzel) {
  const karte = el('section', { class: 'karte abstand-oben' });
  wurzel.append(karte);
  const zeichnen = async () => {
    const stufen = await api('GET', '/api/schutzstufen');
    karte.replaceChildren(
      el('div', { class: 'zeile' }, el('h2', { text: 'Schutzstufen' }), el('span', { class: 'ausgleich' }),
        el('button', { class: 'knopf knopf-klein', type: 'button', text: '+ Eigene Kachel', on: { click: () => stufeDialog(null, zeichnen) } })),
      el('p', { class: 'leise', text: 'Die Kacheln „Wer darf die Seite öffnen?“ im Domain-Dialog. Änderungen gelten sofort für alle Domains mit dieser Kachel.' }),
      el('div', { class: 'stufen' }, ...stufen.map((s) => el('div', { class: 'stufe' },
        el('div', { class: 'zeile' }, el('b', { text: s.titel }), s.fest ? null : el('span', { class: 'marke-klein', text: 'eigene' }), el('span', { class: 'ausgleich' }),
          el('span', { class: 'leise', text: `${s.domains} Domain${s.domains === 1 ? '' : 's'}` })),
        el('p', { class: 'leise', text: s.text }),
        el('p', { class: 'mono klein', text: s.einstellung }),
        el('div', { class: 'zeile ende' }, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Bearbeiten', on: { click: () => stufeDialog(s, zeichnen) } }))))));
  };
  await zeichnen();
}

function stufeDialog(s, fertig) {
  const neu = !s; const eigen = neu || !s.fest;
  const form = el('form', { on: { submit: (ev) => ev.preventDefault() } });
  const titel = el('input', { type: 'text', value: s ? s.titel : '', maxLength: 40 });
  const text = el('textarea', { value: s ? s.text : '', maxLength: 160, rows: 2 });
  const art = el('select', {}, ...Object.entries(ARTEN).map(([w, t]) => el('option', { value: w, text: t, selected: (s ? s.art : 'netze') === w })));
  const netze = el('textarea', { value: s ? (s.netze || []).join('\n') : '', placeholder: '192.168.1.0/24\n85.1.2.3', attr: { spellcheck: 'false' } });
  const tage = el('input', { type: 'number', min: 1, max: 365, value: s && s.sitzung_tage ? s.sitzung_tage : 30 });
  const mitNetzen = eigen || s.id === 'heimnetz';
  form.append(...[
    feld({ titel: 'Titel', eingabe: titel, info: 'So heißt die Kachel im Domain-Dialog.', name: 'titel' }),
    feld({ titel: 'Beschreibung', eingabe: text, info: 'Ein Satz unter dem Titel der Kachel.', name: 'text' }),
    eigen ? feld({ titel: 'Art', eingabe: art, info: 'Bei der zweiten Art öffnen Geräte aus den Netzen die Seite direkt, alle anderen sehen die Anmeldeseite.', name: 'art' }) : null,
    mitNetzen ? feld({ titel: s && s.id === 'heimnetz' ? 'Heimnetz und VPN' : 'Netze und Adressen', eingabe: netze, info: 'Ein Netz oder eine Adresse je Zeile, z. B. 192.168.1.0/24 oder 85.1.2.3.', name: 'netze' }) : null,
    s && s.id === 'anmeldung' ? feld({ titel: 'Anmeldung gilt (Tage)', eingabe: tage, info: 'So lange bleibt man an Seiten mit FAH-Anmeldung angemeldet.', name: 'sitzung_tage' }) : null].filter(Boolean));
  const speichern = async () => {
    for (const f of form.querySelectorAll('.feld')) if (f.fehler) f.fehler('');
    const werte = { titel: titel.value.trim(), text: text.value.trim() };
    if (eigen) werte.art = art.value;
    if (mitNetzen) werte.netze = netze.value.split(/[\s,;]+/).filter(Boolean);
    if (s && s.id === 'anmeldung') werte.sitzung_tage = Number(tage.value);
    try { if (neu) await api('POST', '/api/schutzstufen', werte); else await api('PUT', `/api/schutzstufen/${encodeURIComponent(s.id)}`, werte); } catch (e) { fehlerZeigen(e, form); return false; }
    melden(neu ? 'Kachel angelegt' : 'Kachel gespeichert', 'gut');
    await fertig();
    return true;
  };
  const g = dialog({ titel: neu ? 'Eigene Kachel anlegen' : `Kachel „${s.titel}“`, inhalt: form, knoepfe: [
    ...(s && !s.fest ? [{ text: 'Löschen', art: 'knopf-gefahr', aktion: async () => {
      if (s.domains) { melden(`Die Kachel wird noch von ${s.domains} Domain${s.domains === 1 ? '' : 's'} genutzt – dort erst eine andere Stufe wählen.`, 'schlecht', 8000); return false; }
      await api('DELETE', `/api/schutzstufen/${encodeURIComponent(s.id)}`); melden('Kachel gelöscht', 'gut'); g.schliessen(); await fertig(); return true;
    } }] : []),
    { text: 'Abbrechen', art: 'knopf-zweit' },
    { text: neu ? 'Anlegen' : 'Speichern', aktion: speichern },
  ] });
}
