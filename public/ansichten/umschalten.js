// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Umschalten: Stand (live/Bereitschaft), Fail-over, Checkliste, Vorschau jeder Änderung an der UniFi-Konsole und
// „Übernehmen“/„Nachziehen“ – erst nach Bestätigung. Vor dem ersten Schreiben sichert FAH-Proxy die betroffenen Regeln;
// scheitert ein Schritt, stellt es sofort zurück.

import { el, api, melden, dialog, zeit } from '../app.js';

/** Prüfpunkte aus dem Plan: lokales DNS im Haus und Firewall-Sperren zum NAS (beides zieht „Übernehmen“/„Nachziehen“ mit). */
function imHausUndFirewall(u) {
  if (!u.plan) return [];
  const anzahl = (b) => u.plan.schritte.filter((s) => s.bereich === b).length;
  const live = u.modus === 'live';
  const knopf = live ? '„Nachziehen“' : '„Übernehmen“';
  return [
    anzahl('dns') ? punkt('warn', `Im Haus zeigt ein DNS-Eintrag direkt auf einen Rechner und umgeht die Weiterleitung – ${knopf} schaltet ihn aus.`) : punkt('gut', 'Im Haus gehen die Domains denselben Weg wie aus dem Internet.'),
    anzahl('firewall') ? punkt('warn', `Eine Firewall-Sperre zum NAS kennt die Ports von FAH-Proxy noch nicht – ${knopf} ergänzt sie.`) : punkt('gut', 'Firewall-Sperren zum NAS greifen auch für FAH-Proxy.'),
  ];
}

const punkt = (art, text) => el('li', {}, el('span', { class: `punkt ${art}` }), el('span', { text }));

/** Karte „Fail-over“: wohin das Internet gerade geht, Zustand der anderen Instanz, Schalter (nur an der aktiven Instanz). */
async function failoverKarte(wurzel) {
  let f;
  try { f = await api('GET', '/api/failover'); } catch { return; }
  const ersatz = f.rolle === 'ersatz';
  const aktiv = !f.aktiv ? 'Noch nicht geprüft, wohin das Internet geht.' : !f.aktiv.ip ? 'UniFi leitet das Internet noch nicht an FAH-Proxy.'
    : `Das Internet geht gerade an ${f.aktiv.ip === f.ich.ip ? `diese Instanz (${f.ich.ip})` : `die andere Instanz (${f.aktiv.ip})`}.`;
  const partnerText = !f.partner ? null : f.partner_ok === null ? 'noch nicht geprüft' : f.partner_ok ? 'antwortet' : `antwortet nicht (${f.fehler_folge}× in Folge)`;
  const passiv = !!(f.partner && f.aktiv && f.aktiv.ip && f.aktiv.ip !== f.ich.ip);
  const schalter = el('input', { type: 'checkbox', checked: f.an, disabled: passiv, on: { change: async () => {
    try { await api('PUT', '/api/einstellungen', { failover: { an: schalter.checked } }); melden(schalter.checked ? 'Automatisches Fail-over ist an' : 'Automatisches Fail-over ist aus', 'gut'); } catch (e) { schalter.checked = !schalter.checked; melden(e.message, 'schlecht', 8000); }
  } } });
  wurzel.append(el('section', { class: 'karte abstand-oben' }, el('h2', { text: 'Fail-over' }),
    el('ul', { class: 'checkliste' },
      punkt(f.aktiv && f.aktiv.ip ? 'gut' : 'warn', aktiv),
      f.partner ? punkt(f.partner_ok === false ? 'schlecht' : f.partner_ok ? 'gut' : 'warn', `${ersatz ? 'Haupt-Instanz' : 'Ersatz-Instanz'} ${f.partner.ip}: ${partnerText}.`)
        : punkt('warn', 'Noch keine zweite Instanz gekoppelt (Einstellungen → Ersatz-Instanz).'),
      f.letzter_wechsel ? punkt('gut', `Letzter automatischer Wechsel: ${zeit(f.letzter_wechsel)}.`) : null),
    f.meldung ? el('p', { class: 'leise', text: f.meldung }) : null,
    el('label', { class: 'schalter abstand-oben' }, schalter, el('span', {}, el('b', { text: 'Automatisches Fail-over' }), el('br'),
      el('span', { class: 'leise', text: passiv ? 'Wird an der aktiven Instanz ein- und ausgeschaltet.' : 'Fällt eine Instanz etwa 1 Minute aus, übernimmt die andere. Läuft die Haupt-Instanz wieder 10 Minuten stabil, bekommt sie das Internet zurück.' })))));
}

function schrittListe(schritte) {
  return schritte.length ? el('ol', { class: 'schritte' }, ...schritte.map((s) => el('li', { text: s.text }))) : el('p', { class: 'leise', text: 'Nichts zu ändern – die Konsole ist schon so eingestellt.' });
}

function bestaetigen({ titel, text, knopf, art = '', pfad, gut, koerper = {} }, neuLaden) {
  dialog({ titel, inhalt: el('p', { text }), knoepfe: [
    { text: 'Abbrechen', art: 'knopf-zweit' },
    { text: knopf, art, aktion: async () => {
      const r = await api('POST', pfad, { ...koerper, bestaetigt: true });
      melden(r.hinweis ? `${gut} – ${r.hinweis}` : gut, r.hinweis ? 'warn' : 'gut', 8000);
      neuLaden();
    } },
  ] });
}

export async function zeigen(wurzel) {
  wurzel.append(el('h1', { text: 'Umschalten' }), el('p', { class: 'unter', text: 'Das Internet (Ports 80/443) per UniFi an diese FAH-Proxy-Instanz leiten. Du siehst vorher jede Änderung an der UniFi-Konsole.' }));
  const lade = el('p', { class: 'leise', text: 'Lese die UniFi-Konsole …' });
  wurzel.append(lade);
  const u = await api('GET', '/api/umschalten');
  lade.remove();
  const neuLaden = () => { wurzel.replaceChildren(); zeigen(wurzel).catch((e) => wurzel.append(el('div', { class: 'hinweis schlecht', text: e.message }))); };
  const live = u.modus === 'live';
  const ziel = `${u.ziel.ip || '?'}:${u.ziel.http || '?'} (HTTP) und :${u.ziel.https || '?'} (HTTPS)`;
  wurzel.append(el('div', { class: `hinweis ${live ? 'gut' : 'warn'}` }, el('b', { text: live ? 'Diese Instanz ist live' : 'Bereitschaft – diese Instanz bedient das Internet gerade nicht' }), el('br'),
    el('span', { class: 'leise', text: !u.unifi.eingerichtet ? `Ohne UniFi: Router leitet 80 → ${u.ziel.ip || '?'}:${u.ziel.http || '?'} und 443 → ${u.ziel.ip || '?'}:${u.ziel.https || '?'} (Portfreigabe von Hand).`
      : live ? `Die Konsole leitet 80/443 an ${ziel}.` : `Nach „Übernehmen“ leitet die Konsole 80/443 an ${ziel}.` })));

  await failoverKarte(wurzel);

  const c = u.checkliste;
  const caddyOk = c.caddy.ok !== false && !c.caddy.ausstehend;
  wurzel.append(el('section', { class: 'karte' }, el('h2', { text: 'Vorher prüfen' }), el('ul', { class: 'checkliste' },
    punkt(caddyOk ? 'gut' : 'schlecht', caddyOk ? 'Caddy hat die Konfiguration angenommen.' : `Caddy: ${c.caddy.fehler || 'wartet noch auf den Start'}`),
    punkt(c.erreichbar === c.domains ? 'gut' : 'warn', `${c.erreichbar} von ${c.domains} Zielen erreichbar.`),
    punkt(c.ohne_zertifikat.length ? 'warn' : 'gut', c.ohne_zertifikat.length ? `Ohne Zertifikat (holt FAH-Proxy nach dem Umschalten bei Let's Encrypt): ${c.ohne_zertifikat.join(', ')}` : 'Alle Domains haben ein Zertifikat.'),
    punkt(u.unifi.getestet ? 'gut' : u.unifi.eingerichtet ? 'schlecht' : 'warn', !u.unifi.eingerichtet ? 'UniFi-Konsole nicht eingetragen (Einstellungen → UniFi) – anderer Router: unten „Ohne UniFi“.' : u.unifi.getestet ? 'UniFi-Konsole verbunden.' : 'UniFi eingetragen, aber noch nicht getestet (Einstellungen → UniFi → Verbindung testen).'),
    ...imHausUndFirewall(u))));
  for (const h of (u.plan && u.plan.hinweise) || []) wurzel.append(el('div', { class: 'hinweis warn', text: h }));

  if (!u.unifi.eingerichtet) {
    wurzel.append(el('section', { class: 'karte abstand-oben' }, el('h2', { text: 'Ohne UniFi (anderer Router)' }),
      el('p', { class: 'leise' }, 'Portfreigaben am Router von Hand einrichten – Schritt für Schritt unter ', el('a', { href: '#/hilfe', text: 'Hilfe' }),
        '. Danach hier live schalten: Erst dann holt FAH-Proxy die Zertifikate bei Let\'s Encrypt.'),
      el('div', { class: 'zeile ende' }, el('button', { class: live ? 'knopf knopf-zweit' : 'knopf', type: 'button', text: live ? 'Zurück in Bereitschaft' : 'Live schalten (ohne UniFi)', on: { click: () => bestaetigen(live
        ? { titel: 'Zurück in Bereitschaft?', knopf: 'Bereitschaft', pfad: '/api/umschalten/ohne-unifi', koerper: { live: false }, gut: 'Bereitschaft – keine neuen Zertifikate mehr',
          text: 'FAH-Proxy holt dann keine Zertifikate mehr. Die Portfreigabe am Router bleibt, wie sie ist.' }
        : { titel: 'Live schalten?', knopf: 'Live schalten', pfad: '/api/umschalten/ohne-unifi', gut: 'Live – FAH-Proxy holt jetzt die Zertifikate',
          text: 'Nur, wenn die Portfreigaben 80 und 443 am Router auf diesen Rechner zeigen – sonst scheitert Let\'s Encrypt.' }, neuLaden) } }))));
  }

  if (u.fehler) wurzel.append(el('div', { class: 'hinweis schlecht', text: `UniFi: ${u.fehler}` }));

  if (u.plan && (!live || u.plan.schritte.length)) {
    const kannNicht = !u.plan.ausfuehrbar || !caddyOk || !u.plan.schritte.length;
    wurzel.append(el('section', { class: 'karte abstand-oben' },
      el('h2', { text: live ? 'Nachziehen' : 'Übernehmen – das ändert sich an der UniFi-Konsole' }),
      ...u.plan.probleme.map((p) => el('div', { class: 'hinweis schlecht', text: p })),
      schrittListe(u.plan.schritte),
      el('p', { class: 'leise', text: 'Vorher werden die betroffenen Regeln gesichert. Scheitert ein Schritt, stellt FAH-Proxy sofort alles zurück.' }),
      el('div', { class: 'zeile ende' }, el('button', { class: 'knopf', type: 'button', text: live ? 'Nachziehen' : 'Übernehmen', disabled: kannNicht, on: { click: () => bestaetigen({
        titel: 'Jetzt umschalten?', knopf: 'Umschalten', pfad: '/api/umschalten/uebernehmen', gut: 'Umgeschaltet – diese Instanz ist live',
        text: `Ab dann geht der Verkehr aus dem Internet an diese Instanz (${ziel}).${u.rolle === 'ersatz' ? ' Ist das Fail-over an, holt sich die Haupt-Instanz das Internet zurück, sobald sie 10 Minuten stabil läuft.' : ''}`,
      }, neuLaden) } }))));
  }
}
