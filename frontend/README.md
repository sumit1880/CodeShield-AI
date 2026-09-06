# CodeShield / Console

Frontend for the CodeShield AI vulnerability-analysis backend. React + TypeScript + Vite, Tailwind for styling, no heavy UI kit or code-editor dependency.

## What it talks to

- `POST /api/analyze` — paste-code analysis (`{ language, code }`)
- `POST /api/analyze/upload` — ZIP project analysis (multipart field `file`, optional `?language=`)
- `GET /health` — connectivity check, called once on load only

Auth is Google Sign-In: the client obtains a Google ID token via Google Identity Services and sends it as `Authorization: Bearer <token>` on every `/api/*` call. There is no separate password/session system, matching the backend's `google-auth.middleware.ts`.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `VITE_API_BASE_URL` — where the backend is running, e.g. `http://localhost:3000`
- `VITE_GOOGLE_CLIENT_ID` — a Google OAuth 2.0 **Web application** client ID. It must be one of the values the backend's `GOOGLE_CLIENT_ID` env var accepts, and its **Authorized JavaScript origins** (in Google Cloud Console) must include the origin this app runs on (e.g. `http://localhost:5173`).
- `VITE_MAX_ZIP_SIZE_MB` — optional, should mirror the backend's `MAX_ZIP_SIZE_MB` (defaults to 50).

The backend's `CORS_ORIGIN` must also match whatever origin this frontend is served from.

## Run

```bash
npm run dev        # local dev server on http://localhost:5173
npm run build       # type-checks (tsc -b) then builds to dist/
npm run preview     # serve the production build locally
```

## Notes

- Only one analysis can be in flight at a time; the submit control disables itself during a run.
- Failures are never auto-retried — 429 (rate limited) and 503 (server busy) show a cooldown/retry state that requires a manual click, per the backend's free-tier rate and concurrency limits.
- The last 5 analyses from the current tab session are kept in `sessionStorage` under "This session" so navigating away doesn't lose results; nothing is sent anywhere beyond the API calls above.
- The Google ID token is kept in `sessionStorage` only (never `localStorage`), and a 401 from any request immediately clears the session and returns to the login screen.

## Security note on the backend zip

The backend `.env` bundled in the project you supplied contains live-looking API keys (Gemini, Grok, Llama/Together) and a Neon Postgres connection string. None of that belongs in — or was used by — this frontend, but since it shipped in plaintext inside the archive, it's worth rotating those credentials if the zip has been shared anywhere.
