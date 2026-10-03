# cloudflare.deploy.json reference

One file at the repo root describes the whole deployment. `init` writes a first version from the
code; you edit it; every command validates it and prints precise errors.

## Full example

```json
{
  "app": "notes",
  "zone": "acme.ai",
  "accountId": "",
  "compatibilityDate": "2026-10-02",
  "frontend": {
    "dir": "frontend",
    "framework": "vite",
    "build": "npm run build",
    "outputDir": "dist",
    "hostname": "notes.acme.ai",
    "apiUrlVar": "VITE_API_URL",
    "buildEnv": { "VITE_SENTRY_DSN": "https://public@sentry.io/1" }
  },
  "backend": {
    "dir": "backend",
    "asgi": "app.main:app",
    "hostname": "notes-api.acme.ai",
    "port": 8000,
    "healthPath": "/health",
    "instanceType": "standard-1",
    "instances": 1,
    "maxInstances": 1,
    "sleepAfter": "30m",
    "region": null,
    "envFile": "backend/.env",
    "vars": { "LOG_LEVEL": "info", "MODEL_ID": "claude-sonnet-5-5" },
    "secrets": ["ANTHROPIC_API_KEY", "DATABASE_URL"],
    "prodManagedSecrets": [],
    "extraOrigins": []
  },
  "storage": {
    "files":  { "enabled": true, "browserUploads": true },
    "sqlite": { "enabled": false, "paths": ["/data/app.db"] },
    "public": { "enabled": true, "hostname": "notes-files.acme.ai" }
  },
  "stages": {
    "staging": {
      "frontend": { "hostname": "notes-staging.acme.ai" },
      "backend":  { "hostname": "notes-api-staging.acme.ai", "envFile": "backend/.env.staging", "instanceType": "basic", "sleepAfter": "5m" },
      "storage":  { "public": { "hostname": "notes-files-staging.acme.ai" } }
    }
  }
}
```

## Top level

| Field | Required | Meaning |
|---|---|---|
| `app` | yes | Lowercase slug (2–40 chars). Every resource name is derived from it. |
| `zone` | when any hostname is set | The Cloudflare zone (apex domain) the hostnames live in. It must be active in the same account. |
| `accountId` | only when the credentials see more than one account | You can also set `CLOUDFLARE_ACCOUNT_ID`. |
| `compatibilityDate` | no | Workers runtime date. `init` sets it to the current date. Change it on purpose, never automatically, because a new date can change runtime behaviour. |
| `frontend` / `backend` | at least one | Either part may be left out, for a frontend-only or API-only app. |
| `storage` | no | R2 features. See `storage.md`. |
| `stages` | no | Named overlays, deep-merged over the base. See below. |

## frontend

| Field | Default | Notes |
|---|---|---|
| `dir` | `frontend` | Folder that contains `package.json`. |
| `framework` | `vite` | One of: <ul><li>`vite`: SPA fallback, so unknown paths serve `index.html`.</li><li>`next-static`: needs `output: "export"`; unknown paths serve `404.html`.</li><li>`static`: plain HTML.</li></ul> |
| `install` | auto | The install command. By default it is detected from the lockfile, and skipped when `node_modules` exists. |
| `build` | `npm run build` | Runs inside `dir`. |
| `outputDir` | `dist` (vite) / `out` (next) | Relative to `dir`. |
| `hostname` | — | For example `app.acme.ai`. It becomes a Workers Custom Domain; DNS and the certificate are created automatically. |
| `apiUrlVar` | `VITE_API_URL` / `NEXT_PUBLIC_API_URL` | The env var the frontend code reads for the API base URL. It is set to `https://<backend.hostname>` at build time. |
| `buildEnv` | `{}` | Extra **public** build-time vars. They end up in the JS bundle, so never put secrets here. |
| `workersDev` | `false` | Also serve on `<name>.<account>.workers.dev`. |

## backend

| Field | Default | Notes |
|---|---|---|
| `dir` | `backend` | The Python project folder. |
| `buildContext` | `dir` | Docker build context. |
| `dockerfile` | `<buildContext>/Dockerfile` | It may live elsewhere; the tool copies it into the context for the build. |
| `asgi` / `asgiFactory` / `pythonPath` | detected | Used only by `init` to write the Dockerfile. `pythonPath: "src"` is set for `src/` layouts and adds `ENV PYTHONPATH=/app/src`. |
| `hostname` | — | For example `api.acme.ai`. |
| `port` | `8000` | The port the server listens on inside the container (on `0.0.0.0`). |
| `healthPath` | `/health` | Must return 200 without touching the DB or external APIs. |
| `instanceType` | picked by `init` from the code (`basic` for a plain API) | Chosen from dependencies and Dockerfile apt packages; preflight warns if set below that. Sizes and RAM:<ul><li>`lite`: 256 MiB</li><li>`basic`: 1 GiB</li><li>`standard-1`: ½ vCPU, 4 GiB</li><li>`standard-2`: 1 vCPU, 6 GiB</li><li>`standard-3`: 2 vCPU, 8 GiB</li><li>`standard-4`: 4 vCPU, 12 GiB</li><li>a custom object, `{ "vcpu": 2, "memory_mib": 8192, "disk_mb": 16000 }`</li></ul> |
| `instances` | `1` | `1` means a single container (a singleton). More than 1 spreads requests at random across N containers, which is only safe for **stateless** apps. |
| `maxInstances` | `instances` | Must be ≥ `instances`. |
| `sleepAfter` | `30m` | How long the container stays awake after the last request. Shorter is cheaper but means more cold starts (cold start: seconds, up to about a minute with large images or SQLite restore). |
| `region` | `null` | Placement hint for a singleton: `wnam`, `enam`, `weur`, `eeur`, `apac`, `oc`, … Changing it creates a fresh instance in the new region. |
| `envFile` | `<dir>/.env` | Where secret values are read from. Must be gitignored. In CI, values come from the process environment instead. |
| `vars` | `{}` | Non-secret strings. They become Worker vars and container env vars. |
| `secrets` | `[]` | Names only. Values come from `envFile` or the environment, and are uploaded encrypted with each backend deploy. |
| `prodManagedSecrets` | `[]` | A subset of `secrets` that is set directly in Cloudflare and never pushed from a laptop. Use it for production-only keys. Override with `--push-prod-managed`. |
| `extraOrigins` | `[]` | Additional browser origins allowed by CORS, for example a marketing site or `http://localhost:5173` for a staging stage. |
| `workersDev` | `false` | Also serve on `workers.dev`. |

## Naming

Names are derived; you never choose them by hand.

| Resource | production | stage `staging` |
|---|---|---|
| Frontend Worker | `<app>-web` | `<app>-web-staging` |
| Backend Worker | `<app>-api` | `<app>-api-staging` |
| Container image | `registry.cloudflare.com/<account>/<app>-api:<gitsha>-<timestamp>` | `…/<app>-api-staging:…` |
| Files bucket | `<app>-files` | `<app>-files-staging` |
| SQLite bucket | `<app>-db` | `<app>-db-staging` |
| Public bucket | `<app>-public` | `<app>-public-staging` |

Each stage gets its own buckets. Staging must never write to production data.

## Env vars the container receives

Injected automatically. Don't redefine them in `vars` (validation rejects it).

| Var | Value |
|---|---|
| `APP_STAGE` | `production`, `staging`, … (unset when running locally) |
| `FRONTEND_ORIGINS` | `https://<frontend.hostname>`, then `extraOrigins`, comma-separated |
| `PUBLIC_API_URL` | `https://<backend.hostname>` |
| `R2_ACCOUNT_ID`, `R2_ENDPOINT` | Set when any storage is on. `R2_ENDPOINT` is `https://<account>.r2.cloudflarestorage.com`. |
| `R2_BUCKET` | Files bucket (`storage.files`) |
| `R2_DB_BUCKET` | SQLite replica bucket (`storage.sqlite`) |
| `R2_PUBLIC_BUCKET`, `R2_PUBLIC_BASE_URL` | Public bucket and its `https://` base URL (`storage.public`) |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | Bucket-scoped S3 credentials (secrets) |
| your `vars` and `secrets` | as declared |

`DATA_DIR=/data` is also set by the SQLite Dockerfile.

## Stages

`--stage <name>` deep-merges `stages.<name>` over the base manifest. Objects merge, while scalars and arrays replace.

Every hostname must differ from production. Give staging its own `envFile` so it uses its own keys.

A typical staging stage looks like this:
- `instanceType: "basic"`
- `sleepAfter: "5m"`
- `extraOrigins: ["http://localhost:5173"]`, so developers can point a local frontend at the staging API.
