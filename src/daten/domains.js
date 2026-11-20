// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Domains (daten/domains.json): je Domain Ziel, Schutzstufe, IP-Liste, aktiv. Jede Änderung wird vollständig geprüft
// (Task-1-Prüfungen) – was hier gespeichert ist, darf ungeprüft ins Caddyfile.

import path from 'node:path';
import crypto from 'node:crypto';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { domainPruefen, zielPruefen, cidrPruefen } from '../gemeinsam/pruefen.js';

export const SCHUTZ = Object.freeze(['oeffentlich', 'heimnetz', 'ipliste', 'anmeldung']);
const EIGENE_STUFE = /^s[0-9a-f]{8}$/;
const NOTIZ_MAX = 300;
export const PFADE_MAX = 20;
const PFAD = /^\/[A-Za-z0-9._~\-/]*$/;

/** Pfad-Regeln: [{pfad (beginnt mit /, nur sichere Zeichen), ziel, praefix_entfernen}] – höchstens 20, Pfade eindeutig. */
export function pfadeNormieren(liste) {
  if (liste === undefined || liste === null) return [];
  if (!Array.isArray(liste) || liste.length > PFADE_MAX) throw new Fehler('E_EINGABE', `Höchstens ${PFADE_MAX} Pfad-Regeln`, { feld: 'pfade' });
  const aus = [];
  for (const r of liste) {
    const pfad = String((r && r.pfad) ?? '').trim();
    if (!PFAD.test(pfad) || pfad === '/') throw new Fehler('E_EINGABE', `Pfad „${pfad.slice(0, 40)}“ ungültig – er beginnt mit / und enthält nur Buchstaben, Ziffern und . _ ~ - /`, { feld: 'pfade' });
    let ziel;
    try { ziel = zielPruefen(r.ziel).url; } catch (f) { throw new Fehler('E_EINGABE', `Pfad ${pfad}: ${f.message}`, { feld: 'pfade' }); }
    if (aus.some((x) => x.pfad === pfad)) throw new Fehler('E_EINGABE', `Pfad ${pfad} ist doppelt`, { feld: 'pfade' });
    aus.push({ pfad, ziel, praefix_entfernen: r.praefix_entfernen === true });
  }
  return aus;
}

/** Einen (teilweise neuen) Eintrag prüfen und normieren. */
export function domainNormieren(e) {
  const domain = domainPruefen(e.domain);
  const ziel = zielPruefen(e.ziel).url;
  const schutz = String(e.schutz ?? 'oeffentlich');
  if (!SCHUTZ.includes(schutz) && !EIGENE_STUFE.test(schutz)) throw new Fehler('E_EINGABE', 'Unbekannte Schutzstufe', { feld: 'schutz' });
  const roh = Array.isArray(e.ip_liste) ? e.ip_liste : (typeof e.ip_liste === 'string' ? e.ip_liste.split(/[\s,;]+/) : []);
  let ip_liste;
  try { ip_liste = [...new Set(roh.map((x) => String(x).trim()).filter(Boolean).map(cidrPruefen))]; } catch (f) { throw new Fehler('E_EINGABE', f.message, { feld: 'ip_liste' }); }
  if (schutz === 'ipliste' && !ip_liste.length) throw new Fehler('E_EINGABE', 'Für „Eigene IP-Liste“ mindestens eine Adresse oder ein Netz eintragen', { feld: 'ip_liste' });
  if (ip_liste.length > 200) throw new Fehler('E_EINGABE', 'Höchstens 200 Einträge in der IP-Liste', { feld: 'ip_liste' });
  const notiz = String(e.notiz ?? '').replace(/[\u0000-\u001f]/g, ' ').slice(0, NOTIZ_MAX);
  const herkunft = /^(neu|npm:\d+|spiegel)$/.test(String(e.herkunft || 'neu')) ? String(e.herkunft || 'neu') : 'neu';
  const rubrik = String(e.rubrik ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40).trim();
  return { domain, ziel, schutz, ip_liste, pfade: pfadeNormieren(e.pfade), hsts: e.hsts !== false, aktiv: e.aktiv !== false, ziel_tls_pruefen: e.ziel_tls_pruefen === true, notiz, herkunft, rubrik };
}

export class Domains {
  constructor(datei, eintraege) { this.datei = datei; this.eintraege = eintraege; }

  static async laden(ordner) {
    const datei = path.join(ordner, 'domains.json');
    const d = await jsonLesen(datei, { domains: [] });
    return new Domains(datei, Array.isArray(d.domains) ? d.domains : []);
  }

  liste() { return [...this.eintraege].sort((a, b) => a.domain.localeCompare(b.domain)).map((e) => ({ ...e })); }

  holen(id) {
    const e = this.eintraege.find((x) => x.id === id);
    if (!e) throw new Fehler('E_NICHT_GEFUNDEN', 'Diese Domain gibt es nicht (mehr)', { feld: 'id' });
    return { ...e };
  }

  #frei(domain, ausserId = null) {
    if (this.eintraege.some((x) => x.domain === domain && x.id !== ausserId)) throw new Fehler('E_EXISTIERT', `Die Domain ${domain} ist schon angelegt`, { feld: 'domain' });
  }

  async #speichern() { await jsonSchreiben(this.datei, { domains: this.eintraege }); }

  async anlegen(e) {
    const n = domainNormieren(e);
    this.#frei(n.domain);
    const jetzt = new Date().toISOString();
    const eintrag = { id: `d${crypto.randomBytes(6).toString('hex')}`, ...n, angelegt: jetzt, geaendert: jetzt };
    this.eintraege.push(eintrag);
    await this.#speichern();
    return { ...eintrag };
  }

  async aendern(id, teil) {
    const alt = this.holen(id);
    const n = domainNormieren({ ...alt, ...teil });
    this.#frei(n.domain, id);
    const neu = { ...alt, ...n, id, angelegt: alt.angelegt, geaendert: new Date().toISOString() };
    this.eintraege = this.eintraege.map((x) => (x.id === id ? neu : x));
    await this.#speichern();
    return { ...neu };
  }

  async loeschen(id) {
    this.holen(id);
    this.eintraege = this.eintraege.filter((x) => x.id !== id);
    await this.#speichern();
  }

  /** Ganze Liste ersetzen (Spiegel der Ersatz-Instanz) – jeder Eintrag wird geprüft. */
  async ersetzen(liste) {
    this.eintraege = liste.map((e) => ({ id: /^d[0-9a-f]{12}$/.test(e.id) ? e.id : `d${crypto.randomBytes(6).toString('hex')}`, ...domainNormieren(e), angelegt: e.angelegt || new Date().toISOString(), geaendert: e.geaendert || new Date().toISOString() }));
    await this.#speichern();
  }
}
