// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// API der Oberfläche (alle Routen: angemeldeter Admin, schreibende mit CSRF). Jede Änderung an Domains/Einstellungen
// wird sofort an Caddy geschickt; lehnt Caddy ab, wird der vorherige Stand wiederhergestellt (nichts Halbes bleibt).

import { Fehler } from '../gemeinsam/fehler.js';
import { zielErreichbar } from '../status/pruefer.js';
import { umschaltPlan, leitetWebWeiter } from '../unifi/plan.js';
import crypto from 'node:crypto';
import { stufenListe, stufeFinden, eigeneStufePruefen, titelPruefen, textPruefen, netzePruefen, FESTE_IDS } from '../daten/schutzstufen.js';
import { umschalten, standLesen, fahProxyAuf443 } from '../unifi/ablauf.js';
import { verbinden as spiegelVerbinden, abgleichen as spiegelAbgleichen, entkoppeln as spiegelEntkoppeln } from '../spiegel/ersatz.js';
import { partnerKoppeln, zustand as spiegelZustand } from '../spiegel/partner.js';
import { standBauen, standAnwenden } from '../spiegel/stand.js';
import { uiFingerabdruck } from '../spiegel/haupt.js';
import { zielPruefen } from '../gemeinsam/pruefen.js';
import { zertifikateFinden, verwalteteZertifikate } from '../caddy/zertifikate.js';
import fsp from 'node:fs/promises';

export const LESE_PRAEFIX = 'FAHPROXYLESE1.';
const sha = (x) => crypto.createHash('sha256').update(String(x)).digest('hex');

function basisdomain(d) { const t = d.split('.'); return t.slice(t.length >= 3 ? -3 : -2).join('.'); }

export function apiRegistrieren(app) {
  const { web, domains, einstellungen, protokoll, anwender, konten } = app;

  /** Änderung durchführen und anwenden; bei Ablehnung durch Caddy den Stand davor zurückholen. */
  async function mitCaddy(aenderung) {
    const vorher = domains.liste(); const einstVorher = einstellungen.lesen();
    const ergebnis = await aenderung();
    try { await anwender.anwenden(); } catch (e) {
      if (e.code === 'E_CADDY') { await domains.ersetzen(vorher); await einstellungen.setzen({ heimnetz: einstVorher.heimnetz, acme_email: einstVorher.acme_email, anmeldung: einstVorher.anmeldung, schutz: einstVorher.schutz, sperrseite: einstVorher.sperrseite }); }
      throw e;
    }
    return ergebnis;
  }
  const wer = (ctx) => ctx.sitzung.name;

  // ── Dienst-Schnittstelle (Rolle „dienst“, z. B. FAH-Adblock): nur die eigene Gruppe „AdBlock DNS Domains“ ──────────────
  // Erlaubt ist NUR: Domains „dns-…<basis>“ in dieser Gruppe anlegen/ändern/löschen, Ziel http://<private IPv4>:<Port>, Schutzstufe
  // immer „Öffentlich“. Andere Einträge sieht und berührt ein Dienst-Konto nicht. Ältere Einträge von FAH-Adblock (Notiz
  // „FAH-Adblock unterwegs…“) werden einmal in die Gruppe übernommen.
  const DNS_GRUPPE = 'AdBlock DNS Domains';
  const DNS_NOTIZ = 'FAH-Adblock unterwegs';
  const dnsEigen = (d) => String(d.domain).startsWith('dns-') && (d.rubrik === DNS_GRUPPE || String(d.notiz || '').startsWith(DNS_NOTIZ));
  const dnsZiel = (z) => { const m = /^http:\/\/(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):(\d{2,5})$/.exec(String(z || '')); if (!m) throw new Fehler('E_EINGABE', 'Ziel: http://<private IPv4>:<Port>', { feld: 'ziel' }); return m[0]; };
  web.route('GET', '/api/dienst/dns', { dienst: true }, async () => ({ aktiv: app.istAktiv(), gruppe: DNS_GRUPPE, domains: domains.liste().filter(dnsEigen).map((d) => ({ domain: d.domain, ziel: d.ziel, aktiv: d.aktiv !== false })) }));
  web.route('PUT', '/api/dienst/dns', { dienst: true }, async (ctx) => {
    const b = await ctx.body();
    const basis = String(b.basis || '').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(basis)) throw new Fehler('E_EINGABE', 'Basisdomain ungültig', { feld: 'basis' });
    const ziel = dnsZiel(b.ziel);
    const soll = new Map();
    for (const x of (Array.isArray(b.soll) ? b.soll : []).slice(0, 50)) {
      const dom = String(x.domain || '').toLowerCase();
      if (!/^dns-[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?\./.test(dom) || !dom.endsWith(`.${basis}`) || dom.slice(0, -basis.length - 1).includes('.')) throw new Fehler('E_EINGABE', `Kein Gerätename unter ${basis}: ${dom}`, { feld: 'soll' });
      soll.set(dom, String(x.name || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 60));
    }
    const r = { angelegt: [], geaendert: [], geloescht: [], fremd: [] };
    await mitCaddy(async () => {
      for (const d of domains.liste()) {
        if (!dnsEigen(d) || !d.domain.endsWith(`.${basis}`)) continue;
        if (!soll.has(d.domain)) { await domains.loeschen(d.id); r.geloescht.push(d.domain); continue; }
        if (d.ziel !== ziel || d.schutz !== 'oeffentlich' || d.aktiv === false || d.rubrik !== DNS_GRUPPE) { await domains.aendern(d.id, { ziel, schutz: 'oeffentlich', aktiv: true, rubrik: DNS_GRUPPE, notiz: `${DNS_NOTIZ}: ${soll.get(d.domain)} (nur DNS-Dienst, Oberfläche gesperrt)`, pfade: [] }); r.geaendert.push(d.domain); }
      }
      const da = new Map(domains.liste().map((d) => [d.domain, d]));
      for (const [dom, name] of soll) {
        const d = da.get(dom);
        if (d && !dnsEigen(d)) { r.fremd.push(dom); continue; }   // gleichnamiger fremder Eintrag: nicht anfassen
        if (!d) { await domains.anlegen({ domain: dom, ziel, schutz: 'oeffentlich', rubrik: DNS_GRUPPE, notiz: `${DNS_NOTIZ}: ${name} (nur DNS-Dienst, Oberfläche gesperrt)`, herkunft: 'dienst' }); r.angelegt.push(dom); }
      }
    });
    if (r.angelegt.length || r.geaendert.length || r.geloescht.length) protokoll.eintragen({ wer: wer(ctx), aktion: 'dienst.dns', ziel: DNS_GRUPPE, details: { felder: [`+${r.angelegt.length} ~${r.geaendert.length} −${r.geloescht.length}`, ...r.angelegt.map((x) => `neu ${x}`), ...r.geloescht.map((x) => `weg ${x}`)] } });
    return r;
  });
  // Zertifikate der eigenen Gruppe (FAH-Adblock braucht für DNS-over-TLS dasselbe Zertifikat wie Caddy – so wird je Name nur EINES
  // geholt; Subdomains eines DynDNS-Anbieters teilen sich bei Let's Encrypt ein Wochenkontingent). Nur Domains der Gruppe, nur gültige.
  web.route('GET', '/api/dienst/zertifikate', { dienst: true }, async () => {
    const eigen = new Set(domains.liste().filter(dnsEigen).map((d) => d.domain));
    const beste = new Map();
    for (const quelle of [await zertifikateFinden(app.zertOrdner), await verwalteteZertifikate(app.caddyDaten)]) for (const [d, z] of quelle) if (eigen.has(d) && z.bis > new Date() && (!beste.has(d) || beste.get(d).bis < z.bis)) beste.set(d, z);
    const aus = [];
    for (const [d, z] of beste) { try { aus.push({ domain: d, bis: z.bis.toISOString(), kette: await fsp.readFile(z.fullchain, 'utf8'), schluessel: await fsp.readFile(z.privkey, 'utf8') }); } catch { /* gerade erneuert */ } }
    return { zertifikate: aus, fehlend: [...eigen].filter((d) => !beste.has(d)) };
  });
  // Ein Admin-Konto stuft sich selbst zum Dienst herab (FAH-Adblock vor 0.9.6 legte sein Konto als Admin an) – nur nach unten, nie zurück
  web.route('POST', '/api/dienst/herabstufen', { dienst: true }, async (ctx) => {
    if (ctx.sitzung.rolle === 'dienst') return { rolle: 'dienst' };
    const k = await konten.aendern(ctx.sitzung.name, { rolle: 'dienst' });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geaendert', ziel: k.name, details: { felder: ['rolle → dienst (selbst)'] } });
    return { rolle: k.rolle };
  });
  // Dienst-Konto entfernt sich selbst (FAH-Adblock „entkoppeln“)
  web.route('DELETE', '/api/dienst/konto', { dienst: true }, async (ctx) => {
    if (ctx.sitzung.rolle !== 'dienst') throw new Fehler('E_RECHTE', 'Nur für Dienst-Konten');
    await konten.loeschen(ctx.sitzung.name);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'dienst.entkoppelt', ziel: ctx.sitzung.name });
    return { geloescht: ctx.sitzung.name };
  });

  web.route('GET', '/api/uebersicht', {}, async () => {
    const status = app.pruefer.stand(); const zugriffe = app.zugriffe.zusammenfassung(); const zert = await app.zertifikate();
    const liste = domains.liste();
    const ziele = new Map();
    for (const d of liste) for (const z of [d.ziel, ...(d.pfade || []).map((p) => p.ziel)]) { const e = ziele.get(z) || { ziel: z, domains: [] }; e.domains.push(d.domain); ziele.set(z, e); }
    return {
      modus: einstellungen.lesen().modus, rolle: einstellungen.lesen().rolle, caddy: anwender.stand(), version: app.version, test_ports: app.testPorts,
      aktiv: app.istAktiv(), aktiv_ip: app.wache && app.wache.z.aktiv ? app.wache.z.aktiv.ip : null,
      basisdomains: [...new Set(liste.map((d) => basisdomain(d.domain)))].sort(),
      ziele: [...ziele.values()].sort((a, b) => a.ziel.localeCompare(b.ziel)),
      rubriken: [...new Set(liste.map((d) => d.rubrik).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')),
      schutzstufen: stufenListe(einstellungen.lesen()).map(({ id, art, titel, text }) => ({ id, art, titel, text })),
      domains: liste.map((d) => ({ ...d, status: status[d.domain] || null, zertifikat: zert[d.domain] || null, zugriffe: zugriffe[d.domain] || { anfragen: 0, f4xx: 0, f5xx: 0 } })),
    };
  });

  web.route('POST', '/api/domains', {}, async (ctx) => {
    { const b0 = await ctx.body(); if (b0.schutz !== undefined && !stufeFinden(einstellungen.lesen(), String(b0.schutz))) throw new Fehler('E_EINGABE', 'Diese Schutzstufe gibt es nicht', { feld: 'schutz' }); }
    const b = await ctx.body();
    const d = await mitCaddy(() => domains.anlegen({ ...b, herkunft: 'neu' }));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'domain.angelegt', ziel: d.domain, details: { ziel: d.ziel, schutz: d.schutz } });
    return { domain: d, caddy: anwender.stand() };
  });

  web.route('PUT', '/api/domains/:id', {}, async (ctx) => {
    { const b0 = await ctx.body(); if (b0.schutz !== undefined && !stufeFinden(einstellungen.lesen(), String(b0.schutz))) throw new Fehler('E_EINGABE', 'Diese Schutzstufe gibt es nicht', { feld: 'schutz' }); }
    const b = await ctx.body();
    const { id: _id, herkunft: _h, angelegt: _a, geaendert: _g, ...teil } = b;
    const alt = domains.holen(ctx.params.id);
    const d = await mitCaddy(() => domains.aendern(ctx.params.id, teil));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'domain.geaendert', ziel: d.domain, details: { vorher: { domain: alt.domain, ziel: alt.ziel, schutz: alt.schutz, aktiv: alt.aktiv } } });
    return { domain: d, caddy: anwender.stand() };
  });

  web.route('DELETE', '/api/domains/:id', {}, async (ctx) => {
    const alt = domains.holen(ctx.params.id);
    await mitCaddy(() => domains.loeschen(ctx.params.id));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'domain.geloescht', ziel: alt.domain, details: { ziel: alt.ziel } });
    return { geloescht: alt.domain };
  });

  web.route('POST', '/api/ziel/pruefen', {}, async (ctx) => zielErreichbar((await ctx.body()).ziel));

  web.route('GET', '/api/einstellungen', {}, async () => ({ ...einstellungen.fuerOberflaeche(), version: app.version, test_ports: app.testPorts, host_ip: app.hostIp }));

  web.route('PUT', '/api/einstellungen', {}, async (ctx) => {
    const b = await ctx.body();
    for (const k of Object.keys(b)) if (!['heimnetz', 'acme_email', 'anmeldung', 'ntfy', 'unifi', 'failover', 'sperrseite'].includes(k)) throw new Fehler('E_EINGABE', k === 'modus' ? 'Der Modus wechselt nur über „Umschalten“' : `Die Einstellung „${k}“ lässt sich hier nicht ändern`, { feld: k });
    const teil = { ...b };
    if (b.ntfy !== undefined) {
      // Token nur verschlüsselt ablegen; ohne neues Token bleibt das alte, token_loeschen entfernt es
      const alt = einstellungen.lesen().ntfy; const n = b.ntfy && typeof b.ntfy === 'object' ? b.ntfy : {};
      teil.ntfy = {
        url: n.url !== undefined ? String(n.url).trim() : alt.url, thema: n.thema !== undefined ? String(n.thema).trim() : alt.thema,
        token: n.token_loeschen ? '' : (n.token ? app.geheim.verschluesseln(String(n.token).trim()) : alt.token),
      };
    }
    if (b.unifi !== undefined) {
      // Passwort nur verschlüsselt; ohne neues bleibt das alte, passwort_loeschen entfernt es
      const alt = einstellungen.lesen().unifi; const n = b.unifi && typeof b.unifi === 'object' ? b.unifi : {};
      const wert = (k) => (n[k] !== undefined ? String(n[k]).trim() : alt[k]);
      teil.unifi = { url: wert('url'), benutzer: wert('benutzer'), ziel_ip: wert('ziel_ip'),
        passwort: n.passwort_loeschen ? '' : (n.passwort ? app.geheim.verschluesseln(String(n.passwort)) : alt.passwort) };
    }
    await mitCaddy(() => einstellungen.setzen(teil));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'einstellungen.geaendert', details: { felder: Object.keys(b) } });
    return einstellungen.fuerOberflaeche();
  });

  // UniFi: Verbindung testen (nagelt den Fingerabdruck fest), Umschalten mit Vorschau – geschrieben wird nur auf Klick
  web.route('POST', '/api/unifi/testen', {}, async (ctx) => {
    const b = await ctx.body();
    const client = app.unifiClient(b.neu_bestaetigen === true ? { fingerabdruck: '' } : {});
    const regeln = await client.weiterleitungen();
    const u = einstellungen.lesen().unifi;
    if (u.fingerabdruck !== client.gesehen) await einstellungen.setzen({ unifi: { ...u, fingerabdruck: client.gesehen } });
    return { fingerabdruck: client.gesehen, regeln: regeln.map((r) => ({ name: r.name, aktiv: r.enabled !== false, dst_port: r.dst_port, fwd: r.fwd, fwd_port: r.fwd_port, proto: r.proto, web: leitetWebWeiter(r) })) };
  });

  web.route('GET', '/api/umschalten', {}, async () => {
    const e = einstellungen.lesen(); const ziel = app.unifiZiel();
    const liste = domains.liste().filter((d) => d.aktiv !== false); const status = app.pruefer.stand(); const zert = await app.zertifikate();
    const aus = {
      modus: e.modus, rolle: e.rolle, ziel,
      unifi: { eingerichtet: !!(e.unifi.url && e.unifi.benutzer && e.unifi.passwort), getestet: !!e.unifi.fingerabdruck },
      checkliste: { domains: liste.length, erreichbar: liste.filter((d) => status[d.domain] && status[d.domain].ok).length, ohne_zertifikat: liste.filter((d) => !(zert[d.domain] && zert[d.domain].bis)).map((d) => d.domain), caddy: anwender.stand() },
      plan: null, fehler: null,
    };
    if (!aus.unifi.eingerichtet) return aus;
    try {
      const client = app.unifiClient();
      const stand = await standLesen(client);
      const namen = liste.map((d) => d.domain);
      const partner = app.wache && typeof app.wache.stand === 'function' ? app.wache.stand().partner : null;
      const p = umschaltPlan(stand.regeln, ziel, { ...stand, domains: namen, partnerIps: partner && partner.ip ? [partner.ip] : [], fahProxy443: await fahProxyAuf443(stand.dns, namen, app.pruefen443, [ziel.ip], await app.pruefDomain()) });
      const kurz = (s) => ({ bereich: s.bereich || 'weiterleitung', art: s.art, text: s.text });
      aus.plan = { ausfuehrbar: p.ausfuehrbar, probleme: p.probleme, hinweise: stand.hinweise, schritte: p.schritte.map(kurz) };
    } catch (err) { aus.fehler = Fehler.aus(err).message; }
    return aus;
  });

  let umschaltenLaeuft = false;
  async function umschaltLauf(ctx, aktion, fn) {
    if ((await ctx.body()).bestaetigt !== true) throw new Fehler('E_EINGABE', 'Bitte ausdrücklich bestätigen');
    if (umschaltenLaeuft) throw new Fehler('E_EINGABE', 'Es wird gerade schon umgeschaltet');
    umschaltenLaeuft = true;
    try {
      const r = await fn();
      let hinweis = null;
      try { await anwender.anwenden(); } catch (e) { hinweis = `Caddy: ${Fehler.aus(e).message}`; }
      protokoll.eintragen({ wer: wer(ctx), aktion, details: { felder: r.texte.length ? r.texte : ['nichts zu ändern'] } });
      return { ausgefuehrt: r.texte.length, modus: einstellungen.lesen().modus, hinweis };
    } catch (e) {
      protokoll.eintragen({ wer: wer(ctx), aktion: 'umschalten.fehlgeschlagen', details: { fehler: Fehler.aus(e).message } });
      throw e;
    } finally { umschaltenLaeuft = false; }
  }
  web.route('POST', '/api/umschalten/uebernehmen', {}, async (ctx) => umschaltLauf(ctx, 'umschalten.uebernommen', async () => {
    const st = anwender.stand();
    if (st.ok === false || st.ausstehend) throw new Fehler('E_EINGABE', 'Caddy läuft gerade nicht sauber – erst die Meldung in der Übersicht klären');
    const partner = app.wache && typeof app.wache.stand === 'function' ? app.wache.stand().partner : null;
    const r = await umschalten(app.unifiClient(), { ziel: app.unifiZiel(), sicherungOrdner: app.sicherungOrdner, domains: domains.liste().filter((d) => d.aktiv !== false).map((d) => d.domain), partnerIps: partner && partner.ip ? [partner.ip] : [], pruefen: app.pruefen443, sni: await app.pruefDomain() });
    await einstellungen.setzen({ modus: 'live' });
    return { texte: r.plan.schritte.map((s) => s.text) };
  }));
  // Anderer Router (Portfreigabe von Hand): live = Zertifikate bei Let's Encrypt holen. Mit UniFi schalten Umschalten/Wache.
  web.route('POST', '/api/umschalten/ohne-unifi', {}, async (ctx) => {
    const b = await ctx.body();
    if (b.bestaetigt !== true) throw new Fehler('E_EINGABE', 'Bitte ausdrücklich bestätigen');
    if (einstellungen.lesen().unifi.url) throw new Fehler('E_EINGABE', 'Eine UniFi-Konsole ist eingetragen – dann schaltet FAH-Proxy selbst („Übernehmen“)');
    const modus = b.live === false ? 'test' : 'live';
    await einstellungen.setzen({ modus });
    let hinweis = null;
    try { await anwender.anwenden(); } catch (e) { hinweis = `Caddy: ${Fehler.aus(e).message}`; }
    protokoll.eintragen({ wer: wer(ctx), aktion: 'umschalten.ohne_unifi', details: { felder: [modus === 'live' ? 'Live geschaltet – Portfreigabe am Router von Hand' : 'Zurück in Bereitschaft'] } });
    return { modus, hinweis };
  });

  // Ersatz-Instanz: Haupt erzeugt Codes und gibt den Stand heraus; Ersatz koppelt, gleicht ab, entkoppelt
  const istHaupt = () => einstellungen.lesen().rolle === 'haupt';
  web.route('GET', '/api/spiegel/stand', {}, async () => {
    const e = einstellungen.lesen();
    return { rolle: e.rolle, haupt_url: e.spiegel.haupt_url, fingerabdruck: e.spiegel.fingerabdruck, letzter_abgleich: e.spiegel.letzter_abgleich, letzter_fehler: e.spiegel.letzter_fehler || null, ersatz: istHaupt() ? app.spiegelHaupt.liste() : [] };
  });
  web.route('POST', '/api/spiegel/code', {}, async () => {
    if (!istHaupt()) throw new Fehler('E_EINGABE', 'Nur der Haupt-FAH-Proxy erzeugt Kopplungscodes');
    return app.spiegelHaupt.codeErzeugen();
  });
  web.route('POST', '/api/spiegel/koppeln', { sitzung: 'keine', csrf: false }, async (ctx) => {
    if (!istHaupt()) throw new Fehler('E_RECHTE', 'Das ist selbst eine Ersatz-Instanz');
    const b = await ctx.body();
    web.bremse.pruefen(ctx.ip, 'spiegel');
    let r;
    try { r = await app.spiegelHaupt.koppeln(String(b.schluessel || ''), { name: b.name, ip: ctx.ip, ui: b.ui }); } catch (e) { web.bremse.fehler(ctx.ip, 'spiegel'); throw e; }
    protokoll.eintragen({ wer: 'spiegel', aktion: 'spiegel.gekoppelt', ziel: String(b.name || '').slice(0, 80), details: { ziel: ctx.ip } });
    return r;
  });
  web.route('GET', '/api/spiegel', { sitzung: 'keine' }, async (ctx) => {
    if (!istHaupt()) throw new Fehler('E_RECHTE', 'Eine Ersatz-Instanz gibt keinen Spiegel heraus');
    const token = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization || ''));
    const q = ctx.url.searchParams; // die Ersatz-Instanz meldet ihr Proxy-Ziel (für die Wache der Haupt-Instanz)
    const ziel = { ip: q.get('ip') || '', http: Number(q.get('http')) || null, https: Number(q.get('https')) || null };
    const ui = q.get('ui') ? { url: q.get('ui'), fingerabdruck: q.get('f') || '' } : null;
    if (!token || !(await app.spiegelHaupt.pruefen(token[1], ctx.ip, ziel, ui))) throw new Fehler('E_ANMELDUNG', 'Unbekannte Ersatz-Instanz');
    return app.spiegelHaupt.stand();
  });
  web.route('POST', '/api/spiegel/stand', { sitzung: 'keine', csrf: false }, async (ctx) => {
    if (!istHaupt()) throw new Fehler('E_RECHTE', 'Nur die Haupt-Instanz nimmt einen Stand an');
    const token = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization || ''));
    const stand = (await ctx.body()).stand;
    // das Proxy-Ziel steht im Stand – so kennt eine frisch gekoppelte Haupt-Instanz ihren Partner, auch wenn er gerade aktiv ist
    const absender = token ? await app.spiegelHaupt.pruefen(token[1], ctx.ip, stand && stand.ziel) : null;
    if (!absender) throw new Fehler('E_ANMELDUNG', 'Unbekannte Ersatz-Instanz');
    return app.spiegelHaupt.standEmpfangen(stand, absender.ziel);
  });
  web.route('POST', '/api/spiegel/wechsel', { sitzung: 'keine', csrf: false }, async (ctx) => {
    if (!istHaupt()) throw new Fehler('E_RECHTE', 'Nur die Haupt-Instanz nimmt diese Meldung an');
    const token = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization || ''));
    if (!(token && await app.spiegelHaupt.pruefen(token[1], ctx.ip))) throw new Fehler('E_ANMELDUNG', 'Unbekannte Ersatz-Instanz');
    app.wache.neuLesen();
    return { neu_lesen: true };
  });
  web.route('GET', '/api/spiegel/zugriffe', { sitzung: 'keine' }, async (ctx) => {
    if (!istHaupt()) throw new Fehler('E_RECHTE', 'Eine Ersatz-Instanz gibt keinen Spiegel heraus');
    const token = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization || ''));
    if (!token || !(await app.spiegelHaupt.pruefen(token[1], ctx.ip))) throw new Fehler('E_ANMELDUNG', 'Unbekannte Ersatz-Instanz');
    return app.spiegelHaupt.zugriffe(ctx.url.searchParams.get('kennung') || '', Number(ctx.url.searchParams.get('ab')) || 0);
  });
  web.route('GET', '/api/spiegel/ersatz', {}, async () => app.spiegelHaupt.liste());
  web.route('DELETE', '/api/spiegel/ersatz/:id', {}, async (ctx) => {
    await app.spiegelHaupt.entfernen(ctx.params.id);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.entfernt', ziel: ctx.params.id });
    return { entfernt: true };
  });
  web.route('POST', '/api/spiegel/verbinden', {}, async (ctx) => {
    const r = await spiegelVerbinden(app, (await ctx.body()).code);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.verbunden', ziel: einstellungen.lesen().spiegel.haupt_url });
    return r;
  });
  web.route('POST', '/api/spiegel/abgleichen', {}, async () => spiegelAbgleichen(app));
  web.route('POST', '/api/spiegel/entkoppeln', {}, async (ctx) => {
    await spiegelEntkoppeln(app);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.entkoppelt' });
    return { rolle: 'haupt' };
  });

  // Koppeln von einer Oberfläche aus: Partner-Adresse + Admin-Zugang (spiegel/partner.js); Zustand/Export/Import nutzt dabei die Gegenseite
  web.route('GET', '/api/spiegel/zustand', {}, async () => spiegelZustand(app));
  web.route('GET', '/api/spiegel/export', {}, async (ctx) => {
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.exportiert', details: { felder: ['Stand an den Partner übergeben (Koppeln)'] } });
    return { stand: await standBauen(app) };
  });
  web.route('POST', '/api/spiegel/import', {}, async (ctx) => {
    if (domains.liste().length) throw new Fehler('E_EINGABE', 'Diese Instanz hat schon Domains – sie übernimmt keinen fremden Stand per Import');
    const r = await standAnwenden(app, (await ctx.body()).stand, { vomHaupt: false });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.importiert', details: { felder: [`${r.domains} Domains`, `${r.konten} Konten`] } });
    return r;
  });
  web.route('POST', '/api/spiegel/partner', {}, async (ctx) => {
    const b = await ctx.body();
    if (b.bestaetigt !== true) throw new Fehler('E_EINGABE', 'Bitte ausdrücklich bestätigen');
    const r = await partnerKoppeln(app, { rolle: b.rolle, url: b.url, name: b.name, passwort: b.passwort, code: b.code });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'spiegel.partner', ziel: r.partner, details: { felder: [r.rolle === 'haupt' ? 'Diese Instanz ist Haupt' : 'Diese Instanz ist Fail-over', r.uebernommen ? `Stand ${r.uebernommen} übernommen` : 'Stand des Haupts gilt'] } });
    return { rolle: einstellungen.lesen().rolle, partner: r.partner, uebernommen: r.uebernommen, konten_neu: r.uebernommen === 'vom Partner' };
  });

  // Lese-Zugang der FAH-Homepage: Code (Adresse + Fingerabdruck + Schlüssel) einmal anzeigen, gespeichert wird nur der Hash
  web.route('POST', '/api/homepage/code', {}, async (ctx) => {
    if (!app.uiUrl) throw new Fehler('E_DATEN', 'Adresse der Oberfläche unbekannt (HOST_IP/UI_PORT fehlen)');
    const schluessel = crypto.randomBytes(24).toString('base64url');
    await einstellungen.setzen({ homepage: { lese_hash: sha(schluessel), erzeugt: new Date().toISOString() } });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'homepage.code', details: { felder: ['Lese-Code für die FAH-Homepage neu erzeugt'] } });
    return { code: LESE_PRAEFIX + Buffer.from(JSON.stringify({ u: app.uiUrl, f: await uiFingerabdruck(app), k: schluessel })).toString('base64url') };
  });
  web.route('DELETE', '/api/homepage/code', {}, async (ctx) => {
    await einstellungen.setzen({ homepage: { lese_hash: '' } });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'homepage.code', details: { felder: ['Lese-Zugang der FAH-Homepage entfernt'] } });
    return { entfernt: true };
  });
  // ohne Anmeldebremse: der Schlüssel ist 192 Bit Zufall (nicht zu erraten), die Homepage fragt alle paar Sekunden – mit einem noch
  // nicht abgeglichenen oder alten Code sperrte die Bremse sonst minutenlang auch den richtigen (09.10. am NAS gesehen: HTTP 429)
  const leseZugang = (ctx) => {
    const t = /^Bearer (\S+)$/.exec(String(ctx.req.headers.authorization || ''));
    const soll = einstellungen.lesen().homepage.lese_hash;
    const ok = !!(t && soll) && crypto.timingSafeEqual(Buffer.from(sha(t[1])), Buffer.from(soll));
    if (!ok) throw new Fehler('E_ANMELDUNG', 'Lese-Code der Homepage ungültig – in FAH-Proxy unter Einstellungen → FAH-Homepage neu erzeugen');
  };
  web.route('GET', '/api/homepage/stand', { sitzung: 'keine' }, async (ctx) => {
    leseZugang(ctx);
    const e = einstellungen.lesen(); const w = app.wache.stand();
    let partner = null;
    if (e.rolle === 'ersatz' && e.spiegel.haupt_url) partner = { ui_url: e.spiegel.haupt_url, fingerabdruck: e.spiegel.fingerabdruck || '', ip: (e.spiegel.partner && e.spiegel.partner.ip) || new URL(e.spiegel.haupt_url).hostname };
    else {
      const x = app.spiegelHaupt.liste().filter((y) => y.ui_url).sort((a, b) => String(b.letzter_abruf || '').localeCompare(String(a.letzter_abruf || '')))[0];
      if (x) partner = { ui_url: x.ui_url, fingerabdruck: x.ui_fingerabdruck || '', ip: (x.ziel && x.ziel.ip) || x.ip };
    }
    const ziele = [];
    for (const d of domains.liste()) { try { const z = zielPruefen(d.ziel); ziele.push({ host: d.domain, server: z.host, port: z.port, aktiv: d.aktiv !== false }); } catch { /* ungültiges Ziel überspringen */ } }
    return {
      app: 'fah-proxy', version: app.version, rolle: e.rolle, zeit: new Date().toISOString(),
      ich: { ip: app.unifiZiel().ip || null, ui_url: app.uiUrl || '', fingerabdruck: await uiFingerabdruck(app) },
      partner,
      wache: { fail_over_an: w.an, aktiv_ip: w.aktiv ? w.aktiv.ip : null, partner_ok: w.partner_ok, selbst_ok: w.selbst_ok, meldung: w.meldung, partner_ip: w.partner && w.partner.ip ? w.partner.ip : null },
      ziele,
    };
  });
  web.route('GET', '/api/homepage/zugriffe', { sitzung: 'keine' }, async (ctx) => {
    leseZugang(ctx);
    return app.spiegelHaupt.zugriffe(ctx.url.searchParams.get('kennung') || '', Number(ctx.url.searchParams.get('ab')) || 0);
  });

  web.route('GET', '/api/failover', {}, async () => app.wache.stand());

  // Schutzstufen (Kacheln „Wer darf die Seite öffnen?“)
  const stufeEinstellung = (s, e) => (s.id === 'anmeldung' ? `Anmeldung gilt ${e.anmeldung.sitzung_tage} Tage` : s.art === 'netze' || s.art === 'netze_anmeldung' ? `Netze: ${s.netze.join(', ')}` : s.art === 'ipliste' ? 'Adressen je Domain' : 'Keine Einschränkung');
  web.route('GET', '/api/schutzstufen', {}, async () => {
    const e = einstellungen.lesen(); const liste = domains.liste();
    return stufenListe(e).map((s) => ({ ...s, einstellung: stufeEinstellung(s, e), domains: liste.filter((d) => (d.schutz || 'oeffentlich') === s.id).length, ...(s.id === 'anmeldung' ? { sitzung_tage: e.anmeldung.sitzung_tage } : {}) }));
  });
  web.route('POST', '/api/schutzstufen', {}, async (ctx) => {
    const neu = { id: `s${crypto.randomBytes(4).toString('hex')}`, ...eigeneStufePruefen(await ctx.body()) };
    const e = einstellungen.lesen();
    await mitCaddy(() => einstellungen.setzen({ schutz: { ...e.schutz, eigene: [...e.schutz.eigene, neu] } }));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'schutz.angelegt', ziel: neu.titel });
    return neu;
  });
  web.route('PUT', '/api/schutzstufen/:id', {}, async (ctx) => {
    const b = await ctx.body(); const e = einstellungen.lesen(); const id = ctx.params.id;
    const stufe = stufeFinden(e, id);
    if (!stufe) throw new Fehler('E_NICHT_GEFUNDEN', 'Diese Schutzstufe gibt es nicht');
    const teil = {};
    if (FESTE_IDS.has(id)) {
      if (b.netze !== undefined && id !== 'heimnetz') throw new Fehler('E_EINGABE', 'Diese Kachel hat keine eigenen Netze', { feld: 'netze' });
      if (b.sitzung_tage !== undefined && id !== 'anmeldung') throw new Fehler('E_EINGABE', 'Nur die Anmeldung hat eine Dauer', { feld: 'sitzung_tage' });
      if (b.titel !== undefined || b.text !== undefined) teil.schutz = { ...e.schutz, texte: { ...e.schutz.texte, [id]: { titel: titelPruefen(b.titel ?? stufe.titel), text: textPruefen(b.text ?? stufe.text) } } };
      if (b.netze !== undefined) teil.heimnetz = netzePruefen(b.netze);
      if (b.sitzung_tage !== undefined) teil.anmeldung = { sitzung_tage: Number(b.sitzung_tage) };
    } else {
      const neu = eigeneStufePruefen({ titel: b.titel ?? stufe.titel, text: b.text ?? stufe.text, art: b.art ?? stufe.art, netze: b.netze ?? stufe.netze });
      teil.schutz = { ...e.schutz, eigene: e.schutz.eigene.map((x) => (x.id === id ? { id, ...neu } : x)) };
    }
    await mitCaddy(() => einstellungen.setzen(teil));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'schutz.geaendert', ziel: stufeFinden(einstellungen.lesen(), id).titel, details: { felder: Object.keys(b) } });
    return stufeFinden(einstellungen.lesen(), id);
  });
  web.route('DELETE', '/api/schutzstufen/:id', {}, async (ctx) => {
    const id = ctx.params.id; const e = einstellungen.lesen(); const stufe = stufeFinden(e, id);
    if (!stufe) throw new Fehler('E_NICHT_GEFUNDEN', 'Diese Schutzstufe gibt es nicht');
    if (stufe.fest) throw new Fehler('E_EINGABE', 'Die vier festen Kacheln lassen sich nur bearbeiten, nicht löschen');
    const n = domains.liste().filter((d) => d.schutz === id).length;
    if (n) throw new Fehler('E_EINGABE', `Die Kachel wird noch von ${n} Domain${n === 1 ? '' : 's'} genutzt – dort erst eine andere Stufe wählen`);
    await mitCaddy(() => einstellungen.setzen({ schutz: { ...e.schutz, eigene: e.schutz.eigene.filter((x) => x.id !== id) } }));
    protokoll.eintragen({ wer: wer(ctx), aktion: 'schutz.geloescht', ziel: stufe.titel });
    return { geloescht: true };
  });

  web.route('POST', '/api/ntfy/test', {}, async () => {
    await app.ntfy.nachricht({ titel: 'FAH-Proxy: Testnachricht', text: 'Wenn du das liest, kommen die Warnungen an.', prio: 3, tags: ['bell'] });
    return { gesendet: true };
  });

  web.route('GET', '/api/protokoll', {}, async () => protokoll.lesen(200));

  // Konten (Oberfläche = Rolle admin, FAH-Anmeldung = alle). Das eigene Konto ist vor Aussperren geschützt.
  const sitzungenBeenden = async (name) => (await web.sitzungenBereit).beendenFuer(name);
  const eigenes = (ctx, meldung, feld = 'name') => { if (ctx.params.name === ctx.sitzung.name) throw new Fehler('E_EINGABE', meldung, { feld }); };
  web.route('GET', '/api/konten', {}, async () => konten.liste());
  web.route('POST', '/api/konten', {}, async (ctx) => {
    const b = await ctx.body();
    const k = await konten.anlegen({ name: b.name, passwort: b.passwort, rolle: b.rolle || 'nutzer', domains: Array.isArray(b.domains) ? b.domains : [] });
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.angelegt', ziel: k.name, details: { felder: [`Rolle ${k.rolle}`] } });
    return k;
  });
  web.route('PUT', '/api/konten/:name', {}, async (ctx) => {
    const b = await ctx.body();
    if (b.gesperrt) eigenes(ctx, 'Das eigene Konto kann man nicht sperren', 'gesperrt');
    if (b.rolle !== undefined && b.rolle !== 'admin') eigenes(ctx, 'Das eigene Konto kann man nicht herabstufen', 'rolle');
    const k = await konten.aendern(ctx.params.name, { rolle: b.rolle, domains: Array.isArray(b.domains) ? b.domains : undefined, gesperrt: b.gesperrt === undefined ? undefined : !!b.gesperrt });
    if (k.gesperrt) await sitzungenBeenden(k.name);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geaendert', ziel: k.name, details: { felder: Object.keys(b) } });
    return k;
  });
  web.route('DELETE', '/api/konten/:name', {}, async (ctx) => {
    eigenes(ctx, 'Das eigene Konto kann man nicht löschen');
    await konten.loeschen(ctx.params.name);
    await sitzungenBeenden(ctx.params.name);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geloescht', ziel: ctx.params.name });
    return { geloescht: true };
  });
  web.route('POST', '/api/konten/:name/passwort', {}, async (ctx) => {
    eigenes(ctx, 'Das eigene Passwort bitte unter „Mein Passwort“ ändern (mit dem bisherigen Passwort)', 'neu');
    await konten.passwortSetzen(ctx.params.name, (await ctx.body()).neu);
    await sitzungenBeenden(ctx.params.name);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geaendert', ziel: ctx.params.name, details: { felder: ['Passwort'] } });
    return { geaendert: true };
  });
  web.route('POST', '/api/konten/:name/2fa', {}, async (ctx) => konten.totpVorbereiten(ctx.params.name));
  web.route('POST', '/api/konten/:name/2fa/aktivieren', {}, async (ctx) => {
    await konten.totpAktivieren(ctx.params.name, (await ctx.body()).code);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geaendert', ziel: ctx.params.name, details: { felder: ['2FA an'] } });
    return { aktiv: true };
  });
  web.route('DELETE', '/api/konten/:name/2fa', {}, async (ctx) => {
    await konten.totpAus(ctx.params.name);
    protokoll.eintragen({ wer: wer(ctx), aktion: 'konto.geaendert', ziel: ctx.params.name, details: { felder: ['2FA aus'] } });
    return { aktiv: false };
  });
}
