# Keeping the conversation on the right step

Aria interprets replies against a pending question: accepting an offer, redeeming points, confirming closure, or choosing between lost-card help and permanent account closure. `src/dialogue.mjs` owns that interpretation; account services still authorize every simulated change.

For example, after the points prompt, “haa kardo fir redeem” redeems the remaining demo points and moves to the separate closure confirmation. It cannot confirm account closure. A repeat of that redemption request reports the completed redemption without doing it twice. Hindi, Hinglish and English variants share the same transition. A question such as “mere kitne points hai” reads the balance and leaves the pending choice intact.

Negatives, hypothetical questions, conditional requests and partial redemption requests receive their own handling. The demo supports full-balance redemption, so a request for only some points receives an explanation before any action. A bare yes after an unrelated factual detour brings the pending question back for review. Final closure retains its token, snapshot, expiry and voice-confidence gates.

## Lost cards need a different conversation

“I want to close my card because it got lost” suspends retention and presents two distinct choices: simulated lost-card support, or permanent account closure. A yes alone cannot choose between them. A direct request to block the lost card saves a simulated `card_security` case. It never claims that a real card was blocked, a replacement ordered, or a real colleague connected. An explicit request to continue permanent closure goes to the closure checklist without another retention pitch.

Urgent issuer-contact guidance is available before demo identification; account data remains inaccessible until the matching profile is confirmed. Any outstanding closure token is invalidated when the lost-card concern interrupts the journey. A correction that the card was found restores the earlier discussion without applying an offer or submitting closure.

The distinction follows the issuer-contact guidance in the [RBI card FAQ](https://www.rbi.org.in/scripts/FS_FAQs.aspx?Id=75) and [SBI Card lost/stolen-card FAQ](https://www.sbicard.com/en/faq/lost-stolen-reissue-replace-cards.page). These references do not turn the demo into a bank integration or authorize real card actions.

## Understanding unfamiliar wording

The Ollama fallback receives the current state, pending action, last assistant question and a short redacted conversation excerpt. It returns an enum suggestion, never financial terms or free-form banking answers. A suggested redemption request is phrased as a clarification and needs the caller to confirm that meaning before redemption. The fallback cannot accept an offer, verify identity or submit closure. It remains disabled during final closure confirmation.

Repeated unresolved prompts receive a targeted repair. Requests such as “you keep repeating” explain the current step rather than replaying the previous line. Questions continue to use the matched session snapshot and policy disclosures; unsupported cash conversions, guarantees or bank capabilities are stated as unavailable.

`tests/dialogue.test.mjs` covers these turns and their negative cases. Transport tests also feed the reported phrase through the speech-recognition callback and check that the final voice confirmation gate remains intact. These checks reduce specific failure modes; ambiguous or unsupported requests still require clarification.

`scripts/redemption-voice-smoke.mjs` checks the real speech round trip using a synthetic Hindi recording of “हाँ कर दो फिर रिडीम”. It synthesizes the phrase, streams it to the running app’s recognizer, and checks that only redemption advances. It accepts the Sarvam key as JSON on hidden stdin, creates a synthetic Sameer session and consumes provider quota; it never stores the key or uses a private microphone recording.

The current Render Free deployment uses ephemeral storage, as chosen for this demo. Saved profiles, sessions and conversation context survive within the running instance; they are lost on restart or redeploy.
