// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// UniFi-Umschaltplan (rein, ohne Netz): Aus aktiven TCP-Weiterleitungen, die 80/443 weiterleiten, werden genau diese
// Ports herausgenommen – der Rest (z. B. Plex 32400) bleibt; bleibt nichts übrig, wird die Regel abgeschaltet statt
// gelöscht. Danach Regeln „FAH-Proxy HTTP“ (80 → IP:HTTP-Port) und „FAH-Proxy HTTPS“ (443 → IP:HTTPS-Port) anlegen oder
// nachziehen. Jede berührte Regel kommt vorher unverändert in die Sicherung. Bereiche wie 1-1000 oder unpassende
// Portlisten teilt der Plan nicht – das meldet er und ist dann nicht ausführbar.
// Dazu zwei Dinge, die sonst still am Umschalten vorbeilaufen: Firewall-Sperren (BLOCK) zum Ziel-Rechner auf 80/443 greifen
// nach der Weiterleitung nicht mehr (die Pakete kommen auf den Proxy-Ports an) → diese Ports ergänzen, 80/443 bleiben.
// Lokale DNS-Einträge, die eine FAH-Proxy-Domain im Haus direkt auf einen Rechner zeigen lassen, umgehen die
// Weiterleitung (Port 443 dort ist nicht FAH-Proxy) → ausschalten. Beides kommt mit in die Sicherung. Ausnahme: dort antwortet
// ein FAH-Proxy auf 443 (`fahProxy443`, vom Ablauf geprüft) – so erreichen Geräte im WireGuard-VPN die Domains, denn den
// NAT-Rückweg über die eigene WAN-IP macht die UniFi-Konsole nur fürs LAN, nicht fürs VPN (Betreiber-Fund 09.10.).
// Zeigt so ein A-Eintrag auf eine FAH-Proxy-Instanz (diese oder die Partner-IP) und nimmt die Ziel-Instanz selbst 443 an,
// folgt er der aktiven Instanz – Haus und VPN gehen zum Haupt-Proxy, im Fail-over zum Ersatz (Betreiber 09.10.).

import net from 'node:net';

export const NAME_HTTP = 'FAH-Proxy HTTP';
export const NAME_HTTPS = 'FAH-Proxy HTTPS';
const WEB = new Set(['80', '443']);
const EIGENE = new Set([NAME_HTTP, NAME_HTTPS]);
/** Felder, die eine neue Regel nicht von der alten übernimmt (alles andere – Schnittstelle, Quelle, Protokollierung – schon). */
const NICHT_ERBEN = new Set(['_id', 'site_id', 'name', 'dst_port', 'fwd', 'fwd_port', 'proto', 'enabled']);

const STATISTIK = ['hits', 'last_hit'];
const DNS_TYPEN = new Set(['A', 'AAAA', 'CNAME']);
const FW_PROTOKOLLE = new Set(['tcp', 'tcp_udp', 'all']);
/** Firewall-Regeln tragen Zähler, die die Konsole beim Schreiben nicht annimmt. */
export const ohneStatistik = (r) => { const k = structuredClone(r); for (const f of STATISTIK) delete k[f]; return k; };
/** Deckt ein lokaler DNS-Eintrag (auch *.zone, jede Tiefe wie dnsmasq) die Domain? */
export function dnsDeckt(key, domain) {
  const k = String(key || '').toLowerCase(); const d = String(domain || '').toLowerCase();
  return k.startsWith('*.') ? d.endsWith(k.slice(1)) : k === d;
}
const portListe = (s) => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
function bereichMitWeb(token) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(token);
  return !!m && [80, 443].some((p) => p >= Number(m[1]) && p <= Number(m[2]));
}
/** Leitet die Regel (aktiv, TCP) 80 oder 443 weiter – auch über einen Bereich? (für die Anzeige) */
export function leitetWebWeiter(r) {
  return r.enabled !== false && r.proto !== 'udp' && portListe(r.dst_port).some((p) => WEB.has(p) || bereichMitWeb(p));
}
const kurz = (r) => `${r.dst_port} → ${r.fwd}:${r.fwd_port || r.dst_port}`;

/**
 * @param {object[]} regeln Weiterleitungen der Konsole (rest/portforward)
 * @param {{ip:string, http:number, https:number}} ziel
 * @returns {{ausfuehrbar:boolean, probleme:string[], schritte:object[], sicherung:{zeit:string, ziel:object, regeln:object[]}}}
 */
/** IP, an die die Regel „FAH-Proxy HTTPS“ gerade weiterleitet – null, wenn es sie nicht gibt (noch nicht umgeschaltet). */
export function aktivIp(regeln) {
  const r = regeln.find((x) => x.name === NAME_HTTPS && x.enabled !== false);
  return r ? String(r.fwd) : null;
}

/** `partnerIps`: IPs der anderen FAH-Proxy-Instanz – Firewall-Sperren dorthin bekommen auch die eigene IP. */
export function umschaltPlan(regeln, { ip, http, https }, { dns = [], firewall = [], domains = [], partnerIps = [], fahProxy443 = [] } = {}) {
  const probleme = []; const schritte = []; const gesichert = []; const gesichertDns = []; const gesichertFw = [];
  if (!net.isIPv4(String(ip || ''))) probleme.push('Die IP-Adresse dieses Rechners fehlt (Einstellungen → UniFi).');
  if (!(Number(http) > 0 && Number(https) > 0)) probleme.push('Die Proxy-Ports von FAH-Proxy sind unbekannt.');
  const proxyPort = { 80: String(http), 443: String(https) };
  const bezug = new Set([String(ip), ...partnerIps.map(String)]);
  for (const f of firewall) {
    const d = f.destination || {};
    if (f.predefined || f.enabled === false || f.action !== 'BLOCK' || !FW_PROTOKOLLE.has(f.protocol)) continue;
    const ips = d.ips || [];
    if (d.port_matching_type !== 'SPECIFIC' || !ips.some((x) => bezug.has(x))) continue;
    const liste = portListe(d.port);
    if (!liste.some((p) => WEB.has(p) || p === String(http) || p === String(https))) continue; // z. B. SSH-Regeln
    const neu = [...new Set(liste.filter((p) => WEB.has(p)).map((p) => proxyPort[p]))].filter((p) => !liste.includes(p));
    const neueIp = ips.includes(String(ip)) ? [] : [String(ip)];
    if (!neu.length && !neueIp.length) continue;
    gesichertFw.push(structuredClone(f));
    const teile = [...(neueIp.length ? [`Ziel ${ip}`] : []), ...(neu.length ? [`Ports ${neu.join('/')}`] : [])];
    schritte.push({ bereich: 'firewall', art: 'aendern', id: f._id, nachher: { ...ohneStatistik(f), destination: { ...structuredClone(d), ips: [...ips, ...neueIp], port: [...liste, ...neu].join(',') } },
      text: `Firewall-Regel „${f.name}“: ${teile.join(' und ')} ergänzen – dort nimmt FAH-Proxy 80/443 entgegen, sonst greift die Sperre nicht (Bisheriges bleibt).` });
  }
  let vorlage = null;
  for (const r of regeln) {
    if (EIGENE.has(r.name) || r.enabled === false || r.proto === 'udp') continue;
    const dst = portListe(r.dst_port); const fwdRoh = portListe(r.fwd_port); const fwd = fwdRoh.length ? fwdRoh : dst;
    if (dst.some(bereichMitWeb)) { probleme.push(`Regel „${r.name}“ leitet einen Bereich (${r.dst_port}) weiter, der 80/443 enthält – bitte von Hand teilen.`); continue; }
    if (!dst.some((p) => WEB.has(p))) continue;
    if (fwd.length !== dst.length) { probleme.push(`Regel „${r.name}“: Ziel-Ports (${r.fwd_port}) passen nicht zu den Ports (${r.dst_port}) – bitte von Hand anpassen.`); continue; }
    vorlage = vorlage || r;
    gesichert.push(structuredClone(r));
    const rest = dst.map((p, i) => [p, fwd[i]]).filter(([p]) => !WEB.has(p));
    if (!rest.length) schritte.push({ bereich: 'weiterleitung', art: 'aendern', id: r._id, nachher: { ...structuredClone(r), enabled: false }, text: `Regel „${r.name}“ (${kurz(r)}) abschalten – sie leitet nur 80/443 weiter.` });
    else {
      const nachher = { ...structuredClone(r), dst_port: rest.map(([p]) => p).join(','), fwd_port: rest.map(([, f]) => f).join(',') };
      schritte.push({ bereich: 'weiterleitung', art: 'aendern', id: r._id, nachher, text: `Regel „${r.name}“: 80/443 herausnehmen, bleibt für ${nachher.dst_port} (${kurz(nachher)}).` });
    }
  }
  const erbe = vorlage ? Object.fromEntries(Object.entries(vorlage).filter(([k]) => !NICHT_ERBEN.has(k))) : { pfwd_interface: 'wan', src: 'any', log: false };
  for (const [name, port, ziel] of [[NAME_HTTP, '80', http], [NAME_HTTPS, '443', https]]) {
    const soll = { dst_port: port, fwd: String(ip || ''), fwd_port: String(ziel), proto: 'tcp', enabled: true };
    const da = regeln.find((r) => r.name === name);
    if (!da) { schritte.push({ bereich: 'weiterleitung', art: 'anlegen', regel: { ...structuredClone(erbe), name, ...soll }, text: `Neue Regel „${name}“: Port ${port} → ${ip}:${ziel}.` }); continue; }
    if (Object.entries(soll).every(([k, v]) => da[k] === v)) continue;
    gesichert.push(structuredClone(da));
    schritte.push({ bereich: 'weiterleitung', art: 'aendern', id: da._id, nachher: { ...structuredClone(da), ...soll }, text: `Regel „${name}“ nachziehen: Port ${port} → ${ip}:${ziel} (bisher ${kurz(da)}).` });
  }
  const aktiv = domains.map((x) => String(x).toLowerCase());
  const auf443 = new Set(fahProxy443.map(String));
  const instanzen = new Set([String(ip), ...partnerIps.map(String)]);
  for (const e of dns) {
    if (e.enabled === false || !DNS_TYPEN.has(e.record_type) || !aktiv.some((d) => dnsDeckt(e.key, d))) continue;
    if (e.value === String(ip) && (Number(https) === 443 || auf443.has(String(ip)))) continue; // zeigt auf diese Instanz
    if (e.record_type === 'A' && instanzen.has(String(e.value)) && auf443.has(String(ip))) {
      gesichertDns.push(structuredClone(e));
      schritte.push({ bereich: 'dns', art: 'aendern', id: e._id, nachher: { ...structuredClone(e), value: String(ip) },
        text: `DNS-Eintrag „${e.key} → ${e.value}“ auf die aktive Instanz ${ip} umstellen – Geräte im Haus und im VPN gehen direkt dorthin.` });
      continue;
    }
    if (auf443.has(String(e.value))) continue; // dort antwortet ein FAH-Proxy auf 443
    gesichertDns.push(structuredClone(e));
    schritte.push({ bereich: 'dns', art: 'aendern', id: e._id, nachher: { ...structuredClone(e), enabled: false },
      text: `DNS-Eintrag „${e.key} → ${e.value}“ ausschalten – sonst gehen Geräte im Haus direkt zu ${e.value}:443 statt über die Weiterleitung zu FAH-Proxy.` });
  }
  return { ausfuehrbar: !probleme.length, probleme, schritte, sicherung: { zeit: new Date().toISOString(), ziel: { ip, http, https }, regeln: gesichert, dns: gesichertDns, firewall: gesichertFw } };
}
