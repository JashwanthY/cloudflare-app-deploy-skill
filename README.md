# ☁️ cloudflare-app-deploy

**Ship your Python + React app to Cloudflare by asking your AI coding agent.**
A skill for Claude Code, Cursor and similar agents that deploys a **FastAPI backend** and a
**React or Next.js frontend** to Cloudflare, with custom subdomains, storage and safety checks included.

```
You:    "Deploy this app to Cloudflare — frontend on app.mydomain.com, API on api.mydomain.com"
Agent:  reads your code → small fixes → safety checks → deploys → tests it live → ✅ done
```

---

## 📖 Why this exists

You've built an app with a **Python (FastAPI) backend** and a **React or Next.js frontend**.
It works on `localhost`. Now you want it live, on your own domain, without hiring DevOps or
spending a weekend reading docs.

Cloudflare can run the whole stack, but you have to wire a lot of pieces together yourself:

| You need | Cloudflare product |
|---|---|
| Run FastAPI | **Containers** (plus a Worker and Durable Object in front) |
| Serve React / Next.js | **Workers Static Assets** |
| Store uploads and databases | **R2** |
| `app.` / `api.` subdomains with HTTPS | **Custom Domains** |

On top of that come CORS, secrets, cold starts, Docker images and rollbacks. Each one has
traps that only show up in production.

AI agents can try all of this, but they **improvise**. In testing (below), agents without this skill:
- rewrote the backend onto a different platform,
- picked a Next.js tool Cloudflare now keeps for existing apps only,
- suggested a command that silently left old code running.

**This skill gives the agent a tested recipe.** It follows the same steps every time and comes
with guardrails taken from real production incidents.

---

## 🎯 Who it's for

This skill is **deliberately narrow**, because that's what makes it reliable:

| Your project | Supported |
|---|:--:|
| 🐍 Python **FastAPI** backend | ✅ |
| ⚛️ **React** (Vite) frontend | ✅ |
| ▲ **Next.js** frontend (static export) | ✅ |
| 🗄️ SQLite, file uploads, or a hosted Postgres (Neon, Supabase…) | ✅ |
| 🌐 A domain whose DNS is on Cloudflare | ✅ required |
| Next.js that needs server-side rendering | ❌ |
| Django / Node / Go backends, multiple services, queues | ❌ (not yet) |

It expects a repo shaped like this (folder names can vary):

```
my-app/
├── backend/    FastAPI   (requirements.txt or pyproject.toml, .env)
└── frontend/   React/Vite or Next.js   (calls the API through an env var)
```

---

## 🏗️ What you get

```
  https://app.yourdomain.com   ──►  Frontend   static site on Cloudflare's edge (fast, cheap)
  https://api.yourdomain.com   ──►  FastAPI    in a Cloudflare Container
                                        │
                                        ▼
                                  R2 storage    uploads · SQLite backup · public files
```

The skill also handles:
- ✔️ HTTPS and DNS for your subdomains
- ✔️ CORS that works even while the backend is waking up
- ✔️ Secrets uploaded encrypted, never baked into the image
- ✔️ Data that survives restarts
- ✔️ A live test after every deploy
- ✔️ One-command rollback

---

## ✨ What makes it different

| | Typical "deploy to Cloudflare" | **This skill** |
|---|---|---|
| Setup | Hand-written Wrangler configs | **One small settings file**, everything else generated |
| Your existing subdomains | Can be overwritten silently | **Checked first**; never taken over without your OK |
| Changing a secret | `wrangler secret put` doesn't reach the running container | **Every deploy restarts the container** with the new secrets |
| SQLite / uploads | Lost when the container restarts | **Persisted to R2** automatically |
| "CORS error" on cold start | Common and confusing | **Handled at the edge** |
| Proof it worked | "Deployed!" | **Live smoke test**: HTTPS, pages, API health, CORS |
| Tested | — | **Real deploy, plus an agent benchmark** (see below) |

---

## 🚀 Quick start

### 1. Prerequisites (one time)

- [ ] **Node.js 22+** (`node -v`)
- [ ] **Docker** running
- [ ] A **Cloudflare account on the Workers Paid plan** ($5/mo, required for Containers)
- [ ] Your **domain's DNS on Cloudflare**

### 2. Install the skill (one time)

```bash
git clone https://github.com/JashwanthY/cloudflare-app-deploy-skill.git
cp -R cloudflare-app-deploy-skill/cloudflare-app-deploy ~/.claude/skills/
```

> Using Cursor or another agent? Point it at the folder: *"Read `cloudflare-app-deploy/SKILL.md` and follow it."*

### 3. Connect to Cloudflare (pick one, both work)

| | 🧑‍💻 **Option A: Wrangler login** | 🤖 **Option B: API token** |
|---|---|---|
| **Best for** | Your laptop | CI, servers, unattended agents |
| **How** | `npx wrangler login` (browser opens → Approve) | `export CLOUDFLARE_API_TOKEN=…`<br>`export CLOUDFLARE_ACCOUNT_ID=…` |
| **Secret to manage** | None | Yes, store it securely |
| **Storage keys** | One quick dashboard step, the first time only | Automatic |

> ⚠️ **Never paste a token into the chat.** Put it in your environment, and the agent picks it up automatically.
> Exact token permissions: [`references/auth.md`](cloudflare-app-deploy/references/auth.md).

### 4. Ask your agent

Open your project and say:

> **"Deploy this app to Cloudflare using the cloudflare-app-deploy skill.
> Frontend on `app.mydomain.com`, API on `api.mydomain.com`."**

### 5. Watch it work

```
 1. 🔍 Reads your code        where data is saved, which values are secrets, how the frontend calls the API
 2. ✏️  Small code changes     CORS, /health, storage → shows you the diff
 3. 🛡️  Safety checks          login, plan, domain, subdomains free, secrets, Dockerfile
 4. 🙋 Asks you to confirm
 5. 🚀 Deploys                 storage → API → frontend
 6. 🧪 Tests it live           HTTPS, pages, API health, CORS
 7. 📋 Reports                 live URLs + what was created + commands for later
```

⏱️ The first deploy takes a few minutes while Cloudflare starts the container and issues certificates.

---

## 🔁 Everyday commands

Ask your agent in plain English, or run them yourself:

```bash
CFDEPLOY="node ~/.claude/skills/cloudflare-app-deploy/scripts/cfdeploy.mjs"
```

| I want to… | Command |
|---|---|
| Ship backend changes | `$CFDEPLOY backend` |
| Ship frontend changes | `$CFDEPLOY frontend` |
| Change a secret | edit `backend/.env`, then run `$CFDEPLOY backend` |
| Undo a bad release | `$CFDEPLOY rollback --target backend` *(or `frontend`)* |
| See live logs | `$CFDEPLOY logs --target backend` |
| See what's deployed | `$CFDEPLOY status` |
| Try it without deploying | `$CFDEPLOY backend --dry-run` |
| Add a staging copy | add `stages.staging` to the settings file, then `$CFDEPLOY deploy --stage staging` |

---

## 💾 Where your data goes

Container disks are wiped on every restart, so the skill moves your data somewhere safe:

| Your data | Goes to |
|---|---|
| 📎 Uploads & generated files | Private R2 bucket (with presigned upload/download links) |
| 🗄️ SQLite database | Kept on the container, streamed to R2 about every second, and restored on restart |
| 🐘 Hosted Postgres | Stays where it is, as a `DATABASE_URL` secret |
| 🖼️ Public images & downloads | Public R2 bucket on `files.yourdomain.com` |

---

## 📊 Does it actually work?

### ✅ Tested with a real deploy (Oct 2026)

A sample FastAPI + SQLite + React app was deployed to a real Cloudflare account and domain, then fully removed:

| Check | Result |
|---|:--:|
| Frontend + API live on their own subdomains with HTTPS | ✅ |
| Uploads stored in R2 and downloadable | ✅ |
| Data still there after **3 container restarts** | ✅ |
| Rollback (API and frontend) | ✅ |
| Full teardown, nothing left behind | ✅ |

The live test also surfaced **two Cloudflare quirks** that don't appear in the docs. The skill now handles both:
- **Unchanged code couldn't be redeployed.** The image push gets skipped when nothing changed, so the deploy failed.
- **A quick second deploy could silently do nothing.** Cloudflare's container state lags behind the deploy, so a deploy started too soon changed nothing.

### 📈 Benchmark: AI agent with vs. without this skill

The same model got the same three realistic tasks, once **with** the skill and once **without**:

| Task | With skill | Without skill |
|---|:--:|:--:|
| 📝 Notes app: FastAPI + SQLite + uploads + React | **10 / 10** | 6 / 10 |
| 📊 Dashboard: Next.js + FastAPI + Postgres | **10 / 10** | 9 / 10 |
| 🔧 Debug: "CORS errors" + "new API key not used" | **6 / 6** | 5 / 6 |
| **Overall pass rate** | **🟢 100%** | 🟡 78% |
| Average time per task | 310 s | 373 s |

**Without the skill**, agents produced working setups, but each took a different path, and some had hidden problems: wrong platform, deprecated tooling, a fix that doesn't actually fix anything.
**With the skill**, every run followed the same tested path.

<sub>Small sample (3 tasks, 1 run each), so treat it as a sanity check rather than a scientific result. The prompts and graded checks are in
[`cloudflare-app-deploy/evals/evals.json`](cloudflare-app-deploy/evals/evals.json). Verified with Wrangler 4.147.0 and @cloudflare/containers 0.3.7.</sub>

---

## 📚 Learn more

| File | What's inside |
|---|---|
| [`SKILL.md`](cloudflare-app-deploy/SKILL.md) | The step-by-step instructions the agent follows |
| [`references/auth.md`](cloudflare-app-deploy/references/auth.md) | Login vs. token, exact permissions, GitHub Actions example |
| [`references/manifest.md`](cloudflare-app-deploy/references/manifest.md) | Every setting in `cloudflare.deploy.json` |
| [`references/storage.md`](cloudflare-app-deploy/references/storage.md) | Uploads, SQLite and Postgres, with code examples |
| [`references/nextjs.md`](cloudflare-app-deploy/references/nextjs.md) | Making Next.js work as a static export |
| [`references/troubleshooting.md`](cloudflare-app-deploy/references/troubleshooting.md) | Something broke → symptom, cause, fix |

---

## 🤝 Contributing

Ideas, bug reports and PRs are welcome, especially support for more backends (Django, Node)
and Next.js server-side rendering. Please open an issue first for big changes.

MIT licensed. See [LICENSE](LICENSE).
