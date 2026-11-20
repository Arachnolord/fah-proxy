// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen → Haupt & Fail-over. Koppeln von EINER Oberfläche aus: Rolle dieser Instanz wählen, Adresse und
// Admin-Zugang des Partners eingeben – beide Seiten richten sich selbst ein (eine leere Instanz holt sich dabei den
// Stand der befüllten). „Rollen tauschen“ füllt dasselbe Formular vor. Am Haupt: gekoppelte Fail-over-Instanzen; am
// Fail-over: Stand des Abgleichs, „Jetzt abgleichen“, „Entkoppeln“. Der Kopplungscode bleibt als Weg ohne Passwort.
// Dazu die Karte „FAH-Homepage“ (Lese-Code für Lämpchen, Domain-Ziele und Zugriffe).

import { el, api, feld, melden, dialog, zeit, fehlerZeigen, modusZeigen } from '../app.js';

export async function ersatzAbschnitt(wurzel) {
  const karte = el('section', { class: 'karte abstand-oben' });
  const homepage = el('section', { class: 'karte abstand-oben' });
  wurzel.append(karte, homepage);
  const bestaetigen = (titel, text, knopf, aktion) => dialog({ titel, inhalt: el('p', { text }), knoepfe: [{ text: 'Abbrechen', art: 'knopf-zweit' }, { text: knopf, aktion }] });

  /** Formular „Mit Partner koppeln“ – vorbelegt für den Rollentausch. */
  const partnerForm = ({ rolle = 'ersatz', url = '' } = {}) => {
    const rolleWahl = el('select', {},
      el('option', { value: 'haupt', text: 'Haupt – hier wird eingestellt, bedient normal das Internet', selected: rolle === 'haupt' }),
      el('option', { value: 'ersatz', text: 'Fail-over – übernimmt, wenn der Haupt ausfällt', selected: rolle === 'ersatz' }));
    const adresse = el('input', { type: 'text', value: url, placeholder: 'https://192.168.1.23:28181', attr: { spellcheck: 'false', autocapitalize: 'none' } });
    const name = el('input', { type: 'text', autocomplete: 'off', attr: { spellcheck: 'false', autocapitalize: 'none' } });
    const passwort = el('input', { type: 'password', autocomplete: 'off' });
    const code = el('input', { type: 'text', inputMode: 'numeric', maxLength: 8, autocomplete: 'one-time-code', placeholder: 'nur mit 2FA' });
    const form = el('form', { on: { submit: (ev) => ev.preventDefault() } },
      feld({ titel: 'Diese Instanz wird', eingabe: rolleWahl, info: 'Der Partner bekommt automatisch die andere Rolle.', name: 'rolle' }),
      feld({ titel: 'Adresse des Partners', eingabe: adresse, info: 'Die FAH-Proxy-Oberfläche der anderen Instanz, z. B. https://192.168.1.23:28181.', name: 'url' }),
      feld({ titel: 'Admin-Name beim Partner', eingabe: name, info: 'Ein Admin-Konto der anderen Instanz – wird nur für das Koppeln benutzt.', name: 'name' }),
      feld({ titel: 'Passwort beim Partner', eingabe: passwort, info: 'Wird nicht gespeichert.', name: 'passwort' }),
      feld({ titel: '2FA-Code beim Partner', eingabe: code, info: 'Nur nötig, wenn das Konto dort 2FA hat.', name: 'code' }),
      el('div', { class: 'zeile ende' }, el('button', { class: 'knopf', type: 'button', text: 'Koppeln', on: { click: () => {
        const haupt = rolleWahl.value === 'haupt';
        const text = haupt
          ? 'Diese Instanz wird Haupt, der Partner Fail-over und übernimmt danach den Stand von hier. Ist diese Instanz leer (frisch installiert), holt sie sich vorher Domains, Konten, Einstellungen und Zertifikate vom Partner.'
          : 'Diese Instanz wird Fail-over und übernimmt Domains, Konten, Einstellungen und Zertifikate des Partners. Ist der Partner leer (frisch installiert), bekommt er vorher den Stand von hier.';
        bestaetigen('Mit Partner koppeln?', text, 'Koppeln', async () => {
          for (const f of form.querySelectorAll('.feld')) f.fehler && f.fehler('');
          try {
            const r = await api('POST', '/api/spiegel/partner', { rolle: rolleWahl.value, url: adresse.value, name: name.value, passwort: passwort.value, code: code.value, bestaetigt: true });
            passwort.value = ''; code.value = '';
            melden(`Gekoppelt – diese Instanz ist ${r.rolle === 'haupt' ? 'Haupt' : 'Fail-over'}${r.uebernommen ? `, Stand ${r.uebernommen} übernommen` : ''}.${r.konten_neu ? ' Anmeldung ab jetzt mit den Konten des Partners.' : ''}`, 'gut', 10000);
            modusZeigen(r.rolle === 'haupt' ? 'live' : 'test', r.rolle);
          } catch (e) { fehlerZeigen(e, form); return true; }
          await zeichnen(); return true;
        });
      } } })));
    return form;
  };

  const zeichnen = async () => {
    const s = await api('GET', '/api/spiegel/stand');
    const ersatz = s.rolle === 'ersatz';
    const partnerUrl = ersatz ? s.haupt_url : ((s.ersatz || []).filter((x) => x.ui_url).sort((a, b) => String(b.letzter_abruf || '').localeCompare(String(a.letzter_abruf || '')))[0] || {}).ui_url || '';
    const gekoppelt = ersatz || (s.ersatz || []).length > 0;
    const formHuelle = el('div');
    const formZeigen = (vorgabe) => { formHuelle.replaceChildren(el('h3', { class: 'abstand-oben', text: vorgabe ? 'Rollen tauschen' : 'Mit Partner koppeln' }), partnerForm(vorgabe)); formHuelle.scrollIntoView({ block: 'nearest' }); };
    const tauschen = el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Rollen tauschen', on: { click: () => formZeigen({ rolle: ersatz ? 'haupt' : 'ersatz', url: partnerUrl }) } });

    const kopf = [el('h2', { text: 'Haupt & Fail-over' }),
      el('p', { class: 'leise', text: 'Zwei FAH-Proxy-Instanzen gleichen sich alle 5 Minuten ab – immer von der aktiven zur anderen. Fällt die aktive etwa 1 Minute aus, schaltet FAH-Proxy UniFi auf die andere um.' })];

    if (ersatz) {
      karte.replaceChildren(...kopf,
        el('div', { class: `hinweis ${s.letzter_fehler ? 'schlecht' : 'gut'}` },
          el('b', { text: 'Diese Instanz ist Fail-over des Haupts.' }), el('br'),
          el('span', { class: 'leise', text: `${s.haupt_url} · letzter Abgleich: ${s.letzter_abgleich ? zeit(s.letzter_abgleich) : 'noch nie'}` }),
          s.letzter_fehler ? el('p', { text: s.letzter_fehler }) : null),
        el('p', { class: 'leise' }, 'Fingerabdruck des Haupts: ', el('span', { class: 'mono', text: s.fingerabdruck })),
        el('div', { class: 'zeile ende' },
          tauschen,
          el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Entkoppeln', on: { click: () => bestaetigen('Entkoppeln?', 'Diese Instanz wird wieder eigenständig. Domains und Konten bleiben, werden aber nicht mehr abgeglichen.', 'Entkoppeln', async () => {
            await api('POST', '/api/spiegel/entkoppeln', {}); melden('Entkoppelt – diese Instanz ist wieder eigenständig', 'gut'); modusZeigen('test', 'haupt'); await zeichnen();
          }) } }),
          el('button', { class: 'knopf', type: 'button', text: 'Jetzt abgleichen', on: { click: async (ev) => {
            ev.currentTarget.disabled = true;
            try { const r = await api('POST', '/api/spiegel/abgleichen', {}); melden(`Abgeglichen: ${r.domains} Domains, ${r.konten} Konten, ${r.zertifikate} Zertifikate neu`, 'gut'); } catch (e) { melden(e.message, 'schlecht', 8000); }
            await zeichnen();
          } } })),
        formHuelle);
      return;
    }

    // Haupt (oder allein): gekoppelte Fail-over-Instanzen, Koppeln, Kopplungscode als Weg ohne Passwort
    const codeFeld = el('div');
    const eingabe = el('textarea', { rows: 3, placeholder: 'FAHPROXY1.…', attr: { spellcheck: 'false' } });
    const koppelForm = el('form', { on: { submit: (ev) => ev.preventDefault() } },
      feld({ titel: 'Kopplungscode des Haupt-FAH-Proxys', eingabe, info: 'Domains, Konten und Zertifikate dieser Instanz werden danach durch die des Haupts ersetzt.', name: 'code' }),
      el('div', { class: 'zeile ende' }, el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Als Fail-over koppeln', on: { click: () => bestaetigen('Als Fail-over koppeln?', 'Domains, Konten, Einstellungen und Zertifikate dieser Instanz werden durch die des Haupt-FAH-Proxys ersetzt und danach alle 5 Minuten abgeglichen.', 'Koppeln', async () => {
        try { const r = await api('POST', '/api/spiegel/verbinden', { code: eingabe.value }); melden(`Gekoppelt: ${r.domains} Domains, ${r.konten} Konten übernommen`, 'gut'); } catch (e) { fehlerZeigen(e, koppelForm); return true; }
        modusZeigen('test', 'ersatz'); await zeichnen(); return true;
      }) } })));
    const zeigeCode = (r) => {
      const feldCode = el('textarea', { class: 'mono', rows: 3, readOnly: true, value: r.code });
      codeFeld.replaceChildren(el('div', { class: 'hinweis abstand-oben' },
        el('p', { text: `Gilt bis ${zeit(r.gueltig_bis)} und nur einmal. Auf der anderen Instanz unter „Mit Kopplungscode“ einfügen.` }), feldCode,
        el('div', { class: 'zeile ende abstand-oben' }, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Kopieren', on: { click: async () => {
          try { await navigator.clipboard.writeText(r.code); melden('Code kopiert', 'gut'); } catch { feldCode.select(); melden('Code ist markiert – bitte mit Strg/Cmd+C kopieren'); }
        } } }))));
    };
    karte.replaceChildren(...kopf,
      gekoppelt ? el('div', { class: 'huelle' }, el('table', { class: 'tabelle' },
        el('thead', {}, el('tr', {}, ...['Fail-over-Instanz', 'Adresse', 'Gekoppelt', 'Letzter Abruf', ''].map((t) => el('th', { text: t })))),
        el('tbody', {}, ...s.ersatz.map((x) => el('tr', {},
          el('td', { text: x.name }), el('td', { class: 'mono', text: x.ui_url || x.ip || '–' }), el('td', { text: zeit(x.gekoppelt) }), el('td', { text: x.letzter_abruf ? zeit(x.letzter_abruf) : 'noch nie' }),
          el('td', {}, el('button', { class: 'knopf knopf-gefahr knopf-klein', type: 'button', text: 'Entfernen', on: { click: () => bestaetigen('Fail-over-Instanz entfernen?', `„${x.name}“ kann danach nicht mehr abgleichen, bis du sie neu koppelst.`, 'Entfernen', async () => {
            await api('DELETE', `/api/spiegel/ersatz/${encodeURIComponent(x.id)}`); melden('Fail-over-Instanz entfernt', 'gut'); await zeichnen();
          }) } }))))))) : el('p', { class: 'leise', text: 'Diese Instanz läuft allein – noch kein Partner gekoppelt.' }),
      gekoppelt ? el('div', { class: 'zeile' }, tauschen, el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Weiteren Partner koppeln', on: { click: () => formZeigen() } })) : null,
      formHuelle,
      el('details', { class: 'erweitert abstand-oben' }, el('summary', { text: 'Mit Kopplungscode (ohne Passwort des Partners)' }),
        el('p', { class: 'leise', text: 'Am Haupt einen Code erzeugen und auf der Fail-over-Instanz einfügen.' }),
        el('div', { class: 'zeile' }, el('button', { class: 'knopf knopf-zweit', type: 'button', text: 'Kopplungscode erzeugen', on: { click: async () => {
          try { zeigeCode(await api('POST', '/api/spiegel/code', {})); } catch (e) { melden(e.message, 'schlecht', 8000); }
        } } })),
        codeFeld, koppelForm));
    if (!gekoppelt) formHuelle.replaceChildren(el('h3', { class: 'abstand-oben', text: 'Mit Partner koppeln' }), partnerForm());
  };

  const homepageZeichnen = async () => {
    const e = await api('GET', '/api/einstellungen');
    const h = e.homepage || {};
    const codeFeld = el('div');
    homepage.replaceChildren(
      el('h2', { text: 'FAH-Homepage' }),
      el('p', { class: 'leise', text: 'Die FAH-Homepage liest mit diesem Code Lämpchen, Domain-Ziele und Zugriffe beider Instanzen. Er gilt für Haupt und Fail-over und kann nichts ändern.' }),
      el('p', { text: h.gesetzt ? `Lese-Code eingerichtet${h.erzeugt ? ` am ${zeit(h.erzeugt)}` : ''}.` : 'Noch kein Lese-Code eingerichtet.' }),
      el('div', { class: 'zeile' },
        el('button', { class: 'knopf knopf-zweit', type: 'button', text: h.gesetzt ? 'Neuen Lese-Code erzeugen' : 'Lese-Code erzeugen', on: { click: () => {
          const los = async () => {
            const r = await api('POST', '/api/homepage/code', {});
            const feldCode = el('textarea', { class: 'mono', rows: 3, readOnly: true, value: r.code });
            await homepageZeichnen();
            codeFeld.replaceChildren(el('div', { class: 'hinweis abstand-oben' },
              el('p', { text: 'Wird nur jetzt angezeigt. In der FAH-Homepage unter Admin → FAH-Proxy & FAH-Adblock einfügen.' }), feldCode,
              el('div', { class: 'zeile ende abstand-oben' }, el('button', { class: 'knopf knopf-zweit knopf-klein', type: 'button', text: 'Kopieren', on: { click: async () => {
                try { await navigator.clipboard.writeText(r.code); melden('Code kopiert', 'gut'); } catch { feldCode.select(); melden('Code ist markiert – bitte mit Strg/Cmd+C kopieren'); }
              } } }))));
          };
          if (h.gesetzt) bestaetigen('Neuen Lese-Code erzeugen?', 'Der bisherige Code gilt danach nicht mehr – in der Homepage den neuen eintragen.', 'Erzeugen', los);
          else los().catch((err) => melden(err.message, 'schlecht', 8000));
        } } }),
        h.gesetzt ? el('button', { class: 'knopf knopf-gefahr', type: 'button', text: 'Entfernen', on: { click: () => bestaetigen('Lese-Zugang entfernen?', 'Die Homepage sieht danach keine Lämpchen und Zugriffe von FAH-Proxy mehr.', 'Entfernen', async () => {
          await api('DELETE', '/api/homepage/code'); melden('Lese-Zugang entfernt', 'gut'); await homepageZeichnen();
        }) } }) : null),
      codeFeld);
  };
  await zeichnen();
  await homepageZeichnen();
}
