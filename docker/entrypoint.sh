#!/bin/sh
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Einstieg fah-proxy: beim ersten Start ein selbstsigniertes Zertifikat für die Oberfläche anlegen (10 Jahre, mit der
# Adresse des Rechners), danach den Server starten.
set -eu
DATEN="${DATEN:-/daten}"
mkdir -p "$DATEN/ui-tls" "$DATEN/caddy" "$DATEN/zertifikate"
if [ ! -s "$DATEN/ui-tls/cert.pem" ] || [ ! -s "$DATEN/ui-tls/key.pem" ]; then
  SAN="DNS:localhost,DNS:fah-proxy"
  [ -n "${HOST_IP:-}" ] && SAN="$SAN,IP:$HOST_IP"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 3650 \
    -keyout "$DATEN/ui-tls/key.pem" -out "$DATEN/ui-tls/cert.pem" -subj "/CN=FAH-Proxy" -addext "subjectAltName=$SAN" 2>/dev/null
  chmod 600 "$DATEN/ui-tls/key.pem"
  echo "[fah-proxy] Zertifikat für die Oberfläche angelegt ($SAN)"
fi
exec node --disable-warning=ExperimentalWarning /app/src/server.js
