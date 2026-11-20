// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen → UniFi (Router): Zugang zur Konsole (Passwort nur verschlüsselt, nie wieder angezeigt), IP dieses
// Rechners, „Verbindung testen“ zeigt die Weiterleitungen und nagelt den Zertifikats-Fingerabdruck fest. Hier wird nur
// gelesen – geändert wird die Konsole ausschließlich unter „Umschalten“.

import { el, api, feld, melden, fehlerZeigen } from '../app.js';

const GESPEICHERT = 'gespeichert – leer lassen zum Behalten';

export function unifiAbschnitt(wurzel, e) {
  const url = el('input', { type: 'url', value: e.unifi.url, placeholder: 'https://192.168.1.1' });
  const benutzer = el('input', { type: 'text', value: e.unifi.benutzer, autocomplete: 'off', attr: { autocapitalize: 'none', spellcheck: 'false' } });
  const pw = el('input', { type: 'password', autocomplete: 'new-password', placeholder: e.unifi.passwort_gesetzt ? GESPEICHERT : '' });
  const ip = el('input', { type: 'text', value: e.unifi.ziel_ip, placeholder: e.host_ip || '192.168.1.23', inputMode: 'decimal' });
  const ergebnis = el('div', {},
    e.unifi.fingerabdruck ? el('p', { class: 'leise' }, 'Verbindung geprüft · Fingerabdruck der Konsole: ', el('span', { class: 'mono', text: e.unifi.fingerabdruck })) : null);

  const regelnZeigen = (t) => ergebnis.replaceChildren(
    el('p', { class: 'leise' }, 'Verbunden · Fingerabdruck der Konsole: ', el('span', { class: 'mono', text: t.fingerabdruck })),
    t.regeln.length ? el('div', { class: 'huelle' }, el('table', { class: 'tabelle' },
      el('thead', {}, el('tr', {}, ...['Weiterleitung', 'Ports', 'Ziel', ''].map((x) => el('th', { text: x })))),
      el('tbody', {}, ...t.regeln.map((r) => el('tr', {},
        el('td', {}, el('b', { text: r.name }), r.aktiv ? null : el('span', { class: 'leise', text: ' (aus)' })),
        el('td', { class: 'mono', text: `${r.dst_port} ${r.proto}` }),
        el('td', { class: 'mono', text: `${r.fwd}:${r.fwd_port || r.dst_port}` }),
        el('td', {}, r.web ? el('span', { class: 'marke-klein warn', text: 'leitet 80/443 weiter' }) : null))))))
      : el('p', { class: 'leise', text: 'Keine Portweiterleitungen eingerichtet.' }));

  const speichern = async () => {
    for (const f of form.querySelectorAll('.feld')) if (f.fehler) f.fehler('');
    const r = await api('PUT', '/api/einstellungen', { unifi: { url: url.value.trim(), benutzer: benutzer.value.trim(), ziel_ip: ip.value.trim(), ...(pw.value ? { passwort: pw.value } : {}) } });
    pw.value = ''; pw.placeholder = r.unifi.passwort_gesetzt ? GESPEICHERT : '';
  };
  const testen = async (neuBestaetigen) => {
    try {
      await speichern();
      regelnZeigen(await api('POST', '/api/unifi/testen', neuBestaetigen ? { neu_bestaetigen: true } : {}));
      melden('Verbindung zur UniFi-Konsole steht', 'gut');
    } catch (err) {
      if (err.code === 'E_UNIFI' && err.details && err.details.fingerabdruck) {
        ergebnis.replaceChildren(el('div', { class: 'hinweis warn' }, el('p', { text: err.message }),
          el('p', { class: 'leise' }, 'Neuer Fingerabdruck: ', el('span', { class: 'mono', text: err.details.fingerabdruck })),
          el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Neues Zertifikat bestätigen', on: { click: () => testen(true) } })));
        return;
      }
      fehlerZeigen(err, form);
    }
  };
  const form = el('form', { class: 'karte abstand-oben', on: { submit: async (ev) => {
    ev.preventDefault();
    try { await speichern(); melden('UniFi-Zugang gespeichert', 'gut'); } catch (err) { fehlerZeigen(err, form); }
  } } },
  el('h2', { text: 'UniFi (Router)' }),
  el('p', { class: 'leise', text: 'Damit FAH-Proxy beim Umschalten die Portweiterleitung selbst einstellen kann. Geändert wird die Konsole nur, wenn du unter „Umschalten“ auf „Übernehmen“ klickst.' }),
  feld({ titel: 'Adresse der Konsole', eingabe: url, info: 'Deine UniFi-Konsole (UCG, UDM) im Heimnetz, z. B. https://192.168.1.1.', name: 'unifi.url' }),
  feld({ titel: 'Benutzer', eingabe: benutzer, info: 'Ein lokales Konto der Konsole ohne 2FA – am besten ein eigenes wie „fahproxy“ mit der Rolle Network-Admin.', name: 'unifi.benutzer' }),
  feld({ titel: 'Passwort', eingabe: pw, info: 'Wird nur verschlüsselt gespeichert und nie wieder angezeigt.', name: 'unifi.passwort' }),
  feld({ titel: 'IP dieses Rechners', eingabe: ip, info: `Dorthin leitet die Konsole nach dem Umschalten 80/443. Leer = ${e.host_ip || 'Adresse aus der Installation'}.`, name: 'unifi.ziel_ip' }),
  ergebnis,
  el('div', { class: 'zeile ende' },
    el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Verbindung testen', on: { click: () => testen(false) } }),
    el('button', { class: 'knopf', type: 'submit', text: 'Speichern' })));
  wurzel.append(form);
}
