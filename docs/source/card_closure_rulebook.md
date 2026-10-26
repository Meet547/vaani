# Credit Card Closure and Retention: Rulebook

**Scope:** the full decision structure for a credit card closure conversation: what the agent checks, how it decides, what it says, what limits apply and when a human decides.
**Consistent with:** `card_retention_agent_voice_chat.md`, `prompts/_common.md` section 9 and `prompts/_heroes.md` (action ids and caps).
**Status:** prototype. **Every number in this document is a placeholder** for the bank's credit and compliance policy. All of them live in YAML config, never in code. Confirm each before presenting it as real policy.

---

## 1. Hard rules (cannot be overridden by the model, a customer or a tier)

| # | Rule |
|---|---|
| H1 | A clear closure request is always honoured. The agent never refuses, delays, loops or hides the closure path. |
| H2 | At most **one** retention offer per session, plus **at most one improvement**, and only if the customer *counters* the offer. |
| H3 | After any closure intent (see section 3), **no further offer** is made, in any state, for any reason. |
| H4 | Offers come only from `get_retention_options`. The agent never names an amount, condition or approval the service did not return. |
| H5 | The agent never promises anything above its authority. It says a colleague will review. |
| H6 | Closure needs an explicit confirmation ("yes" or the confirm button) before submission. Voice with STT confidence below 0.7: re-confirm once. |
| H7 | Dues and EMIs never block a closure request. The request is accepted and completes once dues are cleared. |
| H8 | Fraud, unauthorised transaction, dispute or harassment goes to a human immediately, before any offer. |
| H9 | No pressure, no false urgency, no guilt, no claims about what the customer will "lose" beyond what the checklist states as fact. |
| H10 | Ask "why" at most once per session. |
| H11 | Every number spoken comes from a service output or the pure calculators, never from the model. |

---

## 2. Entry paths

| Path | Trigger | First message from the agent |
|---|---|---|
| **A. Customer asks to close** | `card_closure_request` | Acknowledge, verify identity if not yet done, then branch on intent strength (section 3) |
| **B. Proactive, low usage** | `usage_drop` (outbound, consent and DND checked by the router) | Light check-in. If the customer says everything is fine or not interested, end with no action |
| **C. Proactive, churn score** | `churn_score_high` (outbound) | Same as B, never mention a "churn score" |
| **D. Downgrade request** | `downgrade_request` | Honour it. Confirm and apply `CARD_DOWNGRADE_FREE` or the requested variant |
| **E. Continuing session** | `customer_message` | Next turn in the existing session |

---

## 3. Reading the customer's intent (every turn, before anything else)

Rule-based classifier first (including Hinglish such as "card band karo", "close kar do"), LLM classifier as fallback. The intent is written to the trace.

| Intent | Examples | Effect |
|---|---|---|
| `fraud_or_dispute` | "unauthorised transaction", "I did not make this", "someone is harassing me" | Immediate handoff (H8) |
| `human` | "talk to a person", "agent please" | Handoff to `relationship_manager` |
| `closure_firm` | "just close it", "don't want to discuss", "no offers", "close it now", the `close_card` button after an offer, or any repeat of the request | Straight to `CLOSURE_FLOW` (H3) |
| `closure_soft` | "I want to close my card", "thinking of closing", "I want to cancel" (first mention, no refusal of discussion) | Ask why once, then at most one offer |
| `reason_given` | "the fee is too high", "I never use it" | Classify reason (section 5) |
| `accept` | "yes that works", `accept_offer` | Apply the offer |
| `decline` | "no", "not interested", "I'd rather close", `decline_offer` | Treated as closure intent: go to `CLOSURE_FLOW` |
| `counter` | "can you waive two years?", "what about 5000 off?", "can you do better?" | Counter logic (section 8) |
| `question` | "what is the spend condition?" | Answer from facts, no new offer |
| `other` | anything else | Short clarifying reply, once |

**Closure-intent rule:** `closure_firm` or `decline` at any point means the next state is `CLOSURE_FLOW` and no offer follows. A `GUARDRAIL` trace entry `closure_never_blocked` is written when this overrides the model.

---

## 4. What the agent checks in the database

### 4.1 Raw data (read in `ANALYSE`, silently, before the first reply)

| Fact | Table and column | Used for |
|---|---|---|
| Card product, limit, status | `cards.product`, `credit_limit`, `status` | Eligibility of downgrades, idempotent closure |
| Annual fee and due date | `cards.annual_fee`, `fee_due_date` | Fee reason, waiver amount, reversal gate |
| Spend needed for conditional waiver | `cards.fee_waiver_spend` | Waiver terms |
| Reward points and tier | `cards.reward_points`, `tier` | Redemption offer, boost eligibility |
| Outstanding dues and EMI | `cards.outstanding_dues`, `emi_outstanding` | Closure checklist, `pending_dues` |
| Add-on cards | `cards.addon_cards` | Closure checklist |
| Tenure | `cards.opened_on`, `customers.tenure_months` | Tier, competitor-match gate |
| Transactions (12 months) | `card_transactions.txn_date`, `amount`, `category` | Annual spend, trend, category mix |
| Mandates | `card_mandates` | Closure reminders |
| Open tickets | `service_tickets.status`, `category` | Service-issue reason, fraud flag |
| Past retention actions | `card_retention_actions` (additive table) | No repeat waiver within 12 months |
| Consents and DND | `consents`, `customers.dnd` | Whether the bureau may be read, whether outreach is allowed |
| Bureau (only if `bureau_pull` consent is granted) | `bureau_snapshots.score`, `utilisation_pct`, `dpd_30_count`, `dpd_90_count` | Tier, competitor match |
| Other relationship | `accounts`, `loans` | Relationship value |

If bureau consent is missing the agent still works: it skips the bureau-dependent checks, assigns the tier from card data alone (conservatively) and writes a trace note `bureau_unavailable`.

### 4.2 Derived metrics (computed by code, shown in the trace)

| Metric | Definition |
|---|---|
| `annual_spend_12m` | Sum of transactions in the last 12 months (or annualised if the card is younger) |
| `spend_trend_pct` | (last 3 months minus previous 3 months) divided by previous 3 months |
| `fee_charged_recently` | Fee due date passed within the last 30 days (placeholder window) |
| `fee_to_spend_ratio` | `annual_fee` divided by `annual_spend_12m` |
| `dues_ratio` | `outstanding_dues` divided by `credit_limit` |
| `prior_waiver_12m` | A fee waiver or reversal in the last 12 months |
| `relationship_flag` | Has a salary or savings account, or another loan with us |

---

## 5. Why are they leaving? (reason codes)

The reason comes from the customer's words (rules first, model as a fallback) or from the data when proactive.

| Reason code | Customer says | Data hint |
|---|---|---|
| `fee` | "annual fee is too much" | Fee due soon or just charged, low spend |
| `not_using` | "I don't use it" | Spend near zero for 3 months or more |
| `low_rewards` | "rewards are poor" | Spend in categories without bonus |
| `competitor` | "another bank offered me a free card" | Customer states a rival offer |
| `service_issue` | "your support is bad", unresolved complaint | Open `service` ticket |
| `fraud` | handled by H8, not a retention reason | |
| `unknown` | gives no reason | Ask once, and if still unclear, offer the single best data-supported option or go straight to closure if the intent is firm |

---

## 6. Customer value tier and the limits it sets

The tier decides **how much the agent may give on its own**. It is computed by code from the data in section 4. It is never shown to or negotiated with the customer.

### 6.1 Tier assignment (first match wins)

| Tier | Name | Rule (placeholders) |
|---|---|---|
| **X** | Restricted | `dpd_90_count >= 1` or `score < 650` or open fraud ticket or card status not `active` |
| **A** | High value | `annual_spend_12m >= 300000` and `score >= 720` (or no bureau consent and `annual_spend_12m >= 400000`) |
| **B** | Core | `annual_spend_12m >= 120000` |
| **C** | Light | `annual_spend_12m >= 30000` |
| **D** | Dormant | below that, or `spend_trend_pct <= -80` for 3 months |

### 6.2 What each tier may be given **autonomously** (no human)

All amounts in rupees. These are the agent's maximum. Anything above goes to a human (section 8).

| Action (menu id) | A | B | C | D | X |
|---|---|---|---|---|---|
| `CARD_FEE_WAIVER_COND`: next annual fee waived, cap | up to 3,000, **no spend condition** | up to 3,000, condition: spend `fee_waiver_spend` next 12 months | up to 3,000, conditional, only if `fee_to_spend_ratio <= 0.05` | not offered (use downgrade) | not offered |
| `CARD_FEE_REVERSAL`: reverse a fee just charged | up to 3,000 | up to 3,000 | up to 3,000 if `fee_charged_recently` | not offered | not offered |
| `CARD_DOWNGRADE_FREE`: move to LifetimeFree | offered | offered | offered | **preferred** | offered (no cost) |
| `CARD_POINTS_BOOST`: double points for 3 months, cap in points | 2,000 | 1,500 | 1,000 | not offered | not offered |
| `CARD_COMPETITOR_MATCH`: one-year fee waiver plus points boost, cap | up to 3,000 | up to 3,000 | not offered | not offered | not offered |
| `CARD_SERVICE_ESCALATE`: raise and escalate the complaint | human only (all tiers) | | | | |

**Global caps (from `config/negotiation/card.yaml`):** fee waiver 3,000 rupees, points 2,000. The tier value is always the **lower** of the tier limit and the global cap and the card's actual annual fee (never waive more than the fee).

### 6.3 What always needs a human (all tiers)

| Action | Why | Who decides (placeholder) |
|---|---|---|
| `CARD_FEE_WAIVER_2YR` (two-year waiver, up to 6,000) | Above the autonomous cap | `credit_ops` level 1 |
| `CARD_UPGRADE_RECO` | Product change with a cost | `credit_ops` level 1 |
| `CARD_LIMIT_CHANGE` | Credit decision | `credit_ops` level 1 |
| Any waiver above 3,000 or 6,000 | Above level 1 | Senior review (outside the demo) |
| Dispute, fraud, complaint | Not a retention matter | `fraud` or `complaints` queue |

### 6.4 Worked limits for the demo heroes

| Hero | Key data | Tier | Offer it can receive on its own |
|---|---|---|---|
| `H-CARD-1` (Riya) | 12-month spend 256,000, fee 2,999, spend falling, score 745 | B | `CARD_FEE_WAIVER_COND` of 2,999, conditional on 30,000 spend |
| `H-CARD-2` (Arjun) | 12-month spend 8,000, fee 1,499, score 770 | D | `CARD_DOWNGRADE_FREE`. No waiver, no boost. Insists, closure proceeds |
| `H-CARD-3` (Neha) | High spend, but an open fraud ticket | X | None. Handoff to `fraud` before any offer |
| `H-CARD-4` (Sameer) | 12-month spend 108,000, dues 12,500 | C | Closure with `pending_dues` explained. A conditional waiver is possible only if the intent is soft and fee ratio passes |

The 12-month spend figures above are fixed in `_heroes.md` (the updated copy), so the data generator produces exactly these tiers.

---

## 7. Decision logic

### 7.1 Order of checks (every turn)

1. Intent classification (section 3). Fraud or human, then handoff.
2. Closure intent, then `CLOSURE_FLOW`.
3. State machine and negotiation engine (`next_step`) decide whether an offer or improvement is allowed.
4. Service call for options (code), model only phrases the reply.

### 7.2 Choosing the one offer

```
options = get_retention_options(customer, reason_code)
  # 1. load menu rows for the card line
  # 2. apply gates (section 7.3)
  # 3. apply tier limits (section 6.2)
  # 4. remove anything already offered this session or used in the last 12 months
  # 5. rank by score = fit * p_accept * customer_value - cost_to_bank   (heuristic)
  # 6. suitability gate: drop offers that are bad for the customer
best = options[0]     # present exactly this one
```

### 7.3 Gates (an action is dropped if any gate fails)

| Action | Gate |
|---|---|
| `CARD_FEE_WAIVER_COND` | `annual_fee > 0`, `fee_waiver_spend` is set, tier is A, B or C, no `prior_waiver_12m` |
| `CARD_FEE_REVERSAL` | Fee charged within the last 30 days, tier A, B or C |
| `CARD_DOWNGRADE_FREE` | Product is not already LifetimeFree |
| `CARD_POINTS_BOOST` | Card has transaction history, tier A, B or C |
| `CARD_COMPETITOR_MATCH` | Reason is `competitor`, tenure at least 12 months, tier A or B, no late history |
| `CARD_UPGRADE_RECO`, `CARD_LIMIT_CHANGE`, `CARD_FEE_WAIVER_2YR` | Listed as `needs_approval` only |
| `CARD_SERVICE_ESCALATE` | Open `service` ticket or reason `service_issue` |

**Suitability examples (offers that are dropped even if they pass the gates):** a fee waiver on a card with no fee, a points boost for a customer with no spend, an upgrade that raises the fee for an inactive customer.

### 7.4 Decision table (what the agent does next)

| Situation | Decision |
|---|---|
| Fraud or dispute words | Handoff `fraud` or `complaints`, no offer |
| Firm closure on the first message | `CLOSURE_FLOW`, no offer, no reason question |
| Soft closure, reason `fee`, tier A or B or C | Offer `CARD_FEE_WAIVER_COND` |
| Soft closure, reason `not_using`, any tier | Offer `CARD_DOWNGRADE_FREE` |
| Soft closure, reason `low_rewards`, tier A or B or C | Offer `CARD_POINTS_BOOST` |
| Soft closure, reason `competitor`, tier A or B and gates pass | Offer `CARD_COMPETITOR_MATCH` |
| Soft closure, reason `competitor`, otherwise | Offer `CARD_DOWNGRADE_FREE` if allowed, else go straight to closure |
| Soft closure, reason `service_issue` | Offer to raise the complaint (`CARD_SERVICE_ESCALATE`, human only). Closure stays open as a choice |
| Soft closure, reason `unknown` after one ask | Best data-supported option, or closure if none |
| Tier X | No cost-bearing offer. Offer free downgrade only if gates pass, else closure |
| No options survive the gates | Skip the offer and go straight to `CLOSURE_FLOW` with a polite acknowledgement |
| Customer accepts | Apply the action, confirm in writing, `RETAINED` |
| Customer declines or says close | `CLOSURE_FLOW` |
| Customer counters within limits | One improvement (section 8.1) |
| Customer counters above limits | Human review path (section 8.2) |

---

## 8. When the customer's expectation is higher than the agent's limit

### 8.1 Counter within the limits (the one improvement)

Allowed once, only if the first offer was made and the customer countered rather than declined.

| Customer counter | Agent decision |
|---|---|
| Asks for a fee reversal instead of a conditional waiver, and `fee_charged_recently` | Switch to `CARD_FEE_REVERSAL` (it is within the cap, unconditional) |
| Asks to drop the spend condition (tier B or C) | Not available autonomously. Treated as above-limit |
| Asks for more points, within the tier cap | Raise to the tier's points cap |
| Asks for a free card instead of a waiver | `CARD_DOWNGRADE_FREE` |
| Asks for a waiver amount at or below `min(annual_fee, tier cap, 3,000)` | Grant it as the improvement |

After the improvement is used, nothing more is offered. If the customer wants still more, go to 8.2.

### 8.2 Counter above the limits: ask a human

Triggers: the request is above the tier cap or the global cap, needs a product change, a limit change, a multi-year waiver, or something not on the menu.

1. The agent **does not promise or hint** at the outcome. It states plainly what it can do itself, and says a colleague must review the rest.
2. It creates a case in `credit_ops` (placeholder queue) with the summary in section 8.4.
3. It tells the customer honestly what happens next and when, using the review time from config (placeholder: one working day), not a number the model invents.
4. **The customer can still close the card at any time.** The agent states this once, plainly, without pressure.
5. If the customer had already clearly asked to close and then asks for a review: **closure is not paused**. The agent proceeds with the closure request unless the customer explicitly says to hold it, in which case the agent confirms the hold in writing. **Compliance to confirm:** whether a closure clock must keep running during a review.

### 8.3 What the agent says (examples)

Within limits:
> I can waive this year's annual fee of two thousand nine hundred ninety-nine rupees. It applies automatically if you spend thirty thousand rupees on the card over the next twelve months. Would that work for you?

Counter above limits:
> I can't approve that myself, and I don't want to promise something I can't deliver. I can ask a colleague to review your request, and you would hear back within one working day. You can also close the card whenever you like. What would you prefer?

### 8.4 Case summary for the human (`credit_ops`)

| Field | Content |
|---|---|
| Customer and card | IDs (masked), product, tenure, tier |
| Reason | Reason code and the customer's own words (masked) |
| Data highlights | Annual spend, trend, fee, points, dues, score band if available |
| Offered so far | Offer ids and outcomes |
| Customer's request | Exact ask (for example, "two-year waiver" or "waive 5,000") |
| Within or above limit | Which cap was exceeded and by how much |
| Closure status | Whether a closure request exists and its SLA date |
| Recommended action | The rules engine's best within-policy option, for the human's convenience |
| Priority | `normal`, or `high` if a closure SLA date is near |

### 8.5 Human decision outcomes

| Outcome | What happens next |
|---|---|
| Approved | Agent (or system) applies the action with a written confirmation to the customer |
| Approved in part | Customer receives the approved terms and can accept or close |
| Declined | Customer is told politely. They can still close |
| No response by the deadline | Escalate the case and notify the customer of the delay. Never auto-approve |

---

## 9. Conversation flow

States: `ANALYSE`, `FIND_REASON`, `OFFER`, `DECIDE`, `RETAINED`, `CLOSURE_FLOW`, `CLOSED`, `HANDOFF`.

```
Customer opens -> ANALYSE (silent) -> intent?
   fraud/human ................ HANDOFF
   closure_firm ............... CLOSURE_FLOW
   closure_soft ............... FIND_REASON -> OFFER -> DECIDE
                                    DECIDE: accept -> RETAINED
                                            decline/close -> CLOSURE_FLOW
                                            counter -> (improvement | human review) -> DECIDE
   CLOSURE_FLOW -> dues -> points -> mandates -> add-ons/EMI -> confirm -> submit -> CLOSED
```

### 9.1 Scripted responses by state (plain text, 2 to 4 sentences in chat, 1 to 3 in voice)

| State | Chat wording | Voice wording |
|---|---|---|
| Greeting (path A) | "Hello, I'm the BombayBank card assistant. I understand you'd like to close your card. May I ask what's behind it, so I can see if I can help?" | "Hello, this is the BombayBank card assistant. You'd like to close your card. May I ask why?" |
| Firm closure, first message | "Understood, I'll help you close it. First, a couple of quick things so nothing is left open." | "Understood. I'll help you close it. A few quick checks first." |
| Reason: fee, offer | "That's fair. I can waive this year's annual fee of 2,999 rupees. It applies automatically if you spend 30,000 rupees on the card over the next twelve months. Would that work for you?" | "I can waive this year's annual fee of two thousand nine hundred ninety-nine rupees, if you spend thirty thousand over the next year. Would that work?" |
| Reason: not using, offer | "Since you rarely use it, I can move you to our lifetime-free card, with no annual fee. You'd keep your account relationship. Would you like that?" | "I can move you to our lifetime-free card with no annual fee. Would you like that?" |
| Reason: low rewards, offer | "I can double your reward points for the next three months, up to 1,500 extra points. Would that help?" | "I can double your reward points for three months. Would that help?" |
| Reason: competitor | "I understand. I can offer a one-year fee waiver and bonus points, if you qualify. Would you like me to apply it?" | Same, shortened |
| Reason: service issue | "I'm sorry about that experience. I can raise a complaint with our service team right now, and you can still close the card whenever you like. What would you prefer?" | "I'm sorry about that. I can raise a complaint right now, or help you close the card. Which would you prefer?" |
| Reason unknown | "No problem. If you'd rather not say, we can go straight to closing it." | "No problem. Shall we go ahead and close it?" |
| Accept | "Done. Your annual fee is waived on the condition we discussed. You'll receive a confirmation message shortly. Is there anything else I can help with?" | "Done. You'll get a confirmation message. Anything else?" |
| Decline | "Understood, let's close it." (then closure flow) | "Understood. Let's close it." |
| Question about terms | Answer from the facts. No new offer | |
| Counter, improved offer | "I can improve that to a full reversal of the fee that was charged on 15 November, which is 2,999 rupees." | Shortened |
| Counter above limit | Section 8.3 | |
| Fraud | "I'm sorry to hear that. I'm connecting you with our fraud team right away, and I've shared the details so you won't need to repeat them." | Same |
| Ask for a human | "Of course. I'm connecting you with a colleague, and I've shared a summary of our conversation." | Same |
| Out-of-scope question | "I can't help with that here, but I can connect you with someone who can." | Same |

---

## 10. Closure flow (responses and decisions)

Steps run in order, each skippable by the customer with a short reply. Nothing is added beyond this list.

| Step | Check | Agent says (chat) | Decision |
|---|---|---|---|
| 1. Dues | `outstanding_dues`, `emi_outstanding` | "Your outstanding dues are 12,500 rupees, and 4,000 is in EMIs. I can submit the closure now, and it completes once these are cleared." | Dues present: status becomes `pending_dues`. Never refuse (H7) |
| 2. Reward points | `reward_points` | "You have 2,000 reward points. They are usually forfeited on closure. Would you like to redeem them first?" Offer once, accept a skip | Redeem via `redeem_points`, or skip |
| 3. Mandates | `card_mandates` | "Two subscriptions are linked to this card, a streaming service and a gym. Please move them to another payment method so they aren't missed." | Reminder only |
| 4. Add-on cards and EMIs | `addon_cards`, `emi_outstanding` | "Your add-on card will be closed too, and your EMIs continue as scheduled." | Informational |
| 5. Confirm | | "To confirm, you want to close your card ending 4821. Shall I submit it?" (with a confirm button) | Explicit yes required (H6). Issue the confirmation token |
| 6. Submit | `process_closure` | "Done. Your closure request reference is CC-000123. It will complete within seven working days, by 4 November." | Reference and date from the service, never the model |
| 7. After | | "You'll receive a confirmation message. The closed account stays on your credit report as the credit bureaus require. Thank you for banking with us." | State `CLOSED`, session done |

**Edge cases in closure**

| Case | Behaviour |
|---|---|
| Customer wants to stop midway | Honour it. Nothing is submitted without the final yes |
| Closure already requested | Idempotent: return the existing reference |
| Card is not active (blocked, expired) | Explain plainly, hand off to `credit_ops` |
| Customer asks if closing hurts their score | Answer factually and briefly, without inventing specifics. Offer to connect with support for detail |
| Customer changes their mind after submitting | Explain the cancellation route from config. If none exists, say a colleague will advise (handoff) |
| Voice: low confidence on a yes, number or reference | Re-confirm once before acting |
| Customer unauthenticated | Ask to verify (orchestrator OTP) before sharing any card data |

---

## 11. Phrases the agent never uses

"This offer ends today", "last chance", "you cannot close", "you must pay first before we close" (dues are a completion condition, not a blocker), "guaranteed", "I know what the other bank offered", "you'll regret", "are you sure?" repeated more than once, and any claim about approval it cannot make. These are checked on every reply (`never_say` in the policy file).

---

## 12. What is recorded (trace and audit)

Every turn writes: the intent, the reason code, tier and the metrics behind it, every service call, the eligible options with their score breakdown, the offer chosen (`action_id`), the cap and amount remaining, guardrail firings (for example `closure_never_blocked`), state changes, the confirmation, the closure reference and SLA date, and any handoff with its case id. All identifiers are masked.

---

## 13. Worked examples

**Example 1: retained (Riya, tier B).** She says she wants to close because the fee is high. Agent checks tier B, fee 2,999, no prior waiver, and offers the conditional waiver. She accepts. State ends `RETAINED`, action applied, trace shows rung 1, cap used 2,999 of 3,000.

**Example 2: insists (Arjun, tier D).** He says he wants to close, rarely uses the card, and mentions a rival's free card. Agent offers the free downgrade only (nothing else passes the gates). He says "no, just close it". Agent moves straight to closure, offers points redemption once, reminds him of two mandates, confirms, submits. Reference `CC-` plus the SLA date. `CLOSED`.

**Example 3: expectation above limit (Riya, tier B).** After the conditional waiver offer she asks for a two-year waiver with no spend condition. Agent says it cannot approve that itself, creates a `credit_ops` case with the summary in 8.4, tells her to expect an answer within one working day, and reminds her once that she can close any time. If she then says "fine, close it", the agent goes to closure immediately.

**Example 4: firm closure (Arjun).** First message: "Close my card, I don't want to discuss it." Agent skips the reason question and the offer, runs the closure checklist and submits after her yes.

**Example 5: dues pending (Sameer, tier C).** He asks to close with dues of 12,500 and EMI of 4,000. Agent submits the closure with status `pending_dues`, explains clearly that completion follows payment of dues, and gives the reference and the SLA date.

**Example 6: fraud (Neha).** She mentions an unrecognised transaction. Agent immediately transfers to the `fraud` queue, no offer.

---

## 14. Tests that prove the rulebook

| Test | Proves |
|---|---|
| For any sequence of messages containing a closure intent, `CLOSURE_FLOW` is reached within one turn and no offer follows | H1, H3 |
| Never more than one offer and one improvement | H2 |
| Offers never exceed tier limits, global caps or the annual fee | Section 6.2 |
| Tier X never receives a cost-bearing offer | Section 6.2 |
| Counter above limits creates a `credit_ops` case and the reply contains no promise | H5, section 8.2 |
| `apply_retention_action` rejects an id not in the current options | H4 |
| Closure with dues returns `pending_dues` and still gives a reference | H7 |
| Closure with a missing, tampered or expired token is rejected | H6 |
| Fraud wording in any state forces a handoff before any offer | H8 |
| Reply never contains `never_say` phrases (including adversarial scripts and prompt injection) | H9 |
| Spoken numbers match service outputs | H11 |
| Voice: low confidence yes triggers exactly one re-confirmation | H6 |
| Hinglish closure phrases are classified as closure intent | Section 3 |

---

## 15. Placeholders to confirm with the bank (all in config)

| Item | Demo value | Where it lives |
|---|---|---|
| Closure completion timeline | 7 working days | `config/negotiation/card_closure.yaml` |
| Whether any retention offer is permitted after a closure request (especially on a call) | One offer | `config/negotiation/card.yaml` |
| Tier thresholds (spend, score) | Section 6.1 | `config/policy/card_tiers.yaml` |
| Tier limits and global caps | Section 6.2 | `config/negotiation/card.yaml` |
| Window for a fee reversal | 30 days | `config/negotiation/card.yaml` |
| No repeat waiver window | 12 months | `config/negotiation/card.yaml` |
| Human review time | 1 working day | `config/negotiation/card.yaml` |
| Whether closure continues during human review | Continues unless the customer asks to hold | `config/negotiation/card.yaml`, compliance to confirm |
| Authority levels for approvals | `credit_ops` L1 up to 6,000 | `config/negotiation/card.yaml` |
| Bureau reporting and cancellation-after-submission wording | Neutral wording | `services/card/disclosures.yaml` |

**This rulebook does not state any regulation as fact.** Closure timelines, what a bank may say after a closure request, and consent for bureau checks are rules the bank's compliance team owns.
