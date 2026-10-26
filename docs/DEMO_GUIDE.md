# Demo and verification guide

CSV integration verification: **53 automated tests passed**. The original live text-to-speech, synthetic speech-to-text/barge-in, and Ollama fallback checks passed; the CSV browser walkthrough also received live speech. Browser testing confirmed the imported points step, a `pending_dues` closure, explicit submission, gold-only restrictions and invalid-balance restrictions. See `CSV_INTEGRATION.md` for the mapping and source data issues. The previous dependency audit reported 0 known vulnerabilities; this integration adds no dependency.

The default is **Talk naturally · find me by name**. Start with “Hello,” then “My name is Riya Deshmukh.” Confirm the match and decide whether the saved fee issue is relevant. “Hello” alone must never produce an offer. An unknown full name can enter the name/city/enquiry registration flow; nothing is saved until the review is confirmed.

For the scenario table below, choose **Test a selected customer scenario**, expand the profile settings, select a customer and choose **New scenario session**. Every run is synthetic. Use the buttons or type/speak the sample phrases.

| Scenario | Actions | Expected result |
| --- | --- | --- |
| Riya: retain | “The annual fee is too high.” → Accept demo offer | One conditional 2,999-rupee waiver with 30,000 spend over 12 months; written simulated confirmation |
| Riya: reversal request | Fee complaint → “Can you reverse the charged fee instead?” | No reversal: the CSV marks her fee as not recently charged; the engine must follow current eligibility |
| Riya: above authority | Fee complaint → “Can you waive two years?” | Simulated `credit_ops` case; no approval promise; closure remains available |
| Arjun: insist | “I want to close because I never use it.” → Decline & close → Skip points → Confirm simulated closure | Free downgrade is the only retention offer; closure proceeds without another pitch |
| Arjun: first firm request | “Just close my card. No offers.” | No reason question and no retention offer; checklist and confirmation only |
| Sameer: dues | Close the card → Skip or redeem 2,000 points → Confirm simulated closure | Request accepted with `pending_dues`, total dues 12,500 including EMI 4,000; reference and demo date saved |
| Neha: fraud | Select Neha and start | Immediate simulated fraud case, no offer |
| Human request | “Talk to a person.” | Simulated relationship-manager case, no claim of a live transfer |
| Proactive DND | Choose a CSV card profile showing DND enabled + Usage drop | Blocked before account/offer service calls; no outreach audio. Arjun's CSV DND flag is false |
| Voice confirmation | Sameer → firm closure → skip points → say “yes” twice | Re-confirm once; absent transcript confidence requires the confirm button |
| Restart/resume | Pause after an offer or confirmation → refresh/restart server → Resume saved session | State and transcript survive; pending confirmation receives a fresh challenge |

## Automated coverage

The suite exercises:

- hero tiers and exact annual-spend fixtures;
- cap/property matrices across fees, spend and scores;
- one-offer/one-improvement/one-reason limits over adversarial message sequences;
- closure latch, first-turn firm closure, Hindi/Hinglish imperatives and proactive closure;
- fee/points questions without unsolicited offers;
- service whitelist and altered terms;
- missing, tampered, expired, changed-fact, cross-session and wrong-purpose confirmations;
- explicit yes versus generic acknowledgments, and voice-confidence handling;
- duplicate submission and message replay;
- fraud/human, identity, bureau consent and DND gates;
- persistence after database reopening, cookie access hashing and audit integrity;
- overdue-review alerts without automatic approval;
- HTTP/WS origin/authentication and secret/static-file boundaries;
- client attempts to override identity/confidence;
- structured-model output parsing, including fenced JSON observed in the live API;
- fragmented WAV headers, PCM chunk boundaries and 44.1/48 kHz resampling phase.

## Live checks

`scripts/smoke.mjs` checks a real Sarvam voice response to a policy-controlled fee complaint. `scripts/voice-smoke.mjs` sends a synthetic, mono 16 kHz customer recording through the live speech recognizer, verifies its transcript and confirms interruption produces no stale audio. `scripts/classifier-smoke.mjs` verifies the real Ollama fallback on wording outside the deterministic patterns.

The browser walkthrough verifies typed input, streamed playback, explicit closure buttons, visible request references and persisted session recovery. The preview images in `artifacts/` document representative screens.

The backup WAV is a generated 30-second excerpt for a presentation if provider connectivity is unavailable. It is not a recording of a customer's microphone or a full call.

## Remaining subjective checks

Real microphone quality depends on the browser, device, room, headphones and network. Local barge-in uses a sustained-energy heuristic plus provider VAD and may mistake a long back-channel or background speech for an interruption. English and Hindi/Hinglish are implemented; Marathi is not presented as tested. Live-provider latency is an observation, not an SLA.
