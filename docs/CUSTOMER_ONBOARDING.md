# Greeting, lookup and new profiles

Normal conversation is the default. A new browser visit does not resume an old offer or select the first CSV account. Resuming a saved conversation remains an explicit choice. The preselected-customer workflow is available under the separate scenario mode for policy testing.

The conversational journey is:

1. Greet and ask for a name. No account service is called yet.
2. Search the source directory and saved synthetic profiles. Matching ignores case and punctuation; first names may produce multiple candidates. The assistant asks for a full name/city or an explicit choice instead of guessing.
3. Confirm the matched profile. Only then attach a card snapshot and read card services. This is a demo lookup, not real authentication.
4. Check the saved issue against the caller's current intent. A current request takes precedence. A saved fee issue does not authorize an offer until the caller confirms it or raises the issue themselves. A saved firm closure proceeds to the checklist without another retention pitch once confirmed.
5. Route fraud records directly to the existing simulated fraud flow after the correct record is confirmed. Gold-only, invalid and unlinked records stay outside card negotiation.

If no match exists, the assistant asks whether to create a synthetic profile. It collects the full name, optional city and an enquiry of up to 500 characters. Known sensitive patterns in the enquiry are masked. A review turn and explicit save confirmation precede the database write. Cancellation or incomplete onboarding creates no profile.

The `customer_profiles` table stores new profiles independently from the CSV. IDs use the `NEW-...` prefix. Repeated submission is idempotent; a profile with the same normalized name/city is reused rather than overwriting its enquiry. A saved profile is searchable after refresh and server restart. It contains no artificial fee, balance, credit score, tenure, card product or eligibility. Linking a validated account is a separate integration step.

`lib/customer-journey.mjs` owns the onboarding states; `lib/engine.mjs` keeps the financial policy transitions. The model classifier is skipped during identity, registration and saved-context review. Neither source `EXP_*` labels nor source response/confirmation fields become live instructions. Name introductions that already include a current closure request preserve that request until identification is complete.

SQLite schema version 2 adds the profiles table with `CREATE TABLE IF NOT EXISTS`. Existing sessions, confirmations and audit chains are preserved. Onboarding drafts live in their saved session, so a partially completed registration can resume too. The audit records profile creation and the source of a matched identity.

The browser defaults to a collapsed directory. Exploring profiles during a natural conversation does not switch the caller's identity. Scenario mode deliberately uses the selected customer/trigger. New profile controls and resume work in both offline chat and live voice sessions; voice-based card closure retains its separate strict confirmation checks.

Regression coverage includes repeated greetings, delayed account reads, ambiguous/rejected identity matches, natural “that's me” replies, source issue confirmation, issue changes, direct firm closure, fraud/data gates, reviewed registration, cancellation, replay, migration, restart recovery, and HTTP/WebSocket identity spoofing. Microphone recognition still depends on device and provider quality; the UI offers an explicit candidate choice when a name is ambiguous.
