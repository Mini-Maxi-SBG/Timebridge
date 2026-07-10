# Terminfinder-Backend

Kleiner Node.js/Express-Server, der dem Terminfinder-Frontend drei Dinge liefert,
die ein reines Browser-Artefakt nicht kann:

- **Live-Updates** an alle offenen Clients per Server-Sent Events (SSE)
- **E-Mail-Versand**: Einladung, Erinnerung an Nicht-Abstimmende, Abschlussmail mit finalem Termin
- **Microsoft-Teams-Meldungen** über einen Incoming Webhook

Das Frontend funktioniert auch **ohne** dieses Backend weiter (lokale Speicherung +
Polling). Das Backend ist eine optionale Ergänzung für echte Benachrichtigungen.

## 1. Lokal starten

```bash
npm install
cp .env.example .env
# .env ausfüllen (siehe unten)
npm start
```

Der Server läuft danach auf `http://localhost:3000`.

## 2. Umgebungsvariablen (`.env`)

| Variable | Beschreibung |
|---|---|
| `PORT` | Port des Servers (Standard 3000) |
| `FRONTEND_URL` | Wird in E-Mails als Link angezeigt |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` | SMTP-Zugangsdaten für den E-Mail-Versand |
| `SMTP_FROM` | Absenderadresse |
| `TEAMS_WEBHOOK_URL` | Globale Teams-Webhook-URL (Fallback, falls eine Umfrage keine eigene mitschickt) |
| `CORS_ORIGIN` | Erlaubte Frontend-Origin(s), `*` für alle |

### SMTP-Zugang bekommen

Jede der folgenden Optionen funktioniert, du brauchst nur eine:

- **Resend** (einfach, großzügiges Gratis-Kontingent): Account erstellen, API-Key als `SMTP_PASS`
  mit `SMTP_USER=resend`, Host `smtp.resend.com`, Port `587`.
- **Gmail**: `SMTP_HOST=smtp.gmail.com`, Port `587`, App-Passwort statt normalem Passwort verwenden.
- **SendGrid**, **Mailgun** oder ein eigener Mailserver funktionieren analog.

### Teams-Webhook einrichten

1. Im gewünschten Teams-Kanal auf **„…“ → Connectors** (oder „Workflows“ bei neueren Teams-Versionen).
2. „Incoming Webhook“ suchen und hinzufügen, Namen vergeben.
3. Die generierte URL kopieren und als `TEAMS_WEBHOOK_URL` eintragen.

## 3. Deployment

Der Server ist zustandsbehaftet für SSE-Verbindungen, läuft also am einfachsten als
**eine** dauerhaft laufende Instanz (kein reines Serverless/Lambda-Setup):

- **Render.com**, **Railway.app** oder **Fly.io**: Repo verbinden, „Node“-Service anlegen,
  Start-Command `npm start`, Umgebungsvariablen aus `.env` eintragen.
- Ein eigener VM/vServer mit `pm2` oder `systemd` funktioniert ebenso.

Nach dem Deployment die öffentliche URL (z.B. `https://terminfinder-backend.onrender.com`)
im Frontend unter „Einstellungen → Backend-URL“ eintragen.

## 4. Grenzen dieser einfachen Implementierung

- **Speicherung**: Alles liegt in `data.json` neben dem Server (Datei-basiert, kein
  echtes Datenbank-System). Für viele gleichzeitige Nutzer oder mehrere Serverinstanzen
  (Load Balancing) durch Postgres/Redis ersetzen.
- **Keine Authentifizierung**: Jeder, der die Umfrage-ID kennt, kann über die API
  abstimmen oder (bei aktivierten Benachrichtigungen) Erinnerungen auslösen — genau wie
  beim ursprünglichen Doodle-artigen Ansatz über einen Freigabe-Code. Für sensiblere
  Anwendungsfälle einen Zugriffsschutz (z.B. API-Key pro Umfrage) ergänzen.
- **CORS**: Standardmäßig offen (`*`), damit das Artefakt aus jeder Umgebung erreichen
  kann. In Produktivumgebungen auf die konkrete Frontend-Domain einschränken.

## 5. API-Übersicht

| Methode & Pfad | Zweck |
|---|---|
| `POST /api/polls` | Umfrage anlegen, versendet Einladungen/Teams-Meldung |
| `GET /api/polls/:id` | Umfrage-Metadaten abrufen |
| `GET /api/polls/:id/votes` | Alle Stimmen abrufen |
| `POST /api/polls/:id/votes` | Stimme abgeben, löst Live-Update + Teams-Meldung aus |
| `POST /api/polls/:id/remind` | Erinnerungsmails an Nicht-Abstimmende senden |
| `POST /api/polls/:id/finalize` | Finalen Termin festlegen, Abschlussmail + Teams-Meldung |
| `GET /api/polls/:id/stream` | SSE-Stream für Live-Updates |
