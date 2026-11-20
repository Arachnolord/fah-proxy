#!/usr/bin/env bash
# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
# manage.sh – FAH-Proxy (Reverse-Proxy mit Caddy als Motor)
#
#   ./manage.sh update [zip]   Neueste fah-proxy*.zip im Ordner (oder die angegebene) entpacken, bauen, tauschen.
#                              Auch für die Erstinstallation: ZIP + manage.sh in einen leeren Ordner, dann update.
#   ./manage.sh up|down|restart|rebuild|logs|status|url
#   ./manage.sh port           Ports anzeigen (Ändern: Werte in .env anpassen, dann ./manage.sh up)
#   ./manage.sh admin-reset    Notfall: Konto admin / admin wiederherstellen (2FA aus)
#
# Daten (daten/, caddy-daten/, caddy-config/) und .env fasst ein Update nie an. Ports: Erstinstallation ab 28080 (HTTP),
# 28443 (HTTPS), 28181 (Oberfläche) – belegt → nächster freier, fest in .env.
{ # ganzes Skript einlesen, bevor etwas läuft (ein Update ersetzt manage.sh)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"
DEPLOY_GLOB="${DEPLOY_GLOB:-fah-proxy_release*.zip fah-proxy*.zip}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ENV_DATEI="$ROOT/.env"
GESCHUETZT=" .env daten caddy-daten caddy-config "

if [ -t 1 ]; then C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_0=$'\033[0m'; else C_B=""; C_G=""; C_Y=""; C_R=""; C_0=""; fi
log()  { printf "${C_B}==>${C_0} %s\n" "$*"; }
ok()   { printf "${C_G}  ok${C_0} %s\n" "$*"; }
warn() { printf "${C_Y}  ! ${C_0} %s\n" "$*"; }
die()  { printf "${C_R}FEHLER:${C_0} %s\n" "$*" >&2; exit 1; }

detect_compose() {
  if docker compose version >/dev/null 2>&1; then COMPOSE="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then COMPOSE="docker-compose"
  else die "Weder 'docker compose' noch 'docker-compose' gefunden."; fi
}

env_wert() { grep -E "^$1=" "$ENV_DATEI" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d ' \r' || true; }
env_setzen() {
  local neu="$ENV_DATEI.neu"
  if [ -f "$ENV_DATEI" ]; then grep -vE "^$1=" "$ENV_DATEI" > "$neu" || true; else : > "$neu"; fi
  printf '%s=%s\n' "$1" "$2" >> "$neu"
  mv -f "$neu" "$ENV_DATEI"; chmod 600 "$ENV_DATEI" 2>/dev/null || true
}
host_ip() {
  local ip
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | grep -oE 'src [0-9.]+' | awk '{print $2}' | head -n1 || true)"
  [ -n "$ip" ] || ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
  printf '%s' "$ip"
}

env_pruefen() {
  [ -f "$ENV_DATEI" ] || { : > "$ENV_DATEI"; chmod 600 "$ENV_DATEI"; ok ".env angelegt"; }
  [ -n "$(env_wert PROJEKT)" ] || env_setzen PROJEKT "$(basename "$ROOT" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-')"
  local ip; ip="$(host_ip)"
  if [ -n "$ip" ] && [ "$(env_wert HOST_IP)" != "$ip" ]; then env_setzen HOST_IP "$ip"; ok "Adresse dieses Rechners: $ip"; fi
  # NPM-Anbindung früherer Versionen (bis 0.7) entfernen
  if grep -qE '^NPM_(PFAD|HOST)=' "$ENV_DATEI"; then
    grep -vE '^NPM_(PFAD|HOST)=' "$ENV_DATEI" > "$ENV_DATEI.neu" || true; cat "$ENV_DATEI.neu" > "$ENV_DATEI"; rm -f "$ENV_DATEI.neu"; ok "NPM-Einträge aus .env entfernt"
  fi
  [ -d "$ROOT/kein-npm" ] && rmdir "$ROOT/kein-npm" 2>/dev/null || true
  mkdir -p "$ROOT/daten/caddy" "$ROOT/daten/zertifikate" "$ROOT/caddy-daten" "$ROOT/caddy-config"
}

# --- Ports: Container DIESES Projekts zählen als eigene ------------------------------------------------------------
eigene_ids() { { $COMPOSE ps -aq 2>/dev/null || true; } | grep -E '^[0-9a-f]{12,64}$' || true; }
eigene_ports() {
  local ids; ids="$(eigene_ids | tr '\n' ' ')"; [ -n "${ids// /}" ] || return 0
  # shellcheck disable=SC2086
  docker inspect --format '{{range $p, $b := .HostConfig.PortBindings}}{{range $b}}{{.HostPort}} {{end}}{{end}}' $ids 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u || true
}
fremde_ports() {
  local eigene zeile; eigene=" $(eigene_ids | tr '\n' ' ') "
  while IFS= read -r zeile; do
    [[ "$eigene" == *" ${zeile%%|*} "* ]] && continue
    grep -oE ':[0-9]+->' <<< "${zeile#*|}" | tr -dc '0-9\n' || true
  done < <(docker ps -a --format '{{.ID}}|{{.Ports}}' 2>/dev/null || true)
}
port_belegt() {
  local hex d dateien=(); hex="$(printf '%04X' "$1")"
  for d in /proc/net/tcp /proc/net/tcp6; do [ -r "$d" ] && dateien+=("$d"); done
  if [ "${#dateien[@]}" -gt 0 ]; then awk -v p=":$hex" 'FNR > 1 && $4 == "0A" && substr($2, length($2) - 4) == p { f = 1 } END { exit !f }' "${dateien[@]}"
  elif command -v ss >/dev/null 2>&1; then ss -Hltn 2>/dev/null | awk '{print $4}' | grep -Eq "[:.]$1\$"
  else return 1; fi
}
port_waehlen() { # $1 = Name in .env, $2 = Standard
  local name="$1" start port eigene fremde vergeben
  start="$(env_wert "$name")"; [[ "$start" =~ ^[0-9]+$ ]] || start="$2"
  eigene=" $(eigene_ports | tr '\n' ' ') "; fremde=" $(fremde_ports | sort -un | tr '\n' ' ') "
  vergeben=" $(env_wert PROXY_HTTP_PORT) $(env_wert PROXY_HTTPS_PORT) $(env_wert UI_PORT) "; vergeben="${vergeben/ $start / }"
  port="$start"
  while [[ "$eigene" != *" $port "* ]] && { [[ "$fremde" == *" $port "* ]] || [[ "$vergeben" == *" $port "* ]] || port_belegt "$port"; }; do
    port=$((port + 1)); [ "$port" -le 65535 ] || die "Kein freier Port ab $start."
  done
  [ "$port" != "$start" ] && warn "$name: Port $start belegt → $port" || ok "$name: Port $port"
  [ "$(env_wert "$name")" = "$port" ] || env_setzen "$name" "$port"
}
ports_waehlen() { port_waehlen PROXY_HTTP_PORT 28080; port_waehlen PROXY_HTTPS_PORT 28443; port_waehlen UI_PORT 28181; }

warte_gesund() {
  local id status i
  id="$($COMPOSE ps -q fah-proxy 2>/dev/null || true)"
  [ -n "$id" ] || { warn "fah-proxy läuft nicht – ./manage.sh logs"; return 0; }
  for i in $(seq 1 45); do
    status="$(docker inspect -f '{{.State.Health.Status}}' "$id" 2>/dev/null || echo unbekannt)"
    [ "$status" = "healthy" ] && break; sleep 2
  done
  if [ "$status" = "healthy" ]; then ok "FAH-Proxy antwortet"; else warn "FAH-Proxy meldet noch nicht „healthy“ – ./manage.sh logs"; fi
}

print_url() {
  printf '  Oberfläche: https://%s:%s   (Erstanmeldung admin / admin – das Zertifikat ist selbstsigniert)\n' "$(env_wert HOST_IP)" "$(env_wert UI_PORT)"
  printf '  Proxy-Ports: HTTP %s, HTTPS %s (erst „Übernehmen“ in der Oberfläche leitet das Internet hierher)\n' "$(env_wert PROXY_HTTP_PORT)" "$(env_wert PROXY_HTTPS_PORT)"
}

paren_num() { local b; b="$(basename "$1")"; if [[ "$b" =~ \(([0-9]+)\)\.zip$ ]]; then echo "${BASH_REMATCH[1]}"; else echo 0; fi; }
neueste_zip() {
  local neueste="" n_num=-1 n_zeit=-1 f num zeit; shopt -s nullglob
  for f in $DEPLOY_GLOB; do
    [ -f "$f" ] || continue
    num="$(paren_num "$f")"; zeit="$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f")"
    if [ "$zeit" -gt "$n_zeit" ] || { [ "$zeit" -eq "$n_zeit" ] && [ "$num" -gt "$n_num" ]; }; then neueste="$f"; n_num="$num"; n_zeit="$zeit"; fi
  done
  shopt -u nullglob; [ -n "$neueste" ] || return 1; printf '%s\n' "$neueste"
}
entpacken() { # $1 zip, $2 ziel
  mkdir -p "$2"
  if command -v unzip >/dev/null 2>&1; then unzip -oq "$1" -d "$2"
  elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$1" "$2"
  else die "Zum Entpacken wird unzip oder python3 gebraucht."; fi
}

cmd_update() {
  detect_compose
  local zip="${1:-}"
  if [ -z "$zip" ]; then zip="$(neueste_zip)" || die "Keine fah-proxy*.zip im Ordner gefunden."; fi
  [ -f "$zip" ] || die "ZIP nicht gefunden: $zip"
  log "Version aus $(basename "$zip")"
  local tmp; tmp="$(mktemp -d "$ROOT/.update-XXXXXX")"
  trap "rm -rf $(printf '%q' "$tmp")" EXIT
  entpacken "$zip" "$tmp"
  local quelle="$tmp"
  if [ ! -f "$tmp/manage.sh" ] && [ "$(find "$tmp" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then quelle="$(find "$tmp" -mindepth 1 -maxdepth 1)"; fi
  [ -f "$quelle/Dockerfile" ] && [ -f "$quelle/docker-compose.yml" ] && [ -d "$quelle/src" ] || die "Das ist keine FAH-Proxy-ZIP (Dockerfile/docker-compose.yml/src fehlt)."
  # Selbst-Update: neue manage.sh atomar tauschen und mit ihr neu starten (Schutz MANAGE_NEU gegen Schleifen)
  if [ -z "${MANAGE_NEU:-}" ] && [ -f "$quelle/manage.sh" ] && ! cmp -s "$quelle/manage.sh" "$ROOT/manage.sh"; then
    cp -f "$quelle/manage.sh" "$ROOT/.manage.sh.neu"; chmod +x "$ROOT/.manage.sh.neu"; mv -f "$ROOT/.manage.sh.neu" "$ROOT/manage.sh"
    ok "manage.sh aktualisiert – Neustart des Updates"
    rm -rf "$tmp"; trap - EXIT
    MANAGE_NEU=1 exec "$ROOT/manage.sh" update "$zip"
  fi
  log "Programmdateien übernehmen (Daten und .env bleiben)"
  local pfad name
  while IFS= read -r -d '' pfad; do
    name="$(basename "$pfad")"
    [[ "$GESCHUETZT" == *" $name "* || "$name" == "manage.sh" ]] && continue
    if [ -d "$pfad" ]; then rm -rf "${ROOT:?}/$name.neu"; cp -R "$pfad" "$ROOT/$name.neu" || die "Kopieren fehlgeschlagen: $name/"; rm -rf "${ROOT:?}/$name"; mv "$ROOT/$name.neu" "$ROOT/$name"
    else cp -f "$pfad" "$ROOT/$name" || die "Kopieren fehlgeschlagen: $name"; fi
  done < <(find "$quelle" -mindepth 1 -maxdepth 1 -print0)
  rm -rf "$tmp"; trap - EXIT
  env_pruefen
  log "Bauen (die laufende Version bleibt, bis der Bau fertig ist)"
  $COMPOSE build fah-proxy || die "Bauen fehlgeschlagen – die bisherige Version läuft unverändert weiter."
  $COMPOSE pull -q caddy || warn "Caddy-Image nicht neu geladen (offline?) – das vorhandene wird genutzt"
  log "Ports"
  ports_waehlen
  log "Starten"
  $COMPOSE up -d --remove-orphans || die "Start fehlgeschlagen – ./manage.sh logs"
  if [ "$(basename "$zip")" = "$zip" ] || [ "$(cd "$(dirname "$zip")" && pwd)" = "$ROOT" ]; then mv -f "$zip" "${zip%.zip}.$STAMP.bak"; ok "ZIP archiviert: ${zip%.zip}.$STAMP.bak"; fi
  warte_gesund
  log "${C_G}Update abgeschlossen ($(cat "$ROOT/BUILD_VERSION" 2>/dev/null || echo ?)).${C_0}"
  print_url
}

cmd_admin_reset() {
  detect_compose
  $COMPOSE exec -T fah-proxy node /app/src/werkzeuge/admin-reset.js || die "FAH-Proxy läuft nicht – erst ./manage.sh up"
  $COMPOSE restart fah-proxy >/dev/null; ok "Anmeldung jetzt mit admin / admin."
}

case "${1:-}" in
  update)  cmd_update "${2:-}" ;;
  up)      detect_compose; env_pruefen; ports_waehlen; $COMPOSE up -d --remove-orphans; warte_gesund; print_url ;;
  down)    detect_compose; $COMPOSE down ;;
  restart) detect_compose; $COMPOSE restart ;;
  rebuild) detect_compose; env_pruefen; $COMPOSE build fah-proxy; ports_waehlen; $COMPOSE up -d --force-recreate; warte_gesund; print_url ;;
  logs)    detect_compose; $COMPOSE logs -f --tail=100 ;;
  status)  detect_compose; $COMPOSE ps; print_url ;;
  url)     print_url ;;
  port)    printf 'HTTP %s · HTTPS %s · Oberfläche %s\n' "$(env_wert PROXY_HTTP_PORT)" "$(env_wert PROXY_HTTPS_PORT)" "$(env_wert UI_PORT)" ;;
  admin-reset) cmd_admin_reset ;;
  ""|-h|--help|help) sed -n '6,16p' "$0" ;;
  *) die "Unbekannter Befehl: $1 (siehe ./manage.sh help)" ;;
esac
exit $?
}
