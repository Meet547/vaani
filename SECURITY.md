# Security and data boundaries

Vaani is a synthetic banking sandbox. Use fake accounts and conversations only. The demo access code is a shared invitation mechanism; it does not establish a bank customer's identity.

Provider keys belong in server environment variables or local hidden prompts. Do not commit `.env` files, runtime databases, backups, access codes, or private recordings. The frontend build contains no provider credentials.

Hosted mode requires explicit frontend origins, secure cookies, a demo access code and an absolute database path. Voice connections use short-lived one-use tickets. The code enforces offer/confirmation rules before speech is streamed. The audit chain detects local alteration but is not externally anchored or an immutable legal record.

Pattern-based masking is a best-effort guard for known identifiers; it does not make real personal or financial data safe to upload. Sarvam receives audio, and Ollama may receive masked messages for intent classification. Provider retention policies apply.

If you find a vulnerability, use GitHub's private vulnerability reporting for this repository if it is available, or contact the repository owner privately through an established channel. Please do not open a public issue containing credentials, transcripts, exploit tokens or private account information.

Before a real banking deployment, replace the simulated services and shared access code with reviewed authentication, authorization, bank integrations, operational monitoring and a suitable shared storage design. This repository does not claim compliance certification.
