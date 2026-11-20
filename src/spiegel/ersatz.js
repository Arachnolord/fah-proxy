// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Ersatz-Seite des Spiegels: Kopplungscode lesen, beim Haupt koppeln (Fingerabdruck aus dem Code wird festgenagelt – ein
// falsches Gegenüber bekommt den Einmal-Schlüssel nie), alle 5 Minuten den Stand holen und anwenden: Domains, Konten (2FA
// mit eigenem Schlüssel neu verschlüsselt), Einstellungen (die eigene Ziel-IP für UniFi bleibt), neuere Zertifikate.
// Der eigene Caddy bleibt im Modus test, bis hier jemand „Übernehmen“ klickt. Warnung, wenn der Abgleich > 1 h alt ist.

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { festgenagelteAnfrage } from '../gemeinsam/festgenagelt.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { standBauen, standAnwenden } from './stand.js';
import { CODE_PRAEFIX, uiFingerabdruck } from './haupt.js';

export const ABGLEICH_MS = 5 * 60_000;
export const WARN_MS = 3600_000;
const MELDUNGEN = {
  zeit: 'Der Haupt-FAH-Proxy antwortet nicht (Zeitüberschreitung)', netz: 'Der Haupt-FAH-Proxy ist nicht erreichbar ({grund})', anfrage: 'Anfrage an den Haupt-FAH-Proxy fehlgeschlagen ({grund})',
  zertifikat: 'Das Zertifikat des Haupt-FAH-Proxys passt nicht zum Kopplungscode – aus Sicherheit abgebrochen. Bitte am Haupt einen neuen Code erzeugen.',
};

/** Kopplungscode → {url, fingerabdruck, schluessel}; sonst E_EINGABE. */
export function codeLesen(code) {
  const s = String(code || '').trim();
  try {
    if (!s.startsWith(CODE_PRAEFIX)) throw new Error('Präfix');
    const j = JSON.parse(Buffer.from(s.slice(CODE_PRAEFIX.length), 'base64url').toString('utf8'));
    const u = new URL(j.u);
    if (u.protocol !== 'https:' || !j.f || !j.k) throw new Error('unvollständig');
    return { url: u.origin, fingerabdruck: String(j.f), schluessel: String(j.k) };
  } catch { throw new Fehler('E_EINGABE', 'Das ist kein Kopplungscode von FAH-Proxy – bitte den ganzen Code vom Haupt-FAH-Proxy einfügen', { feld: 'code' }); }
}

async function anfrage(url, fingerabdruck, methode, pfad, { token, body } = {}) {
  const r = await festgenagelteAnfrage({ url, fingerabdruck, methode, pfad, kopf: token ? { Authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body), zeitlimit_ms: 30_000, code: 'E_SPIEGEL', meldungen: MELDUNGEN });
  let j = null; try { j = JSON.parse(r.text); } catch { /* kein JSON */ }
  return { status: r.status, j };
}
/** Abfrageteil mit dem eigenen Proxy-Ziel (die Haupt-Instanz braucht es für ihre Wache) und der eigenen Oberfläche (Rollentausch, Homepage). */
async function eigenesZiel(app) {
  const z = app.unifiZiel(); const q = new URLSearchParams();
  if (z.ip && z.http && z.https) { q.set('ip', z.ip); q.set('http', String(z.http)); q.set('https', String(z.https)); }
  if (app.uiUrl) { q.set('ui', app.uiUrl); q.set('f', await uiFingerabdruck(app)); }
  return q.size ? `?${q}` : '';
}
const portOk = (p) => Number.isInteger(p) && p > 0 && p < 65536;
const ablehnung = (r) => (r.j && r.j.fehler && r.j.fehler.meldung) || `HTTP ${r.status}`;

export async function verbinden(app, code) {
  const k = codeLesen(code);
  const r = await anfrage(k.url, k.fingerabdruck, 'POST', '/api/spiegel/koppeln', { body: { schluessel: k.schluessel, name: `FAH-Proxy ${app.hostIp || os.hostname()}`, ui: app.uiUrl ? { url: app.uiUrl, fingerabdruck: await uiFingerabdruck(app) } : null } });
  if (!r.j || !r.j.ok) throw new Fehler('E_SPIEGEL', `Koppeln abgelehnt: ${ablehnung(r)}`);
  await app.einstellungen.setzen({ rolle: 'ersatz', spiegel: { haupt_url: k.url, fingerabdruck: k.fingerabdruck, schluessel: app.geheim.verschluesseln(r.j.ergebnis.token), letzter_abgleich: null, letzter_fehler: null } });
  return abgleichen(app);
}

/**
 * Abgleich mit der Haupt-Instanz, immer von der aktiven Instanz aus: Ist diese Ersatz-Instanz aktiv (Fail-over), geht ihr
 * Stand zur Haupt-Instanz (Änderungen während des Ausfalls); sonst holt sie den Stand der Haupt-Instanz.
 */
export async function abgleichen(app) {
  const e = app.einstellungen.lesen();
  if (e.rolle !== 'ersatz' || !e.spiegel.schluessel) throw new Fehler('E_EINGABE', 'Diese Instanz ist nicht als Ersatz gekoppelt');
  const vermerken = (felder) => app.einstellungen.setzen({ spiegel: { ...app.einstellungen.lesen().spiegel, ...felder } });
  const token = app.geheim.entschluesseln(e.spiegel.schluessel);
  try {
    let ergebnis;
    if (app.istAktiv()) {
      const r = await anfrage(e.spiegel.haupt_url, e.spiegel.fingerabdruck, 'POST', '/api/spiegel/stand', { token, body: { stand: await standBauen(app) } });
      if (r.status === 401) throw new Fehler('E_SPIEGEL', 'Der Haupt-FAH-Proxy kennt diese Ersatz-Instanz nicht mehr – bitte neu koppeln (Einstellungen → Ersatz-Instanz)');
      if (!r.j || !r.j.ok) throw new Fehler('E_SPIEGEL', `Haupt-Instanz nimmt den Stand nicht an: ${ablehnung(r)}`);
      ergebnis = { ...r.j.ergebnis, richtung: 'zur Haupt-Instanz' };
    } else {
      const r = await anfrage(e.spiegel.haupt_url, e.spiegel.fingerabdruck, 'GET', `/api/spiegel${await eigenesZiel(app)}`, { token });
      if (r.status === 401) throw new Fehler('E_SPIEGEL', 'Der Haupt-FAH-Proxy kennt diese Ersatz-Instanz nicht mehr – bitte neu koppeln (Einstellungen → Ersatz-Instanz)');
      if (!r.j || !r.j.ok) throw new Fehler('E_SPIEGEL', `Abgleich abgelehnt: ${ablehnung(r)}`);
      ergebnis = { ...await standAnwenden(app, r.j.ergebnis, { vomHaupt: true }), richtung: 'von der Haupt-Instanz' };
    }
    await vermerken({ letzter_abgleich: new Date().toISOString(), letzter_fehler: null });
    return ergebnis;
  } catch (err) {
    const f = Fehler.aus(err);
    await vermerken({ letzter_fehler: f.message });
    throw f;
  }
}

/**
 * Neue Zeilen des Zugriffsprotokolls der Haupt-Instanz nach daten/caddy/partner-zugriffe.log (0644, die Homepage auf dem
 * NAS liest sie mit). Stand (Inode + Position) in daten/partner-zugriffe.json; ab 20 MB wird die Datei einmal umbenannt.
 */
/** Nach der Rückgabe: der Haupt-Instanz sagen, dass sie wieder aktiv ist – sie liest UniFi dann sofort statt erst nach 5 min. */
export async function wechselMelden(app) {
  const e = app.einstellungen.lesen();
  if (e.rolle !== 'ersatz' || !e.spiegel.schluessel) return;
  const r = await anfrage(e.spiegel.haupt_url, e.spiegel.fingerabdruck, 'POST', '/api/spiegel/wechsel', { token: app.geheim.entschluesseln(e.spiegel.schluessel), body: {} });
  if (!r.j || !r.j.ok) throw new Fehler('E_SPIEGEL', `Haupt-Instanz: ${ablehnung(r)}`);
}

export async function zugriffeHolen(app) {
  const e = app.einstellungen.lesen();
  if (e.rolle !== 'ersatz' || !e.spiegel.schluessel) return 0;
  const standDatei = path.join(app.daten, 'partner-zugriffe.json');
  const stand = await jsonLesen(standDatei, { kennung: '', bis: 0 });
  const r = await anfrage(e.spiegel.haupt_url, e.spiegel.fingerabdruck, 'GET', `/api/spiegel/zugriffe?${new URLSearchParams({ kennung: stand.kennung || '', ab: String(stand.bis || 0) })}`, { token: app.geheim.entschluesseln(e.spiegel.schluessel) });
  if (!r.j || !r.j.ok) throw new Fehler('E_SPIEGEL', `Zugriffe holen abgelehnt: ${ablehnung(r)}`);
  const { kennung, bis, text } = r.j.ergebnis;
  if (text) {
    const ziel = path.join(app.daten, 'caddy', 'partner-zugriffe.log');
    await fs.mkdir(path.dirname(ziel), { recursive: true });
    const st = await fs.stat(ziel).catch(() => null);
    if (st && st.size > 20 * 1024 * 1024) await fs.rename(ziel, `${ziel.slice(0, -4)}.1.log`);
    await fs.appendFile(ziel, text, { mode: 0o644 });
    await fs.chmod(ziel, 0o644);
  }
  await jsonSchreiben(standDatei, { kennung, bis });
  return text ? text.split('\n').length - 1 : 0;
}

export async function entkoppeln(app) {
  await app.einstellungen.setzen({ rolle: 'haupt', spiegel: { haupt_url: '', fingerabdruck: '', schluessel: '', letzter_abgleich: null, letzter_fehler: null } });
}

/** ntfy-Regel der Ersatz-Instanz: Abgleich älter als 1 Stunde (oder nie) → Warnung; null, wenn nicht gekoppelt. */
export function spiegelWarnung(e, jetzt = Date.now()) {
  if (e.rolle !== 'ersatz' || !e.spiegel || !e.spiegel.schluessel) return null;
  const l = e.spiegel.letzter_abgleich;
  let host = e.spiegel.haupt_url; try { host = new URL(host).host; } catch { /* so lassen */ }
  const wann = l ? new Date(l).toLocaleString('de-DE', { timeZone: 'Europe/Berlin', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'noch nie';
  return {
    schluessel: 'spiegel:abgleich', aktiv: !l || jetzt - Date.parse(l) > WARN_MS, prio: 4, tags: ['warning'],
    titel: 'FAH-Proxy Ersatz: Abgleich veraltet', text: `Letzter Abgleich mit dem Haupt-FAH-Proxy ${host}: ${wann}.${e.spiegel.letzter_fehler ? ` ${e.spiegel.letzter_fehler}` : ''}`,
    entwarnung: { titel: 'FAH-Proxy Ersatz: Abgleich läuft wieder', text: 'Die Ersatz-Instanz ist wieder auf dem Stand des Haupt-FAH-Proxys.', prio: 3, tags: ['white_check_mark'] },
  };
}
