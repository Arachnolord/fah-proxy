// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Zertifikate lesen: Namen (SAN) und Ablauf aus PEM (node:crypto X509Certificate). Übernommene Zertifikate liegen je
// Domain in daten/zertifikate/<domain>/{fullchain,privkey}.pem.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

/** Erstes Zertifikat einer PEM-Kette → {namen, bis}. Wirft bei unlesbarem PEM. */
export function zertifikatLesen(pem) {
  const erstes = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(String(pem));
  if (!erstes) throw new Error('kein Zertifikat im PEM');
  const x = new crypto.X509Certificate(erstes[0]);
  const namen = String(x.subjectAltName || '').split(',').map((s) => s.trim()).filter((s) => s.startsWith('DNS:')).map((s) => s.slice(4).toLowerCase());
  return { namen, bis: new Date(x.validTo) };
}

/** Deckt ein Name (auch *.beispiel.de) die Domain ab? */
export function nameDeckt(name, domain) {
  if (name === domain) return true;
  return name.startsWith('*.') && domain.endsWith(name.slice(1)) && !domain.slice(0, -name.length + 1).includes('.');
}

/** Alle Zertifikatsordner → Map domain → {fullchain, privkey, bis, namen}; nur gültige PEMs, deren SAN die Domain deckt. */
export async function zertifikateFinden(ordner) {
  const aus = new Map();
  let namen = [];
  try { namen = (await fs.readdir(ordner)).sort(); } catch { return aus; }
  for (const domain of namen) {
    const fullchain = path.join(ordner, domain, 'fullchain.pem'); const privkey = path.join(ordner, domain, 'privkey.pem');
    try {
      const z = zertifikatLesen(await fs.readFile(fullchain, 'utf8'));
      await fs.access(privkey);
      if (z.namen.some((n) => nameDeckt(n, domain))) aus.set(domain, { fullchain, privkey, bis: z.bis, namen: z.namen });
    } catch { /* unlesbar oder unvollständig → nicht verwenden */ }
  }
  return aus;
}

/**
 * Von Caddy selbst geholte Zertifikate (Caddy-Datenordner …/caddy/certificates/<aussteller>/<domain>/<domain>.crt)
 * → Map domain → {bis, aussteller, fullchain, privkey}. Bei mehreren Ausstellern gilt das am längsten gültige.
 */
export async function verwalteteZertifikate(caddyDaten) {
  const aus = new Map();
  const wurzel = path.join(caddyDaten, 'caddy', 'certificates');
  let aussteller = [];
  try { aussteller = await fs.readdir(wurzel); } catch { return aus; }
  for (const a of aussteller) {
    let domains = [];
    try { domains = await fs.readdir(path.join(wurzel, a)); } catch { continue; }
    for (const d of domains) {
      try {
        const z = zertifikatLesen(await fs.readFile(path.join(wurzel, a, d, `${d}.crt`), 'utf8'));
        const alt = aus.get(d);
        if (!alt || alt.bis < z.bis) aus.set(d, { bis: z.bis, aussteller: a, fullchain: path.join(wurzel, a, d, `${d}.crt`), privkey: path.join(wurzel, a, d, `${d}.key`) });
      } catch { /* unvollständig */ }
    }
  }
  return aus;
}
