#!/usr/bin/env bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# Baut dist/fah-proxy_release.zip (nur, was zum Laufen gebraucht wird – keine Tests/Doku) und legt eine Kopie nach
# ~/claude/NEUE ZIPs/Docker Projekte/fah-proxy_release.zip (Ablage-Struktur seit 16.11.2026).
set -euo pipefail
WURZEL="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$WURZEL"
VERSION="$(tr -d '[:space:]' < BUILD_VERSION)"
mkdir -p dist; rm -f dist/fah-proxy_release.zip
zip -q -r dist/fah-proxy_release.zip manage.sh docker-compose.yml Dockerfile .dockerignore docker package.json BUILD_VERSION README.md src public -x '*.DS_Store'
cp -f dist/fah-proxy_release.zip "$HOME/claude/NEUE ZIPs/Docker Projekte/fah-proxy_release.zip"
echo "fah-proxy_release.zip $VERSION gebaut ($(du -h dist/fah-proxy_release.zip | cut -f1)), Kopie in NEUE ZIPs/Docker Projekte"
