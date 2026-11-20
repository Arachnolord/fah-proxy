// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Einstieg im Container: Oberfläche per HTTPS auf 8443 (selbstsigniertes Zertifikat aus <daten>/ui-tls, legt der
// Einstiegsskript beim ersten Start an), intern per HTTP auf 8081 nur im Compose-Netz (Gesundheit, FAH-Anmeldung).

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { App } from './app.js';
import { appOptionen } from './umgebung.js';

const optionen = appOptionen();
const { daten: DATEN, version } = optionen;
const app = await App.starten(optionen);

const tls = { key: fs.readFileSync(path.join(DATEN, 'ui-tls', 'key.pem')), cert: fs.readFileSync(path.join(DATEN, 'ui-tls', 'cert.pem')) };
const ui = https.createServer(tls, app.web.handler());
ui.listen(8443, '0.0.0.0', () => process.stdout.write(`[fah-proxy] ${version}: Oberfläche auf https://0.0.0.0:8443 (außen Port ${process.env.UI_PORT || '?'})\n`));

const intern = http.createServer(app.internerHandler());
intern.listen(8081, '0.0.0.0');

function beenden() { app.stoppen(); ui.close(); intern.close(); setTimeout(() => process.exit(0), 1500).unref(); }
process.on('SIGTERM', beenden);
process.on('SIGINT', beenden);
