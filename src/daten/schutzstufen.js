// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Schutzstufen = die Kacheln „Wer darf die Seite öffnen?“. Vier feste (Texte änderbar; Netze der Heimnetz-Stufe sind die
// Einstellung „heimnetz“, die Dauer der Anmeldung „anmeldung.sitzung_tage“) und eigene Stufen in den Einstellungen unter
// schutz.eigene: Art „netze“ (nur diese Netze) oder „netze_anmeldung“ (diese Netze direkt, alle anderen mit FAH-Anmeldung).
// Eine Domain speichert die ID ihrer Stufe.

import { Fehler } from '../gemeinsam/fehler.js';
import { cidrPruefen } from '../gemeinsam/pruefen.js';

export const FESTE = Object.freeze([
  Object.freeze({ id: 'oeffentlich', art: 'oeffentlich', titel: 'Öffentlich', text: 'Jeder aus dem Internet kann die Seite öffnen.' }),
  Object.freeze({ id: 'heimnetz', art: 'netze', titel: 'Nur Heimnetz + VPN', text: 'Nur aus dem Heimnetz oder per WireGuard – alle anderen sehen „Kein Zugriff“.' }),
  Object.freeze({ id: 'ipliste', art: 'ipliste', titel: 'Eigene IP-Liste', text: 'Nur die Adressen und Netze, die du bei der Domain einträgst.' }),
  Object.freeze({ id: 'anmeldung', art: 'anmeldung', titel: 'Mit FAH-Anmeldung', text: 'FAH-Proxy zeigt vor der App eine Anmeldeseite (Konten unter Einstellungen).' }),
]);
export const FESTE_IDS = new Set(FESTE.map((s) => s.id));
export const EIGENE_ARTEN = Object.freeze({ netze: 'Nur diese Netze', netze_anmeldung: 'Diese Netze direkt, alle anderen mit FAH-Anmeldung' });
export const ID_MUSTER = /^s[0-9a-f]{8}$/;
export const EIGENE_MAX = 30;

/** Alle Stufen in Anzeigereihenfolge (feste zuerst), Texte überschrieben, Netze aufgelöst. */
export function stufenListe(e) {
  const schutz = e.schutz || { texte: {}, eigene: [] };
  const feste = FESTE.map((s) => ({ ...s, ...((schutz.texte || {})[s.id] || {}), netze: s.id === 'heimnetz' ? [...(e.heimnetz || [])] : [], fest: true }));
  const eigene = (schutz.eigene || []).map((s) => ({ id: s.id, art: s.art, titel: s.titel, text: s.text || '', netze: [...(s.netze || [])], fest: false }));
  return [...feste, ...eigene];
}
export function stufeFinden(e, id) { return stufenListe(e).find((s) => s.id === id) || null; }
export function brauchtAnmeldung(stufe) { return !!stufe && (stufe.art === 'anmeldung' || stufe.art === 'netze_anmeldung'); }

export function titelPruefen(titel) {
  const t = String(titel ?? '').trim();
  if (!t || t.length > 40) throw new Fehler('E_EINGABE', 'Titel: 1 bis 40 Zeichen', { feld: 'titel' });
  return t;
}
export function textPruefen(text) {
  const t = String(text ?? '').trim();
  if (t.length > 160) throw new Fehler('E_EINGABE', 'Text: höchstens 160 Zeichen', { feld: 'text' });
  return t;
}
export function netzePruefen(netze) {
  const roh = Array.isArray(netze) ? netze : String(netze ?? '').split(/[\s,;]+/);
  let liste;
  try { liste = [...new Set(roh.map((x) => String(x).trim()).filter(Boolean).map(cidrPruefen))]; } catch (f) { throw new Fehler('E_EINGABE', f.message, { feld: 'netze' }); }
  if (!liste.length) throw new Fehler('E_EINGABE', 'Mindestens ein Netz oder eine Adresse angeben', { feld: 'netze' });
  if (liste.length > 100) throw new Fehler('E_EINGABE', 'Höchstens 100 Netze', { feld: 'netze' });
  return liste;
}

/** Eingabe einer eigenen Stufe prüfen → {titel, text, art, netze}. */
export function eigeneStufePruefen({ titel, text, art, netze }) {
  if (!(art in EIGENE_ARTEN)) throw new Fehler('E_EINGABE', 'Unbekannte Art der Kachel', { feld: 'art' });
  return { titel: titelPruefen(titel), text: textPruefen(text), art, netze: netzePruefen(netze) };
}

/** Den gespeicherten Teil `schutz` der Einstellungen prüfen (Spiegel, Laden). */
export function schutzPruefen(schutz) {
  const s = schutz && typeof schutz === 'object' ? schutz : {};
  const texte = {};
  for (const [id, t] of Object.entries(s.texte || {})) {
    if (!FESTE_IDS.has(id) || !t || typeof t !== 'object') continue;
    texte[id] = { titel: titelPruefen(t.titel), text: textPruefen(t.text) };
  }
  const eigene = []; const ids = new Set();
  for (const x of Array.isArray(s.eigene) ? s.eigene : []) {
    if (!ID_MUSTER.test(String(x && x.id)) || ids.has(x.id)) throw new Fehler('E_EINGABE', 'Ungültige Kennung einer Kachel', { feld: 'schutz' });
    ids.add(x.id);
    eigene.push({ id: x.id, ...eigeneStufePruefen(x) });
  }
  if (eigene.length > EIGENE_MAX) throw new Fehler('E_EINGABE', `Höchstens ${EIGENE_MAX} eigene Kacheln`, { feld: 'schutz' });
  return { texte, eigene };
}
