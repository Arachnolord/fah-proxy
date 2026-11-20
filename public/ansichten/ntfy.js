// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen → Benachrichtigungen (ntfy): Adresse, Thema, Zugang (wird nur verschlüsselt gespeichert und nie wieder
// angezeigt), Testnachricht. „Testnachricht“ speichert vorher, damit getestet wird, was eingetragen ist.

import { el, api, feld, melden, fehlerZeigen } from '../app.js';

const OHNE_ZUGANG = 'tk_… oder Benutzer:Passwort';
const MIT_ZUGANG = 'gespeichert – leer lassen zum Behalten';

export function ntfyAbschnitt(wurzel, e) {
  const url = el('input', { type: 'url', value: e.ntfy.url, placeholder: 'https://ntfy.beispiel.de' });
  const thema = el('input', { type: 'text', value: e.ntfy.thema, placeholder: 'fah-proxy', autocomplete: 'off', attr: { autocapitalize: 'none', spellcheck: 'false' } });
  const zugang = el('input', { type: 'password', autocomplete: 'off', placeholder: e.ntfy.token_gesetzt ? MIT_ZUGANG : OHNE_ZUGANG });
  const stand = (n) => { zugang.value = ''; zugang.placeholder = n.token_gesetzt ? MIT_ZUGANG : OHNE_ZUGANG; entfernen.hidden = !n.token_gesetzt; };
  const entfernen = el('button', { class: 'knopf knopf-leise knopf-klein', type: 'button', text: 'Gespeicherten Zugang entfernen', hidden: !e.ntfy.token_gesetzt, on: { click: async () => {
    try { stand((await api('PUT', '/api/einstellungen', { ntfy: { token_loeschen: true } })).ntfy); melden('Zugang entfernt', 'gut'); } catch (err) { fehlerZeigen(err, form); }
  } } });
  const speichern = async () => {
    for (const f of form.querySelectorAll('.feld')) if (f.fehler) f.fehler('');
    stand((await api('PUT', '/api/einstellungen', { ntfy: { url: url.value.trim(), thema: thema.value.trim(), ...(zugang.value ? { token: zugang.value } : {}) } })).ntfy);
  };
  const form = el('form', { class: 'karte abstand-oben', on: { submit: async (ev) => {
    ev.preventDefault();
    try { await speichern(); melden('Benachrichtigungen gespeichert', 'gut'); } catch (err) { fehlerZeigen(err, form); }
  } } },
  el('h2', { text: 'Benachrichtigungen (ntfy)' }),
  el('p', { class: 'leise', text: 'Warnt aufs Handy, wenn ein Ziel länger als 5 Minuten nicht erreichbar ist oder ein Zertifikat in unter 14 Tagen abläuft – je Ereignis höchstens einmal pro Stunde.' }),
  feld({ titel: 'ntfy-Adresse', eingabe: url, info: 'Adresse deines ntfy-Servers. Leer lassen schaltet die Warnungen ab.', name: 'ntfy.url' }),
  feld({ titel: 'Thema', eingabe: thema, info: 'Dieses Thema in der ntfy-App abonnieren.', name: 'ntfy.thema' }),
  feld({ titel: 'Zugang', eingabe: zugang, info: 'Token (tk_…) oder Benutzer:Passwort, falls dein ntfy-Server eine Anmeldung verlangt.', name: 'ntfy.token' }),
  entfernen,
  el('div', { class: 'zeile ende' },
    el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Testnachricht', on: { click: async () => {
      try { await speichern(); await api('POST', '/api/ntfy/test'); melden('Testnachricht gesendet – ist sie angekommen?', 'gut'); } catch (err) { fehlerZeigen(err, form); }
    } } }),
    el('button', { class: 'knopf', type: 'submit', text: 'Speichern' })));
  wurzel.append(form);
}
