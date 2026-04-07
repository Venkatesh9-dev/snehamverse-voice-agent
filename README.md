# SNEHAMVERSE Voice Agent 🎙️ v2.1
### Trilingual AI Receptionist — Hindi + Telugu + English
### Production Ready

Built by **Venkatesh Potti** | SNEHAMVERSE PRIVATE LIMITED | DPIIT: DIPP226707

---

## What's Fixed in v2.1

| Bug | Status |
|---|---|
| WhatsApp never sent (boolean flag bug) | ✅ Fixed |
| Double WhatsApp / double Sheets log on call end | ✅ Fixed (sessionEnded guard) |
| Call hangs open forever (no timeout) | ✅ Fixed (MAX_CALL_DURATION_SECONDS) |
| Silent caller never handled | ✅ Fixed (IDLE_TIMEOUT_SECONDS) |
| Deepgram crash if connection drops mid-call | ✅ Fixed (try/catch + auto-reconnect) |
| Booking JSON extraction broken by regex | ✅ Fixed (dedicated extraction from tagged output) |
| Google Sheets tab name hardcoded | ✅ Fixed (GOOGLE_SHEET_TAB_NAME env var) |
| language_code not sent to ElevenLabs correctly | ✅ Fixed (REST API, direct param) |
| No startup env validation | ✅ Fixed (checkEnv.js runs before server starts) |
| Greeting used process.env directly (stale at import) | ✅ Fixed (greeting is now a function) |

---

## What This Agent Does

- 📞 Answers every inbound call 24/7
- 🌐 Auto-detects and responds in **Hindi, Telugu, or English**
- 📅 Books appointments and captures caller details
- 💬 Sends **WhatsApp confirmation** to caller after booking
- 📊 Sends **call summary** to business owner on WhatsApp
- 📋 Logs every call to **Google Sheets** automatically
- 🔁 Handles **missed calls** — sends WhatsApp automatically
- 🚨 Transfers to **human** on emergency or request
- ⏱ Ends call after idle or max duration (no runaway costs)
- 🏢 Works for: **Clinics, Coaching, Real Estate, Colleges**

---

## Tech Stack

| Layer | Technology |
|---|---|
| Telephony | Twilio Voice + Media Streams |
| Speech-to-Text | Deepgram Nova-2 (multilingual) |
| AI Brain | Claude Haiku (Anthropic) |
| Text-to-Speech | ElevenLabs Turbo v2.5 |
| Session Storage | Upstash Redis |
| Call Logging | Google Sheets API |
| Deployment | Railway |

**Charge client: ₹12,000/month → Your cost: ~₹2,000/month → Margin: 83%**

---

## Folder Structure

```
snehamverse-voice-agent/
├── src/
│   ├── index.js                    # Server entry point
│   ├── config/
│   │   ├── languages.js            # Trilingual strings + detection
│   │   └── prompts.js              # Claude system prompts per business type
│   ├── handlers/
│   │   └── streamHandler.js        # Core audio pipeline (WebSocket)
│   ├── routes/
│   │   └── callRoutes.js           # Twilio webhook routes
│   ├── services/
│   │   ├── llmService.js           # Claude Haiku integration
│   │   ├── ttsService.js           # ElevenLabs TTS
│   │   ├── sessionManager.js       # Redis session state
│   │   └── notificationService.js  # WhatsApp + Google Sheets
│   └── utils/
│       ├── logger.js               # Winston logger
│       └── checkEnv.js             # Startup env validator
├── .env.example
├── .gitignore
├── package.json
└── railway.json
```

---

## Setup Guide

### Step 1 — Get API Keys

| Service | URL | Free Credit |
|---|---|---|
| Twilio | console.twilio.com | $15 |
| Deepgram | console.deepgram.com | $200 STT |
| Anthropic | console.anthropic.com | $5 |
| ElevenLabs | elevenlabs.io | 10K chars/mo |
| Upstash | upstash.com | Free forever |
| Google Cloud | console.cloud.google.com | Free Sheets API |

### Step 2 — Install

```bash
cd snehamverse-voice-agent
npm install
cp .env.example .env
# Fill in all values in .env
```

### Step 3 — Validate env

```bash
npm run test:env
# Will tell you exactly which keys are missing
```

### Step 4 — Local dev with ngrok

```bash
# Terminal 1
npm run dev

# Terminal 2
ngrok http 3000
# Copy https URL → set as BASE_URL in .env → restart server
```

### Step 5 — Configure Twilio

1. Twilio Console → Phone Numbers → Active Numbers → your number
2. Voice webhook: `https://YOUR_URL/call/incoming` (POST)
3. Status callback: `https://YOUR_URL/call/status` (POST)
4. Save → call your number

### Step 6 — Google Sheets Setup

1. console.cloud.google.com → New Project → Enable Google Sheets API
2. IAM → Service Accounts → Create → Download JSON key
3. Copy `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL` in .env
4. Copy `private_key` → `GOOGLE_PRIVATE_KEY` in .env
5. Create new Google Sheet → name first tab "Calls"
6. Share sheet with your service account email (Editor)
7. Copy Sheet ID from URL → `GOOGLE_SHEETS_ID` in .env

### Step 7 — Deploy to Railway

```bash
npm install -g @railway/cli
railway login
railway new
railway up
```

Add all env vars in Railway → Variables tab.
Update `BASE_URL` in Railway to your Railway URL.
Update Twilio webhooks to Railway URL.

---

## New Client Onboarding (30 minutes)

Change just 5 env vars per client:
```
BUSINESS_NAME=Dr. Sharma's Clinic
BUSINESS_TYPE=clinic
OWNER_WHATSAPP=+91XXXXXXXXXX
HUMAN_TRANSFER_NUMBER=+91XXXXXXXXXX
GOOGLE_SHEETS_ID=their_sheet_id
```

---

## Pricing Tiers

### Starter — ₹12,000/month
```
ENABLE_WHATSAPP_CONFIRMATION=true
ENABLE_SHEETS_LOGGING=true
ENABLE_OWNER_SUMMARY=true
ENABLE_MISSED_CALL_HANDLER=true
ENABLE_HUMAN_TRANSFER=true
```

### Growth — ₹20,000/month
Coming soon: CRM sync, Google Calendar booking

### Full Stack — ₹35,000/month
Coming soon: Analytics dashboard, voice cloning, multi-agent

---

## Cost Per Client (Monthly)

| Item | Cost |
|---|---|
| Twilio number + calls | ~₹1,100 |
| Deepgram STT | ~₹100 |
| Claude Haiku | ~₹50 |
| ElevenLabs | ~₹400 |
| Railway | ~₹400 |
| **Total** | **~₹2,050** |
| **You charge** | **₹12,000** |
| **Profit** | **₹9,950/client** |

**10 clients = ₹99,500/month**

---

Built by SNEHAMVERSE PRIVATE LIMITED
Venkatesh Potti | DPIIT: DIPP226707 | Siddipet, Telangana
