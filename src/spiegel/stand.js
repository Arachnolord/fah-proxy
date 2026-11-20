// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Der gemeinsame Stand zweier FAH-Proxy-Instanzen – abgeglichen wird immer von der aktiven zur anderen: Domains, Konten,
// gemeinsame Einstellungen (Heimnetz, Anmeldung, Schutzstufen, ntfy, UniFi ohne die eigene Ziel-IP, Fail-over-Schalter)
// und das jeweils beste Zertifikat je Domain. Anwenden ersetzt alles: Neues kommt dazu, Geändertes wird übernommen,
// Gelöschtes verschwindet (auch übernommene Zertifikate gelöschter Domains). Geheimnisse gehen entschlüsselt über die
// festgenagelte TLS-Verbindung und werden mit dem eigenen Schlüssel neu verschlüsselt.

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Fehler } from '../gemeinsam/fehler.js';
import { textSchreiben } from '../gemeinsam/dateien.js';
import { domainPruefen } from '../gemeinsam/pruefen.js';
import { zertifikateFinden, verwalteteZertifikate, zertifikatLesen } from '../caddy/zertifikate.js';

const portOk = (p) => Number.isInteger(p) && p > 0 && p < 65536;

/** Stand dieser Instanz zum Übertragen. */
export async function standBauen(app) {
  const e = app.einstellungen.lesen();
  const klar = (v) => (v ? app.geheim.entschluesseln(v) : '');
  const beste = new Map(await zertifikateFinden(app.zertOrdner));
  for (const [d, z] of await verwalteteZertifikate(app.caddyDaten)) if (!beste.has(d) || beste.get(d).bis < z.bis) beste.set(d, z);
  const zertifikate = [];
  for (const d of app.domains.liste()) {
    const z = beste.get(d.domain);
    if (!z) continue;
    try { zertifikate.push({ domain: d.domain, bis: z.bis.toISOString(), fullchain: await fs.readFile(z.fullchain, 'utf8'), privkey: await fs.readFile(z.privkey, 'utf8') }); } catch { /* gerade erneuert/unvollständig */ }
  }
  return {
    format: 1, version: app.version, zeit: new Date().toISOString(), rolle: e.rolle,
    ziel: app.unifiZiel(),
    domains: app.domains.liste(),
    einstellungen: {
      heimnetz: e.heimnetz, acme_email: e.acme_email, anmeldung: e.anmeldung, failover: e.failover, sperrseite: e.sperrseite, schutz: e.schutz, homepage: e.homepage,
      ntfy: { url: e.ntfy.url, thema: e.ntfy.thema, token: klar(e.ntfy.token) },
      unifi: { url: e.unifi.url, benutzer: e.unifi.benutzer, passwort: klar(e.unifi.passwort), fingerabdruck: e.unifi.fingerabdruck },
    },
    konten: app.konten.fuerSpiegel(),
    zertifikate,
  };
}

/**
 * Fremden Stand übernehmen → {domains, konten, zertifikate (neu geschrieben), entfernt (Zertifikate gelöschter Domains)}.
 * `vomHaupt`: diese Instanz ist die Ersatz-Instanz und merkt sich das Proxy-Ziel des Haupts als Partner.
 */
export async function standAnwenden(app, s, { vomHaupt = true } = {}) {
  if (!s || s.format !== 1 || !Array.isArray(s.domains) || !Array.isArray(s.konten) || !s.konten.length || !s.einstellungen) throw new Fehler('E_SPIEGEL', 'Die andere Instanz hat einen unvollständigen Stand geliefert');
  // Eine leere Instanz (frisch installiert) überschreibt nie eine befüllte – sonst wären nach einer Neuinstallation alle Domains weg
  if (!s.domains.length && app.domains.liste().length) throw new Fehler('E_SPIEGEL', `Die andere Instanz hat keine Domains, diese hier ${app.domains.liste().length} – nicht übernommen, damit nichts verloren geht. Zum Neu-Einrichten: Einstellungen → Haupt & Fail-over → Koppeln.`);
  const vorher = JSON.stringify({ d: app.domains.liste(), k: app.konten.liste(), e: app.einstellungen.lesen().schutz });
  await app.domains.ersetzen(s.domains);
  await app.konten.spiegelUebernehmen(s.konten);
  const eigen = app.einstellungen.lesen(); const geheim = (v) => (v ? app.geheim.verschluesseln(String(v)) : '');
  const { ntfy = {}, unifi = {} } = s.einstellungen;
  const partnerOk = vomHaupt && s.ziel && net.isIPv4(String(s.ziel.ip)) && portOk(s.ziel.http) && portOk(s.ziel.https);
  await app.einstellungen.setzen({
    heimnetz: s.einstellungen.heimnetz, acme_email: s.einstellungen.acme_email || '', anmeldung: s.einstellungen.anmeldung,
    ...(s.einstellungen.failover ? { failover: s.einstellungen.failover } : {}),
    ...(s.einstellungen.sperrseite ? { sperrseite: s.einstellungen.sperrseite } : {}),
    ...(s.einstellungen.schutz ? { schutz: s.einstellungen.schutz } : {}),
    ...(s.einstellungen.homepage ? { homepage: s.einstellungen.homepage } : {}),
    ...(partnerOk ? { spiegel: { ...eigen.spiegel, partner: { ip: s.ziel.ip, http: s.ziel.http, https: s.ziel.https } } } : {}),
    ntfy: { url: ntfy.url || '', thema: ntfy.thema || '', token: geheim(ntfy.token) },
    unifi: { url: unifi.url || '', benutzer: unifi.benutzer || '', passwort: geheim(unifi.passwort), fingerabdruck: unifi.fingerabdruck || '', ziel_ip: eigen.unifi.ziel_ip },
  });
  let zertifikate = 0;
  for (const z of Array.isArray(s.zertifikate) ? s.zertifikate : []) {
    let domain;
    try { domain = domainPruefen(z.domain); zertifikatLesen(z.fullchain); } catch { continue; }
    if (typeof z.privkey !== 'string' || !z.privkey.includes('PRIVATE KEY')) continue;
    const ordner = path.join(app.zertOrdner, domain);
    if ((await fs.readFile(path.join(ordner, 'fullchain.pem'), 'utf8').catch(() => null)) === z.fullchain) continue;
    await fs.mkdir(ordner, { recursive: true, mode: 0o700 });
    await textSchreiben(path.join(ordner, 'fullchain.pem'), z.fullchain, 0o644);
    await textSchreiben(path.join(ordner, 'privkey.pem'), z.privkey, 0o600);
    zertifikate++;
  }
  // Gelöschtes löschen: übernommene Zertifikate von Domains, die es nicht mehr gibt
  const gibtEs = new Set(app.domains.liste().map((d) => d.domain));
  let entfernt = 0;
  for (const name of await fs.readdir(app.zertOrdner).catch(() => [])) {
    if (gibtEs.has(name)) continue;
    try { domainPruefen(name); } catch { continue; }
    await fs.rm(path.join(app.zertOrdner, name), { recursive: true, force: true });
    entfernt++;
  }
  await app.anwender.anwenden({ erzwingen: zertifikate > 0 || entfernt > 0 });
  if (zertifikate || entfernt || vorher !== JSON.stringify({ d: app.domains.liste(), k: app.konten.liste(), e: app.einstellungen.lesen().schutz })) {
    app.protokoll.eintragen({ wer: 'spiegel', aktion: 'spiegel.abgeglichen', details: { felder: [`${s.domains.length} Domains`, `${s.konten.length} Konten`, `${zertifikate} Zertifikate neu`, `${entfernt} entfernt`, vomHaupt ? 'von der Haupt-Instanz' : 'von der Ersatz-Instanz'] } });
  }
  return { domains: s.domains.length, konten: s.konten.length, zertifikate, entfernt };
}
