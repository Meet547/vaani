# Security and data boundaries

Vaani is a publicly accessible **synthetic banking sandbox**. No login or shared access code is required. Never import actual customer accounts, private recordings or financial information.

Provider keys belong in server environment variables or local hidden prompts. Do not commit `.env` files, runtime databases, backups or private recordings. The frontend build contains no provider credentials.

Hosted mode requires exact frontend origins, secure session cookies and an absolute database path. Voice connections use session-bound, short-lived one-use tickets. These controls isolate demo sessions, **not real bank customer identities**. The app enforces offer/confirmation rules before streaming speech. The audit chain detects local alteration but is not externally anchored or a legally immutable record.

Because the public demo has no login gate, anonymous visitors can create synthetic sessions and potentially consume Sarvam/Ollama quota. Monitor provider usage, configure provider spending limits, and consider upstream traffic protection for any long-running public deployment.

Pattern-based masking is a best-effort guard for known identifiers; it does not make real personal or financial data safe to upload. Sarvam receives audio, and Ollama may receive masked messages for intent classification. Provider retention policies apply.

If you find a vulnerability, use GitHub's private vulnerability reporting for this repository if available, or contact the repository owner privately. Do not open a public issue containing credentials, transcripts, exploit tokens or private account information.

Before a real banking deployment, implement reviewed customer authentication, authorization, bank integrations, operational monitoring and a suitable shared storage design. This repository does not claim compliance certification.
