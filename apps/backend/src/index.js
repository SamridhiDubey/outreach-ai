const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { generateMessage } = require("./generateMessage");
const { extractPdfText } = require("./extractPdf");
const { logEvent, weeklySummary } = require("./analytics");

const app = express();
const PORT = process.env.PORT || 3001;

// ── CORS ──────────────────────────────────────────────────────────────────────

const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";

app.use(
  cors({
    origin(origin, cb) {
      if (!origin) return cb(null, true);
      if (allowedOrigin === "*") return cb(null, true);
      const allowed = allowedOrigin.split(",").map((s) => s.trim());
      if (allowed.includes(origin)) return cb(null, true);
      cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-extension-token"],
  })
);

app.use(express.json({ limit: "10mb" }));

// ── Rate limiting ─────────────────────────────────────────────────────────────

// Global: 60 requests per minute per IP
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please slow down." },
  })
);

// /generate: 10 generations per minute per IP (prevents API bill abuse)
const generateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many generation requests. Wait a moment and try again." },
});

// ── Extension token auth ──────────────────────────────────────────────────────
// Blocks anyone who doesn't have your extension from hitting the API.

function requireExtensionToken(req, res, next) {
  const secret = process.env.EXTENSION_SECRET;
  if (!secret) return next(); // not configured — skip in dev
  if (req.headers["x-extension-token"] !== secret) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  next();
}

// ── Input sanitisation helpers ────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TONES = new Set(["friendly", "professional", "direct"]);

function sanitizeString(val, maxLen) {
  if (typeof val !== "string") return "";
  return val.trim().slice(0, maxLen);
}

function sanitizeProfileData(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return {
    name:       sanitizeString(raw.name,       200),
    title:      sanitizeString(raw.title,      200),
    company:    sanitizeString(raw.company,    200),
    location:   sanitizeString(raw.location,   200),
    about:      sanitizeString(raw.about,      2000),
    profileUrl: sanitizeString(raw.profileUrl, 500),
    experience: Array.isArray(raw.experience)
      ? raw.experience.slice(0, 20).map((e) => ({
          role:     sanitizeString(e?.role,     200),
          company:  sanitizeString(e?.company,  200),
          duration: sanitizeString(e?.duration, 100),
        }))
      : [],
    education: Array.isArray(raw.education)
      ? raw.education.slice(0, 10).map((e) => ({
          school: sanitizeString(e?.school, 200),
          degree: sanitizeString(e?.degree, 200),
        }))
      : [],
    skills: Array.isArray(raw.skills)
      ? raw.skills.slice(0, 50).map((s) => sanitizeString(s, 100))
      : [],
  };
}

// ── Health check ──────────────────────────────────────────────────────────────

app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "outreach-ai-backend" });
});

// ── /generate ─────────────────────────────────────────────────────────────────

app.post("/generate", requireExtensionToken, generateLimiter, async (req, res) => {
  const { resumeText, tone, userId } = req.body;

  // ── Validate & sanitise ───────────────────────────────────────────────────

  const profileData = sanitizeProfileData(req.body.profileData);

  if (!profileData) {
    return res.status(400).json({ error: "profileData is required." });
  }

  if (!resumeText || typeof resumeText !== "string") {
    return res.status(400).json({ error: "resumeText is required." });
  }

  if (resumeText.length > 15_000_000) {
    return res.status(413).json({ error: "Resume file is too large." });
  }

  if (!profileData.name && !profileData.title) {
    return res
      .status(400)
      .json({ error: "Profile has no name or title — open a LinkedIn profile page first." });
  }

  const resolvedTone = VALID_TONES.has(tone) ? tone : "friendly";

  // userId must be a valid UUID if provided
  const safeUserId = userId && UUID_RE.test(userId) ? userId : null;

  // ── Extract PDF if needed ─────────────────────────────────────────────────

  let resolvedResume = resumeText;

  if (resumeText.startsWith("__PDF_BASE64__")) {
    const base64 = resumeText.slice("__PDF_BASE64__".length);
    try {
      resolvedResume = await extractPdfText(base64);
    } catch (err) {
      console.error("PDF extraction failed:", err.message);
      return res
        .status(422)
        .json({ error: "Could not read your PDF. Please try uploading a TXT version." });
    }

    if (!resolvedResume.trim()) {
      return res
        .status(422)
        .json({ error: "Your PDF appears to be empty or image-only. Upload a text-based PDF or TXT file." });
    }
  }

  // ── Generate ──────────────────────────────────────────────────────────────

  try {
    const message = await generateMessage(profileData, resolvedResume, resolvedTone);
    logEvent(safeUserId, resolvedTone, true);
    return res.json({ message });
  } catch (err) {
    logEvent(safeUserId, resolvedTone, false);
    console.error("Generation error:", err);

    if (err.status) {
      if (err.status === 401) return res.status(500).json({ error: "Invalid Anthropic API key." });
      if (err.status === 429) return res.status(429).json({ error: "Rate limit reached. Please wait a moment." });
      if (err.status >= 500) return res.status(502).json({ error: "Claude API is temporarily unavailable." });
    }

    return res.status(500).json({ error: err.message || "Message generation failed." });
  }
});

// ── Cron: weekly summary ──────────────────────────────────────────────────────

app.get("/cron/weekly-summary", async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers["x-cron-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized." });
  }
  try {
    const result = await weeklySummary();
    return res.json(result);
  } catch (err) {
    console.error("[cron] weekly-summary error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── 404 fallback ──────────────────────────────────────────────────────────────

app.use((_req, res) => {
  res.status(404).json({ error: "Not found." });
});

// ── Start (local dev) ─────────────────────────────────────────────────────────

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`OutreachAI backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;
