import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(__dirname, 'data.json');

const PORT = process.env.PORT || 3000;
const FRONTEND_URL = process.env.FRONTEND_URL || '';
const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || '';
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

// ---------------------------------------------------------------------------
// Sehr einfache Persistenz: alles im Speicher, bei jeder Änderung als JSON
// auf die Platte geschrieben. Reicht für kleine/mittlere Nutzergruppen und
// einen einzelnen Server-Prozess. Für hohe Last / mehrere Instanzen durch
// eine echte Datenbank (Postgres, Redis, ...) ersetzen.
// ---------------------------------------------------------------------------
function loadData() {
  if (fs.existsSync(DATA_FILE)) {
    try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); }
    catch (e) { console.error('data.json konnte nicht gelesen werden, starte leer.', e); }
  }
  return { polls: {}, votes: {} };
}
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}
const db = loadData();

// pollId -> Set(res) der offenen SSE-Verbindungen
const sseClients = new Map();

function broadcast(pollId, event, payload) {
  const clients = sseClients.get(pollId);
  if (!clients) return;
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(data);
}

// ---------------------------------------------------------------------------
// E-Mail
// ---------------------------------------------------------------------------
const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined
    })
  : null;

async function sendMail(to, subject, text) {
  if (!mailer) { console.warn('SMTP nicht konfiguriert, E-Mail wird übersprungen:', subject, '->', to); return; }
  try {
    await mailer.sendMail({ from: process.env.SMTP_FROM || 'Terminfinder <no-reply@example.com>', to, subject, text });
  } catch (e) {
    console.error('E-Mail-Versand fehlgeschlagen an', to, e.message);
  }
}

function pollLinkText(pollId) {
  return FRONTEND_URL
    ? `${FRONTEND_URL} (Code: ${pollId})`
    : `Code: ${pollId}`;
}

function fmtOption(o) {
  const d = new Date(`${o.date}T${o.time || '00:00'}`);
  const dateStr = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
  return o.time ? `${dateStr}, ${o.time} Uhr` : dateStr;
}

// ---------------------------------------------------------------------------
// Microsoft Teams (Incoming Webhook)
// ---------------------------------------------------------------------------
async function postToTeams(webhookUrl, text) {
  const url = webhookUrl || TEAMS_WEBHOOK_URL;
  if (!url) { console.warn('Kein Teams-Webhook konfiguriert, Meldung wird übersprungen:', text); return; }
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
  } catch (e) {
    console.error('Teams-Webhook fehlgeschlagen', e.message);
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(cors({ origin: CORS_ORIGIN === '*' ? '*' : CORS_ORIGIN.split(',') }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Umfrage anlegen (spiegelt die im Frontend lokal erzeugte Umfrage und
// aktiviert serverseitige Benachrichtigungen dafür)
app.post('/api/polls', async (req, res) => {
  const { id, title, description, creator, options, emails, notify } = req.body || {};
  if (!id || !title || !Array.isArray(options) || options.length === 0) {
    return res.status(400).json({ error: 'id, title und options sind erforderlich.' });
  }
  const poll = {
    id, title, description: description || '', creator: creator || '',
    options,
    emails: Array.isArray(emails) ? emails.filter(Boolean) : [],
    notify: { email: !!notify?.email, teams: !!notify?.teams, push: !!notify?.push },
    teamsWebhookUrl: notify?.teamsWebhookUrl || '',
    finalizedOptionId: null,
    createdAt: Date.now()
  };
  db.polls[id] = poll;
  db.votes[id] = db.votes[id] || {};
  saveData();

  const dateList = options.map(fmtOption).join('\n- ');
  if (poll.notify.email && poll.emails.length) {
    const subject = `Einladung: ${title}`;
    const text =
      `${creator || 'Jemand'} hat dich zu einer Terminabstimmung eingeladen: "${title}"\n\n` +
      (description ? `${description}\n\n` : '') +
      `Vorgeschlagene Termine:\n- ${dateList}\n\n` +
      `Hier abstimmen: ${pollLinkText(id)}`;
    await Promise.all(poll.emails.map(e => sendMail(e, subject, text)));
  }
  if (poll.notify.teams) {
    await postToTeams(poll.teamsWebhookUrl, `📅 Neue Umfrage **${title}** von ${creator || 'Jemand'} wurde erstellt. Code: ${id}`);
  }

  res.json({ ok: true, id });
});

app.get('/api/polls/:id', (req, res) => {
  const poll = db.polls[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Nicht gefunden' });
  const { emails, teamsWebhookUrl, ...publicPoll } = poll;
  res.json(publicPoll);
});

app.get('/api/polls/:id/votes', (req, res) => {
  const votes = db.votes[req.params.id] || {};
  res.json(Object.values(votes).map(({ email, ...v }) => v));
});

// Stimme abgeben (spiegelt eine lokal gespeicherte Stimme)
app.post('/api/polls/:id/votes', async (req, res) => {
  const poll = db.polls[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
  const { name, email, choices, voterId } = req.body || {};
  if (!name || !choices) return res.status(400).json({ error: 'name und choices sind erforderlich.' });

  // Bevorzugt eine geräteeigene Kennung als Schlüssel, damit zwei Personen mit dem
  // gleichen Namen sich nicht gegenseitig überschreiben. Ohne Kennung (ältere Clients)
  // wird auf den Namen zurückgefallen.
  const key = voterId ? 'v:' + voterId : name.trim().toLowerCase();
  db.votes[poll.id] = db.votes[poll.id] || {};
  db.votes[poll.id][key] = { name: name.trim(), email: email || '', choices, votedAt: Date.now() };
  saveData();

  broadcast(poll.id, 'vote', { name: name.trim() });
  if (poll.notify.teams) {
    await postToTeams(poll.teamsWebhookUrl, `🗳️ Neue Stimme von **${name.trim()}** bei "${poll.title}"`);
  }
  res.json({ ok: true });
});

// Erinnerung an alle, die noch nicht abgestimmt haben
app.post('/api/polls/:id/remind', async (req, res) => {
  const poll = db.polls[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
  if (!poll.notify.email) return res.status(400).json({ error: 'E-Mail-Benachrichtigungen sind für diese Umfrage deaktiviert.' });

  const votedEmails = new Set(Object.values(db.votes[poll.id] || {}).map(v => (v.email || '').toLowerCase()).filter(Boolean));
  const pending = poll.emails.filter(e => !votedEmails.has(e.toLowerCase()));

  const dateList = poll.options.map(fmtOption).join('\n- ');
  const subject = `Erinnerung: ${poll.title}`;
  const text =
    `Du hast noch nicht abgestimmt bei "${poll.title}".\n\n` +
    `Vorgeschlagene Termine:\n- ${dateList}\n\n` +
    `Hier abstimmen: ${pollLinkText(poll.id)}`;
  await Promise.all(pending.map(e => sendMail(e, subject, text)));

  res.json({ ok: true, sent: pending.length });
});

// Umfrage abschließen: finalen Termin festlegen und alle informieren
app.post('/api/polls/:id/finalize', async (req, res) => {
  const poll = db.polls[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Umfrage nicht gefunden' });
  const { optionId } = req.body || {};
  const option = poll.options.find(o => o.id === optionId);
  if (!option) return res.status(400).json({ error: 'Unbekannte optionId' });

  poll.finalizedOptionId = optionId;
  saveData();

  const finalText = fmtOption(option);
  if (poll.notify.email) {
    const votedEmails = Object.values(db.votes[poll.id] || {}).map(v => v.email).filter(Boolean);
    const allEmails = Array.from(new Set([...poll.emails, ...votedEmails]));
    const subject = `Termin steht fest: ${poll.title}`;
    const text = `Der finale Termin für "${poll.title}" ist:\n\n${finalText}\n\nBis dahin!`;
    await Promise.all(allEmails.map(e => sendMail(e, subject, text)));
  }
  if (poll.notify.teams) {
    await postToTeams(poll.teamsWebhookUrl, `✅ Termin für **${poll.title}** steht fest: ${finalText}`);
  }
  broadcast(poll.id, 'finalized', { optionId });

  res.json({ ok: true });
});

// Server-Sent Events: Live-Updates für eine einzelne Umfrage
app.get('/api/polls/:id/stream', (req, res) => {
  const pollId = req.params.id;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  res.write(': connected\n\n');

  if (!sseClients.has(pollId)) sseClients.set(pollId, new Set());
  sseClients.get(pollId).add(res);

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.get(pollId)?.delete(res);
  });
});

// Alle sonstigen Pfade (z.B. /A1B2C3) liefern die Weboberfläche aus,
// die dann selbst anhand der URL den Umfrage-Code erkennt.
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Terminfinder-Backend läuft auf Port ${PORT}`);
  if (!mailer) console.warn('Hinweis: Kein SMTP konfiguriert -- E-Mails werden nur geloggt, nicht versendet.');
  if (!TEAMS_WEBHOOK_URL) console.warn('Hinweis: Kein globaler TEAMS_WEBHOOK_URL gesetzt -- Teams-Meldungen werden übersprungen, sofern nicht pro Umfrage angegeben.');
});
