// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Oberfläche: Hilfen (el, api, melden, dialog, feld), Anmeldung, Pflicht-Passwortwechsel, Router (#/ansicht).
// Kein innerHTML – Texte immer über textContent.

const ANSICHTEN = {
  uebersicht: () => import('./ansichten/uebersicht.js'),
  umschalten: () => import('./ansichten/umschalten.js'),
  einstellungen: () => import('./ansichten/einstellungen.js'),
  protokoll: () => import('./ansichten/protokoll.js'),
  hilfe: () => import('./ansichten/hilfe.js'),
};
export const zustand = { ich: null };

/** DOM-Element bauen: el('div', {class, text, on:{click}, attr}, ...kinder) */
export function el(tag, eig = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(eig || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = String(v);
    else if (k === 'on') for (const [art, fn] of Object.entries(v)) e.addEventListener(art, fn);
    else if (k === 'attr') for (const [a, w] of Object.entries(v)) { if (w !== undefined && w !== null && w !== false) e.setAttribute(a, w === true ? '' : String(w)); }
    else if (k in e && typeof e[k] !== 'function') e[k] = v;
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const k of kinder.flat(Infinity)) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}

function csrf() { const m = document.cookie.match(/(?:^|;\s*)fp_csrf=([^;]*)/); return m ? decodeURIComponent(m[1]) : ''; }

export class ApiFehler extends Error { constructor(f) { super(f.meldung || 'Fehler'); this.code = f.code; this.details = f.details || {}; } }

export async function api(methode, pfad, body) {
  const kopf = { Accept: 'application/json' };
  if (methode !== 'GET') { kopf['Content-Type'] = 'application/json'; kopf['X-FP-CSRF'] = csrf(); }
  let r;
  try { r = await fetch(pfad, { method: methode, headers: kopf, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' }); } catch {
    throw new ApiFehler({ code: 'E_NETZ', meldung: 'Keine Verbindung zu FAH-Proxy' });
  }
  const j = await r.json().catch(() => ({ ok: false, fehler: { code: 'E_INTERN', meldung: `Unerwartete Antwort (${r.status})` } }));
  if (j.ok) return j.ergebnis;
  const f = new ApiFehler(j.fehler || {});
  if (f.code === 'E_ANMELDUNG' && pfad !== '/api/anmelden' && pfad !== '/api/passwort') { zustand.ich = null; zeigeAnmeldung(); }
  else if (f.details && f.details.pflichtwechsel) zeigePflichtwechsel();
  throw f;
}

export function melden(text, art = 'info', dauer = 5000) {
  const m = el('div', { class: `meldung ${art}`, text, attr: { role: art === 'schlecht' ? 'alert' : 'status' } });
  document.getElementById('meldungen').append(m);
  setTimeout(() => m.remove(), dauer);
}

/** Modaler Dialog: {titel, inhalt (Node), knoepfe:[{text, art, aktion(g) → Promise|void, schliesst?}]} → {schliessen, element} */
export function dialog({ titel, inhalt, knoepfe = [] }) {
  const vorher = document.activeElement;
  const fuss = el('div', { class: 'dialog-fuss' });
  const box = el('div', { class: 'dialog', attr: { role: 'dialog', 'aria-modal': 'true', 'aria-label': titel } },
    el('div', { class: 'dialog-kopf' }, el('h2', { text: titel }), el('span', { class: 'ausgleich' }), el('button', { class: 'knopf knopf-leise', type: 'button', text: '✕', attr: { 'aria-label': 'Schließen' }, on: { click: () => g.schliessen() } })),
    el('div', { class: 'dialog-inhalt' }, inhalt), fuss);
  const schleier = el('div', { class: 'schleier', on: { mousedown: (ev) => { if (ev.target === schleier) g.schliessen(); } } }, box);
  const g = {
    element: box,
    schliessen() { schleier.remove(); document.removeEventListener('keydown', esc); if (vorher && vorher.focus) vorher.focus(); },
    beschaeftigt(an) { for (const b of fuss.querySelectorAll('button')) b.disabled = an; },
  };
  const esc = (ev) => { if (ev.key === 'Escape') g.schliessen(); };
  document.addEventListener('keydown', esc);
  for (const k of knoepfe) {
    fuss.append(el('button', { class: `knopf ${k.art || ''}`, type: 'button', text: k.text, on: { click: async () => { if (!k.aktion) { g.schliessen(); return; } g.beschaeftigt(true); try { const r = await k.aktion(g); if (r !== false) g.schliessen(); } catch (e) { melden(e.message, 'schlecht', 8000); } finally { g.beschaeftigt(false); } } } }));
  }
  document.body.append(schleier);
  const erstes = box.querySelector('input, select, textarea, button.knopf:not(.knopf-leise)');
  if (erstes) erstes.focus();
  return g;
}

/** Formularfeld mit Beschriftung, Info-Text (≤ 2 Sätze) und Fehlerzeile. */
export function feld({ titel, eingabe, info = '', name = '' }) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  if (eingabe.id === '') eingabe.id = id;
  const fehler = el('p', { class: 'fehler', hidden: true });
  const f = el('div', { class: 'feld', attr: { 'data-feld': name } }, el('label', { attr: { for: eingabe.id }, text: titel }), eingabe, info ? el('p', { class: 'info', text: info }) : null, fehler);
  f.fehler = (text) => { f.classList.toggle('falsch', !!text); fehler.hidden = !text; fehler.textContent = text || ''; };
  return f;
}

/** Fehler eines API-Aufrufs am passenden Feld zeigen (details.feld), sonst als Meldung. */
export function fehlerZeigen(e, form) {
  const name = e.details && e.details.feld;
  const suchen = (n) => form.querySelector(`[data-feld="${CSS.escape(n)}"]`);
  const f = name && form ? suchen(String(name)) || suchen(String(name).split('.')[0]) : null;
  if (f && f.fehler) { f.fehler(e.message); f.scrollIntoView({ block: 'nearest' }); } else melden(e.message, 'schlecht', 8000);
}

export function datum(iso) { if (!iso) return '–'; const d = new Date(iso); return Number.isNaN(d.getTime()) ? '–' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
export function zeit(iso) { if (!iso) return '–'; const d = new Date(iso); return d.toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
export function tageBis(iso) { return iso ? Math.floor((new Date(iso).getTime() - Date.now()) / 86400000) : null; }

// --- Anmeldung und Pflichtwechsel ---------------------------------------------------------------------------------
function ohneKopf() { document.querySelector('.kopf').hidden = true; }

function zeigeAnmeldung() {
  ohneKopf();
  const inhalt = document.getElementById('inhalt'); inhalt.replaceChildren();
  const name = el('input', { type: 'text', autocomplete: 'username', value: 'admin' });
  const pw = el('input', { type: 'password', autocomplete: 'current-password' });
  const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxLength: 6 });
  const codeFeld = feld({ titel: 'Code aus der Authenticator-App', eingabe: code }); codeFeld.hidden = true;
  const form = el('form', { class: 'karte anmelden', on: { submit: async (ev) => {
    ev.preventDefault();
    try {
      await api('POST', '/api/anmelden', { name: name.value, passwort: pw.value, code: code.value || undefined });
      await start();
    } catch (e) {
      if (e.details && e.details.code_noetig) { codeFeld.hidden = false; code.focus(); if (code.value) melden(e.message, 'schlecht'); return; }
      melden(e.message, 'schlecht', 8000);
    }
  } } },
  el('div', { class: 'marke' }, el('img', { src: 'symbol.svg', alt: '', width: 36, height: 36 }), el('span', { text: 'FAH-Proxy' })),
  feld({ titel: 'Name', eingabe: name }), feld({ titel: 'Passwort', eingabe: pw }), codeFeld,
  el('button', { class: 'knopf', type: 'submit', text: 'Anmelden' }));
  inhalt.append(form);
  pw.focus();
}

function zeigePflichtwechsel() {
  ohneKopf();
  const inhalt = document.getElementById('inhalt'); inhalt.replaceChildren();
  const neu = el('input', { type: 'password', autocomplete: 'new-password' });
  const neu2 = el('input', { type: 'password', autocomplete: 'new-password' });
  const f1 = feld({ titel: 'Neues Passwort', eingabe: neu, info: 'Mindestens 10 Zeichen. Das Startpasswort „admin“ gilt nur für die erste Anmeldung.', name: 'neu' });
  const form = el('form', { class: 'karte anmelden', on: { submit: async (ev) => {
    ev.preventDefault();
    if (neu.value !== neu2.value) { f1.fehler('Die beiden Eingaben unterscheiden sich'); return; }
    try { await api('POST', '/api/passwort', { neu: neu.value }); melden('Passwort gespeichert', 'gut'); await start(); } catch (e) { fehlerZeigen(e, form); }
  } } },
  el('h1', { text: 'Eigenes Passwort setzen' }), el('p', { class: 'unter', text: 'Bevor es losgeht: bitte ein eigenes Passwort für das Konto admin wählen.' }),
  f1, feld({ titel: 'Neues Passwort wiederholen', eingabe: neu2 }), el('button', { class: 'knopf', type: 'submit', text: 'Speichern' }));
  inhalt.append(form);
  neu.focus();
}

// --- Router -------------------------------------------------------------------------------------------------------
let lauf = 0;
async function route() {
  if (!zustand.ich) return;
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0]) || 'uebersicht';
  const laden = ANSICHTEN[name] || ANSICHTEN.uebersicht;
  for (const a of document.querySelectorAll('.navi a')) { if (a.dataset.ansicht === name) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  const nr = ++lauf;
  const inhalt = document.getElementById('inhalt');
  const modul = await laden();
  if (nr !== lauf) return;
  inhalt.replaceChildren();
  try { await modul.zeigen(inhalt); } catch (e) { if (nr === lauf) inhalt.append(el('div', { class: 'hinweis schlecht', text: e.message })); }
}

export function modusZeigen(modus, rolle = 'haupt') {
  const m = document.getElementById('modus');
  m.className = `modus ${modus}`;
  const text = modus === 'live' ? 'Live – FAH-Proxy bedient das Internet' : 'Bereitschaft – diese Instanz bedient das Internet gerade nicht';
  m.textContent = rolle === 'ersatz' ? `Ersatz-Instanz · ${text}` : text;
}

async function start() {
  try { zustand.ich = await api('GET', '/api/ich'); } catch (e) { if (e.code === 'E_ANMELDUNG' || e.code === 'E_NETZ') zeigeAnmeldung(); return; }
  if (zustand.ich.pflichtwechsel) { zeigePflichtwechsel(); return; }
  document.querySelector('.kopf').hidden = false;
  if (zustand.ich.modus) modusZeigen(zustand.ich.modus, zustand.ich.rolle);
  await route();
}

document.getElementById('abmelden').addEventListener('click', async () => { try { await api('POST', '/api/abmelden', {}); } catch { /* egal */ } zustand.ich = null; zeigeAnmeldung(); });
window.addEventListener('hashchange', route);
start();
