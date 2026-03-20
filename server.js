import express from "express";
import twilio from "twilio";
import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { ElevenLabsClient } from "elevenlabs";
import pkg from "pg";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const { Pool } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const VoiceResponse = twilio.twiml.VoiceResponse;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

// ─── PostgreSQL ───────────────────────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") || process.env.DATABASE_URL?.includes("amazonaws")
    ? { rejectUnauthorized: false }
    : false,
});

async function initDB() {
  console.log("DATABASE_URL is set:", !!process.env.DATABASE_URL);
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS favorites (
        number     TEXT PRIMARY KEY,
        name       TEXT NOT NULL DEFAULT '',
        added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS blocked_keywords (
        keyword    TEXT PRIMARY KEY,
        added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS calls (
        id          TEXT PRIMARY KEY,
        from_number TEXT NOT NULL,
        time        TEXT NOT NULL,
        duration    TEXT NOT NULL DEFAULT '0m 0s',
        status      TEXT NOT NULL DEFAULT 'voicemail',
        summary     TEXT NOT NULL DEFAULT '',
        turns       INT  NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS profile (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL DEFAULT ''
      );

      INSERT INTO blocked_keywords (keyword) VALUES
        ('insurance'), ('warranty'), ('loan offer'), ('free cruise'), ('limited time')
      ON CONFLICT DO NOTHING;
    `);
    console.log("Database tables ready");
  } catch (err) {
    console.error("initDB query failed — message:", err.message);
    console.error("initDB query failed — code:", err.code);
    if (err.detail) console.error("initDB query failed — detail:", err.detail);
    throw err;
  }
}

const callSessions = new Map();

const CONFIG = {
  yourRealNumber: process.env.YOUR_REAL_NUMBER ?? "",
  twilioNumber:   process.env.TWILIO_NUMBER    ?? "",
  voiceId:        process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM",
  maxTurns:       6,
  firstName:      "",
};

async function loadProfileFromDB() {
  const { rows } = await db.query("SELECT key, value FROM profile");
  for (const row of rows) {
    if (row.key === "firstName")      CONFIG.firstName      = row.value;
    if (row.key === "yourRealNumber") CONFIG.yourRealNumber = row.value;
    if (row.key === "twilioNumber")   CONFIG.twilioNumber   = row.value;
  }
}

function normalizeNumber(raw) {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return `+${digits}`;
}

async function isFavorite(fromNumber) {
  const { rows } = await db.query("SELECT 1 FROM favorites WHERE number = $1", [normalizeNumber(fromNumber)]);
  return rows.length > 0;
}

async function getFavorite(fromNumber) {
  const { rows } = await db.query("SELECT * FROM favorites WHERE number = $1", [normalizeNumber(fromNumber)]);
  return rows[0] ?? null;
}

async function containsBlockedKeyword(text) {
  const { rows } = await db.query("SELECT keyword FROM blocked_keywords");
  const lower = text.toLowerCase();
  for (const { keyword } of rows) {
    if (lower.includes(keyword)) return keyword;
  }
  return null;
}

function getSystemPrompt() {
  const name = CONFIG.firstName || "Richard";
  return `You are an AI phone assistant for ${name}. Your job is to answer the phone on their behalf.

Your behavior rules:
1. Be friendly, concise, and professional. Keep responses under 2 sentences.
2. Answer common questions: business hours, location, general inquiries.
3. Take messages: ask for name, callback number, and reason.
4. If caller says it's URGENT, PERSONAL, or mentions a specific emergency, say you will connect them and set action: FORWARD
5. If caller seems like spam or a robocall, set action: HANGUP
6. Once you have a complete message, set action: VOICEMAIL_TAKEN

Always respond in this JSON format:
{"speech": "What you say out loud", "action": "CONTINUE | FORWARD | HANGUP | VOICEMAIL_TAKEN", "notes": "Internal note"}`;
}

function buildTwiml(speechText, nextAction) {
  const twiml = new VoiceResponse();
  twiml.say({ voice: "Polly.Joanna-Neural" }, speechText);
  if (nextAction === "gather") {
    const gather = twiml.gather({ input: "speech", action: "/conversation", method: "POST", speechTimeout: "auto", speechModel: "phone_call", enhanced: true });
    gather.say({ voice: "Polly.Joanna-Neural" }, "I'm listening...");
    twiml.redirect("/conversation");
  }
  return twiml.toString();
}

async function runAI(callSid, newUserMessage) {
  const session = callSessions.get(callSid) ?? { history: [], turnCount: 0 };
  session.history.push({ role: "user", content: newUserMessage });
  session.turnCount++;
  const response = await anthropic.messages.create({ model: "claude-sonnet-4-6", max_tokens: 300, system: getSystemPrompt(), messages: session.history });
  const rawText = response.content[0].text;
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { parsed = { speech: rawText, action: "CONTINUE" }; }
  session.history.push({ role: "assistant", content: rawText });
  callSessions.set(callSid, session);
  return { ...parsed, turnCount: session.turnCount };
}

async function saveCallToDB(callSid, from, status, summary, turns) {
  const time = new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  await db.query(
    `INSERT INTO calls (id, from_number, time, status, summary, turns) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO UPDATE SET status=$4, summary=$5, turns=$6`,
    [callSid, from, time, status, summary, turns]
  );
}

// ─── Twilio Routes ────────────────────────────────────────────────────────────

app.post("/incoming", async (req, res) => {
  const { CallSid, From, To } = req.body;
  console.log(`Incoming call from ${From} [${CallSid}]`);
  if (await isFavorite(From)) {
    const contact = await getFavorite(From);
    const twiml = new VoiceResponse();
    twiml.say({ voice: "Polly.Joanna-Neural" }, `Connecting you now${contact?.name ? `, ${contact.name}` : ""}.`);
    twiml.dial(CONFIG.yourRealNumber);
    await saveCallToDB(CallSid, From, "forwarded", "VIP caller — forwarded directly.", 0);
    return res.type("text/xml").send(twiml.toString());
  }
  callSessions.set(CallSid, { history: [], turnCount: 0, from: From, startTime: new Date() });
  const name = CONFIG.firstName || "the owner";
  res.type("text/xml").send(buildTwiml(`Hi! You've reached ${name}'s AI assistant. I can answer questions, take a message, or connect you if it's urgent. How can I help?`, "gather"));
});

app.post("/conversation", async (req, res) => {
  const { CallSid, SpeechResult, Confidence } = req.body;
  const session = callSessions.get(CallSid);
  if (!SpeechResult) return res.type("text/xml").send(buildTwiml("Sorry, I didn't catch that. Could you say that again?", "gather"));
  if (session?.turnCount >= CONFIG.maxTurns) {
    await saveCallToDB(CallSid, session.from, "voicemail", "Call ended — max turns reached.", session.turnCount);
    callSessions.delete(CallSid);
    return res.type("text/xml").send(buildTwiml("I'll have them give you a call back. Goodbye!", "hangup"));
  }
  const matchedKeyword = await containsBlockedKeyword(SpeechResult);
  if (matchedKeyword) {
    await saveCallToDB(CallSid, session?.from ?? "unknown", "blocked", `Blocked — said "${matchedKeyword}".`, session?.turnCount ?? 0);
    callSessions.delete(CallSid);
    const twiml = new VoiceResponse();
    twiml.say({ voice: "Polly.Joanna-Neural" }, "Sorry, we're not interested. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }
  const { speech, action, notes } = await runAI(CallSid, SpeechResult);
  const twiml = new VoiceResponse();
  if (action === "FORWARD") {
    twiml.say({ voice: "Polly.Joanna-Neural" }, speech);
    twiml.dial(CONFIG.yourRealNumber);
    await saveCallToDB(CallSid, session.from, "forwarded", notes ?? "Forwarded to owner.", session.turnCount);
    callSessions.delete(CallSid);
  } else if (action === "HANGUP" || action === "VOICEMAIL_TAKEN") {
    twiml.say({ voice: "Polly.Joanna-Neural" }, speech);
    twiml.hangup();
    await saveCallToDB(CallSid, session.from, "voicemail", notes ?? speech, session.turnCount);
    sendSmsNotification(session.from, notes ?? speech);
    callSessions.delete(CallSid);
  } else {
    twiml.say({ voice: "Polly.Joanna-Neural" }, speech);
    const gather = twiml.gather({ input: "speech", action: "/conversation", method: "POST", speechTimeout: "auto", speechModel: "phone_call", enhanced: true });
    gather.say({ voice: "Polly.Joanna-Neural" }, "");
  }
  res.type("text/xml").send(twiml.toString());
});

app.post("/status", (req, res) => {
  callSessions.delete(req.body.CallSid);
  res.sendStatus(200);
});

// ─── Calls API ────────────────────────────────────────────────────────────────

app.get("/calls", async (_, res) => {
  const { rows } = await db.query("SELECT * FROM calls ORDER BY created_at DESC LIMIT 100");
  res.json(rows);
});

app.delete("/calls/:id", async (req, res) => {
  await db.query("DELETE FROM calls WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// ─── Profile API ──────────────────────────────────────────────────────────────

app.get("/config/profile", async (_, res) => {
  const { rows } = await db.query("SELECT key, value FROM profile");
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  res.json(result);
});

app.post("/config/profile", async (req, res) => {
  const { firstName, myNumber, twilioNum } = req.body;
  const upsert = (key, val) => db.query(`INSERT INTO profile (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`, [key, val]);
  if (firstName !== undefined) { await upsert("firstName", firstName.trim());     CONFIG.firstName      = firstName.trim(); }
  if (myNumber  !== undefined) { await upsert("yourRealNumber", myNumber.trim()); CONFIG.yourRealNumber = myNumber.trim(); }
  if (twilioNum !== undefined) { await upsert("twilioNumber", twilioNum.trim());  CONFIG.twilioNumber   = twilioNum.trim(); }
  res.json({ ok: true });
});

// ─── Blocked Keywords API ─────────────────────────────────────────────────────

app.get("/config/blocked-keywords", async (_, res) => {
  const { rows } = await db.query("SELECT keyword FROM blocked_keywords ORDER BY added_at");
  res.json(rows.map(r => r.keyword));
});

app.post("/config/blocked-keywords", async (req, res) => {
  const kw = req.body.keyword?.trim().toLowerCase();
  if (!kw) return res.status(400).json({ error: "keyword is required" });
  await db.query("INSERT INTO blocked_keywords (keyword) VALUES ($1) ON CONFLICT DO NOTHING", [kw]);
  res.json({ ok: true, keyword: kw });
});

app.delete("/config/blocked-keywords/:keyword", async (req, res) => {
  const kw = decodeURIComponent(req.params.keyword).toLowerCase();
  const { rowCount } = await db.query("DELETE FROM blocked_keywords WHERE keyword=$1", [kw]);
  if (!rowCount) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, keyword: kw });
});

// ─── Favorites API ────────────────────────────────────────────────────────────

app.get("/favorites", async (_, res) => {
  const { rows } = await db.query("SELECT * FROM favorites ORDER BY added_at");
  res.json(rows);
});

app.post("/favorites", async (req, res) => {
  const { number, name } = req.body;
  if (!number) return res.status(400).json({ error: "number is required" });
  const normalized = normalizeNumber(number);
  await db.query(`INSERT INTO favorites (number,name) VALUES ($1,$2) ON CONFLICT (number) DO UPDATE SET name=$2`, [normalized, name ?? ""]);
  res.json({ ok: true, number: normalized, name });
});

app.delete("/favorites/:number", async (req, res) => {
  const normalized = normalizeNumber(decodeURIComponent(req.params.number));
  const { rowCount } = await db.query("DELETE FROM favorites WHERE number=$1", [normalized]);
  if (!rowCount) return res.status(404).json({ error: "not found" });
  res.json({ ok: true, number: normalized });
});

// ─── Health ───────────────────────────────────────────────────────────────────

app.get("/health", (_, res) => res.json({ status: "ok", activeCalls: callSessions.size }));

// ─── SMS helper ───────────────────────────────────────────────────────────────

async function sendSmsNotification(fromNumber, message) {
  if (!CONFIG.yourRealNumber || !process.env.TWILIO_ACCOUNT_SID) return;
  try {
    const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    await client.messages.create({ body: `New voicemail from ${fromNumber}:\n${message}`, from: CONFIG.twilioNumber, to: CONFIG.yourRealNumber });
  } catch (err) { console.error("SMS failed:", err.message); }
}

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;
initDB()
  .then(loadProfileFromDB)
  .then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)))
  .catch(err => { console.error("DB init failed:", err); process.exit(1); });
