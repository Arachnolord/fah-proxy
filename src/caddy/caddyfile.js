// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Caddyfile aus Domains + Einstellungen + Zertifikaten erzeugen (reine Funktion). Jeder Wert wird hier ERNEUT mit den
// Prüfungen aus gemeinsam/pruefen.js normiert – ein beschädigter Datensatz kann so nie Caddy-Direktiven einschleusen.
//
// Modus test (diese Instanz bedient das Internet nicht): keine Zertifikats-Automatik (Port 80 aus dem Internet kommt hier
// nicht an), nur übernommene Zertifikate.
// Modus live: übernommene Zertifikate, solange sie > 30 Tage gelten (kein Massenantrag bei Let's Encrypt), sonst ACME.

import { domainPruefen, zielPruefen, cidrPruefen } from '../gemeinsam/pruefen.js';
import { Fehler } from '../gemeinsam/fehler.js';
import { pfadeNormieren } from '../daten/domains.js';
import { stufeFinden } from '../daten/schutzstufen.js';

export const LIVE_ZERT_MINDEST_TAGE = 30;
const TAG = 86400000;
const TEXT_HEIMNETZ = 'Kein Zugriff – diese Seite ist nur aus dem Heimnetz oder über VPN erreichbar.';
const TEXT_IPLISTE = 'Kein Zugriff – diese Seite ist für deine Adresse nicht freigegeben.';

/** Pfadpräfix für rewrite: „/app/“ → „/app“, „/“ → „“. */
function praefix(pfad) { return pfad.replace(/\/+$/, ''); }

/**
 * Weiterleitung einer Domain: ohne Pfad-Regeln die Hauptweiterleitung direkt, sonst je Regel ein handle_path (Präfix
 * entfernen, wie nginx „proxy_pass …/“) bzw. handle (Präfix bleibt) und die Hauptweiterleitung in einem eigenen handle.
 */
function weiterleitung(d, e) {
  const regeln = pfadeNormieren(d.pfade);
  const tls = d.ziel_tls_pruefen === true;
  if (!regeln.length) return proxyZeilen(d.ziel, tls, e);
  const zeilen = [];
  for (const r of regeln) {
    const ohne = r.pfad.replace(/\/+$/, '');
    zeilen.push(r.praefix_entfernen ? `${e}handle_path ${ohne}/* {` : `${e}handle ${r.pfad}* {`, ...proxyZeilen(r.ziel, tls, `${e}\t`), `${e}}`);
  }
  zeilen.push(`${e}handle {`, ...proxyZeilen(d.ziel, tls, `${e}\t`), `${e}}`);
  return zeilen;
}

function proxyZeilen(ziel, tlsPruefen, einrueckung) {
  const e = einrueckung;
  const z = zielPruefen(ziel);
  const zeilen = [];
  if (praefix(z.pfad)) zeilen.push(`${e}rewrite * ${praefix(z.pfad)}{uri}`);
  const upstream = `${z.scheme}://${z.host}:${z.port}`;
  if (z.scheme === 'https' && !tlsPruefen) zeilen.push(`${e}reverse_proxy ${upstream} {`, `${e}\ttransport http {`, `${e}\t\ttls_insecure_skip_verify`, `${e}\t}`, `${e}}`);
  else zeilen.push(`${e}reverse_proxy ${upstream}`);
  return zeilen;
}

/**
 * @param {{domains:Array, einstellungen:{heimnetz:string[], acme_email:string, modus:'test'|'live'}, zertifikate:Map<string,{bis:Date}>,
 *   pfade:{zertifikate:string, protokoll:string, intern:string}, jetzt?:Date}} p
 * @returns {{text:string, hinweise:Array<{domain:string, text:string}>}}
 */
/**
 * Wartungsseite, wenn das Ziel nicht antwortet (502/503/504 aus reverse_proxy): freundlich statt Fehlerseite, lädt sich
 * nach 60 s neu. Ohne geschweifte Klammern – Caddy würde sie als Platzhalter lesen; nur {http.request.host} ist gewollt.
 */
const WARTUNGSSEITE = [
  '<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta http-equiv="refresh" content="60"><meta name="robots" content="noindex"><title>Gleich wieder da</title></head>',
  '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#15181d;color:#e7eaee;font:16px/1.5 system-ui,-apple-system,sans-serif">',
  '<main style="max-width:420px;padding:28px;text-align:center"><div style="font-size:13px;font-weight:700;letter-spacing:.06em;color:#2bb3a3">FAH-PROXY</div>',
  '<h1 style="font-size:22px;margin:8px 0">Kurz in Wartung</h1><p style="color:#9aa3ae">{http.request.host} ist gerade nicht erreichbar. Die Seite lädt sich in einer Minute von selbst neu.</p></main></body></html>',
];

/** Auffang für gesperrte Domains: nur aus dem Heimnetz, alles andere bricht Caddy ohne Antwort ab. */
function sperrBloecke(ziel, netze) {
  const inhalt = [`\t@fah_fremd not remote_ip ${netze.join(' ')}`, '\thandle @fah_fremd {', '\t\tabort', '\t}', '\thandle {', '\t\trewrite * /sperrseite',
    `\t\treverse_proxy ${ziel} {`, '\t\t\theader_up X-Sperr-Domain {host}', '\t\t}', '\t}', '}'];
  return [['https:// {', '\ttls {', '\t\tissuer internal', '\t\ton_demand', '\t}', ...inhalt].join('\n'), ['http:// {', ...inhalt].join('\n')];
}

export function caddyfileErzeugen({ domains, einstellungen, zertifikate, pfade, jetzt = new Date() }) {
  const live = einstellungen.modus === 'live';
  const hinweise = [];
  if (!/^[a-z0-9._-]+:\d{1,5}$/.test(pfade.intern)) throw new Fehler('E_EINGABE', 'Interne Adresse ungültig', { feld: 'intern' });
  const kopf = ['# Erzeugt von FAH-Proxy – Änderungen bitte in der Oberfläche, diese Datei wird überschrieben.', '{',
    '\tadmin caddy:2019 {', '\t\torigins caddy:2019', '\t}'];
  const email = String(einstellungen.acme_email || '');
  if (email) { if (!/^[^\s@<>"'{}]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)) throw new Fehler('E_EINGABE', 'ACME-E-Mail ungültig', { feld: 'acme_email' }); kopf.push(`\temail ${email}`); }
  if (!live) kopf.push('\tauto_https disable_certs');
  // Sperrseite von FAH-Adblock: Zertifikate aus der eigenen Caddy-CA, aber nur für Domains, die der Adblocker wirklich sperrt.
  // Auch im Testbetrieb, denn die Ersatz-Instanz läuft so und bekommt genauso DNS-Anfragen der Geräte.
  const sperrZiel = einstellungen.sperrseite?.an ? String(pfade.sperrseite || '') : '';
  if (sperrZiel && !/^http:\/\/[a-z0-9.-]+:\d{1,5}$/.test(sperrZiel)) throw new Fehler('E_EINGABE', 'Adresse der Sperrseite ungültig', { feld: 'sperrseite' });
  if (sperrZiel) kopf.push('\tskip_install_trust', '\ton_demand_tls {', `\t\task ${sperrZiel}/api/sperrseite/pruefe`, '\t}');
  kopf.push('\tservers {', '\t\tprotocols h1 h2', '\t}', '}', '',
    '(fah_protokoll) {', '\tlog {', `\t\toutput file ${pfade.protokoll} {`, '\t\t\troll_size 10MiB', '\t\t\troll_keep 3', '\t\t\tmode 0644', '\t\t}', '\t\tformat json', '\t}', '}',
    '', '(fah_wartung) {', '\thandle_errors 502 503 504 {', '\t\theader Content-Type "text/html; charset=utf-8"', '\t\theader Retry-After "60"', '\t\trespond <<SEITE',
    ...WARTUNGSSEITE.map((z) => `\t\t\t${z}`), '\t\tSEITE 503', '\t}', '}',
    // Lebenszeichen für die Fail-over-Wache der anderen Instanz: Caddy antwortet selbst, ohne App und ohne Protokollzeile
    '', '(fah_lebt) {', '\thandle /_fah/lebt {', '\t\tlog_skip', '\t\trespond 204', '\t}', '}');

  const bloecke = [];
  const aktive = domains.filter((d) => d.aktiv !== false).map((d) => ({ ...d, domain: domainPruefen(d.domain) })).sort((a, b) => a.domain.localeCompare(b.domain));
  for (const d of aktive) {
    const z = zertifikate.get(d.domain);
    const restTage = z ? (z.bis.getTime() - jetzt.getTime()) / TAG : -1;
    const zeilen = [`${d.domain} {`, '\timport fah_protokoll', '\timport fah_wartung', '\timport fah_lebt'];
    if (z && (!live || restTage > LIVE_ZERT_MINDEST_TAGE)) zeilen.push(`\ttls ${pfade.zertifikate}/${d.domain}/fullchain.pem ${pfade.zertifikate}/${d.domain}/privkey.pem`);
    if (!live && !z) hinweise.push({ domain: d.domain, text: 'Kein Zertifikat übernommen – im Testbetrieb nicht per HTTPS erreichbar (nach dem Umschalten holt FAH-Proxy eines).' });
    if (!live && z && restTage <= 0) hinweise.push({ domain: d.domain, text: 'Das übernommene Zertifikat ist abgelaufen.' });
    if (d.hsts !== false) zeilen.push('\theader Strict-Transport-Security "max-age=63072000"');
    const stufe = stufeFinden(einstellungen, d.schutz || 'oeffentlich');
    const anmelden = () => ['\thandle /_fah/* {', `\t\treverse_proxy ${pfade.intern}`, '\t}'];
    const forwardAuth = (einzug) => [`${einzug}forward_auth ${pfade.intern} {`, `${einzug}\turi /_fah/pruefen`, `${einzug}\tcopy_headers X-FAH-Nutzer`, `${einzug}}`];
    if (!stufe) {
      // Stufe gelöscht oder (noch) nicht gespiegelt: lieber alles sperren als offen weiterleiten
      hinweise.push({ domain: d.domain, text: 'Die Schutzstufe dieser Domain gibt es nicht – sie ist gesperrt, bis du eine Stufe wählst.' });
      zeilen.push(`\trespond "${TEXT_IPLISTE}" 403`);
    } else if (stufe.art === 'netze' || stufe.art === 'ipliste') {
      const netze = stufe.art === 'ipliste' ? (d.ip_liste || []).map(cidrPruefen) : stufe.netze.map(cidrPruefen);
      if (!netze.length) throw new Fehler('E_EINGABE', `Keine Netze für ${d.domain}`, { feld: 'ip_liste' });
      zeilen.push(`\t@fah_fremd not remote_ip ${netze.join(' ')}`, '\thandle @fah_fremd {', `\t\trespond "${stufe.id === 'heimnetz' ? TEXT_HEIMNETZ : TEXT_IPLISTE}" 403`, '\t}',
        '\thandle {', ...weiterleitung(d, '\t\t'), '\t}');
    } else if (stufe.art === 'anmeldung') {
      zeilen.push(...anmelden(), '\thandle {', ...forwardAuth('\t\t'), ...weiterleitung(d, '\t\t'), '\t}');
    } else if (stufe.art === 'netze_anmeldung') {
      const netze = stufe.netze.map(cidrPruefen);
      zeilen.push(...anmelden(), `\t@fah_drinnen remote_ip ${netze.join(' ')}`, '\thandle @fah_drinnen {', ...weiterleitung(d, '\t\t'), '\t}',
        '\thandle {', ...forwardAuth('\t\t'), ...weiterleitung(d, '\t\t'), '\t}');
    } else if (stufe.art === 'oeffentlich') {
      zeilen.push(...weiterleitung(d, '\t'));
    } else throw new Fehler('E_EINGABE', `Unbekannte Schutzstufe bei ${d.domain}`, { feld: 'schutz' });
    zeilen.push('}');
    bloecke.push(zeilen.join('\n'));
  }
  if (sperrZiel) bloecke.push(...sperrBloecke(sperrZiel, (einstellungen.heimnetz || []).map(cidrPruefen)));
  return { text: `${kopf.join('\n')}\n\n${bloecke.join('\n\n')}${bloecke.length ? '\n' : ''}`, hinweise };
}
