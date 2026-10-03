#!/usr/bin/env node
// cfdeploy — deploy a FastAPI (Cloudflare Containers) + React/Next static (Workers Static Assets)
// app with R2 storage and custom subdomains, driven by cloudflare.deploy.json.
// Run from the app repo root:  node <skill>/scripts/cfdeploy.mjs <command> [--stage name]

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cf from "./lib/cf.mjs";
import { MANIFEST_FILE, hostnames, loadContext } from "./lib/manifest.mjs";
import {
  DeployError, copyIfMissing, extractJson, fail, fmt, log, parseArgs, parseEnvFile, readJson, run, runLive, sleep, today,
  upsertEnvFile, writeJson,
} from "./lib/util.mjs";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tpl = (p) => path.join(SKILL_DIR, "templates", p);
const R2_KEY_VARS = ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];

const HELP = `cfdeploy — Cloudflare deploy for FastAPI + React/Next apps

Usage: node cfdeploy.mjs <command> [options]

Commands
  init        Detect the project, write ${MANIFEST_FILE} (if missing) and scaffold deploy/ + Dockerfile
              --app <slug> --zone <example.com> --frontend-host <app.example.com>
              --backend-host <api.example.com> --files --sqlite --public-host <files.example.com>
  preflight   Check tools, login, account, plan, zone, hostname conflicts, secrets, Dockerfile
  storage     Create R2 buckets, CORS, public bucket domain, and bucket-scoped S3 keys
              --r2-keys-from-token  derive S3 keys from CLOUDFLARE_API_TOKEN (account-wide; ask first)
  backend     Build + push image, deploy the Worker + Container with secrets (always rolls the container)
              --image-tag <tag>  reuse an already-pushed image (skip build)   --rollout gradual
              --push-prod-managed  also push secrets listed in prodManagedSecrets
              --dry-run  generate config + \`wrangler deploy --dry-run\` only (no build, push or upload)
  frontend    Build the frontend with the API URL baked in and deploy it as static assets (--dry-run too)
  deploy      preflight → storage → backend → frontend → smoke   (--only backend|frontend)
  smoke       Verify DNS/TLS, SPA fallback, /health through the container, and CORS
  status      Show what is deployed
  rollback    --target backend [--to <image-tag>]  |  --target frontend [--to <version-id>]
  logs        Live logs: --target backend|frontend
  teardown    Delete this stage's Workers/containers: --confirm <app>[-<stage>]
              [--delete-buckets  empty + delete its R2 buckets]  [--delete-images  remove its registry images]

Global options
  --stage <name>        production (default) or a stage defined under "stages"
  --takeover <host>     allow replacing an existing DNS record/custom domain for <host> (ask the user first!)
`;

// ------------------------------------------------------------------ init

function detectProject(root) {
  const exists = (p) => fs.existsSync(path.join(root, p));
  const det = {};
  const feDir = ["frontend", "web", "client", "ui", "apps/web", "app"].find((d) => exists(`${d}/package.json`));
  if (feDir) {
    const pkg = readJson(path.join(root, feDir, "package.json"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    det.frontend = { dir: feDir, framework: deps.next ? "next-static" : deps.vite ? "vite" : "static" };
    det.frontend.apiUrlVar = findApiVar(path.join(root, feDir), det.frontend.framework);
  }
  const beDir = ["backend", "api", "server", "service"].find((d) => exists(`${d}/requirements.txt`) || exists(`${d}/pyproject.toml`));
  if (beDir) {
    const abs = path.join(root, beDir);
    det.backend = {
      dir: beDir,
      deps: depsStyle(abs),
      ...findAsgi(abs),
      hasDockerfile: fs.existsSync(path.join(abs, "Dockerfile")),
    };
    const envFile = [".env", ".env.production"].map((f) => path.join(abs, f)).find((f) => fs.existsSync(f));
    det.backend.envFile = envFile ? path.relative(root, envFile) : `${beDir}/.env`;
    det.backend.secrets = Object.keys(parseEnvFile(envFile)).filter(
      (k) => !/^(CLOUDFLARE_|R2_|APP_STAGE$|FRONTEND_ORIGINS$|PUBLIC_API_URL$)/.test(k)
    );
  }
  return det;
}

function depsStyle(abs) {
  if (fs.existsSync(path.join(abs, "requirements.txt"))) return "requirements";
  if (fs.existsSync(path.join(abs, "uv.lock"))) return "uv";
  return "pyproject";
}

function* walk(dir, depth = 0) {
  if (depth > 6 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", ".venv", "venv", "dist", "out", ".next", "__pycache__", "build", ".generated"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else yield p;
  }
}

function findApiVar(feAbs, framework) {
  const re = framework === "next-static" ? /process\.env\.(NEXT_PUBLIC_[A-Z0-9_]*(?:API|BACKEND)[A-Z0-9_]*)/ : /import\.meta\.env\.(VITE_[A-Z0-9_]*(?:API|BACKEND)[A-Z0-9_]*)/;
  for (const f of walk(feAbs)) {
    if (!/\.(t|j)sx?$|\.vue$|\.svelte$/.test(f)) continue;
    const m = fs.readFileSync(f, "utf8").match(re);
    if (m) return m[1];
  }
  return null;
}

function findAsgi(beAbs) {
  for (const f of walk(beAbs)) {
    if (!f.endsWith(".py")) continue;
    const src = fs.readFileSync(f, "utf8");
    if (!/FastAPI\(/.test(src)) continue;
    let mod = path.relative(beAbs, f).replace(/\.py$/, "").split(path.sep).join(".");
    // src/ layout: the importable package lives under src/, so it must be on PYTHONPATH.
    const pythonPath = mod.startsWith("src.") ? "src" : null;
    if (pythonPath) mod = mod.slice(4);
    const v = src.match(/^(\w+)\s*(?::\s*FastAPI\s*)?=\s*FastAPI\(/m);
    if (v) return { asgi: `${mod}:${v[1]}`, asgiFactory: false, pythonPath };
    const fn = src.match(/^def (\w+)\([^)]*\)\s*(?:->\s*FastAPI)?\s*:/m);
    if (fn) return { asgi: `${mod}:${fn[1]}`, asgiFactory: true, pythonPath };
  }
  return { asgi: "app.main:app", asgiFactory: false, pythonPath: null };
}

function buildManifest(root, det, args) {
  const zone = args.zone || "example.com";
  const m = {
    app: args.app || path.basename(root).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app",
    zone,
    compatibilityDate: today(),
  };
  if (det.frontend) {
    m.frontend = {
      dir: det.frontend.dir,
      framework: det.frontend.framework,
      build: "npm run build",
      hostname: args["frontend-host"] || `app.${zone}`,
      apiUrlVar: det.frontend.apiUrlVar || (det.frontend.framework === "next-static" ? "NEXT_PUBLIC_API_URL" : "VITE_API_URL"),
      buildEnv: {},
    };
  }
  if (det.backend) {
    m.backend = {
      dir: det.backend.dir,
      asgi: det.backend.asgi,
      ...(det.backend.asgiFactory ? { asgiFactory: true } : {}),
      ...(det.backend.pythonPath ? { pythonPath: det.backend.pythonPath } : {}),
      hostname: args["backend-host"] || `api.${zone}`,
      port: 8000,
      healthPath: "/health",
      instanceType: "standard-1",
      instances: 1,
      maxInstances: 1,
      sleepAfter: "30m",
      envFile: det.backend.envFile,
      vars: {},
      secrets: det.backend.secrets,
      prodManagedSecrets: [],
    };
  }
  m.storage = {
    files: { enabled: !!args.files },
    sqlite: { enabled: !!args.sqlite, paths: ["/data/app.db"] },
    public: { enabled: !!args["public-host"], hostname: args["public-host"] || `files.${zone}` },
  };
  return m;
}

function renderDockerfile(b, sqlite, deps) {
  const port = b.port || 8000;
  const uvicorn = ["uvicorn", b.asgi || "app.main:app", ...(b.asgiFactory ? ["--factory"] : []), "--host", "0.0.0.0", "--port", String(port), "--proxy-headers", "--forwarded-allow-ips=*"];
  const install = {
    requirements: "COPY requirements.txt .\nRUN pip install -r requirements.txt",
    uv: 'COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv\nCOPY pyproject.toml uv.lock ./\nRUN uv sync --frozen --no-dev --no-install-project\nENV PATH="/app/.venv/bin:$PATH"',
    pyproject: "",
  }[deps];
  const postCopy = [deps === "uv" ? "RUN uv sync --frozen --no-dev" : deps === "pyproject" ? "RUN pip install ." : "", sqlite ? "RUN chmod +x /app/cfdeploy-entrypoint.sh" : ""]
    .filter(Boolean)
    .join("\n");
  const system = sqlite
    ? [
        "# Litestream streams SQLite changes to R2 (storage.sqlite).",
        "ARG LITESTREAM_VERSION=0.3.13",
        "RUN apt-get update \\",
        " && apt-get install -y --no-install-recommends ca-certificates curl \\",
        ' && curl -fsSL -o /tmp/litestream.deb "https://github.com/benbjohnson/litestream/releases/download/v${LITESTREAM_VERSION}/litestream-v${LITESTREAM_VERSION}-linux-$(dpkg --print-architecture).deb" \\',
        " && dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb \\",
        " && rm -rf /var/lib/apt/lists/*",
        "ENV DATA_DIR=/data",
      ].join("\n")
    : "";
  const pyPath = b.pythonPath ? `ENV PYTHONPATH=/app/${b.pythonPath}` : "";
  const cmd = sqlite ? 'CMD ["/app/cfdeploy-entrypoint.sh"]' : `CMD ${JSON.stringify(uvicorn)}`;
  return {
    dockerfile: (c) =>
      c
        .replace("__SYSTEM_PACKAGES__", [system, pyPath].filter(Boolean).join("\n"))
        .replace("__INSTALL_DEPS__", install)
        .replace("__POST_COPY__", postCopy)
        .replace("__PORT__", String(port))
        .replace("__CMD__", cmd)
        .replace(/\n{3,}/g, "\n\n"),
    appCmd: uvicorn.join(" "),
  };
}

function litestreamYml(paths) {
  const dbs = paths
    .map(
      (p) => `  - path: ${p}
    replicas:
      - type: s3
        bucket: \${R2_DB_BUCKET}
        path: ${path.posix.basename(p)}
        endpoint: \${R2_ENDPOINT}
        access-key-id: \${R2_ACCESS_KEY_ID}
        secret-access-key: \${R2_SECRET_ACCESS_KEY}`
    )
    .join("\n");
  return `# Generated by cloudflare-app-deploy. Values come from env vars injected by the edge Worker.\ndbs:\n${dbs}\n`;
}

async function cmdInit(args) {
  const root = path.resolve(args.root || process.cwd());
  const manifestPath = path.join(root, MANIFEST_FILE);
  log(fmt.step("Project setup"));
  if (!fs.existsSync(manifestPath)) {
    const det = detectProject(root);
    if (!det.frontend && !det.backend) fail(`Could not find a frontend (package.json) or backend (requirements.txt/pyproject.toml) under ${root}.`);
    writeJson(manifestPath, buildManifest(root, det, args));
    log(fmt.ok(`wrote ${MANIFEST_FILE}`));
    if (det.frontend) log(fmt.info(`frontend: ${det.frontend.dir} (${det.frontend.framework}), API URL env var: ${det.frontend.apiUrlVar || "none found — check apiUrlVar"}`));
    if (det.backend) log(fmt.info(`backend: ${det.backend.dir} (${det.backend.deps}), ASGI app: ${det.backend.asgi}${det.backend.asgiFactory ? " (factory)" : ""}${det.backend.pythonPath ? ` (PYTHONPATH ${det.backend.pythonPath})` : ""}, secrets from ${det.backend.envFile}: ${det.backend.secrets.join(", ") || "none"} — remove any the code doesn't read`));
  } else log(fmt.info(`${MANIFEST_FILE} already exists — leaving it untouched`));

  const m = readJson(manifestPath);
  const deployDir = path.join(root, "deploy");
  const app = m.app || "app";
  const wrote = [];
  const put = (src, dest, t) => copyIfMissing(tpl(src), path.join(root, dest), t) && wrote.push(dest);
  put("deploy/package.json", "deploy/package.json", (c) => c.replaceAll("__APP__", app));
  put("deploy/tsconfig.json", "deploy/tsconfig.json");
  put("deploy/gitignore", "deploy/.gitignore");
  put("deploy/backend/src/index.ts", "deploy/backend/src/index.ts");

  if (m.backend) {
    const beDir = m.backend.dir || "backend";
    const ctxDir = m.backend.buildContext || beDir;
    const sqlite = !!m.storage?.sqlite?.enabled;
    const r = renderDockerfile(m.backend, sqlite, depsStyle(path.join(root, beDir)));
    put("backend/Dockerfile", m.backend.dockerfile || `${ctxDir}/Dockerfile`, r.dockerfile);
    put("backend/dockerignore", `${ctxDir}/.dockerignore`);
    // Top-level module next to the app's package so `from cloudflare_runtime import …` works both in the
    // container and in local dev (src/ layouts keep it inside src/).
    put("backend/cloudflare_runtime.py", `${beDir}/${m.backend.pythonPath ? `${m.backend.pythonPath}/` : ""}cloudflare_runtime.py`);
    if (sqlite) {
      const paths = m.storage.sqlite.paths || ["/data/app.db"];
      put("backend/cfdeploy-entrypoint.sh", `${ctxDir}/cfdeploy-entrypoint.sh`, (c) => c.replace("__APP_CMD__", r.appCmd).replace("__DB_PATHS__", paths.join(" ")));
      const yml = path.join(root, ctxDir, "litestream.yml");
      if (!fs.existsSync(yml)) {
        fs.writeFileSync(yml, litestreamYml(paths));
        wrote.push(`${ctxDir}/litestream.yml`);
      }
    }
    // The env file holds real secrets — make sure git never sees it.
    const envRel = m.backend.envFile || `${beDir}/.env`;
    if (run("git", ["-C", root, "rev-parse"]).code === 0 && run("git", ["-C", root, "check-ignore", "-q", envRel]).code === 1) {
      fs.appendFileSync(path.join(root, ".gitignore"), `\n# secrets (cloudflare-app-deploy)\n${envRel}\n`);
      wrote.push(`.gitignore (+ ${envRel})`);
    }
  }
  for (const w of wrote) log(fmt.ok(`created ${w}`));

  if (!args["no-install"]) {
    log(fmt.info("Installing deploy toolchain (deploy/node_modules)…"));
    runLive("npm", ["install", "--no-fund", "--no-audit"], { cwd: deployDir });
  }
  try {
    loadContext({ root });
    log(fmt.ok(`${MANIFEST_FILE} is valid`));
  } catch (e) {
    if (!(e instanceof DeployError)) throw e;
    log(fmt.warn(`Finish ${MANIFEST_FILE} before deploying:\n${e.message}`));
  }
}

// ------------------------------------------------------------------ preflight

async function preflight(ctx, args, { needDocker = true } = {}) {
  log(fmt.step(`Preflight (${ctx.stage})`));
  const blocks = [];
  const ok = (m) => log(fmt.ok(m));
  const warn = (m) => log(fmt.warn(m));
  const block = (m) => {
    blocks.push(m);
    log(fmt.err(m));
  };
  const takeover = [].concat(args.takeover || []);

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    fail(`Node ${process.versions.node} is too old — wrangler 4 needs Node 22+. Switch first (e.g. \`nvm install 22 && nvm use 22\`, or \`volta install node@22\`).`);
  }
  ok(`Node ${process.versions.node}`);
  cf.ensureDeployDeps(ctx);

  const who = cf.whoami(ctx);
  if (!who.loggedIn) {
    fail(
      `Not authenticated with Cloudflare. Either:\n` +
        `    • interactive: cd deploy && npx wrangler login\n` +
        `    • CI/agents:   export CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=…  (permissions: references/auth.md)`
    );
  }
  ok(`Authenticated (${who.authType || "unknown"}${who.email ? `, ${who.email}` : ""})`);
  try {
    cf.resolveAccountId(ctx, who);
    ok(`Account ${ctx.accountId}`);
  } catch (e) {
    if (!(e instanceof DeployError)) throw e;
    block(e.message);
  }

  if (ctx.backend && ctx.accountId) {
    const r = cf.wrangler(ctx, ["containers", "list", "--json"], { allowFail: true });
    if (r.code === 0) ok("Containers available on this account");
    else {
      const out = (r.stderr + r.stdout).slice(-600);
      if (/403|401|unauthori[sz]ed|forbidden|not entitled|subscription|paid/i.test(out))
        block(`Cannot use Containers. Either the account is not on the Workers Paid plan (required for Containers), or the API token lacks "Containers: Edit".\n    ${out.trim().split("\n").pop()}`);
      else warn(`Could not list containers: ${out.trim().split("\n").pop()}`);
    }
  }

  let zone = null;
  const hosts = hostnames(ctx);
  if (hosts.length && ctx.accountId) {
    zone = await cf.getZone(ctx);
    if (zone.error) warn(`Could not verify zone ${ctx.zone} (${zone.error}) — needs Zone:Read; continuing`);
    else if (zone.notFound) block(`Zone ${ctx.zone} is not in account ${ctx.accountId}. Custom domains require the domain's DNS to be on Cloudflare in the same account.`);
    else if (zone.status !== "active") block(`Zone ${ctx.zone} is "${zone.status}", not active — finish nameserver setup first.`);
    else ok(`Zone ${ctx.zone} active (${zone.id})`);

    for (const h of hosts) {
      const verdict = await hostnameVerdict(ctx, zone, h);
      if (verdict.ok) ok(`${h.hostname}: ${verdict.msg}`);
      else if (takeover.includes(h.hostname)) warn(`${h.hostname}: ${verdict.msg} — will be REPLACED (--takeover)`);
      else block(`${h.hostname}: ${verdict.msg}\n    wrangler would silently take it over in non-interactive mode. Ask the user; if they confirm, re-run with --takeover ${h.hostname}`);
    }
  }

  if (ctx.backend && needDocker) {
    const d = run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    if (d.code === 0) ok(`Docker ${d.stdout.trim()}`);
    else block(`Docker is not running (needed to build the backend image). Start Docker Desktop / the docker daemon.`);
  }

  if (ctx.backend) {
    const b = ctx.backend;
    const env = parseEnvFile(b.envFileAbs);
    const rel = path.relative(ctx.root, b.envFileAbs);
    if (!fs.existsSync(b.envFileAbs) && b.secrets.length) warn(`${rel} not found — secrets must come from the process environment`);
    for (const s of b.secrets) {
      const has = !!(env[s] || process.env[s]);
      if (b.prodManagedSecrets.includes(s)) {
        if (!has) warn(`${s} is prod-managed and not set locally — it must already exist on the Worker`);
      } else if (!has) block(`Secret ${s} is empty/missing in ${rel} (and not in the environment)`);
    }
    if (b.secrets.length) ok(`${b.secrets.length} secret(s) declared, values found in ${rel}/environment`);
    if (fs.existsSync(b.envFileAbs) && run("git", ["-C", ctx.root, "check-ignore", "-q", b.envFileAbs]).code === 1)
      block(`${rel} is NOT gitignored — add it to .gitignore before deploying`);
    if (ctx.storage.files || ctx.storage.sqlite || ctx.storage.public) {
      if (R2_KEY_VARS.every((k) => env[k] || process.env[k])) ok("R2 S3 keys present");
      else warn("R2 S3 keys not set yet — `storage` will create them");
    }
    lintDockerfile(ctx, { ok, warn, block });
  }

  if (ctx.frontend) {
    const f = ctx.frontend;
    if (!fs.existsSync(path.join(f.dirAbs, "package.json"))) block(`frontend: ${path.relative(ctx.root, f.dirAbs)}/package.json not found`);
    else ok(`Frontend ${path.relative(ctx.root, f.dirAbs)} (${f.framework})`);
    if (f.framework === "next-static") {
      const cfgFile = ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"].map((n) => path.join(f.dirAbs, n)).find((p) => fs.existsSync(p));
      const src = cfgFile ? fs.readFileSync(cfgFile, "utf8") : "";
      if (!/output\s*:\s*["']export["']/.test(src))
        block(`Next.js must use static export: add  output: "export"  (and images: { unoptimized: true }) to next.config. For SSR see references/nextjs.md.`);
    }
    if (ctx.backend && !srcMentions(f.dirAbs, f.apiUrlVar)) warn(`frontend code never reads ${f.apiUrlVar} — the API URL will not reach the app (set frontend.apiUrlVar)`);
  }

  if (blocks.length) fail(`Preflight found ${blocks.length} blocking problem(s). Fix them and re-run.`);
  log(fmt.ok("Preflight passed"));
  return { who, zone };
}

function srcMentions(dir, needle) {
  for (const f of walk(dir)) if (/\.(t|j)sx?$|\.vue$|\.svelte$|\.py$/.test(f) && fs.readFileSync(f, "utf8").includes(needle)) return true;
  return false;
}

async function hostnameVerdict(ctx, zone, h) {
  const domains = await cf.api(ctx, "GET", `/accounts/${ctx.accountId}/workers/domains?hostname=${encodeURIComponent(h.hostname)}`);
  const attached = domains.ok ? (domains.result || []).find((d) => d.hostname === h.hostname) : null;
  if (attached) {
    if (h.kind === "worker" && attached.service === h.service) return { ok: true, msg: `already attached to ${h.service}` };
    return { ok: false, msg: `already a custom domain of Worker "${attached.service}"` };
  }
  if (h.kind === "r2") {
    const r = cf.wrangler(ctx, ["r2", "bucket", "domain", "list", h.bucket], { allowFail: true });
    if (r.code === 0 && r.stdout.includes(h.hostname)) return { ok: true, msg: `already attached to bucket ${h.bucket}` };
  }
  if (zone?.id) {
    const recs = await cf.api(ctx, "GET", `/zones/${zone.id}/dns_records?name=${encodeURIComponent(h.hostname)}`);
    if (recs.ok) {
      const r = (recs.result || [])[0];
      return r ? { ok: false, msg: `existing DNS record ${r.type} → ${r.content}` } : { ok: true, msg: "free" };
    }
  }
  // No DNS read permission (e.g. wrangler OAuth login): fall back to public DNS.
  const answers = [...((await cf.doh(h.hostname, "A")) || []), ...((await cf.doh(h.hostname, "CNAME")) || [])];
  return answers.length ? { ok: false, msg: `already resolves in public DNS (${answers[0].data})` } : { ok: true, msg: "free (public DNS)" };
}

function lintDockerfile(ctx, { ok, warn, block }) {
  const b = ctx.backend;
  if (!fs.existsSync(b.dockerfileAbs)) return block(`Dockerfile not found at ${path.relative(ctx.root, b.dockerfileAbs)} — run init or write one`);
  const src = fs.readFileSync(b.dockerfileAbs, "utf8");
  const expose = src.match(/^EXPOSE\s+(\d+)/m);
  if (expose && Number(expose[1]) !== b.port) warn(`Dockerfile EXPOSEs ${expose[1]} but backend.port is ${b.port}`);
  const cmd = src.match(/^(CMD|ENTRYPOINT)\s+(.*)$/m);
  if (cmd && !cmd[2].trim().startsWith("[")) warn(`Dockerfile ${cmd[1]} uses shell form — use exec form ["…"] so SIGTERM reaches the app`);
  if (/--host[ =](127\.0\.0\.1|localhost)/.test(src)) block(`Dockerfile binds to localhost — the server must listen on 0.0.0.0`);
  if (ctx.storage.sqlite && !/litestream/.test(src) && !fs.existsSync(path.join(b.buildContextAbs, "cfdeploy-entrypoint.sh")))
    block(`storage.sqlite is enabled but the Dockerfile does not install/run Litestream — data would be lost on every restart`);
  if (!srcMentions(b.dirAbs, `"${b.healthPath}"`) && !srcMentions(b.dirAbs, `'${b.healthPath}'`))
    warn(`No ${b.healthPath} route found in the backend — add one (cloudflare_runtime.install(app) does)`);
  ok(`Dockerfile ${path.relative(ctx.root, b.dockerfileAbs)}`);
}

// ------------------------------------------------------------------ storage

async function cmdStorage(ctx, args) {
  const s = ctx.storage;
  const buckets = [s.files, s.sqlite, s.public].filter(Boolean);
  if (!buckets.length) return log(fmt.info("No storage enabled in the manifest — skipping"));
  log(fmt.step(`R2 storage (${ctx.stage})`));
  cf.ensureDeployDeps(ctx);
  if (!ctx.accountId) cf.resolveAccountId(ctx, cf.whoami(ctx));

  for (const b of buckets) {
    const r = cf.wrangler(ctx, ["r2", "bucket", "create", b.bucket], { allowFail: true });
    const out = r.stdout + r.stderr;
    if (r.code === 0) log(fmt.ok(`created bucket ${b.bucket}`));
    else if (/already exists|already own/i.test(out)) log(fmt.ok(`bucket ${b.bucket} exists`));
    else fail(`Could not create bucket ${b.bucket}:\n${out.trim().slice(-800)}`);
  }

  const origins = [ctx.frontend?.origin, ...(ctx.backend?.extraOrigins || [])].filter(Boolean);
  if (s.files) {
    const all = [...origins, ...(ctx.isProd ? [] : s.files.devOrigins)];
    if (s.files.browserUploads && all.length) {
      setCors(ctx, s.files.bucket, all, ["GET", "PUT", "HEAD"]);
      log(fmt.ok(`CORS on ${s.files.bucket} for ${all.join(", ")} (presigned uploads/downloads)`));
    }
  }
  if (s.public) {
    if (origins.length) setCors(ctx, s.public.bucket, origins, ["GET", "HEAD"]);
    const listed = cf.wrangler(ctx, ["r2", "bucket", "domain", "list", s.public.bucket], { allowFail: true });
    if (listed.code === 0 && listed.stdout.includes(s.public.hostname)) log(fmt.ok(`${s.public.hostname} already serves ${s.public.bucket}`));
    else {
      const zone = await cf.getZone(ctx);
      if (!zone.id) fail(`Need the zone id of ${ctx.zone} to attach ${s.public.hostname} (${zone.error || "zone not found"}).`);
      cf.wrangler(ctx, ["r2", "bucket", "domain", "add", s.public.bucket, "--domain", s.public.hostname, "--zone-id", zone.id, "--min-tls", "1.2", "--force"], { live: true });
      log(fmt.ok(`attached ${s.public.hostname} → ${s.public.bucket} (activates within a few minutes)`));
    }
  }

  // S3 credentials for the container (a container has no R2 binding of its own).
  if (!ctx.backend) return;
  const envFile = ctx.backend.envFileAbs;
  const rel = path.relative(ctx.root, envFile);
  const env = { ...parseEnvFile(envFile) };
  for (const k of R2_KEY_VARS) env[k] = env[k] || process.env[k];
  const names = buckets.map((b) => b.bucket);
  if (!(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY)) {
    let keys;
    let source;
    if (args["r2-keys-from-token"]) {
      log(fmt.warn("Deriving R2 S3 keys from the deploy token (--r2-keys-from-token): they can reach every bucket the token can."));
      keys = await cf.deriveR2KeysFromToken(ctx);
      source = "derived from the deploy API token — rotating that token rotates these";
    } else {
      log(fmt.info(`Creating a bucket-scoped R2 token for ${names.join(", ")}…`));
      keys = await cf.createScopedR2Keys(ctx, names, `${ctx.app}${ctx.isProd ? "" : `-${ctx.stage}`} R2 (cloudflare-app-deploy)`);
      source = `bucket-scoped token for ${names.join(", ")}`;
    }
    if (keys.error)
      fail(
        `Could not get R2 keys automatically (${keys.error}). Expected with \`wrangler login\` or a token without "Account API Tokens: Edit". Pick one:\n` +
          `  A) (recommended) dashboard → R2 → Manage API tokens → Create Account API token → "Object Read & Write" →\n` +
          `     apply to buckets: ${names.join(", ")}. Add to ${rel}:\n       R2_ACCESS_KEY_ID="<Access Key ID>"\n       R2_SECRET_ACCESS_KEY="<Secret Access Key>"\n     then re-run.\n` +
          `  B) with a CLOUDFLARE_API_TOKEN that has R2 Edit: re-run with --r2-keys-from-token (keys reach ALL buckets the token can — ask the user first).`
      );
    upsertEnvFile(envFile, { R2_ACCESS_KEY_ID: keys.accessKeyId, R2_SECRET_ACCESS_KEY: keys.secretAccessKey }, `R2 S3 keys: ${source} (cloudflare-app-deploy ${today()})`);
    Object.assign(env, { R2_ACCESS_KEY_ID: keys.accessKeyId, R2_SECRET_ACCESS_KEY: keys.secretAccessKey });
    log(fmt.ok(`wrote R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY to ${rel}`));
  }
  for (const bucket of names) {
    let status = 0;
    for (let i = 0; i < 8; i++) {
      status = await cf.r2HeadBucket({ accountId: ctx.accountId, bucket, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY });
      if (status === 200) break;
      await sleep(4000); // new tokens take a few seconds to propagate
    }
    if (status !== 200) fail(`R2 keys in ${rel} cannot access bucket ${bucket} (HTTP ${status}). Remove them and re-run storage, or fix the token's bucket scope.`);
    log(fmt.ok(`R2 keys verified on ${bucket}`));
  }
}

function setCors(ctx, bucket, origins, methods) {
  // wrangler's CORS file format (differs from the S3/dashboard format).
  const rules = { rules: [{ allowed: { origins, methods, headers: ["*"] }, exposeHeaders: ["ETag", "Content-Length", "Content-Type"], maxAgeSeconds: 3600 }] };
  const file = path.join(ctx.genDir, `r2-cors-${bucket}.json`);
  writeJson(file, rules);
  cf.wrangler(ctx, ["r2", "bucket", "cors", "set", bucket, "--file", file, "--force"]);
}

// ------------------------------------------------------------------ backend

function imageTag(root) {
  const sha = run("git", ["-C", root, "rev-parse", "--short", "HEAD"]);
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // Always unique: reusing a tag makes Cloudflare report "no changes" and keep the old container,
  // and a fresh tag is also what restarts the container so new secrets take effect.
  return `${sha.code === 0 ? sha.stdout.trim() : "nogit"}-${ts}`;
}

function backendVars(ctx, secretNames) {
  const b = ctx.backend;
  const s = ctx.storage;
  const origins = [ctx.frontend?.origin, ...b.extraOrigins].filter(Boolean);
  const container = {
    APP_STAGE: ctx.stage,
    FRONTEND_ORIGINS: origins.join(","),
    PUBLIC_API_URL: b.url || "",
    ...(s.files || s.sqlite || s.public ? { R2_ACCOUNT_ID: ctx.accountId, R2_ENDPOINT: `https://${ctx.accountId}.r2.cloudflarestorage.com` } : {}),
    ...(s.files ? { R2_BUCKET: s.files.bucket } : {}),
    ...(s.sqlite ? { R2_DB_BUCKET: s.sqlite.bucket } : {}),
    ...(s.public ? { R2_PUBLIC_BUCKET: s.public.bucket, R2_PUBLIC_BASE_URL: s.public.baseUrl } : {}),
    ...b.vars,
  };
  return {
    ...container,
    CONTAINER_PORT: String(b.port),
    SLEEP_AFTER: String(b.sleepAfter),
    INSTANCES: String(b.instances),
    ...(b.region ? { REGION: b.region } : {}),
    CONTAINER_ENV_KEYS: [...new Set([...Object.keys(container), ...secretNames])].join(","),
  };
}

const DRY_RUN_ACCOUNT = "00000000000000000000000000000000";

/** Resolve the account; in --dry-run, fall back to a placeholder when not logged in. */
function ensureAccount(ctx, args) {
  if (ctx.accountId) return;
  const who = cf.whoami(ctx);
  if (!who.loggedIn && args["dry-run"]) {
    ctx.accountId = DRY_RUN_ACCOUNT;
    log(fmt.warn("Not logged in — dry run uses a placeholder account id"));
    return;
  }
  if (!who.loggedIn) fail("Not authenticated with Cloudflare — run preflight for instructions.");
  cf.resolveAccountId(ctx, who);
}

function collectSecrets(ctx, args) {
  const b = ctx.backend;
  const env = parseEnvFile(b.envFileAbs);
  const needR2 = !!(ctx.storage.files || ctx.storage.sqlite || ctx.storage.public);
  const names = [...new Set([...b.secrets, ...(needR2 ? R2_KEY_VARS : [])])];
  const values = {};
  const missing = [];
  const kept = [];
  for (const n of names) {
    if (b.prodManagedSecrets.includes(n) && !args["push-prod-managed"]) {
      kept.push(n); // managed directly on the Worker (dashboard / wrangler secret put) — never overwritten from a laptop
      continue;
    }
    const v = env[n] || process.env[n];
    if (v) values[n] = v;
    else missing.push(n); // pushing an empty secret "configures" an integration that then fails every call
  }
  if (missing.length) {
    const msg = `Missing values for secret(s): ${missing.join(", ")} (looked in ${path.relative(ctx.root, b.envFileAbs)} and the environment).${missing.some((m) => R2_KEY_VARS.includes(m)) ? " Run `storage` to create R2 keys." : ""}`;
    if (!args["dry-run"]) fail(msg);
    log(fmt.warn(`${msg} (ignored for dry run)`));
  }
  return { names, values, kept };
}

function backendConfig(ctx, imageRef, vars) {
  const b = ctx.backend;
  const rel = (p) => path.relative(ctx.genDir, p).split(path.sep).join("/");
  return {
    $schema: rel(path.join(ctx.deployDir, "node_modules/wrangler/config-schema.json")),
    name: b.workerName,
    main: rel(path.join(ctx.deployDir, "backend/src/index.ts")),
    account_id: ctx.accountId,
    compatibility_date: ctx.compatibilityDate,
    compatibility_flags: ["nodejs_compat"],
    workers_dev: b.workersDev,
    routes: b.hostname ? [{ pattern: b.hostname, custom_domain: true }] : [],
    observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true } },
    vars,
    containers: [{ class_name: "Backend", image: imageRef, instance_type: b.instanceType, max_instances: b.maxInstances }],
    durable_objects: { bindings: [{ name: "BACKEND", class_name: "Backend" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["Backend"] }],
  };
}

/** Image the container app is configured with right now (undefined = app doesn't exist yet). */
function containerAppImage(ctx) {
  const name = `${ctx.backend.workerName}-backend`; // wrangler names it <worker>-<lowercased class>
  const list = cf.wrangler(ctx, ["containers", "list", "--json"], { allowFail: true });
  let app;
  try {
    app = JSON.parse(list.stdout).find((a) => a.name === name);
  } catch {
    return null;
  }
  if (!app) return undefined;
  const info = cf.wrangler(ctx, ["containers", "info", app.id], { allowFail: true });
  return extractJson(info.stdout)?.configuration?.image ?? null;
}

async function waitForContainerImage(ctx, imageRef, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (containerAppImage(ctx) === imageRef) return true;
    if (Date.now() - start > timeoutMs) return false;
    await sleep(10_000);
  }
}

function history(ctx) {
  const f = path.join(ctx.genDir, "history.json");
  return { file: f, entries: fs.existsSync(f) ? readJson(f) : [] };
}

async function cmdBackend(ctx, args) {
  if (!ctx.backend) return log(fmt.info("No backend in the manifest — skipping"));
  const b = ctx.backend;
  const dry = !!args["dry-run"];
  log(fmt.step(`Backend → ${b.url || b.workerName} (${ctx.stage})${dry ? " [dry run]" : ""}`));
  cf.ensureDeployDeps(ctx);
  ensureAccount(ctx, args);
  const secrets = collectSecrets(ctx, args);

  let tag = args["image-tag"];
  if (tag) log(fmt.info(`Reusing pushed image ${b.imageName}:${tag} (no build)`));
  else if (dry) tag = "dry-run";
  else {
    tag = imageTag(ctx.root);
    const localTag = `${b.imageName}:${tag}`;
    // Built with docker directly (same flags wrangler uses) plus a per-deploy label. The label makes
    // every image digest unique: `wrangler containers build --push` skips pushing an image whose
    // digest already exists remotely, so an unchanged build never got its new tag and the rollout
    // failed with IMAGE_REGISTRY_DOESNT_CONTAIN_IMAGE. Unique digests also guarantee the container
    // restarts on every deploy, which is how changed secrets take effect.
    runLive("docker", ["build", "--load", "--platform", "linux/amd64", "--provenance=false", "--label", `cfdeploy.build=${tag}`, "-t", localTag, "-f", b.dockerfileAbs, b.buildContextAbs]);
    cf.wrangler(ctx, ["containers", "push", localTag], { live: true });
    run("docker", ["image", "rm", localTag]);
  }

  const imageRef = `registry.cloudflare.com/${ctx.accountId}/${b.imageName}:${tag}`;
  const configFile = path.join(ctx.genDir, "backend.wrangler.json");
  writeJson(configFile, backendConfig(ctx, imageRef, backendVars(ctx, secrets.names)));
  if (dry) {
    cf.wrangler(ctx, ["deploy", "--config", configFile, "--dry-run", "--outdir", path.join(ctx.genDir, "backend-dry-run")], { live: true });
    log(fmt.ok(`Dry run OK — config at ${path.relative(ctx.root, configFile)}; secrets that would be uploaded: ${Object.keys(secrets.values).join(", ") || "none"}`));
    return;
  }

  // Cloudflare's container-app state lags a rollout by ~30-60s. Wrangler diffs against that state,
  // so a deploy fired too soon after the previous one sees "no changes" and silently keeps the old
  // image (seen live during a rollback). Let the previous rollout settle first, then verify ours.
  const last = history(ctx).entries.at(-1);
  if (last && Date.now() - Date.parse(last.at) < 180_000 && containerAppImage(ctx) !== last.imageRef) {
    log(fmt.info("Waiting for the previous rollout to register before deploying…"));
    await waitForContainerImage(ctx, last.imageRef, 120_000);
  }

  const deployOnce = () => {
    const secretsFile = path.join(os.tmpdir(), `cfdeploy-${crypto.randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(secretsFile, JSON.stringify(secrets.values), { mode: 0o600 });
    try {
      const rollout = args.rollout === "gradual" ? "gradual" : "immediate";
      cf.wrangler(ctx, ["deploy", "--config", configFile, "--secrets-file", secretsFile, "--containers-rollout", rollout, "--message", `cfdeploy ${ctx.stage} image ${tag}`], { live: true });
    } finally {
      fs.rmSync(secretsFile, { force: true });
    }
  };
  deployOnce();
  if (secrets.kept.length) log(fmt.info(`kept remote values for prod-managed secrets: ${secrets.kept.join(", ")}`));

  log(fmt.info("Verifying the container app picked up the new image…"));
  if (!(await waitForContainerImage(ctx, imageRef, 120_000))) {
    log(fmt.warn("Container app still reports the previous image — redeploying once (wrangler likely compared against stale state)"));
    deployOnce();
    if (!(await waitForContainerImage(ctx, imageRef, 180_000)))
      fail(`The Worker deployed but the container app is not on ${tag}. Check \`cd deploy && npx wrangler containers list\` and re-run \`backend --image-tag ${tag}\`.`);
  }
  log(fmt.ok(`Container app is on image ${tag}`));

  const h = history(ctx);
  h.entries.push({ at: new Date().toISOString(), tag, imageRef });
  writeJson(h.file, h.entries.slice(-50));
  log(fmt.ok(`Backend deployed: ${b.url || b.workerName}  (image ${tag})`));
  log(fmt.info("First deploys take a few minutes to provision the container; `smoke` waits for it."));
}

// ------------------------------------------------------------------ frontend

function installFrontendDeps(f) {
  if (f.install) return runLive(f.install, [], { cwd: f.dirAbs, shell: true });
  if (fs.existsSync(path.join(f.dirAbs, "node_modules"))) return;
  const has = (n) => fs.existsSync(path.join(f.dirAbs, n));
  const cmd = has("pnpm-lock.yaml") ? "pnpm install --frozen-lockfile" : has("yarn.lock") ? "yarn install --frozen-lockfile" : has("bun.lockb") || has("bun.lock") ? "bun install" : has("package-lock.json") ? "npm ci" : "npm install";
  runLive(cmd, [], { cwd: f.dirAbs, shell: true });
}

const IMMUTABLE_ASSETS = {
  vite: "/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  "next-static": "/_next/static/*\n  Cache-Control: public, max-age=31536000, immutable\n",
  static: "",
};

async function cmdFrontend(ctx, args) {
  if (!ctx.frontend) return log(fmt.info("No frontend in the manifest — skipping"));
  const f = ctx.frontend;
  const dry = !!args["dry-run"];
  log(fmt.step(`Frontend → ${f.origin || f.workerName} (${ctx.stage})${dry ? " [dry run]" : ""}`));
  cf.ensureDeployDeps(ctx);
  ensureAccount(ctx, args);

  installFrontendDeps(f);
  const buildEnv = { ...f.buildEnv, ...(ctx.backend?.url ? { [f.apiUrlVar]: ctx.backend.url } : {}), NEXT_TELEMETRY_DISABLED: "1" };
  log(fmt.info(`Build env: ${Object.entries(buildEnv).map(([k, v]) => `${k}=${v}`).join(" ")}`));
  runLive(f.build, [], { cwd: f.dirAbs, shell: true, env: buildEnv });
  if (!fs.existsSync(path.join(f.outputAbs, "index.html")))
    fail(`Build output ${path.relative(ctx.root, f.outputAbs)}/index.html not found.${f.framework === "next-static" ? ' Next.js needs output: "export" in next.config.' : " Check frontend.outputDir."}`);

  const headersFile = path.join(f.outputAbs, "_headers");
  if (!fs.existsSync(headersFile))
    fs.writeFileSync(headersFile, `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: SAMEORIGIN\n${IMMUTABLE_ASSETS[f.framework]}`);

  const rel = (p) => path.relative(ctx.genDir, p).split(path.sep).join("/");
  const config = {
    $schema: rel(path.join(ctx.deployDir, "node_modules/wrangler/config-schema.json")),
    name: f.workerName,
    account_id: ctx.accountId,
    compatibility_date: ctx.compatibilityDate,
    assets: { directory: rel(f.outputAbs), not_found_handling: f.framework === "vite" ? "single-page-application" : "404-page" },
    workers_dev: f.workersDev,
    routes: f.hostname ? [{ pattern: f.hostname, custom_domain: true }] : [],
    observability: { enabled: true },
  };
  const configFile = path.join(ctx.genDir, "frontend.wrangler.json");
  writeJson(configFile, config);
  if (dry) {
    cf.wrangler(ctx, ["deploy", "--config", configFile, "--dry-run"], { live: true });
    return log(fmt.ok(`Dry run OK — config at ${path.relative(ctx.root, configFile)}`));
  }
  cf.wrangler(ctx, ["deploy", "--config", configFile, "--message", `cfdeploy ${ctx.stage}`], { live: true });
  log(fmt.ok(`Frontend deployed: ${f.origin || f.workerName}`));
}

// ------------------------------------------------------------------ smoke

async function waitFor(label, fn, { timeoutMs, everyMs = 10000 }) {
  const start = Date.now();
  let last;
  process.stdout.write(fmt.info(`${label} `));
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last.pass) {
      process.stdout.write(`✔ (${Math.round((Date.now() - start) / 1000)}s)\n`);
      return last;
    }
    process.stdout.write(`${last.status || "·"} `);
    await sleep(everyMs);
  }
  process.stdout.write("✘\n");
  return last;
}

async function cmdSmoke(ctx) {
  log(fmt.step(`Smoke test (${ctx.stage})`));
  const failures = [];
  const check = (cond, okMsg, badMsg) => {
    if (cond) log(fmt.ok(okMsg));
    else {
      failures.push(badMsg);
      log(fmt.err(badMsg));
    }
  };
  const f = ctx.frontend;
  const b = ctx.backend;

  if (f?.origin) {
    const r = await waitFor(`GET ${f.origin}/`, async () => {
      const p = await cf.probe(`${f.origin}/`);
      return { ...p, pass: p.status === 200 && /text\/html/.test(p.headers["content-type"] || "") };
    }, { timeoutMs: 5 * 60_000 });
    check(r.pass, `frontend serves HTML at ${f.origin}`, `frontend ${f.origin} → ${r.status || r.error} (DNS/certificate can take a few minutes on first deploy — re-run smoke)`);
    if (f.framework === "vite" && r.pass) {
      const deep = await cf.probe(`${f.origin}/cfdeploy/deep/link`);
      check(deep.status === 200, "SPA deep links fall back to index.html", `deep link returned ${deep.status} — SPA fallback not active`);
    }
  }

  if (b?.url) {
    const edge = await waitFor(`GET ${b.url}/__cfdeploy/health (edge)`, async () => {
      const p = await cf.probe(`${b.url}/__cfdeploy/health`);
      return { ...p, pass: p.status === 200 };
    }, { timeoutMs: 5 * 60_000 });
    check(edge.pass, `API edge Worker reachable at ${b.url}`, `API edge ${b.url} → ${edge.status || edge.error}`);
    if (edge.pass) {
      const health = await waitFor(`GET ${b.url}${b.healthPath} (container; first boot can take minutes)`, async () => {
        const p = await cf.probe(`${b.url}${b.healthPath}`, { timeoutMs: 200_000 });
        return { ...p, pass: p.status === 200 };
      }, { timeoutMs: 10 * 60_000, everyMs: 15000 });
      check(health.pass, `container answers ${b.healthPath}`, `container ${b.healthPath} → ${health.status || health.error} ${(health.body || "").slice(0, 200)} — check \`logs --target backend\``);
      if (f?.origin) {
        const pre = await cf.probe(`${b.url}${b.healthPath}`, {
          method: "OPTIONS",
          headers: { Origin: f.origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,authorization" },
        });
        check(pre.status === 204 && pre.headers["access-control-allow-origin"] === f.origin, `CORS preflight from ${f.origin} allowed`, `CORS preflight → ${pre.status}, allow-origin=${pre.headers["access-control-allow-origin"]}`);
        const get = await cf.probe(`${b.url}${b.healthPath}`, { headers: { Origin: f.origin } });
        check(get.headers["access-control-allow-origin"] === f.origin, `CORS headers on API responses`, `API response lacks Access-Control-Allow-Origin for ${f.origin}`);
      }
    }
  }

  if (ctx.storage.public) {
    const p = await waitFor(`HTTPS ${ctx.storage.public.baseUrl}`, async () => {
      const r = await cf.probe(`${ctx.storage.public.baseUrl}/`);
      return { ...r, pass: r.status > 0 && r.status < 500 };
    }, { timeoutMs: 3 * 60_000 });
    check(p.pass, `public bucket domain ${ctx.storage.public.hostname} serves over TLS`, `public bucket domain → ${p.status || p.error} (activation can take a few minutes)`);
  }

  if (failures.length) fail(`Smoke test: ${failures.length} check(s) failed.`);
  log(fmt.ok("All smoke checks passed"));
}

// ------------------------------------------------------------------ status / rollback / logs / teardown

async function cmdStatus(ctx) {
  cf.ensureDeployDeps(ctx);
  const who = cf.whoami(ctx);
  if (!who.loggedIn) fail("Not authenticated (see preflight).");
  cf.resolveAccountId(ctx, who);
  log(fmt.step(`Status (${ctx.stage}) — account ${ctx.accountId}`));
  for (const [label, part] of [["frontend", ctx.frontend], ["backend", ctx.backend]]) {
    if (!part) continue;
    const r = cf.wrangler(ctx, ["deployments", "list", "--name", part.workerName, "--json"], { allowFail: true });
    let latest = null;
    try {
      const list = JSON.parse(r.stdout);
      latest = list[list.length - 1] || list[0];
    } catch {}
    const when = latest ? `deployed ${latest.created_on} (${latest.annotations?.["workers/message"] || latest.id})` : r.code === 0 ? "" : "not deployed";
    log(fmt.info(`${label}: ${part.workerName}  ${part.hostname ? `https://${part.hostname}` : ""}  ${when}`));
  }
  if (ctx.backend) {
    const h = history(ctx).entries;
    if (h.length) log(fmt.info(`backend image (last deploy from this machine): ${h[h.length - 1].tag}`));
    const c = cf.wrangler(ctx, ["containers", "list", "--json"], { allowFail: true });
    try {
      for (const app of JSON.parse(c.stdout).filter((a) => (a.name || "").includes(ctx.backend.workerName)))
        log(fmt.info(`container app ${app.name}: ${JSON.stringify(app.health || app.state || {})}`));
    } catch {}
  }
}

async function cmdRollback(ctx, args) {
  const target = args.target || args._[1];
  if (target === "frontend") {
    cf.ensureDeployDeps(ctx);
    cf.wrangler(ctx, ["rollback", ...(args.to ? [args.to] : []), "--name", ctx.frontend.workerName, "-y", "-m", "cfdeploy rollback"], { live: true });
    return log(fmt.ok("Frontend rolled back"));
  }
  if (target !== "backend") fail("rollback needs --target backend|frontend");
  let tag = args.to;
  if (!tag) {
    // Previous = most recent deployed tag that differs from the current one (history may contain repeats).
    const entries = history(ctx).entries;
    const current = entries.at(-1)?.tag;
    tag = [...entries].reverse().find((e) => e.tag !== current)?.tag;
    if (!tag) {
      const r = cf.wrangler(ctx, ["containers", "images", "list", "--filter", ctx.backend.imageName, "--json"], { allowFail: true });
      fail(`No previous image recorded on this machine. Pick a tag and pass --to <tag>:\n${r.stdout.slice(0, 2000)}`);
    }
  }
  log(fmt.info(`Rolling backend back to image ${tag} (redeploys that image; secrets/vars come from the current manifest)`));
  await cmdBackend(ctx, { ...args, "image-tag": tag });
}

async function cmdLogs(ctx, args) {
  const part = (args.target || args._[1]) === "frontend" ? ctx.frontend : ctx.backend;
  if (!part) fail("Nothing to tail for that target.");
  cf.ensureDeployDeps(ctx);
  cf.wrangler(ctx, ["tail", part.workerName, "--format", "pretty"], { live: true, allowFail: true });
}

async function cmdTeardown(ctx, args) {
  const expected = ctx.isProd ? ctx.app : `${ctx.app}-${ctx.stage}`;
  if (args.confirm !== expected)
    fail(`This deletes the ${ctx.stage} Workers, container app and custom domains. Re-run with --confirm ${expected} (add --delete-buckets to also DELETE ALL DATA in its R2 buckets, --delete-images to remove registry images).`);
  cf.ensureDeployDeps(ctx);
  cf.resolveAccountId(ctx, cf.whoami(ctx));
  log(fmt.step(`Teardown ${expected}`));
  for (const part of [ctx.frontend, ctx.backend].filter(Boolean)) {
    const code = cf.wrangler(ctx, ["delete", "--name", part.workerName, "--force"], { live: true, allowFail: true });
    log(code === 0 ? fmt.ok(`deleted Worker ${part.workerName}`) : fmt.warn(`could not delete ${part.workerName}`));
  }
  if (ctx.backend) {
    const c = cf.wrangler(ctx, ["containers", "list", "--json"], { allowFail: true });
    try {
      for (const app of JSON.parse(c.stdout).filter((a) => (a.name || "").startsWith(ctx.backend.workerName))) {
        const code = cf.wrangler(ctx, ["containers", "delete", app.id], { live: true, allowFail: true });
        log(code === 0 ? fmt.ok(`deleted container app ${app.name}`) : fmt.warn(`could not delete container app ${app.name}`));
      }
    } catch {}
  }
  if (args["delete-buckets"]) {
    if (ctx.storage.public) cf.wrangler(ctx, ["r2", "bucket", "domain", "remove", ctx.storage.public.bucket, "--domain", ctx.storage.public.hostname, "--force"], { live: true, allowFail: true });
    const env = ctx.backend ? parseEnvFile(ctx.backend.envFileAbs) : {};
    const creds = { accountId: ctx.accountId, accessKeyId: env.R2_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY };
    for (const b of [ctx.storage.files, ctx.storage.sqlite, ctx.storage.public].filter(Boolean)) {
      if (creds.accessKeyId && creds.secretAccessKey) {
        try {
          const n = await cf.r2EmptyBucket(creds, b.bucket);
          log(fmt.ok(`emptied ${b.bucket} (${n} objects)`));
        } catch (e) {
          log(fmt.warn(`could not empty ${b.bucket}: ${e.message}`));
        }
      }
      const code = cf.wrangler(ctx, ["r2", "bucket", "delete", b.bucket], { live: true, allowFail: true });
      log(code === 0 ? fmt.ok(`deleted bucket ${b.bucket}`) : fmt.warn(`bucket ${b.bucket} not deleted (must be empty first)`));
    }
    // Revoke the bucket-scoped token only if this tool created it (never a derived deploy token).
    if (creds.accessKeyId) {
      const t = await cf.api(ctx, "GET", `/accounts/${ctx.accountId}/tokens/${creds.accessKeyId}`);
      if (t.ok && /cloudflare-app-deploy/.test(t.result?.name || "")) {
        const d = await cf.api(ctx, "DELETE", `/accounts/${ctx.accountId}/tokens/${creds.accessKeyId}`);
        log(d.ok ? fmt.ok(`revoked R2 token "${t.result.name}"`) : fmt.warn(`could not revoke R2 token (${d.message})`));
      }
    }
  }
  if (args["delete-images"] && ctx.backend) {
    const r = cf.wrangler(ctx, ["containers", "images", "list", "--filter", `^${ctx.backend.imageName}$`, "--json"], { allowFail: true });
    let tags = [];
    try {
      tags = (JSON.parse(r.stdout).find((i) => i.name === ctx.backend.imageName) || {}).tags || [];
    } catch {}
    for (const t of tags) {
      const code = cf.wrangler(ctx, ["containers", "images", "delete", `${ctx.backend.imageName}:${t}`, "--skip-confirmation"], { allowFail: true }).code;
      log(code === 0 ? fmt.ok(`deleted image ${ctx.backend.imageName}:${t}`) : fmt.warn(`could not delete image ${t}`));
    }
  } else if (ctx.backend) log(fmt.info("Images stay in the registry (add --delete-images to remove them)."));
  if (args["delete-buckets"]) log(fmt.info("Remove the R2_* lines from the env file — those buckets are gone."));
}

// ------------------------------------------------------------------ main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || args.help || cmd === "help") return log(HELP);
  if (cmd === "init") return cmdInit(args);

  const ctx = loadContext({ stage: args.stage || "production" });
  const only = args.only;
  switch (cmd) {
    case "preflight":
      return preflight(ctx, args, { needDocker: !args["image-tag"] });
    case "storage":
      return cmdStorage(ctx, args);
    case "backend":
      return cmdBackend(ctx, args);
    case "frontend":
      return cmdFrontend(ctx, args);
    case "smoke":
      return cmdSmoke(ctx);
    case "deploy": {
      await preflight(ctx, args, { needDocker: only !== "frontend" && !args["image-tag"] });
      if (only !== "frontend") {
        await cmdStorage(ctx, args);
        await cmdBackend(ctx, args);
      }
      if (only !== "backend") await cmdFrontend(ctx, args);
      await cmdSmoke(ctx);
      log(fmt.step("Done"));
      if (ctx.frontend?.origin) log(fmt.ok(`App:   ${ctx.frontend.origin}`));
      if (ctx.backend?.url) log(fmt.ok(`API:   ${ctx.backend.url}`));
      if (ctx.storage.public) log(fmt.ok(`Files: ${ctx.storage.public.baseUrl}`));
      return;
    }
    case "status":
      return cmdStatus(ctx);
    case "rollback":
      return cmdRollback(ctx, args);
    case "logs":
      return cmdLogs(ctx, args);
    case "teardown":
      return cmdTeardown(ctx, args);
    default:
      fail(`Unknown command "${cmd}".\n${HELP}`);
  }
}

main().catch((e) => {
  if (e instanceof DeployError) {
    log(fmt.err(e.message));
    process.exit(1);
  }
  console.error(e);
  process.exit(1);
});
