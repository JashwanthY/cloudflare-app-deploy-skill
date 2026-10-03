# Troubleshooting and the reasons behind the guardrails

Most rows come from incidents in a real production app's history; the rest from Cloudflare's docs
and wrangler's source (Oct 2026). Fix causes, not symptoms. If you must change a guardrail, know
which incident it prevents.

## Symptom → cause → fix

| Symptom | Likely cause | Fix |
|---|---|---|
| Browser: "No 'Access-Control-Allow-Origin' header" on API calls, intermittently, often the first request of the day | The container was asleep or cold-starting, and the platform's error/timeout page has no CORS headers | The edge Worker in `deploy/backend/src/index.ts` answers preflights at the edge and adds CORS to platform errors. Keep that logic. If the error persists, check that `FRONTEND_ORIGINS` contains the exact origin (scheme + host, no trailing slash): look at `status`, or `vars` in `.generated/<stage>/backend.wrangler.json`. |
| CORS error on **every** call | Frontend origin not in `FRONTEND_ORIGINS`, or the app calls a different API URL than you think | Check the built bundle's API URL (`grep -r api.<zone> <outputDir>`). Add other origins to `backend.extraOrigins` and redeploy the backend. |
| `container is not listening in the TCP address 10.0.0.1:8000` or 503 "Backend is starting" for a long time | <ul><li>App slow to boot: heavy imports, migrations, SQLite restore</li><li>App listening on 127.0.0.1</li><li>Wrong port</li></ul> | <ul><li>The Worker already waits 180s; the default of 20s was too short in production.</li><li>Make sure the server binds `0.0.0.0` on `backend.port`.</li><li>Check `logs --target backend` for crash loops (missing env var, import error).</li><li>Raise `instanceType` if CPU-bound at boot.</li></ul> |
| 503 "There is no Container instance available" right after the first deploy | First-time provisioning takes several minutes | Wait, then `smoke`. |
| 503 "There is no Container instance available" later | `maxInstances` reached | Raise `maxInstances` (stateless apps only). |
| Deploy fails with `403 Authentication error` / "Unauthorized" on containers | Account is on the Workers **Free** plan (containers need Paid), *or* the token lacks Containers: Edit | Check the plan in the dashboard first; then token permissions (`auth.md`). |
| Changed a secret, app still sees the old value | Containers read env vars **only at start**, so `wrangler secret put` alone doesn't reach a running container | `$CFDEPLOY backend`. Every backend deploy uses a new image tag, which restarts the container. |
| A deploy says "no changes" and old code keeps running | An image was pushed under a tag that was already deployed; Cloudflare compares references, not bytes | Never reuse tags. The tool generates `<gitsha>-<timestamp>`. Don't hand-edit the image in the generated config. |
| Production secret got overwritten by someone's local value | Every deploy pushed every secret from a laptop `.env` | List production-only keys in `backend.prodManagedSecrets`. They're never pushed unless `--push-prod-managed`. |
| An integration "configured" but every call fails | An empty secret was pushed | The tool refuses empty values. Fill the env file or remove the name from `secrets`. |
| Literal quotes inside a secret (e.g. OpenAI 401) | `.env` parsed with grep/cut | The tool parses like python-dotenv (quotes stripped, last duplicate wins). Don't hand-roll `.env` parsing in scripts. |
| Preflight: "hostname already has a DNS record / custom domain of Worker X" | The subdomain is in use | Ask the user. Pick another subdomain, or with explicit confirmation run with `--takeover <host>`. Wrangler would replace it silently. |
| Custom domain doesn't resolve / TLS error right after deploy | DNS and certificate still provisioning, or your machine cached NXDOMAIN | Wait a few minutes. `smoke` resolves through DNS-over-HTTPS to bypass local cache. Re-run it. |
| `workers.dev` URL stopped working after adding a hostname | Adding `routes` defaults `workers_dev` to false | Set `workersDev: true` on that part if old links must keep working. |
| One Worker calling another by `*.workers.dev` URL gets error 1042 | Worker-to-Worker over workers.dev is blocked | Call the custom domain, or add a service binding (edit the generated-config logic). |
| Upload PUT to presigned URL → 403 `SignatureDoesNotMatch` | Browser sent a different `Content-Type` than was signed | Send exactly the signed type. See `storage.md`. |
| Upload works locally, CORS error in production | Bucket CORS doesn't include the production origin | Re-run `$CFDEPLOY storage`. It rewrites CORS from the manifest. |
| Request body too large (413) | Worker request limit is 100 MB on Free/Pro zones | Use presigned uploads straight to R2. |
| Data gone after restart / redeploy | Written to container disk | Move it to `storage.files`, `storage.sqlite` or an external DB. See `storage.md`. |
| SQLite data from yesterday missing after deploy | Restore failed and the app started empty, or two replicators | The entrypoint refuses to start on a failed restore. Make sure `instances` and `maxInstances` are both 1. Never run the production image locally against the production bucket. |
| `Wrangler requires at least Node.js v22` | Old Node | `nvm install 22 && nvm use 22`. |
| Rollout fails with `IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE` | `wrangler containers build --push` skips the push when an identical image digest already exists remotely, so a new tag on unchanged code never reaches the registry (seen live, Oct 2026) | The tool builds with `docker build --label cfdeploy.build=<tag>`, which makes every digest unique, then runs `wrangler containers push`. Don't switch back to `containers build --push`. |
| Deploy prints "no changes" for the container although the image tag changed, so the old image keeps running | Cloudflare's container-app state lags a rollout by ~30–60s, and a deploy fired inside that window diffs against stale state (seen live, Oct 2026) | `backend` waits for the previous rollout to register, then verifies the app's image after deploying and redeploys once if needed. If it still fails, wait a minute and run `backend --image-tag <tag>`. |
| Build can't find the Dockerfile | `backend.dockerfile` / `backend.buildContext` are wrong | The tool runs `docker build -f <dockerfile> <buildContext>`. Fix the paths in the manifest. |
| Image builds very slowly on Apple Silicon | Builds target linux/amd64 under emulation | Expected. Keep the image lean and dependency layers cached (requirements copied before code). |
| Second deploy fails with API code 100146 "version could not be found" | Known flake when deploying twice in a row | The tool deploys once per run, with secrets uploaded as part of it. Just re-run. |

## Dockerfile rules

- **Base image:** `python:3.12-slim` or similar. Build for linux/amd64; wrangler does this.
- **Listen address:** listen on `0.0.0.0:<backend.port>`, never on `localhost`.
- **Start command:** use exec-form `CMD ["uvicorn", …]` so SIGTERM reaches the app. On rollout or sleep the platform sends SIGTERM, waits, then sends SIGKILL.
- **Layer order:** copy requirements first and install them, then copy the code, so code changes don't reinstall dependencies.
- **No secrets in the image:** `.dockerignore` must exclude `.env*` and local databases. Secrets arrive as env vars at runtime.
- **Size:** keep the image small. Image pull time is part of the cold start, and image size counts against instance disk.
- **Proxy headers:** pass `--proxy-headers --forwarded-allow-ips=*`. The container sits behind Cloudflare, so scheme and client IP come from forwarded headers.
- **Multiple workers:** `uvicorn --workers N` is fine on `standard-2` and above, but in SQLite mode keep a single process writing to the DB.

## Debugging commands

```bash
$CFDEPLOY status                         # what's deployed, last image tag
$CFDEPLOY logs --target backend          # Worker + container stdout/stderr, live
$CFDEPLOY smoke                          # re-run end-to-end checks
cd deploy && npx wrangler containers list
cd deploy && npx wrangler containers images list --filter <app>-api
cd deploy && npx wrangler deployments list --name <app>-api
```

The Cloudflare dashboard (Workers & Pages → `<app>-api` → Observability) keeps 7 days of logs. Container stdout appears there when observability is enabled; the tool enables it.
