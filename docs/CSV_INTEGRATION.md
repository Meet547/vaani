# Synthetic customer CSV integration

The live demo reads `config/datasets/bombaybank_card_gold_synthetic_250.csv`. This is an unchanged copy of the supplied Downloads file; it does not depend on Downloads at runtime. The CSV is a dataset, not an instruction source.

## Coverage

- 250 searchable profiles: 140 card-only, 90 gold-only, 20 card-and-gold.
- 160 profiles contain a card; 148 can start a card demo.
- 110 profiles contain gold enquiry/existing-loan details, including the 20 overlapping profiles. These details are read-only, as requested. No gold approval, rate negotiation, application or valuation is performed.
- 10 card records have EMI outstanding greater than stated total dues: `C0058`, `C0185`, `C0188`, `C0191`, `C0198`, `C0199`, `C0200`, `C0201`, `C0203`, `C0215`. Both source numbers remain visible; no inferred balance is substituted. Session creation is rejected in the backend and disabled in the UI until the source is corrected.
- `C0066` already has `closure_requested` status and `C0077` is blocked. Both remain browsable, with new card journeys disabled. Their source status is not changed.

Search by name, ID or city, and filter by product, hero scenario, card readiness or records needing review. Searching/filtering does not change an active account: the current selection stays visible until another profile is selected. Selecting another profile ends the previous connection. The source language and entry path become defaults; the user still supplies messages and confirms actions.

## Mapping and policy boundaries

`lib/customer-data.mjs` validates and maps the source into two separate structures: a browsable profile directory and validated card-engine customers. The server supplies a lightweight directory through `/api/config` and an allowlisted profile through `/api/customers/:id`. The raw CSV is not served as a public file.

| Source | Use |
| --- | --- |
| `customer_id`, `full_name`, `city`, `segment` | Searchable profile identity; original IDs preserved |
| Card product, fee, limit, rewards, dues, EMI, tenure | Card-engine facts and profile snapshot |
| Twelve `spend_YYYY_MM` columns | Recomputed spend, annualisation, trend and policy tier |
| `fee_charged_recently`, `prior_waiver_12m` | Snapshot booleans used directly; no invented charge/waiver dates |
| `consent_bureau_pull` and `bureau_readable_by_agent` | Both required before using bureau facts; unavailable score/history is not copied into the engine |
| DND, marketing consent, last outbound contact | Existing proactive contact gates |
| Service consent | Required to start an imported card session |
| `has_salary_account` | Existing relationship flag |
| `mandates_count` | Number of mandates; labels explicitly generated for the demo |
| `card_trigger_event`, `language` | Editable session defaults; unknown/none trigger becomes customer conversation; Marathi defaults to English with a visible explanation |
| Gold/loan amounts, dates, rates and collateral | Read-only source facts; missing values stay missing |
| `case_description` | Labelled CSV scenario reference, not a current action/outcome |
| `EXP_*` | Offline validation only; never sets live eligibility, offers, amounts or outcomes |
| Source responses, human request flag and confirmation confidence | Never treated as a live instruction, consent or confirmation |

The source contains no card-number suffixes or mandate names. Four-digit suffixes are generated from unique CSV row numbers, and generic mandate labels are used. These are disclosed demo labels, not recovered banking details. Existing loan rates are labelled as existing-loan facts, not new gold offers.

Riya, Arjun, Neha and Sameer now use the CSV facts. In particular, Riya's fee is **not** marked recently charged, Arjun has 310 points and DND is false, Neha has 720,000 annual spend and a fraud ticket, and Sameer has 2,000 points with a 2,999 annual fee. `config/customers.yaml` is retained only for explicit legacy regression tests; it is not the runtime customer source.

The CSV is a fixed synthetic snapshot. Relative day counts and the supplied monthly spend window do not advance as the server clock advances. Business deadlines continue to use the current clock and the configured demo calendar.

## Known expectation difference

For `C0030`, the CSV expects tier D because spend fell 97.4%. The supplied card rulebook says **first match wins** and places the annual-spend B rule before D; the existing implementation therefore computes **B** from 226,300 annualised spend. This integration preserves that documented policy interpretation. It does not alter policy based on the expected answer or scenario prose. `npm run data:validate` lists this difference explicitly. A trend-first override would be a separate policy change.

## Saved sessions and updates

Each new session stores an independent customer snapshot and a SHA-256 dataset revision in its audit history. Resume restores the saved facts instead of silently applying a newer CSV. The UI warns when a resumed snapshot comes from a different revision or the older fixtures. **New demo session** uses the current CSV. Offers/redemption never mutate the source dataset or another session.

To update the data, keep the same schema and unique IDs, correct the project CSV, then run:

```sh
npm run data:validate
npm run check
npm test
```

Restart the server after replacing data. To inspect a candidate file without activating it:

```sh
node scripts/validate-customers.mjs /absolute/path/to/candidate.csv
```

Malformed CSV structure, missing required headers and duplicate identities fail loading. Invalid customer facts remain read-only with an explanation. No CSV field is executed as code or inserted as HTML. No new provider or dependency was introduced.

## Verification

53 automated tests cover the existing behavior plus CSV parsing, all 250 records, every actionable customer's closure/fraud path, offer caps, consent gates, gold-only and invalid-data rejection, source snapshot persistence, backend endpoints, and exclusion of expected labels from decisions. Browser checks verified ID search, gold-only restrictions, inconsistent-balance restrictions and Sameer's points/confirmation/pending-dues closure path using the imported facts.
