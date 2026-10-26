# Vercel frontend + Render backend

This setup hosts the synthetic demo. Aria's card services remain simulated after deployment. The repository contains ready-to-configure deployment files; you still create the services and set their environment variables in your own accounts.

## How the connection works

The browser loads static assets from Vercel. Requests to `/api/*` are rewritten to Render, so session and demo-access cookies stay on the frontend's own origin. They are HttpOnly, Secure and SameSite=Strict in hosted mode.

For audio and chat streaming, the frontend requests a one-use, 60-second voice ticket through that API proxy. It then connects directly to Render over `wss://`, presenting the ticket as a WebSocket subprotocol. The ticket is bound to the frontend origin and consumed once. It contains no provider key and is not placed in a URL. This avoids depending on third-party cookies or a WebSocket server inside a Vercel Function.

Platform references: [external-origin rewrites](https://vercel.com/docs/routing/rewrites), [Build Output API](https://vercel.com/docs/build-output-api), [Vercel WebSocket guidance](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections) and [Render WebSockets](https://render.com/docs/websocket).

## 1. Choose the frontend address

Decide the Vercel project name or custom domain first. The backend needs its exact HTTPS origin, such as `https://your-vaani-project.vercel.app`. Use the actual hostname assigned to your project. A trailing slash is accepted; paths, wildcards and credentials are rejected.

Render can start with the intended frontend origin before the frontend is live. If Vercel assigns a different hostname, update `FRONTEND_ORIGINS` on Render before testing the app.

## 2. Create the Render backend

In Render, choose **New → Blueprint**, connect `Meet547/vaani`, and use the root `render.yaml`.

The blueprint configures Node.js 24, one web-service instance, `npm ci --omit=dev && npm run check`, `npm start`, a health check at `/api/health`, and a 1 GB persistent disk mounted at `/var/data`. It selects the **paid Starter plan** because the saved SQLite database needs a persistent disk. Review the resource choice before creating it. A free ephemeral service will not preserve the intended session history across redeployments.

Set these values in Render:

- `FRONTEND_ORIGINS`: the exact HTTPS frontend origin from step 1. Multiple approved origins can be comma-separated.
- `SARVAM_API_KEY`: your speech provider key. Without it, offline chat works but live speech is unavailable.
- `OLLAMA_API_KEY`: your Ollama Cloud key. Without it, unfamiliar wording uses deterministic clarification.
- `DEMO_ACCESS_CODE`: the blueprint generates a random value. Copy it from Render's environment settings and share it privately with demo participants. If creating the service manually, supply your own random value of at least 16 characters.

The blueprint also sets `DEPLOYMENT_TARGET=render`, `NODE_ENV=production` and `DATABASE_PATH=/var/data/vaani/aria.sqlite`. Leave Render's `PORT` alone; the process binds to `0.0.0.0` and the platform-provided port. `RENDER_EXTERNAL_URL` supplies the backend's public origin automatically.

If you use a custom backend domain, set `PUBLIC_BACKEND_URL` to its exact HTTPS origin. The automatic Render hostname remains allowed for health checks. Use that same custom origin for Vercel's `BACKEND_URL`.

Wait for the backend to become healthy, then copy its public URL. A request to `https://your-service.onrender.com/api/health` should return `status: ready`. The database query is checked here; provider credentials being present does not prove that the provider account has quota.

## 3. Create the Vercel frontend

Import `Meet547/vaani` into Vercel with the repository root as **Root Directory** and **Other** as the framework preset. Keep the repository's `vercel.json` build settings. Do not override the output directory: `npm run build:frontend` emits Vercel's Build Output API in `.vercel/output`.

Add just this frontend environment variable:

```text
BACKEND_URL=https://your-service.onrender.com
```

Use your actual Render URL. This is a public routing destination, not a credential. **Sarvam, Ollama and the demo access code belong only on Render.** The frontend build fails clearly when `BACKEND_URL` is missing or is not an HTTPS origin.

Deploy. The build copies only the browser assets and generated backup audio. It generates the `/api/*` proxy route, security headers and the exact `wss://` origin for the Content Security Policy. It does not ship the CSV, source briefs, SQLite database or backend code as static assets.

Open the assigned frontend URL, confirm it matches `FRONTEND_ORIGINS`, then enter the demo access code. You should see the customer directory and a ready connection badge.

## 4. Verify the hosted app

1. Open the frontend in a private browser window. The access-code prompt should appear before any customer data loads. An incorrect code should fail.
2. Unlock it, start a normal conversation and say “Hello.” Aria should ask for a name, with no offer or selected account.
3. Say “My name is Riya Deshmukh,” confirm the match, then confirm the saved fee issue. Check the offer uses ₹2,999 with the configured spend condition.
4. Start a new conversation as Sameer Gupte, confirm the saved closure request, skip points, and confirm submission. Verify `pending_dues` and a written reference.
5. Refresh and resume. Verify the same reference survives.
6. Try the microphone over HTTPS. Allow the browser permission, speak, and interrupt an answer. Headphones help with echo.
7. Inspect the browser's Network panel if needed: HTTP API calls should use the Vercel origin and the `/voice` WebSocket should use Render with protocol `vaani`.
8. After a controlled Render redeploy, resume again. The saved account facts and reference should remain on the persistent disk. In-flight voice connections close during deployment; the UI can resume the saved session.

Also try an unknown synthetic full name. Consent to registration, supply a city and enquiry, review, and save. A fresh conversation should find the same `NEW-...` profile and saved enquiry. These profiles share the persistent SQLite database; schema version 2 adds their table without replacing existing sessions. Take a backup before upgrading an existing hosted database.

Repository CI and local integration tests verify the code and proxy/ticket contract. The actual hosted URLs, provider quota and disk persistence still require this deployment acceptance check in your accounts.

## Preview URLs and custom domains

Production and preview domains are different origins. Add an exact preview origin to `FRONTEND_ORIGINS` only when you want it to access this backend, then redeploy/restart the service. There is no `*.vercel.app` wildcard. Set `BACKEND_URL` for the Vercel environments you intend to use and rebuild after changing it.

You can give previews a separate Render backend and dataset instead of sharing production demo sessions. This repo does not provision that additional service automatically.

## Storage and capacity

Keep **one backend instance**. SQLite is on one disk and voice tickets live in that process. Multiple instances need a shared database and ticket store before they can safely serve the same sessions. The transport currently allows six simultaneous connections and a 15-minute call limit; other bounds live in `config/runtime.yaml`.

Render's [disk documentation](https://render.com/docs/disks) explains persistence, instance limits and the deployment downtime tradeoff. Back up the live database using a SQLite-aware backup or stop the service before copying its database/WAL files. Do not put database backups or real customer data into Git.

`NODE_ENV=production` enables the hosted runtime environment. `APP_MODE=production` deliberately fails because this is still a synthetic banking service; do not set it to bypass that boundary.

## When something does not connect

- **Build says BACKEND_URL is missing:** set it on Vercel and redeploy; use an origin without `/api`.
- **Backend fails at startup:** check origins, the access-code length, disk/path, Node.js version and [Render logs](https://render.com/docs/troubleshooting-deploys).
- **403 / Invalid host:** check `PUBLIC_BACKEND_URL` and Render's automatic hostname. Arbitrary forwarded hosts are not trusted.
- **403 on a POST or WebSocket:** confirm the exact frontend origin is in `FRONTEND_ORIGINS`.
- **Access code succeeds but the socket fails:** verify Render's URL, secure `wss://` and the frontend CSP. Reconnect for a fresh ticket; each ticket works once.
- **Voice unavailable but chat works:** inspect provider account quota and credentials in Render. Never paste keys into the browser or a GitHub issue.
- **Sessions disappear after redeploy:** verify the disk is mounted and `DATABASE_PATH` points inside it.

For local development, `npm run dev:secure` uses loopback and hidden key prompts. See [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md).
