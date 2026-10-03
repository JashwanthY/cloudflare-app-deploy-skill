---
name: cloudflare-app-deploy
description: Deploy, redeploy, roll back or debug a web app on Cloudflare end-to-end and production-ready — FastAPI/Python backend on Cloudflare Containers, React/Vite or Next.js (static export) frontend on Workers static assets, R2 object storage (private uploads, SQLite persisted via Litestream, public assets bucket), and custom subdomains like app./api./files. on a Cloudflare-managed domain. Use this whenever someone wants to ship, deploy, host, publish or "go live" with an app on Cloudflare, hook a subdomain/DNS up to a frontend or API, move a FastAPI + React app to Cloudflare, add R2 for file uploads, set up a staging copy, or fix a broken Cloudflare deploy (CORS errors, 503s, container not starting, custom domain not resolving) — even if they never say Containers, Wrangler, Workers or R2. Works with either `wrangler login` or a CLOUDFLARE_API_TOKEN.
---

# Cloudflare App Deploy

Takes a repo with a FastAPI backend and/or a React (Vite) or Next.js frontend to a production
deployment on Cloudflare with no DevOps team. One manifest (`cloudflare.deploy.json`) describes the
app; one script (`scripts/cfdeploy.mjs`) does every deploy step with the safety checks built in.

```
browser ──► https://app.example.com   Worker + static assets (SPA fallback, cache headers)
   │
   └──────► https://api.example.com   edge Worker (CORS, cold-start handling, 503 fallback)
                     │
                     └─► Durable Object ─► Container: FastAPI on :8000 (linux/amd64 image)
                                                │  S3 API (bucket-scoped keys)
                                                ▼
                                   R2: <app>-files (private uploads, presigned URLs)
                                       <app>-db    (SQLite replica via Litestream)
                                       <app>-public ──► https://files.example.com
```

The design and its guardrails come from a real production app and current Cloudflare
docs. Each guardrail exists because skipping it caused an outage or data loss — see
`references/troubleshooting.md` before working around any of them.

## How to run the tool

```bash
CFDEPLOY="node <absolute path to this skill>/scripts/cfdeploy.mjs"
cd <app repo root>        # the folder that holds (or will hold) cloudflare.deploy.json
$CFDEPLOY <command> [--stage <name>]
```

Commands: `init`, `preflight`, `storage`, `backend`, `frontend`, `deploy` (all of them + smoke test),
`smoke`, `status`, `rollback`, `logs`, `teardown`. `$CFDEPLOY --help` lists flags.

Wrangler configs are **generated** into `deploy/.generated/<stage>/` on every run — don't hand-edit
them and don't run raw `wrangler deploy` for this app; the raw command skips the hostname, secret and
image-tag protections below. If the tool can't do something, fix the manifest or the tool's input.

## Ground rules

- **Production is outward-facing.** Before the first deploy to a real domain, and before any
  `teardown`, tell the user exactly which hostnames, buckets and Workers will be created or deleted
  and get a yes.
- **Never pass `--takeover <host>` on your own.** In non-interactive mode wrangler silently replaces
  an existing DNS record or another Worker's custom domain. Preflight blocks this; only the user can
  decide that a hostname may be taken over.
- **Secrets stay secret.** They live in the backend env file (gitignored) or the CI environment,
  reach Cloudflare only through the deploy's secrets file, and never go in `backend.vars`, the image,
  the manifest, logs, or your replies.
- **Ask, don't guess, for:** the zone (domain) and subdomains, the Cloudflare account if several
  exist, and which data must survive restarts. Infer everything else from the code.

## Workflow

### 1. Prerequisites

- **Node 22+.** Current wrangler refuses to run on Node 20. If `node -v` is older, use nvm or volta (`nvm use 22`).
- **Docker running**, for building the backend image. Cloudflare needs linux/amd64, and wrangler handles that itself.
- **A Cloudflare account on Workers Paid** ($5/mo). Containers require it. On the free plan the deploy fails with a misleading `403 Authentication error`.
- **The domain's DNS on Cloudflare**, in the same account.
- **Credentials**, either of:
  - Interactive: `cd deploy && npx wrangler login`. Use `--device` on a headless machine.
  - CI or agents: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`.

  Token permissions are listed in `references/auth.md`.

### 2. Read the app before touching anything

Find out, from the code:
- frontend dir, framework (Vite / Next.js), and the env var it uses for the API base URL;
- backend dir, ASGI entry (`app.main:app`), dependencies (requirements.txt / uv), port;
- **every place the backend writes to local disk** (SQLite files, `uploads/`, generated files, caches).
  Container disk is wiped on every restart, deploy and idle sleep. Each such write must move to one
  of the storage modes below or be genuinely disposable.
- which env vars are secrets (API keys, DB URLs) vs plain config.

Choose storage from what you found (full guide: `references/storage.md`):

| The app… | Use | Notes |
|---|---|---|
| stores user files/uploads/generated artifacts | `storage.files` | R2 via boto3; browser uploads via presigned URLs |
| uses SQLite as its database | `storage.sqlite` | Litestream → R2; forces exactly **one** container |
| uses Postgres/MySQL elsewhere (Neon, Supabase, RDS…) | nothing | just add `DATABASE_URL` to `backend.secrets` |
| serves public images/videos/downloads | `storage.public` | own bucket + `files.<zone>` domain (r2.dev is rate-limited) |

### 3. Ask the user what you can't infer

Typically one message: "Which domain (zone) should this go on? I'd use `app.<zone>` for the
frontend and `api.<zone>` for the API — OK?" plus any storage question the code left ambiguous.
Use subdomains for separate apps on a shared zone (e.g. `notes.acme.ai` / `notes-api.acme.ai`).

### 4. Initialise

```bash
$CFDEPLOY init --app notes --zone acme.ai --frontend-host notes.acme.ai --backend-host notes-api.acme.ai [--files] [--sqlite] [--public-host notes-files.acme.ai]
```

This writes `cloudflare.deploy.json` (if missing) and creates the files below. It never overwrites a file that already exists.

| File | Purpose |
|---|---|
| `deploy/` | Pinned wrangler toolchain, plus the edge Worker in `deploy/backend/src/index.ts` |
| `<backend>/Dockerfile` | Production image |
| `<backend>/.dockerignore` | Keeps `.env` and local databases out of the image |
| `<backend>/cloudflare_runtime.py` | CORS, `/health` and R2 helpers |
| `<backend>/cfdeploy-entrypoint.sh` + `litestream.yml` | Only when `--sqlite` is set |

It also adds the backend env file to `.gitignore`.

**Instance size is picked from the code.** `init` reads the backend's dependencies (`requirements*.txt` / `pyproject.toml`) and the Dockerfile's apt packages, sets `backend.instanceType`, and prints why:

| Detected | Picks |
|---|---|
| Plain API (FastAPI, SQLAlchemy, httpx, LLM SDKs calling remote APIs) | `basic` (¼ vCPU, 1 GiB) |
| SQLite mode, pandas/numpy/scikit-learn, LangChain, Pillow, PDF libs | `standard-1` (½ vCPU, 4 GiB) |
| Playwright/Selenium, OpenCV, ONNX, spaCy, WeasyPrint, ffmpeg/LibreOffice/Tesseract | `standard-2` (1 vCPU, 6 GiB) |
| PyTorch, TensorFlow, transformers, Whisper, YOLO | `standard-3` (2 vCPU, 8 GiB) |

Tell the user the chosen size and the reason in one line. A bigger size costs more for every second the container is awake. The heuristic only sees declared dependencies, so raise the size yourself when the code does heavy work it can't see. Examples: models downloaded at startup, large files processed in memory, `uvicorn --workers N`. Preflight warns if someone later sets a size below the recommendation, and `backend` stops before pushing an image that won't fit on the instance's disk.

Then review the manifest; every field is documented in `references/manifest.md`. In particular:
- `backend.secrets` is pre-filled from the env file's keys. Remove anything that isn't needed at runtime.
- Non-secret config goes in `backend.vars`.
- Make sure `frontend.apiUrlVar` matches what the frontend code actually reads.

If a Dockerfile already existed, keep it, but check it against the Dockerfile rules in `references/troubleshooting.md`:
- exec-form `CMD`
- listens on `0.0.0.0`
- `.env` is not copied into the image

### 5. Make the code cloud-ready

These are small, reviewable edits. Show the user the diff.

**Backend**
- Call `install(app)` from `cloudflare_runtime`, or read `FRONTEND_ORIGINS` (comma-separated) into the existing `CORSMiddleware`. Keep `localhost` origins only when `APP_STAGE` is unset.
- Make sure there is a dependency-free `GET /health`, since it is the smoke test and the cold-start probe.
- Replace local-disk persistence:
  - Uploads and files go through `storage.put_bytes` / `storage.presigned_upload_url`.
  - In SQLite mode, the DB path comes from the env and lives under `/data` (e.g. `os.path.join(os.getenv("DATA_DIR", "."), "app.db")`).
- Add `boto3` to requirements if storage is used.
- Read every setting from env vars. The Worker injects `APP_STAGE`, `FRONTEND_ORIGINS`, `PUBLIC_API_URL`, `R2_*`, plus your vars and secrets.

**Frontend**
- The API base URL comes from `import.meta.env.<apiUrlVar>` (Vite) or `process.env.NEXT_PUBLIC_…` (Next), with a localhost fallback for dev. It is baked in at build time, so changing it means redeploying the frontend.
- Next.js: set `output: "export"` and `images: { unoptimized: true }` in `next.config`. Dynamic routes need `generateStaticParams`. Server-only features (SSR, API routes, middleware) don't fit here; see `references/nextjs.md`.
- Browser uploads: `PUT` the file to the presigned URL with the **same `Content-Type`** that was signed.

### 6. Preflight

```bash
$CFDEPLOY preflight
```

Preflight checks:
- Node, Docker and authentication
- the account, and that it can use Containers (Paid plan)
- the zone is active
- **every hostname is free or already ours**
- all secrets have values, and the env file is gitignored
- the Dockerfile follows the rules
- Next.js uses static export
- the frontend reads `apiUrlVar`

Fix each ✘ at its cause and re-run. A hostname conflict goes back to the user (step 3).

### 7. Deploy

```bash
$CFDEPLOY deploy
```

This runs preflight, then `storage`, `backend`, `frontend` and `smoke`:
- **storage:** creates buckets, sets CORS, attaches the public domain, and creates bucket-scoped R2 keys, which it writes to the env file.
- **backend:** builds and pushes the image under a unique tag, then deploys the Worker, container, secrets and `api.` domain.
- **frontend:** builds with the API URL baked in and deploys the assets and `app.` domain.
- **smoke:** checks DNS and TLS, SPA fallback, the edge `/__cfdeploy/health`, the container `/health`, and CORS from the frontend origin.

How long it takes:
- The first container deploy takes a few minutes to provision. The smoke test waits up to 10 minutes.
- A first custom domain can take a few minutes for its certificate.
- If smoke times out on a brand-new deploy, wait and run `$CFDEPLOY smoke` again before changing anything.

If `storage` cannot create R2 keys, it stops before deploying anything and prints two options. This is normal with `wrangler login`, or with a token that can't create tokens.
- **A (preferred):** the user creates an "Object Read & Write" token scoped to the listed buckets in the dashboard and pastes the two values into the env file.
- **B:** re-run with `--r2-keys-from-token`. This derives keys from the deploy token itself. The keys reach *every* bucket the token can, so ask the user before choosing B.

### 8. Report back

Tell the user:
- the live URLs and the smoke results
- what was created: Workers, buckets, domains and the R2 token
- the code changes you made
- the day-2 commands below
- cost: containers bill per 10 ms while awake, so `sleepAfter` (default 30m) and `instanceType` (picked from the code at `init`) are the main cost knobs

## Day-2 operations

| Task | Command |
|---|---|
| Ship new backend code | `$CFDEPLOY backend` (always rolls the container; new image tag every time) |
| Ship new frontend code / changed API URL | `$CFDEPLOY frontend` |
| Change a secret | edit the env file → `$CFDEPLOY backend` (containers read env only at start) |
| Secret managed only in Cloudflare | add the name to `backend.prodManagedSecrets`; set it once with `cd deploy && npx wrangler secret put NAME --config .generated/production/backend.wrangler.json` |
| Roll back API | `$CFDEPLOY rollback --target backend [--to <image-tag>]` |
| Roll back site | `$CFDEPLOY rollback --target frontend [--to <version-id>]` |
| Live logs | `$CFDEPLOY logs --target backend` (container stdout + Worker logs) |
| What's deployed | `$CFDEPLOY status` |
| Staging copy | add `stages.staging` (own hostnames, env file) → `$CFDEPLOY deploy --stage staging` |
| CI (GitHub Actions etc.) | see `references/auth.md#ci` |
| Remove a stage | `$CFDEPLOY teardown --stage staging --confirm <app>-staging` (ask first). Add `--delete-buckets` only when the user agrees to **destroy that stage's data**, and `--delete-images` to clear the registry |

Scaling up is a manifest change: `instanceType` (lite → standard-4) and, **for stateless apps only**,
`instances`/`maxInstances` > 1 (requests are spread across N containers; no autoscaling yet).

## When something breaks

Start from the symptom table in `references/troubleshooting.md`. It covers:
- CORS errors that are really cold starts
- the 403 that is really the free plan
- "container is not listening"
- secrets that didn't change
- deploys that report "no changes"
- custom domains that don't resolve
- `SignatureDoesNotMatch` on uploads

Use `$CFDEPLOY logs --target backend` for anything happening inside the container.

## Reference files

| File | Read it when |
|---|---|
| `references/manifest.md` | You are editing `cloudflare.deploy.json`. It covers every field, stages, naming, and the env vars injected into the container. |
| `references/storage.md` | You are choosing storage, adding uploads (backend and frontend code), working with SQLite or Litestream, or using an external DB. |
| `references/auth.md` | You are choosing between `wrangler login` and a token, need the exact token permissions, or are setting up CI. |
| `references/nextjs.md` | The frontend is Next.js. |
| `references/troubleshooting.md` | Something failed, or you want to change one of the guardrails. |
