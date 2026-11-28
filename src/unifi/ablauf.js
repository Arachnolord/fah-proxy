// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Umschalten auf der Konsole ausführen: aktuellen Stand lesen (Weiterleitungen, lokale DNS-Einträge, Firewall-Regeln),
// planen, Sicherung schreiben (vor dem ersten Schreibzugriff), Schritte der Reihe nach. Scheitert ein Schritt, wird sofort
// zurückgestellt. „Nachziehen“ im Live-Betrieb ergänzt die offene Sicherung (der Stand vor dem ERSTEN Umschalten bleibt –
// sie ist das Protokoll, wie die Konsole vorher aussah). Nur auf Klick.

import fs from 'node:fs/promises';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { umschaltPlan, ohneStatistik, aktivIp, dnsDeckt, NAME_HTTP, NAME_HTTPS } from './plan.js';
import { datenwegPruefen } from '../gemeinsam/datenweg.js';

/** Schritte der Reihe nach; `erledigt` sammelt, was geklappt hat (bei „anlegen“ mit der neuen Regel), für das Rückgängigmachen. */
async function schritteAusfuehren(client, schritte, erledigt = []) {
  for (let i = 0; i < schritte.length; i++) {
    const s = schritte[i];
    try {
      let neu = null;
      if (s.bereich === 'dns') await client.dnsAendern(s.id, s.nachher);
      else if (s.bereich === 'firewall') await client.firewallAendern(s.id, s.nachher);
      else if (s.art === 'aendern') await client.aendern(s.id, s.nachher);
      else if (s.art === 'anlegen') neu = await client.anlegen(s.regel);
      else if (s.art === 'loeschen') await client.loeschen(s.id);
      erledigt.push({ s, neu });
    } catch (e) {
      const f = Fehler.aus(e);
      throw new Fehler(f.code, f.message, { ...(f.details || {}), schritt: i + 1, text: s.text });
    }
  }
}

/** Neueste Sicherung → {datei, sicherung} oder null. */
export async function letzteSicherung(ordner) {
  let namen;
  try { namen = (await fs.readdir(ordner)).filter((n) => n.endsWith('.json')).sort(); } catch { return null; }
  if (!namen.length) return null;
  const datei = path.join(ordner, namen.at(-1));
  return { datei, sicherung: await jsonLesen(datei, null) };
}

/** Stand der Konsole: Weiterleitungen müssen lesbar sein; DNS/Firewall ohne Erfolg → leer + Hinweis (selbst prüfen). */
export async function standLesen(client) {
  const hinweise = [];
  const lesen = async (fn, was) => { try { return await fn(); } catch (e) { hinweise.push(`${was} ließen sich nicht lesen (${Fehler.aus(e).message}) – bitte selbst prüfen.`); return []; } };
  const regeln = await client.weiterleitungen();
  return { regeln, dns: await lesen(() => client.dnsEintraege(), 'Die lokalen DNS-Einträge'), firewall: await lesen(() => client.firewallRegeln(), 'Die Firewall-Regeln'), hinweise };
}

/**
 * Nach einem Fehler genau die erledigten Schritte DIESES Laufs rückgängig machen (rückwärts): Geändertes aus der Sicherung
 * des Laufs zurückschreiben, Angelegtes löschen. Ein früheres Umschalten (z. B. vor „Nachziehen“) bleibt so bestehen.
 * Danach FAH-Proxy-Regeln entfernen, die es vor dem Lauf nicht gab (falls ein Anlegen trotz Fehlermeldung durchging).
 */
async function rueckgaengig(client, erledigt, sicherung, vorher) {
  const gesichert = (bereich, id) => (sicherung[bereich === 'weiterleitung' ? 'regeln' : bereich] || []).find((x) => x._id === id);
  for (const { s, neu } of [...erledigt].reverse()) {
    if (s.art === 'anlegen') { if (neu && neu._id) await client.loeschen(neu._id); continue; }
    const b = gesichert(s.bereich || 'weiterleitung', s.id);
    if (!b) continue;
    if (s.bereich === 'dns') await client.dnsAendern(b._id, ohneStatistik(b));
    else if (s.bereich === 'firewall') await client.firewallAendern(b._id, ohneStatistik(b));
    else await client.aendern(b._id, b);
  }
  const bekannt = new Set(vorher.regeln.map((r) => r._id));
  for (const r of await client.weiterleitungen()) if ((r.name === NAME_HTTP || r.name === NAME_HTTPS) && !bekannt.has(r._id)) await client.loeschen(r._id);
}

/** Offene Sicherung (seit dem letzten Zurück) um neu berührte Einträge ergänzen; der ältere Stand gewinnt. */
function zusammenfuehren(alt, neu) {
  if (!alt) return neu;
  const aus = { ...alt, zeit: neu.zeit, ziel: neu.ziel };
  for (const k of ['regeln', 'dns', 'firewall']) {
    const da = new Set((alt[k] || []).map((x) => x._id));
    aus[k] = [...(alt[k] || []), ...(neu[k] || []).filter((x) => !da.has(x._id))];
  }
  return aus;
}

/**
 * Ziele lokaler DNS-Einträge (A, aktiv, deckt eine Domain), unter denen auf 443 ein FAH-Proxy antwortet – solche Einträge
 * bleiben an (z. B. *.example.org → NAS, dessen Instanz zusätzlich 443 annimmt: nötig fürs WireGuard-VPN).
 * `sni`: Domain mit Zertifikat, unter der gefragt wird (wie bei der Wache). Ohne Zertifikat scheitert schon der TLS-Aufbau,
 * und ein lebender FAH-Proxy gälte als „nicht auf 443“ – am 23.11. blieb so der DNS beim Ersatz: Die alphabetisch erste
 * Domain war eine neue dns-…-Domain, für die die Haupt-Instanz im Testbetrieb noch kein Zertifikat hatte.
 */
export async function fahProxyAuf443(dns, domains, pruefen = datenwegPruefen, zusatz = [], sni = null) {
  const ziele = new Map();
  if (domains.length) for (const h of zusatz) if (h) ziele.set(String(h), domains[0]);
  for (const e of dns) {
    if (e.enabled === false || e.record_type !== 'A') continue;
    const d = domains.find((x) => dnsDeckt(e.key, x));
    if (d && !ziele.has(String(e.value))) ziele.set(String(e.value), d);
  }
  const frage = sni && domains.includes(sni) ? sni : null;
  const ok = await Promise.all([...ziele].map(async ([host, domain]) => ((await pruefen({ host, port: 443, domain: frage || domain })) ? host : null)));
  return ok.filter(Boolean);
}

/** @returns {Promise<{plan, ausgefuehrt:number, sicherungDatei:string|null}>} */
export async function umschalten(client, { ziel, sicherungOrdner, domains = [], partnerIps = [], pruefen = datenwegPruefen, sni = null }) {
  const stand = await standLesen(client);
  const fahProxy443 = await fahProxyAuf443(stand.dns, domains, pruefen, [ziel.ip], sni);
  const plan = { ...umschaltPlan(stand.regeln, ziel, { ...stand, domains, partnerIps, fahProxy443 }), hinweise: stand.hinweise };
  if (!plan.ausfuehrbar) throw new Fehler('E_EINGABE', `So lässt sich nicht umschalten: ${plan.probleme.join(' ')}`, { probleme: plan.probleme });
  if (!plan.schritte.length) return { plan, ausgefuehrt: 0, sicherungDatei: null };
  await fs.mkdir(sicherungOrdner, { recursive: true, mode: 0o700 });
  const offen = await letzteSicherung(sicherungOrdner);
  const datei = path.join(sicherungOrdner, `${plan.sicherung.zeit.replace(/[:.]/g, '-')}.json`);
  await jsonSchreiben(datei, zusammenfuehren(offen && offen.sicherung && !offen.sicherung.abgeschlossen ? offen.sicherung : null, plan.sicherung));
  const erledigt = [];
  try { await schritteAusfuehren(client, plan.schritte, erledigt); } catch (e) {
    const f = Fehler.aus(e);
    let rueck = 'alles ist wieder wie vorher';
    try { await rueckgaengig(client, erledigt, plan.sicherung, stand); } catch (e2) {
      rueck = `der Rückweg ist ebenfalls gescheitert (${Fehler.aus(e2).message}) – der Stand davor steht in der Sicherung ${path.basename(datei)}`;
    }
    throw new Fehler('E_UNIFI', `Umschalten bei Schritt ${f.details?.schritt ?? '?'} gescheitert (${f.message}) – zurückgestellt: ${rueck}.`, { schritt: f.details?.schritt });
  }
  return { plan, ausgefuehrt: plan.schritte.length, sicherungDatei: datei };
}

/**
 * Fail-over/Rollenwechsel: die FAH-Proxy-Weiterleitungen auf `ziel` stellen und Firewall-Sperren zur Partner-IP um die
 * eigene IP ergänzen – nichts anderes (keine Sicherung). Gibt es die FAH-Proxy-Regeln noch nicht (nie umgeschaltet),
 * gibt es nichts zu wechseln. Fehler → eigene Schritte zurück.
 */
export async function aktivWechseln(client, { ziel, partnerIps = [], domains = [], pruefen = datenwegPruefen, sni = null }) {
  const stand = await standLesen(client);
  if (!stand.regeln.some((r) => r.name === NAME_HTTP) || !aktivIp(stand.regeln)) throw new Fehler('E_EINGABE', 'FAH-Proxy ist noch nicht umgeschaltet (keine Weiterleitungen „FAH-Proxy HTTP/HTTPS“) – es gibt nichts zu wechseln');
  const fahProxy443 = await fahProxyAuf443(stand.dns, domains, pruefen, [ziel.ip], sni);
  const plan = umschaltPlan(stand.regeln, ziel, { ...stand, domains, partnerIps, fahProxy443 });
  if (!plan.ausfuehrbar) throw new Fehler('E_EINGABE', `So lässt sich nicht wechseln: ${plan.probleme.join(' ')}`);
  const eigene = new Set(stand.regeln.filter((r) => r.name === NAME_HTTP || r.name === NAME_HTTPS).map((r) => r._id));
  // DNS nur, wenn er der aktiven Instanz folgt (Umstellen auf die neue IP) – nie im Fail-over etwas abschalten
  const schritte = plan.schritte.filter((s) => s.bereich === 'firewall' || (s.bereich === 'dns' && s.nachher && s.nachher.enabled !== false) || (s.bereich === 'weiterleitung' && s.art === 'aendern' && eigene.has(s.id)));
  const erledigt = [];
  try { await schritteAusfuehren(client, schritte, erledigt); } catch (e) {
    const f = Fehler.aus(e);
    let rueck = 'alles ist wieder wie vorher';
    try { await rueckgaengig(client, erledigt, plan.sicherung, stand); } catch (e2) { rueck = `der Rückweg ist ebenfalls gescheitert (${Fehler.aus(e2).message})`; }
    throw new Fehler('E_UNIFI', `Wechsel bei Schritt ${f.details?.schritt ?? '?'} gescheitert (${f.message}) – zurückgestellt: ${rueck}.`);
  }
  return { schritte };
}
