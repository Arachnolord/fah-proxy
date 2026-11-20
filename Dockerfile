# ============================================================================
# Erdacht und programmiert von Fabian Hammer, Deutschland.
# (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
# ============================================================================
FROM node:24-alpine
RUN apk add --no-cache openssl tzdata
WORKDIR /app
COPY package.json BUILD_VERSION ./
COPY src ./src
COPY public ./public
COPY docker/entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
ENV NODE_ENV=production TZ=Europe/Berlin DATEN=/daten
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD wget -qO- http://127.0.0.1:8081/_fah/gesund >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
