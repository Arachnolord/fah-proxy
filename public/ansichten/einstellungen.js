// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen: E-Mail für Let's Encrypt, Schutzstufen (schutz.js: Kacheln mit Heimnetz-Netzen und Anmeldedauer), eigenes Passwort, Benachrichtigungen
// (ntfy.js), UniFi (unifi.js), Konten (konten.js), Ersatz-Instanz (ersatz.js). Jede Einstellung mit kurzem Info-Text
// (≤ 2 Sätze). Weitere Abschnitte hängen sich über abschnittRegistrieren an.

import { el, api, feld, melden, fehlerZeigen } from '../app.js';
import { ntfyAbschnitt } from './ntfy.js';
import { schutzAbschnitt } from './schutz.js';
import { kontenAbschnitt } from './konten.js';
import { unifiAbschnitt } from './unifi.js';
import { ersatzAbschnitt } from './ersatz.js';

const erweiterungen = [];
/** Weitere Einstellungs-Abschnitte (Konten, ntfy, UniFi, Ersatz) hängen sich hier an. */
export function abschnittRegistrieren(fn) { erweiterungen.push(fn); }

export async function zeigen(wurzel) {
  const e = await api('GET', '/api/einstellungen');
  wurzel.append(el('h1', { text: 'Einstellungen' }), el('p', { class: 'unter', text: `FAH-Proxy ${e.version} · Rolle: ${e.rolle === 'ersatz' ? 'Ersatz-Instanz' : 'Haupt-Instanz'}` }));
  let ich = null; try { ich = await api('GET', '/api/ich'); } catch { /* Hinweis entfällt */ }
  if (ich && ich.aktiv === false) wurzel.append(el('div', { class: 'hinweis warn', text: `Diese Instanz bedient das Internet gerade nicht – Änderungen bitte an der aktiven Instanz${ich.aktiv_ip ? ` (${ich.aktiv_ip})` : ''} machen, sie kommen automatisch hierher. Hier gehen nur UniFi testen sowie Abgleich und Entkoppeln (ganz unten).` }));

  const email = el('input', { type: 'email', value: e.acme_email, placeholder: 'ich@beispiel.de' });
  const sperrseite = el('input', { type: 'checkbox' }); sperrseite.checked = !!(e.sperrseite && e.sperrseite.an);
  const form = el('form', { class: 'karte', on: { submit: async (ev) => {
    ev.preventDefault();
    for (const f of form.querySelectorAll('.feld')) f.fehler && f.fehler('');
    try {
      await api('PUT', '/api/einstellungen', { acme_email: email.value.trim(), sperrseite: { an: sperrseite.checked } });
      melden('Einstellungen gespeichert', 'gut');
    } catch (err) { fehlerZeigen(err, form); }
  } } },
  el('h2', { text: 'Allgemein' }), el('br'),
  feld({ titel: 'E-Mail für Let\'s Encrypt', eingabe: email, info: 'Let\'s Encrypt schreibt hierhin, falls ein Zertifikat Probleme macht. Darf leer bleiben.', name: 'acme_email' }),
  el('label', { class: 'schalter' }, sperrseite, el('span', {}, el('b', { text: 'Sperrseite von FAH-Adblock' }), el('br'),
    el('span', { class: 'leise', text: 'Seiten, die FAH-Adblock sperrt, zeigen im Heimnetz einen Hinweis statt einer Browser-Fehlermeldung. Das Zertifikat dafür erzeugt der Proxy selbst und nur für wirklich gesperrte Domains. Von außen ändert sich nichts.' }))),
  el('div', { class: 'zeile ende' }, el('button', { class: 'knopf', type: 'submit', text: 'Speichern' })));
  wurzel.append(form);
  try { await schutzAbschnitt(wurzel); } catch (err) { wurzel.append(el('div', { class: 'hinweis schlecht', text: err.message })); }

  // Eigenes Passwort
  const alt = el('input', { type: 'password', autocomplete: 'current-password' });
  const neu = el('input', { type: 'password', autocomplete: 'new-password' });
  const pw = el('form', { class: 'karte abstand-oben', on: { submit: async (ev) => {
    ev.preventDefault();
    try { await api('POST', '/api/passwort', { alt: alt.value, neu: neu.value }); alt.value = ''; neu.value = ''; melden('Passwort geändert', 'gut'); } catch (err) { fehlerZeigen(err, pw); }
  } } },
  el('h2', { text: 'Mein Passwort' }), el('br'),
  feld({ titel: 'Bisheriges Passwort', eingabe: alt, name: 'alt' }),
  feld({ titel: 'Neues Passwort', eingabe: neu, info: 'Mindestens 10 Zeichen.', name: 'neu' }),
  el('div', { class: 'zeile ende' }, el('button', { class: 'knopf', type: 'submit', text: 'Passwort ändern' })));
  wurzel.append(pw);
  for (const fn of [ntfyAbschnitt, unifiAbschnitt, kontenAbschnitt, ersatzAbschnitt, ...erweiterungen]) { try { await fn(wurzel, e); } catch (err) { wurzel.append(el('div', { class: 'hinweis schlecht', text: err.message })); } }
}
