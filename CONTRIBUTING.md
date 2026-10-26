# Working on Vaani

Keep changes small enough to review and clear enough to explain. A good pull request says what a customer can do differently, why the change matters, and what was checked.

Start with Node.js 24 and `npm ci`. Run `npm run check`, `npm test` and `npm run data:validate` before opening a pull request. Provider smoke tests are optional and consume quota; keep them out of automated CI.

Keep backend code in `src/`, browser code in `public/`, and policy/settings in `config/`. The server entry point is `src/server.mjs`; normal commands stay in `package.json`. Add a folder only when it makes the project easier to navigate.

The card engine owns policy decisions. Provider adapters classify intent or produce speech; they must not authorize financial actions. Keep explicit confirmation, offer budgets, closure intent and fraud/consent gates in code that can be tested.

The source CSV is a fixed synthetic snapshot. If you change it, keep the schema and IDs valid, inspect the data validation report and explain any intentional expectation differences. Never turn an `EXP_*` column into a live decision.

Keep browser content accessible and use text nodes for imported data. Test narrow screens and keyboard navigation when changing the UI. Preserve the one-use voice-ticket flow when editing the Vercel/Render connection.

Do not include keys, `.env`, databases, recordings or local tooling state in a commit. See [SECURITY.md](SECURITY.md) and [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
