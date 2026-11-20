// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Koppeln von EINER Oberfläche aus (09.10.2026): Rolle dieser Instanz wählen (Haupt oder Fail-over), Adresse und
// Admin-Zugang des Partners eingeben – diese Instanz meldet sich dort an und richtet beide Seiten ein. Den
// Kopplungscode tauschen die beiden dabei selbst aus (er enthält den Fingerabdruck der Haupt-Oberfläche, die Verbindung
// bleibt festgenagelt). Das Passwort des Partners wird nirgends gespeichert.
// Schutz: Eine leere Instanz (keine Domains, z. B. frisch installiert) überschreibt nie eine befüllte – sie holt sich
// zuerst deren Stand, auch wenn sie Haupt wird. So geht nach einer Neuinstallation nichts verloren.

import { Fehler } from '../gemeinsam/fehler.js';
import { festgenagelteAnfrage } from '../gemeinsam/festgenagelt.js';
import { standBauen, standAnwenden } from './stand.js';
import { verbinden, entkoppeln } from './ersatz.js';

const MELDUNGEN = {
  zeit: 'Der Partner antwortet nicht (Zeitüberschreitung)', netz: 'Der Partner ist nicht erreichbar ({grund})', anfrage: 'Anfrage an den Partner fehlgeschlagen ({grund})',
  zertifikat: 'Das Zertifikat des Partners hat sich während der Kopplung geändert – aus Sicherheit abgebrochen.',
};

/** Adresse der Partner-Oberfläche → Origin (nur https://Host:Port). */
export function partnerUrl(roh) {
  let u = null;
  try { u = new URL(String(roh || '').trim()); } catch { /* unten */ }
  if (!u || u.protocol !== 'https:' || (u.pathname !== '/' && u.pathname !== '') || u.search) throw new Fehler('E_EINGABE', 'Adresse der FAH-Proxy-Oberfläche des Partners, z. B. https://192.168.1.23:28181', { feld: 'url' });
  return u.origin;
}

/**
 * Bei der Partner-Oberfläche anmelden → {anfrage(methode, pfad, body), fingerabdruck, abmelden()}. Der beim Anmelden
 * gesehene Zertifikats-Fingerabdruck gilt für alle weiteren Anfragen dieser Sitzung.
 */
export async function partnerAnmelden(url, { name, passwort, code }) {
  let fingerabdruck = ''; const glas = {};
  const anfrage = async (methode, pfad, body) => {
    const kopf = {};
    if (glas.fp_sitzung) kopf.Cookie = `fp_sitzung=${encodeURIComponent(glas.fp_sitzung)}; fp_csrf=${encodeURIComponent(glas.fp_csrf || '')}`;
    if (glas.fp_csrf && methode !== 'GET') kopf['X-FP-CSRF'] = glas.fp_csrf;
    const r = await festgenagelteAnfrage({ url, fingerabdruck, methode, pfad, kopf, body: body === undefined ? undefined : JSON.stringify(body), zeitlimit_ms: 90_000, code: 'E_SPIEGEL', meldungen: MELDUNGEN });
    if (!fingerabdruck) fingerabdruck = r.gesehen;
    for (const c of [].concat(r.kopf['set-cookie'] || [])) {
      const [nv] = String(c).split(';'); const i = nv.indexOf('=');
      if (i > 0) glas[nv.slice(0, i).trim()] = decodeURIComponent(nv.slice(i + 1).trim());
    }
    let j = null; try { j = JSON.parse(r.text); } catch { /* unten */ }
    if (!j || typeof j.ok !== 'boolean') throw new Fehler('E_SPIEGEL', `Unter ${url} antwortet keine FAH-Proxy-Oberfläche (HTTP ${r.status})`);
    if (!j.ok) {
      const f = j.fehler || {};
      throw new Fehler('E_SPIEGEL', `Partner: ${f.meldung || `HTTP ${r.status}`}`, { partner: f.code || null });
    }
    return j.ergebnis;
  };
  try {
    const ich = await anfrage('POST', '/api/anmelden', { name: String(name || '').trim(), passwort: String(passwort || ''), ...(code ? { code: String(code).trim() } : {}) });
    if (ich.pflichtwechsel) throw new Fehler('E_EINGABE', 'Der Partner hat noch das Startpasswort – bitte dort zuerst anmelden und ein eigenes Passwort setzen', { feld: 'passwort' });
  } catch (e) {
    const f = Fehler.aus(e);
    if (f.details && (f.details.partner === 'E_ANMELDUNG' || f.details.partner === 'E_RECHTE')) {
      if (f.details.partner === 'E_RECHTE') throw new Fehler('E_EINGABE', `${f.message} – bitte ein Admin-Konto des Partners nehmen`, { feld: 'name' });
      const zweiFa = /Code/.test(f.message);
      throw new Fehler('E_EINGABE', zweiFa ? 'Der Partner verlangt den Code aus der Authenticator-App (2FA)' : 'Name oder Passwort beim Partner stimmen nicht', { feld: zweiFa ? 'code' : 'passwort' });
    }
    throw f;
  }
  return { anfrage, get fingerabdruck() { return fingerabdruck; }, abmelden: () => anfrage('POST', '/api/abmelden', {}).catch(() => {}) };
}

/** Kurzer Zustand dieser Instanz für den Partner (GET /api/spiegel/zustand). */
export function zustand(app) {
  const e = app.einstellungen.lesen();
  return { rolle: e.rolle, leer: app.domains.liste().length === 0, domains: app.domains.liste().length, aktiv: app.istAktiv(), ui_url: app.uiUrl || '', version: app.version, gekoppelt: e.rolle === 'ersatz' ? !!e.spiegel.schluessel : app.spiegelHaupt.liste().length > 0 };
}

/**
 * Koppeln: diese Instanz wird `rolle` ('haupt' | 'ersatz'), der Partner die andere Rolle.
 * → {rolle, partner, uebernommen: 'vom Partner'|'zum Partner'|null, ergebnis}
 */
export async function partnerKoppeln(app, { rolle, url, name, passwort, code }, { anmelden = partnerAnmelden } = {}) {
  if (!['haupt', 'ersatz'].includes(rolle)) throw new Fehler('E_EINGABE', 'Bitte wählen, ob diese Instanz Haupt oder Fail-over wird', { feld: 'rolle' });
  const ziel = partnerUrl(url);
  if (app.uiUrl && new URL(app.uiUrl).origin === ziel) throw new Fehler('E_EINGABE', 'Das ist die Adresse dieser Instanz – bitte die des Partners eingeben', { feld: 'url' });
  if (!String(name || '').trim() || !passwort) throw new Fehler('E_EINGABE', 'Name und Passwort eines Admins des Partners eingeben', { feld: name ? 'passwort' : 'name' });
  const p = await anmelden(ziel, { name, passwort, code });
  try {
    const pz = await p.anfrage('GET', '/api/spiegel/zustand');
    const ichLeer = app.domains.liste().length === 0;
    let uebernommen = null;
    if (rolle === 'haupt') {
      // erst den Stand des Partners holen, wenn hier nichts ist (Neuinstallation) – sonst überschriebe die leere Instanz ihn
      if (ichLeer && !pz.leer) {
        await standAnwenden(app, (await p.anfrage('GET', '/api/spiegel/export')).stand, { vomHaupt: false });
        uebernommen = 'vom Partner';
      }
      if (app.einstellungen.lesen().rolle === 'ersatz') await entkoppeln(app);
      const host = new URL(ziel).hostname;
      for (const x of app.spiegelHaupt.liste()) if (x.ip === host || (x.ui_url && new URL(x.ui_url).origin === ziel)) await app.spiegelHaupt.entfernen(x.id);
      const { code: kopplung } = await app.spiegelHaupt.codeErzeugen();
      const ergebnis = await p.anfrage('POST', '/api/spiegel/verbinden', { code: kopplung });
      return { rolle, partner: ziel, uebernommen, ergebnis };
    }
    // diese Instanz wird Fail-over: Partner zum Haupt machen und Code holen; ist er leer, bekommt er danach den Stand von
    // hier (Import ersetzt dort die Konten – deshalb als letzte Anfrage dieser Sitzung)
    if (pz.rolle === 'ersatz') await p.anfrage('POST', '/api/spiegel/entkoppeln', {});
    const { code: kopplung } = await p.anfrage('POST', '/api/spiegel/code', {});
    if (pz.leer && !ichLeer) {
      await p.anfrage('POST', '/api/spiegel/import', { stand: await standBauen(app) });
      uebernommen = 'zum Partner';
    }
    const ergebnis = await verbinden(app, kopplung);
    return { rolle, partner: ziel, uebernommen, ergebnis };
  } finally { await p.abmelden(); }
}
