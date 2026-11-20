// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstellungen aus der Umgebung des Containers (.env über Compose) – gemeinsam für server.js und die Werkzeuge.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DATEN = process.env.DATEN || '/daten';
const WURZEL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const zahl = (v) => (Number(v) > 0 ? Number(v) : null);

export function version() {
  try { return fs.readFileSync(path.join(WURZEL, 'BUILD_VERSION'), 'utf8').trim(); } catch { return '?'; }
}

/** Optionen für App.starten (ohne `hintergrund`). */
export function appOptionen() {
  const env = process.env;
  return {
    daten: DATEN, caddyUrl: env.CADDY_URL || 'http://caddy:2019', caddyDaten: '/caddy-daten', version: version(),
    testPorts: { http: zahl(env.PROXY_HTTP_PORT), https: zahl(env.PROXY_HTTPS_PORT) }, hostIp: env.HOST_IP || '',
    uiUrl: env.HOST_IP && env.UI_PORT ? `https://${env.HOST_IP}:${env.UI_PORT}` : '', uiZertDatei: path.join(DATEN, 'ui-tls', 'cert.pem'),
  };
}
