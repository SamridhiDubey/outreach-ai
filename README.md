# OutreachAI

A Chrome extension that generates personalized LinkedIn DMs using your resume and Claude AI.

## What it does

- Reads the LinkedIn profile you're viewing (supports LinkedIn's 2024+ DOM layout)
- Combines it with your resume or job description
- Generates a short, personalized outreach message via Claude
- Supports **Job Seeker** and **Recruiter** modes
- Supports **Connect** and **Referral** outreach goals
- Inserts the message directly into LinkedIn's compose box

## Tech Stack

| Part | Tech |
|---|---|
| Chrome Extension | Manifest V3, Vanilla JS |
| Backend | Node.js + Express, deployed on Vercel |
| AI | Anthropic Claude (`claude-sonnet-4-6`) |
| Analytics | Supabase (anonymous usage tracking) |
| Notifications | Discord webhooks (milestones + weekly summary) |

## Project Structure

```
outreach-app/
├── apps/
│   ├── extension/              # Chrome extension
│   │   ├── manifest.json
│   │   ├── background.js       # Service worker — calls backend
│   │   ├── content.js          # Reads LinkedIn profile from DOM
│   │   ├── popup.html          # Extension UI
│   │   ├── popup.js            # UI logic, resume upload, tone selector
│   │   ├── popup.css           # Dark theme UI
│   │   └── icons/
│   └── backend/                # Express API on Vercel
│       ├── src/
│       │   ├── index.js            # Routes + security middleware
│       │   ├── generateMessage.js  # Claude API call + prompt building
│       │   ├── extractPdf.js       # PDF text extraction
│       │   └── analytics.js        # Supabase logging + Discord notifications
│       ├── vercel.json
│       └── package.json
└── supabase-schema.sql         # Database schema
```

## Backend

Live at: `https://outreach-ai-backend.vercel.app`

## Environment Variables (Vercel)

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Supabase service role key |
| `DISCORD_WEBHOOK_URL` | Discord webhook for notifications |
| `EXTENSION_SECRET` | Shared secret between extension and backend |
| `CRON_SECRET` | Secret for the weekly summary cron endpoint |
| `ALLOWED_ORIGIN` | Allowed CORS origin (Chrome extension ID) |

## Security

- `x-extension-token` header required on all `/generate` requests — blocks random API abuse
- Rate limited: 60 req/min globally, 10 req/min on `/generate`
- All input sanitised and length-capped before reaching Claude
- UUID validation on userId
- CORS locked to extension origin in production

## Analytics

Every generation is logged anonymously to Supabase. `user_id` is a random UUID stored in `chrome.storage.local` — no PII collected.

Discord notifications fire at **10 / 50 / 100 / 500 / 1000 unique users**.

Weekly summary posts every **Monday at 9am** with user counts, generation stats, and a monetization signal.

## Supabase Schema

```sql
create table events (
  id         bigserial primary key,
  user_id    text        not null,
  tone       text,
  success    boolean     not null default true,
  created_at timestamptz not null default now()
);

create table milestones (
  id         bigserial primary key,
  name       text        not null unique,
  created_at timestamptz not null default now()
);
```

## Local Development

```bash
cd apps/backend
cp .env.example .env   # fill in your keys
npm install
npm run dev            # runs on http://localhost:3001
```

Load the extension: Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `apps/extension/`

## Deploy

```bash
cd apps/backend
vercel --prod
```

## Extension Features

- **Job Seeker mode** — upload your resume (PDF/TXT), pick Connect or Referral goal, add extra context
- **Recruiter mode** — paste job URL, upload JD, or type it manually
- **Tone selector** — Friendly / Professional / Direct
- **Recipient-aware prompts** — different messaging for HR, Leaders, Managers, ICs
- **Auto-insert** — clicks Message button and inserts generated text into the compose box

## LinkedIn DOM Compatibility

The content script supports both LinkedIn's classic layout and the 2024+ redesign:
- Name extracted from `document.title` as primary fallback
- Profile card data from `section[1]` when h2-name match fails
- Experience extracted via three-pass strategy (artdeco list → section h2 → heading scan)
- Broader location pattern matching (India, USA, UK, Canada, Germany, Australia, France, Singapore, Remote)

## Future Plans

- Publish to Chrome Web Store
- Freemium limit (20 generations/month free, $6/month unlimited)
- Pricing page
