// ============================================================================
// Erdacht und programmiert von Fabian Hammer, Deutschland.
// (c) 2026 Fabian Hammer - Alle Rechte vorbehalten. Geistiges Eigentum.
// ============================================================================
// Fehler mit Code (E_EINGABE, E_EXISTIERT, E_NICHT_GEFUNDEN, E_DATEN, E_RECHTE, E_ANMELDUNG, E_CADDY, E_UNIFI …) und
// Details (z. B. {feld}) – die Oberfläche zeigt `meldung` und markiert `details.feld`.

export const HTTP_STATUS = Object.freeze({
  E_EINGABE: 400, E_CSRF: 403, E_RECHTE: 403, E_ANMELDUNG: 401, E_NICHT_GEFUNDEN: 404, E_EXISTIERT: 409, E_BREMSE: 429,
  E_DATEN: 500, E_CADDY: 502, E_UNIFI: 502, E_SPIEGEL: 502, E_NTFY: 502, E_INTERN: 500,
});

export class Fehler extends Error {
  constructor(code, meldung, details = {}) {
    super(meldung);
    this.code = code;
    this.details = details;
  }
  static aus(e) {
    if (e instanceof Fehler) return e;
    return new Fehler('E_INTERN', 'Unerwarteter Fehler', { grund: String((e && e.message) || e) });
  }
  get status() { return HTTP_STATUS[this.code] || 500; }
  toJSON() { return { code: this.code, meldung: this.message, details: this.details }; }
}
