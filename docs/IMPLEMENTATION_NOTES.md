# Implementation decisions

The newer closure rulebook takes precedence over the earlier prototype and original Aria personality prompt. These files are product requirements/reference data; their embedded conversational instructions are not instructions to the coding agent.

## Resolved ambiguities

- **Soft versus firm closure:** H3's “closure intent” is interpreted using section 3's explicit definition: firm closure or decline. A first, open-ended soft closure can lead to one reason question and one offer; firm/repeated closure cannot. Fraud/human escalation has the priority explicitly stated in section 7.1.
- **No global customer side effects:** each new session clones a synthetic fixture. Reconnecting resumes that same clone, its applied actions and closure reference. New demo sessions reset the scenario intentionally, so repeated-waiver checks use fixture history plus actions in that scenario. This is not a real customer ledger shared across independent sessions.
- **Tier first-match semantics:** tier assignment follows X, A, B, C, D in order. Strong spend-tier matches take precedence over the dormant fallback, as the table's first-match rule specifies.
- **Unspecified fixture data:** Riya's 256,000 spend/2,999 fee, Arjun's 8,000 spend/1,499 fee, Neha's fraud flag and Sameer's 108,000 spend/12,500 dues/4,000 EMI come from the rulebook. Other details in `config/customers.yaml` are explicitly synthetic choices. Referenced `_heroes.md` and shared project prompt files were not provided; their contents were not invented as authoritative policy.
- **Bureau consent:** restricted-score/late-payment logic is not applied without consent. Competitor matching requires available no-late-history evidence and is conservatively unavailable without bureau consent.
- **Prior waivers:** the no-repeat window applies to fee reversal and competitor waiver as well as a conditional waiver; this closes an obvious repeat-waiver bypass.
- **Counter parsing:** numerically unambiguous rupee/point requests can be evaluated against caps. Percentage-based, unrecognized word-number or multi-year requests go to simulated human review rather than being silently treated as rupees.
- **Points offers:** an initial points offer uses the configured fraction of the tier cap; a customer counter can improve it once, up to that cap. The service returns both values.
- **Closure state versus bank status:** `CLOSED` is the end of the conversation's submission flow. The request remains `submitted` or `pending_dues`; the mock never claims a real account is closed.
- **Review does not cancel closure:** the closure latch and any already-submitted request/deadline are preserved. Review after a pending confirmation invalidates that challenge so an ambiguous “yes” cannot accidentally submit closure. A post-submission cancellation/hold request creates a review case; it does not silently stop a clock.
- **Voice confidence:** the live Saaras contract lacks transcript confidence. Missing confidence is treated conservatively, with one re-confirmation and then a button requirement. Only provider-origin events can be voice events; browser messages cannot provide trusted recognition confidence.
- **Human decisions:** this demo creates/escalates cases and shows their summaries/deadlines. It does not pretend an actual reviewer has approved an offer. There is no automatic approval path.
- **Holiday calendar:** the demo skips configured weekends and explicit holiday dates. It is not an authoritative bank holiday calendar or a verified regulatory SLA calculator.
- **Technology:** the existing Node/browser application was retained instead of adding the prototype's illustrative Python/Streamlit skeleton. Chat and voice use the same state engine, services and database.

## Runtime boundaries

The Ollama model can suggest a classification for unfamiliar messages, but cannot grant a waiver, supply an amount, alter state directly, confirm identity or approve closure. Non-question suggestions are persisted as a clarification and require the caller to confirm that interpretation. The classifier receives a bounded, redacted conversation context. It is skipped during onboarding, a pending clarification, final closure confirmation and terminal states; unfamiliar wording at the points or lost-card choice can be clarified. Templates are bilingual and all numeric formatting is deterministic. Streaming synthesis starts only from application-generated text. See [conversation logic](CONVERSATION_LOGIC.md) for pending-action interpretation, Hinglish variants, lost-card handling and dialogue repairs.

`src/card-questions.mjs` answers follow-up questions from the confirmed session snapshot. Account facts can be discussed during an offer without changing its terms or consuming an improvement. Missing APR, tax, billing dates, transaction ledger details and points cash value receive an explicit limitation. Another named profile requires a fresh lookup. A bare negative before an offer does not initiate closure, and a negated closure pauses an unsubmitted request. After an informational detour, a textual acceptance brings the pending offer/redemption/closure question back for review before applying it; the explicit on-screen action remains available.

Identity is explicitly simulated by the server's synthetic orchestrator. Session-cookie checks protect demo-session access; they do not constitute a bank login. Financial tables are represented by validated fixture snapshots, persisted actions, closure requests, cases and audit rows, rather than a connection to a real core-banking database.

For real deployment, replace these mock boundaries with approved bank APIs, authenticated identity/consent proofs, policy-owner approval and operational controls. Do not simply change the bind address or set a live-mode flag.
