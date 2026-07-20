# The Exam Academy — your actual setup, wired up

This matches what you already had: a Capacitor iOS app (`ios/App`) loading `www/index.html`, plus a small Node/Express backend that relays to Gemini. Vercel is gone — you said that link was a mistake, so this now targets Render, matching the `ielts-api` server code you already had.

## What changed, and why

- **Removed** the `.vercel` folder and the leftover `.env.local` (`VERCEL_OIDC_TOKEN`) — dead weight from the Vercel link.
- **Added `server/`** — your uploaded Express + `@google/generative-ai` code, generalised. The original hardcoded one fixed "evaluate this paraphrase" prompt on `/api/evaluate`. Your actual app (`www/index.html`) already calls a *different* endpoint, `/api/ielts-evaluator`, sending its own custom prompt for each feature (plan feedback, self-checks, the Socratic coach). So the server no longer bakes in any single task — it's a thin relay: whatever `systemInstruction` + `contents` the app sends, it forwards to Gemini and returns `{ reply }`. Endpoint name and request/response shape now match exactly what the app already expects.
- **One new line in `www/index.html`** — a `BACKEND_URL` constant (blank by default, so nothing changes yet) right above `aiCall()`. Nothing else in the app changed.
- **Model**: bumped from `gemini-1.5-flash` to `gemini-2.5-flash` (1.5 is old and may be retired) — override with the `GEMINI_MODEL` env var if you'd rather pin a specific version.

## 1. Install and test the server locally

    cd server
    npm install
    export GEMINI_API_KEY=AIza...        (from aistudio.google.com — never commit this)
    npm start

Check http://localhost:3000/health shows `{"ok":true,...}`.

## 2. Push to GitHub

From the project root (`ielts-mobile-app`):

    git init                      # only if this folder isn't already a repo
    git add .
    git commit -m "Gemini backend + cleanup"
    git remote add origin https://github.com/<you>/<repo>.git
    git push -u origin main

`.gitignore` already excludes `node_modules`, `.env*`, and `.DS_Store`.

## 3. Deploy the server to Render

1. render.com → New + → Web Service → connect your repo.
2. **Root Directory**: `server`
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. Add environment variable `GEMINI_API_KEY` (paste your key in Render's dashboard, not in any file).
6. Deploy. Render gives a URL like `https://ielts-api.onrender.com`. Confirm `<url>/health` responds.

Free-tier Render sleeps after inactivity — first request after a quiet spell takes ~30s to wake up, that's normal.

## 4. Point the app at it

In `www/index.html`, find (just above `aiCall`):

    const BACKEND_URL = '';

Change to your Render URL:

    const BACKEND_URL = 'https://ielts-api.onrender.com';

This one line matters because the Capacitor app loads `www/index.html` as a local bundle, not from that domain — a relative `fetch('/api/...')` would otherwise try to reach the app's own local origin instead of your server.

## 5. Run it in the Xcode simulator

Your existing project is already set up for this — no changes needed:

    npx cap sync ios
    npx cap open ios

Then pick a simulator and hit ▶ Run in Xcode. Because `BACKEND_URL` is now a public `https://` address, it'll reach Gemini through your Render server from inside the simulator.

## Everyday workflow

Edit `www/index.html` or `server/server.js` → `npx cap sync ios` (only needed after www/ changes) → commit + push → Render redeploys the server automatically → re-run in Xcode.

## Optional: lock the server down

Anyone with your Render URL can currently use it. Set `APP_SECRET` in Render's environment variables, and add the same value as a header in `aiCall()`'s fetch call (`'x-app-secret': 'your-secret'`) if you want to gate access later.
