// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Hilfe: Schritt-für-Schritt-Anleitungen, wie das Internet zu FAH-Proxy kommt – UniFi automatisch, zweite Instanz
// (Fail-over), anderer Router von Hand. Je Abschnitt eine aufklappbare Karte mit kurzen nummerierten Schritten; IP und
// Ports dieser Instanz sind eingesetzt. In den Texten: **fett**, `Wert`.

import { el, api } from '../app.js';

/** Text mit **fett** und `Wert` in Knoten zerlegen. */
function satz(text) {
  return String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean).map((t) => (t.startsWith('**') ? el('b', { text: t.slice(2, -2) })
    : t.startsWith('`') ? el('code', { class: 'mono', text: t.slice(1, -1) }) : t));
}

function abschnitt(titel, unter, schritte, { offen = false, hinweis = null } = {}) {
  return el('details', { class: 'karte hilfe', open: offen },
    el('summary', {}, el('span', { class: 'hilfe-titel', text: titel }), el('span', { class: 'leise', text: ` · ${unter}` })),
    el('ol', { class: 'schritte' }, ...schritte.map((s) => el('li', {}, ...satz(s)))),
    hinweis ? el('p', { class: 'leise' }, ...satz(hinweis)) : null);
}

export async function zeigen(wurzel) {
  let e = {};
  try { e = await api('GET', '/api/einstellungen'); } catch { /* ohne Werte */ }
  const ip = (e.unifi && e.unifi.ziel_ip) || e.host_ip || '<IP dieses Rechners>';
  const http = (e.test_ports && e.test_ports.http) || 28080; const https = (e.test_ports && e.test_ports.https) || 28443;

  wurzel.append(el('h1', { text: 'Hilfe' }), el('p', { class: 'unter', text: 'Schritt für Schritt: So kommt das Internet zu FAH-Proxy.' }),
    el('div', { class: 'hinweis' }, ...satz(`Deine Werte: Rechner \`${ip}\` · HTTP-Port \`${http}\` · HTTPS-Port \`${https}\``)),

    abschnitt('UniFi (UDM, UCG, Cloud Key)', 'FAH-Proxy stellt alles selbst ein – empfohlen', [
      'UniFi öffnen → **Einstellungen → Admins & Benutzer → Admin hinzufügen**.',
      '**Nur lokaler Zugriff**, Name z. B. `fahproxy`, eigenes Passwort, Recht für **Network: verwalten** (nicht nur ansehen).',
      'Hier in FAH-Proxy: **Einstellungen → UniFi** → Adresse `https://<IP der Konsole>`, Benutzer, Passwort → **Speichern**.',
      'Dort **Verbindung testen** – FAH-Proxy merkt sich das Zertifikat der Konsole.',
      '**Umschalten** öffnen → Liste der Änderungen ansehen → **Übernehmen**.',
      `Fertig: UniFi leitet \`80 → ${ip}:${http}\` und \`443 → ${ip}:${https}\` (Regeln „FAH-Proxy HTTP/HTTPS“), passende Sperrregeln und lokale DNS-Einträge sind angepasst.`,
      'Testen: Handy mit **WLAN aus** → `https://deine-domain` öffnen.',
    ], { offen: true }),

    abschnitt('Zweite Instanz (Fail-over)', 'nur mit UniFi', [
      'Zweite FAH-Proxy-Installation einmal öffnen und das eigene Passwort setzen.',
      'Auf einer der beiden: **Einstellungen → Haupt & Fail-over → Mit Partner koppeln** → Rolle dieser Instanz wählen (Haupt oder Fail-over), Adresse der anderen (z. B. `https://192.168.1.23:28181`) und deren Admin-Zugang eingeben → **Koppeln**.',
      'Fertig: Beide gleichen sich alle 5 Minuten ab – immer von der aktiven zur anderen.',
      'Neu installiert? Genauso koppeln: Die leere Instanz holt sich zuerst den Stand der anderen – auch wenn sie Haupt wird. **Rollen tauschen** geht über denselben Knopf.',
      'Fällt die aktive etwa 1 Minute aus, stellt FAH-Proxy UniFi auf die andere um. Läuft die Haupt-Instanz wieder 10 Minuten stabil, bekommt sie das Internet samt Änderungen zurück.',
    ], { hinweis: 'Ändern lässt sich immer nur an der aktiven Instanz – die andere zeigt einen Hinweis mit deren Adresse.' }),

    abschnitt('Anderer Router (FRITZ!Box, Speedport, OpenWrt …)', 'Portfreigabe von Hand', [
      `Router: dem Rechner mit FAH-Proxy eine **feste IP** geben (DHCP-Reservierung) – hier \`${ip}\`.`,
      `**Portfreigabe 1:** TCP, extern \`80\` → \`${ip}\`, Port \`${http}\`.`,
      `**Portfreigabe 2:** TCP, extern \`443\` → \`${ip}\`, Port \`${https}\`.`,
      'FRITZ!Box: **Internet → Freigaben → Portfreigaben → Gerät hinzufügen → Neue Freigabe → Andere Anwendung**.',
      'Ältere Freigaben auf 80 oder 443 (z. B. alter Proxy) löschen.',
      'Domain beim DNS-Anbieter auf deine **öffentliche IP** zeigen lassen; wechselt sie, **DynDNS** im Router einrichten.',
      'Hier in FAH-Proxy: **Umschalten → Live schalten (ohne UniFi)** – jetzt holt FAH-Proxy die Zertifikate.',
      'Testen: Handy mit **WLAN aus** → `https://deine-domain` öffnen.',
    ], { hinweis: 'Im Heimnetz klappt der Aufruf nur, wenn der Router **NAT-Loopback** kann (FRITZ!Box: ja). UniFi ohne FAH-Proxy-Konto: genauso vorgehen, die Regeln aber genau **FAH-Proxy HTTP** und **FAH-Proxy HTTPS** nennen. Automatisches Fail-over gibt es nur mit UniFi-Konto.' }));
}
