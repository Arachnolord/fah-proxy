// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Notfall (manage.sh admin-reset): Konto admin auf Passwort „admin“ mit Pflichtwechsel zurücksetzen, 2FA aus, entsperrt.
// Fehlt das Konto, wird es angelegt. Andere Konten bleiben unberührt.

import path from 'node:path';
import { jsonLesen, jsonSchreiben } from '../gemeinsam/dateien.js';
import { hashErzeugen } from '../totp.js';

const datei = path.join(process.env.DATEN || '/daten', 'konten.json');
const d = await jsonLesen(datei, { konten: [] });
const konten = Array.isArray(d.konten) ? d.konten : [];
const neu = { name: 'admin', hash: await hashErzeugen('admin'), rolle: 'admin', pflichtwechsel: true, totp: null, letzterSchritt: -1, domains: [], gesperrt: false };
const i = konten.findIndex((k) => k.name === 'admin');
if (i >= 0) konten[i] = { ...konten[i], ...neu }; else konten.push(neu);
await jsonSchreiben(datei, { konten });
process.stdout.write('Konto admin zurückgesetzt: Anmeldung mit admin / admin, danach eigenes Passwort setzen.\n');
