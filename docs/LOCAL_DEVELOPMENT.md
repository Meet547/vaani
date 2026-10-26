# Local development and implementation reference

This is the **synthetic-customer demo** requested in this chat. It implements the supplied rulebook as executable policy, with a browser chat/voice interface, simulated banking services, persisted sessions and an audit trail. It does **not** perform real banking actions, send messages, pull a credit report, or connect a real human.

## Project directory

Use the root of your cloned `vaani` repository for the commands below.

For local development, open **http://localhost:4317**. For the hosted setup, use [DEPLOYMENT.md](DEPLOYMENT.md).

Use this HTTP address in your browser. Opening `public/index.html` directly as a `file://` URL will not load the app correctly: its styles, scripts, session API and voice connection require the local server. If the browser says “connection refused,” restart the server using the instructions below and keep that terminal open.

| File or directory | Purpose |
| --- | --- |
| `docs/source/card_closure_rulebook.md` | Unchanged copy of your rulebook |
| `docs/source/card_retention_agent_voice_chat.md` | Unchanged copy of your chat/voice specification |
| `docs/source/aria-original-prompt.txt` | Original Aria personality brief, preserved for reference |
| `config/negotiation/card.yaml` | Offer budgets, caps, review targets, prohibited phrases and voice-confirmation threshold |
| `config/policy/card_tiers.yaml` | Tier thresholds and per-tier caps |
| `config/negotiation/card_closure.yaml` | Demo business calendar, deadlines and confirmation expiry |
| `config/datasets/bombaybank_card_gold_synthetic_250.csv` | Active, unchanged copy of the 250-profile synthetic dataset |
| `lib/customer-data.mjs` | Validated CSV import, profile directory and card fact mapping |
| `config/customers.yaml` | Original four fixtures, retained for explicit regression tests only |
| `services/card/disclosures.yaml` | Demo disclosures and cancellation/reporting wording |
| `config/runtime.yaml` | Local transport limits, timeouts and deadline scan interval |
| `lib/engine.mjs` | Conversation state machine and approved English/Hindi response templates |
| `lib/card-services.mjs` | Whitelisted simulated services, confirmation checks and transactional actions |
| `lib/intents.mjs` | Deterministic intent and counter classification |
| `lib/policy.mjs` | Configuration validation, metrics, tiers, offer gates and business-day calculation |
| `lib/store.mjs` | SQLite schema, transactions, session access and audit hash chain |
| `lib/providers.mjs` | Ollama intent fallback and Sarvam speech integrations |
| `server.mjs` | HTTP/WebSocket transport, origin checks, rate limits and shutdown |
| `public/` | Browser interface, PCM playback and microphone worklet |
| `data/aria.sqlite` | Runtime SQLite database; excluded from Git |
| `artifacts/aria-backup.wav` | Thirty-second, generated synthetic voice excerpt |
| `tests/` | Automated policy, service, audio, persistence and transport checks |
| `docs/DEMO_GUIDE.md` | Scenario walkthroughs and acceptance checks |
| `docs/IMPLEMENTATION_NOTES.md` | Resolved specification ambiguities and deliberate demo boundaries |
| `docs/CSV_INTEGRATION.md` | Dataset mapping, read-only gold scope, balance conflicts and update instructions |

The source Markdown files are references. Changing executable policy means editing the relevant YAML or engine code, running tests, and restarting the server.

## Start or restart

Tested on Node.js **24.1.0**. Requires Node.js **22.13 or later**.

```sh
cd vaani
npm ci
npm run dev:secure
```

Enter the Sarvam and Ollama keys at the **hidden terminal prompts**. Keys remain in the server process environment/memory and are not written to project files. Keep the terminal running. Restarting requires entering the keys again.

Alternatively, provide `SARVAM_API_KEY` and `OLLAMA_API_KEY` through your shell's environment and run `npm run dev`. `.env.example` documents optional overrides without credentials. The existing `npm run dev` command can also read an ignored local `.env` if you independently choose that credential-management method.

For an offline policy/UI demonstration, run `npm run dev` without keys. **Chat and all simulated policy flows still work.** Live voice requires Sarvam; semantic intent fallback requires Ollama. The pre-generated audio excerpt is available under “Behind the voice & data.”

Node may print an experimental warning for its built-in SQLite module. The tested runtime supports the API; the warning is not a failed database connection.

## Using the demo

1. Search any of the 250 synthetic profiles by name, ID or city. Use the product/readiness filters, select a customer and an entry path. Gold-only profiles, 10 conflicting-balance records and 2 non-active cards are read-only; 148 profiles can start card demos.
2. Select **New demo session**, type a message, or select **Start conversation** for microphone input.
3. For voice, allow browser microphone permission. Headphones reduce echo.
4. The offer/checklist panel exposes explicit accept, decline, skip and closure-confirmation buttons.
5. Open **Behind the decision** to inspect state, tier, metrics, offer counters, service calls, audit events, simulated cases and deadline alerts.
6. **Clear view** disconnects and clears the displayed transcript. It does not delete the saved session. **Resume saved session** restores the most recent browser session after a refresh or server restart.
7. Changing the customer or trigger disconnects the old conversation. **New demo session** creates an independent synthetic scenario; it does not modify a real or shared customer account.

The state named `CLOSED` means the **demo closure journey was submitted**. The actual request status remains `submitted` or `pending_dues`; the UI never represents that as a completed real account closure.

## Controls enforced outside the model

- At most one initial retention offer, one improvement after a counter, and one reason question.
- Firm/repeated closure and declined offers permanently disable further retention offers in that session.
- Amounts, points, conditions, references and dates come from policy/service results and pure formatters. The model never writes financial terms or authorizes actions.
- Eligibility is recomputed when accepting an offer; unsupported IDs or changed terms are rejected.
- Fraud, disputes, harassment and human requests use simulated case queues.
- Dues and EMIs do not prevent recording a closure request. EMI amounts are included in total dues, not added twice.
- Explicit final **yes** or the correct confirm button is required. Confirmation tokens bind to session, card facts, policy version and expiry. Duplicate submission returns the existing reference.
- Generic acknowledgments such as “that works” do not confirm closure.
- Saaras realtime does not supply transcript confidence. Voice confirmation therefore re-confirms once and, if confidence is still unavailable, requires the on-screen button. Language-detection confidence is never used as a substitute.
- Consent/DND checks precede proactive outreach. Bureau-dependent checks are skipped without consent.
- Deadline scans produce local audit/UI alerts; overdue simulated review cases escalate without automatic approval.

## Voice behavior

Recognition uses **Saaras v4** at 16 kHz. Synthesis uses **Bulbul v4 Flash** at 24 kHz, with Simran's English/Hindi customer-care persona by default. Ishita expressive and Shalini calm are alternatives. Pace is adjustable before a session.

The browser uses echo cancellation, noise suppression, a stateful microphone resampler and scheduled PCM playback. Sustained local speech or a provider speech-start event interrupts queued audio and aborts the old generation. Turn IDs discard stale audio. Two gentle silence prompts are allowed, but not while muted or after terminal states.

**Gemma 4 31B** classifies unfamiliar masked wording when deterministic rules do not recognize it. A bounded enum validator prevents it from issuing actions or accepting confirmations. Classifier failure falls back to a clarification. All banking responses use reviewed templates with service facts, so unsafe content cannot be streamed before a validator checks it.

## Data and access

- Local mode binds to `127.0.0.1`. `DEPLOYMENT_TARGET=render` enables public hosting with exact frontend origins, secure session cookies and one-use voice tickets. Live banking mode remains disabled.
- A random, HttpOnly, SameSite=Strict cookie grants access to one synthetic session. This is demo-session isolation, **not bank customer authentication**.
- Cookie access secrets are hashed in SQLite. API keys are never returned by the browser API or stored in the database.
- Database directory/file permissions are restricted. SQLite is plaintext and should contain **synthetic data only**.
- Known card-number, phone-number, PAN, email and credential patterns are masked before transcript storage, audit or model classification. This pattern masker is not a universal PII detection guarantee.
- Audio is streamed to Sarvam and is not recorded. The backup clip is generated speech, not a customer recording. Provider retention policies apply.
- SQLite retains masked demo transcripts, confirmations, simulated actions/cases and audit records. Session access expires after the configured duration; expiry does not automatically delete the database.
- UI snapshots show the most recent 100 messages and 100 audit entries (the inspector renders the latest 35). The complete audit remains in SQLite.
- Hash chaining detects local record alteration and a failed integrity check blocks further session mutation. It is not externally anchored or a legally immutable audit system.

To reset all demo data, stop the server, back up anything you want to retain, and remove `data/aria.sqlite` and its `-wal`/`-shm` companions. The app creates a new database on restart.

## Checks

```sh
npm run check
npm test
npm run data:validate
# These require the configured local server and consume provider quota:
node scripts/smoke.mjs
node scripts/classifier-smoke.mjs
node scripts/voice-smoke.mjs /path/to/synthetic-16k-mono.wav
# Rebuild the backup clip:
node scripts/backup-clip.mjs
```

`npm test` uses isolated databases and temporary localhost servers; it needs permission to bind loopback ports. It does not use live provider credentials or modify your demo database. Live smoke scripts intentionally create independent synthetic sessions.

A real microphone audition remains the final subjective check for pacing, room acoustics, echo suppression and back-channel handling. Tested behavior is documented in `docs/DEMO_GUIDE.md`; no software or speech provider can be guaranteed to work perfectly under every device or network condition.

## Boundary of this deliverable

This is a hardened **local demonstration**, as you confirmed. All bank-policy numbers remain placeholders from your rulebook. Identity verification, account changes, point redemption, human review and notifications are simulated. No RBI/compliance approval is asserted. Marathi, telephony, a real banking database, real customer authentication and live human-queue/SMS integration are outside this demo. Setting `APP_MODE=production` fails closed rather than exposing mock services as live banking.
