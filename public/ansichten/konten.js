// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen → Konten: wer sich vor Domains mit „Mit FAH-Anmeldung“ anmelden darf (Rolle Nutzer) und wer zusätzlich
// diese Oberfläche bedient (Rolle Admin). Domains je Konto (nichts angehakt = alle geschützten), Sperren, Passwort
// setzen, 2FA per QR-Code einrichten. Das eigene Konto lässt sich hier nicht sperren, herabstufen oder löschen.

import { el, api, feld, melden, dialog, fehlerZeigen, zustand } from '../app.js';
import { qrErzeugen, qrZeichnen } from './qr.js';

const ROLLEN = { nutzer: 'Nutzer – nur FAH-Anmeldung', admin: 'Admin – auch diese Oberfläche' };
const pfadVon = (name) => `/api/konten/${encodeURIComponent(name)}`;
const istIch = (k) => !!(k && zustand.ich && k.name === zustand.ich.name);

export async function kontenAbschnitt(wurzel) {
  const karte = el('section', { class: 'karte abstand-oben' });
  wurzel.append(karte);
  const zeichnen = async () => {
    const [konten, ue] = await Promise.all([api('GET', '/api/konten'), api('GET', '/api/uebersicht')]);
    const mitAnmeldung = new Set((ue.schutzstufen || []).filter((s) => s.art === 'anmeldung' || s.art === 'netze_anmeldung').map((s) => s.id));
    const geschuetzt = ue.domains.filter((d) => mitAnmeldung.has(d.schutz)).map((d) => d.domain).sort();
    const oeffnen = (k) => kontoDialog(k, geschuetzt, zeichnen);
    karte.replaceChildren(
      el('div', { class: 'zeile' }, el('h2', { text: 'Konten' }), el('span', { class: 'ausgleich' }),
        el('button', { class: 'knopf knopf-klein', type: 'button', text: '+ Konto', on: { click: () => oeffnen(null) } })),
      el('p', { class: 'leise', text: 'Wer sich vor Domains mit „Mit FAH-Anmeldung“ anmelden darf. Admins bedienen zusätzlich diese Oberfläche.' }),
      el('div', { class: 'huelle' }, el('table', { class: 'tabelle' },
        el('thead', {}, el('tr', {}, ...['Name', 'Rolle', 'Domains', '2FA', ''].map((t) => el('th', { text: t })))),
        el('tbody', {}, ...konten.map((k) => el('tr', {},
          el('td', {}, el('b', { text: k.name }), istIch(k) ? el('span', { class: 'leise', text: ' (du)' }) : null, ' ', k.gesperrt ? el('span', { class: 'marke-klein schlecht', text: 'gesperrt' }) : null),
          el('td', { text: k.rolle === 'admin' ? 'Admin' : 'Nutzer' }),
          el('td', { class: 'leise', text: k.rolle === 'admin' || !k.domains.length ? 'alle geschützten' : k.domains.join(', ') }),
          el('td', { text: k.totp ? 'an' : 'aus' }),
          el('td', {}, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Bearbeiten', on: { click: () => oeffnen(k) } }))))))));
  };
  await zeichnen();
}

function kontoDialog(k, geschuetzt, fertig) {
  const neu = !k; const ich = istIch(k);
  const form = el('form', { on: { submit: (ev) => ev.preventDefault() } });
  const name = el('input', { type: 'text', value: k ? k.name : '', disabled: !neu, autocomplete: 'off', attr: { autocapitalize: 'none', spellcheck: 'false' } });
  const pw = el('input', { type: 'password', autocomplete: 'new-password', disabled: ich });
  const rolle = el('select', { disabled: ich }, ...Object.entries(ROLLEN).map(([w, t]) => el('option', { value: w, text: t, selected: (k ? k.rolle : 'nutzer') === w })));
  const alle = [...new Set([...geschuetzt, ...(k ? k.domains : [])])].sort();
  const haken = new Map(alle.map((d) => [d, el('input', { type: 'checkbox', checked: !!(k && k.domains.includes(d)) })]));
  const domainFeld = el('div', { class: 'feld', attr: { 'data-feld': 'domains' } }, el('span', { class: 'titel', text: 'Domains' }),
    alle.length ? el('div', { class: 'auswahl' }, ...alle.map((d) => el('label', { class: 'schalter' }, haken.get(d), el('span', { class: 'mono', text: d }))))
      : el('p', { class: 'leise', text: 'Noch keine Domain mit „Mit FAH-Anmeldung“.' }),
    el('p', { class: 'info', text: 'Nichts angehakt = alle Domains mit FAH-Anmeldung. Admins dürfen immer alle.' }), el('p', { class: 'fehler', hidden: true }));
  domainFeld.fehler = (t) => { domainFeld.classList.toggle('falsch', !!t); const f = domainFeld.querySelector('.fehler'); f.hidden = !t; f.textContent = t || ''; };
  const gesperrt = el('input', { type: 'checkbox', checked: !!(k && k.gesperrt), disabled: ich });
  let g;
  const zweiFa = neu ? null : el('div', { class: 'feld' }, el('span', { class: 'titel', text: 'Zwei-Faktor (2FA)' }),
    el('div', { class: 'zeile' }, el('span', { text: k.totp ? 'Eingerichtet' : 'Aus' }),
      el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: k.totp ? 'Ausschalten' : 'Einrichten', on: { click: async () => {
        if (!k.totp) { g.schliessen(); zweiFaDialog(k, fertig); return; }
        try { await api('DELETE', `${pfadVon(k.name)}/2fa`); melden('2FA ausgeschaltet', 'gut'); g.schliessen(); fertig(); } catch (e) { melden(e.message, 'schlecht', 8000); }
      } } })),
    el('p', { class: 'info', text: 'Bei der Anmeldung zusätzlich ein Code aus einer Authenticator-App.' }));
  form.append(...[
    feld({ titel: 'Name', eingabe: name, info: neu ? '2–32 Zeichen: Kleinbuchstaben, Ziffern, Punkt, Binde- und Unterstrich.' : '', name: 'name' }),
    feld({ titel: neu ? 'Passwort' : 'Neues Passwort', eingabe: pw, name: neu ? 'passwort' : 'neu',
      info: neu ? 'Mindestens 10 Zeichen.' : ich ? 'Dein eigenes Passwort änderst du oben unter „Mein Passwort“.' : 'Leer lassen, um es zu behalten. Ein neues Passwort meldet das Konto überall ab.' }),
    feld({ titel: 'Rolle', eingabe: rolle, info: 'Nutzer melden sich nur vor geschützten Domains an, Admins bedienen auch FAH-Proxy.', name: 'rolle' }),
    domainFeld,
    neu ? null : el('label', { class: 'schalter' }, gesperrt, el('span', {}, el('b', { text: 'Gesperrt' }), el('br'),
      el('span', { class: 'leise', text: ich ? 'Das eigene Konto kann man nicht sperren.' : 'Gesperrte Konten können sich nicht anmelden; bestehende Anmeldungen enden sofort.' }))),
    zweiFa].filter(Boolean));
  const speichern = async () => {
    for (const f of form.querySelectorAll('.feld')) if (f.fehler) f.fehler('');
    const domains = [...haken].filter(([, h]) => h.checked).map(([d]) => d);
    try {
      if (neu) await api('POST', '/api/konten', { name: name.value.trim(), passwort: pw.value, rolle: rolle.value, domains });
      else {
        await api('PUT', pfadVon(k.name), { rolle: rolle.value, domains, gesperrt: gesperrt.checked });
        if (pw.value) await api('POST', `${pfadVon(k.name)}/passwort`, { neu: pw.value });
      }
    } catch (e) { fehlerZeigen(e, form); return false; }
    melden(neu ? 'Konto angelegt' : 'Konto gespeichert', 'gut');
    fertig();
    return true;
  };
  const loeschen = () => {
    dialog({ titel: 'Konto löschen?', inhalt: el('p', { text: `„${k.name}“ wird gelöscht und überall abgemeldet.` }), knoepfe: [
      { text: 'Abbrechen', art: 'knopf-zweit' },
      { text: 'Löschen', art: 'knopf-gefahr', aktion: async () => { await api('DELETE', pfadVon(k.name)); melden('Konto gelöscht', 'gut'); g.schliessen(); fertig(); } },
    ] });
    return false;
  };
  g = dialog({ titel: neu ? 'Konto anlegen' : `Konto ${k.name}`, inhalt: form, knoepfe: [
    ...(neu || ich ? [] : [{ text: 'Löschen', art: 'knopf-gefahr', aktion: loeschen }]),
    { text: 'Abbrechen', art: 'knopf-zweit' },
    { text: neu ? 'Anlegen' : 'Speichern', aktion: speichern },
  ] });
}

async function zweiFaDialog(k, fertig) {
  let daten;
  try { daten = await api('POST', `${pfadVon(k.name)}/2fa`); } catch (e) { melden(e.message, 'schlecht', 8000); return; }
  const canvas = el('canvas', { attr: { role: 'img', 'aria-label': 'QR-Code für die Authenticator-App' } });
  let qrOk = true;
  try { qrZeichnen(canvas, qrErzeugen(String(daten.uri || '')), 5, 4); } catch { qrOk = false; }
  const code = el('input', { type: 'text', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 8 });
  const form = el('form', { on: { submit: (ev) => ev.preventDefault() } },
    el('p', { text: istIch(k) ? 'Mit der Authenticator-App scannen (z. B. 2FAS, Google Authenticator, Bitwarden).' : `Auf dem Telefon von „${k.name}“ mit der Authenticator-App scannen (z. B. 2FAS, Google Authenticator, Bitwarden).` }),
    qrOk ? el('div', { class: 'qr-rahmen' }, canvas) : el('div', { class: 'hinweis warn', text: 'Der QR-Code ließ sich nicht zeichnen – bitte den Schlüssel von Hand eingeben.' }),
    el('p', { class: 'leise' }, 'Schlüssel zum Abtippen: ', el('span', { class: 'mono', text: daten.geheimnis })),
    feld({ titel: 'Code aus der App', eingabe: code, info: 'Zur Bestätigung den 6-stelligen Code eingeben.', name: 'code' }));
  dialog({ titel: `2FA für ${k.name}`, inhalt: form, knoepfe: [
    { text: 'Abbrechen', art: 'knopf-zweit' },
    { text: 'Einschalten', aktion: async () => {
      try { await api('POST', `${pfadVon(k.name)}/2fa/aktivieren`, { code: code.value.replace(/\s/g, '') }); } catch (e) { fehlerZeigen(e, form); return false; }
      melden('2FA eingeschaltet', 'gut'); fertig(); return true;
    } },
  ] });
}
