# FAH-Proxy

Reverse-Proxy mit einfacher Oberfläche – Caddy als Motor, Zertifikate automatisch.

- **Domain in einem Schritt:** Adresse + Ziel eintragen, Zertifikat und HTTPS kommen von selbst.
- **Schutz per Klick:** Öffentlich · Nur Heimnetz + VPN · Eigene IP-Liste · Mit FAH-Anmeldung.
- **Status:** je Domain Ziel erreichbar?, Zertifikat gültig bis?, Zugriffe der letzten 24 h.
- **Umschalten per UniFi:** leitet 80/443 an FAH-Proxy (mit Vorschau jeder Änderung, Sicherung, Firewall- und DNS-Abgleich).
- **Zwei Instanzen mit Fail-over:** Haupt + Ersatz gleichen sich ab (immer von der aktiven zur anderen); fällt die aktive
  aus, übernimmt die andere, danach geht das Internet samt Änderungen der Ausfallzeit zurück.

## Screenshots

*Aufgenommen mit erfundenen Beispiel-Domains (`*.example.org`) und Platzhalter-Zielen – keine echten Adressen oder Daten.*

![Übersicht – Domains als Kacheln mit Status, Schutz und Zertifikat](docs/screenshots/1-uebersicht.png)

| Liste | Domain bearbeiten |
|---|---|
| ![Liste](docs/screenshots/2-liste.png) | ![Domain bearbeiten](docs/screenshots/3-domain-bearbeiten.png) |
| **Einstellungen & Schutzstufen** | **Umschalten (Fail-over)** |
| ![Einstellungen](docs/screenshots/4-einstellungen.png) | ![Umschalten](docs/screenshots/6-umschalten.png) |
| **Protokoll** | **Handy** |
| ![Protokoll](docs/screenshots/5-protokoll.png) | <img src="docs/screenshots/7-handy.png" alt="Handy" width="260"> |

## Installation
`fah-proxy_release.zip` und `manage.sh` in einen leeren Ordner legen, dann `./manage.sh update`.
Danach `https://<Rechner>:28181` öffnen (Zertifikat ist selbstsigniert), Anmeldung **admin / admin**, eigenes Passwort setzen.
Auf FAH-NAS: Apps → „App aus ZIP“.

Ports (in `.env`, belegt → nächster freier): HTTP 28080, HTTPS 28443, Oberfläche 28181.

## Befehle
`./manage.sh update [zip] | up | down | restart | rebuild | logs | status | url | port | admin-reset`

Daten liegen in `daten/` (Domains, Konten, Zertifikate, Protokoll) und `caddy-daten/` (von Caddy geholte Zertifikate);
ein Update fasst sie nie an.
