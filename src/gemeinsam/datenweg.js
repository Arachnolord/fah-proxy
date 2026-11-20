// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Lebend-Prüfung eines FAH-Proxy unter host:port (Wache, Umschalten). Eigenes Modul, damit unifi/ablauf.js sie ohne
// Kreisbezug zu spiegel/wache.js nutzen kann.

import https from 'node:https';

/** Antwortet ein FAH-Proxy unter host:port für `domain`? Fragt /_fah/lebt (Caddy antwortet selbst, ohne Protokoll); jede HTTP-Antwort heißt: er lebt. */
export function datenwegPruefen({ host, port, domain, zeitlimit_ms = 5000 }) {
  return new Promise((ok) => {
    const req = https.request({ host, port, path: '/_fah/lebt', method: 'GET', servername: domain, headers: { Host: domain, 'User-Agent': 'FAH-Proxy-Wache' }, rejectUnauthorized: false, agent: false, timeout: zeitlimit_ms }, (res) => { res.resume(); ok(true); });
    req.on('timeout', () => { req.destroy(); ok(false); });
    req.on('error', () => ok(false));
    req.end();
  });
}
