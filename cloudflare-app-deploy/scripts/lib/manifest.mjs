// Loads cloudflare.deploy.json, applies a stage overlay, validates it, and derives every
// resource name so the rest of the tooling never invents names on its own.

import fs from "node:fs";
import path from "node:path";
import { fail, readJson } from "./util.mjs";

export const MANIFEST_FILE = "cloudflare.deploy.json";
export const INSTANCE_TYPES = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];
export const REGIONS = ["wnam", "enam", "sam", "weur", "eeur", "apac", "oc", "afr", "me"];

// Env vars the tooling injects into the container itself. Apps read these; manifests must not redefine them.
export const RESERVED_VARS = [
  "APP_STAGE",
  "FRONTEND_ORIGINS",
  "PUBLIC_API_URL",
  "R2_ACCOUNT_ID",
  "R2_ENDPOINT",
  "R2_BUCKET",
  "R2_DB_BUCKET",
  "R2_PUBLIC_BUCKET",
  "R2_PUBLIC_BASE_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
];
// Worker-only control vars (not forwarded to the container).
const CONTROL_VARS = ["CONTAINER_PORT", "SLEEP_AFTER", "INSTANCES", "REGION", "CONTAINER_ENV_KEYS"];

function isObj(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

export function findRoot(start = process.cwd()) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, MANIFEST_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Returns a fully-resolved deployment context for one stage.
 * `production` is the default stage and uses unsuffixed names; any other stage gets `-<stage>`.
 */
export function loadContext({ root, stage = "production" } = {}) {
  root = root || findRoot();
  if (!root) fail(`No ${MANIFEST_FILE} found here or in any parent directory. Run \`init\` first.`);
  const manifestPath = path.join(root, MANIFEST_FILE);
  const raw = readJson(manifestPath);
  const { stages = {}, ...base } = raw;
  if (stage !== "production" && !stages[stage])
    fail(`Stage "${stage}" is not defined under "stages" in ${MANIFEST_FILE}. Defined: ${Object.keys(stages).join(", ") || "none"}.`);
  const m = stage === "production" ? base : deepMerge(base, stages[stage]);
  const suffix = stage === "production" ? "" : `-${stage}`;

  const errors = [];
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  need(typeof m.app === "string" && /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(m.app), `"app" must be a lowercase slug (a-z, 0-9, -), got ${JSON.stringify(m.app)}`);
  const app = m.app;
  const zone = m.zone;
  const checkHost = (h, label) => {
    if (!h) return;
    need(typeof zone === "string" && zone.length > 0, `"zone" is required when ${label} is set`);
    need(!/change-me|example\.com/i.test(h), `${label} "${h}" is still a placeholder — ask the user which subdomain to use`);
    need(h === zone || h.endsWith(`.${zone}`), `${label} "${h}" is not inside zone "${zone}"`);
  };

  const deployDir = path.join(root, "deploy");
  const ctx = {
    root,
    manifestPath,
    stage,
    isProd: stage === "production",
    app,
    zone,
    accountId: m.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || null,
    compatibilityDate: m.compatibilityDate || "2026-10-01",
    deployDir,
    genDir: path.join(deployDir, ".generated", stage),
    frontend: null,
    backend: null,
    storage: { files: null, sqlite: null, public: null },
  };

  // ---------- frontend ----------
  if (m.frontend) {
    const f = m.frontend;
    const framework = f.framework || "vite";
    need(["vite", "next-static", "static"].includes(framework), `frontend.framework must be vite | next-static | static, got "${framework}"`);
    checkHost(f.hostname, "frontend.hostname");
    need(!!f.hostname || f.workersDev, `frontend.hostname is required (or set frontend.workersDev: true for a *.workers.dev URL only)`);
    const dirAbs = path.resolve(root, f.dir || "frontend");
    const outputDir = f.outputDir || (framework === "next-static" ? "out" : "dist");
    ctx.frontend = {
      ...f,
      framework,
      dirAbs,
      outputAbs: path.resolve(dirAbs, outputDir),
      install: f.install ?? null,
      build: f.build || "npm run build",
      hostname: f.hostname || null,
      origin: f.hostname ? `https://${f.hostname}` : null,
      apiUrlVar: f.apiUrlVar || (framework === "next-static" ? "NEXT_PUBLIC_API_URL" : "VITE_API_URL"),
      buildEnv: f.buildEnv || {},
      workerName: `${app}-web${suffix}`,
      workersDev: !!f.workersDev,
    };
  }

  // ---------- backend ----------
  if (m.backend) {
    const b = m.backend;
    checkHost(b.hostname, "backend.hostname");
    need(!!b.hostname || b.workersDev, `backend.hostname is required (or set backend.workersDev: true for a *.workers.dev URL only)`);
    const instanceType = b.instanceType || "standard-1";
    need(
      INSTANCE_TYPES.includes(instanceType) || (isObj(instanceType) && instanceType.vcpu && instanceType.memory_mib),
      `backend.instanceType must be one of ${INSTANCE_TYPES.join(", ")} or {vcpu, memory_mib, disk_mb}`
    );
    const instances = b.instances ?? 1;
    const maxInstances = b.maxInstances ?? Math.max(instances, 1);
    need(Number.isInteger(instances) && instances >= 1, `backend.instances must be an integer >= 1`);
    need(Number.isInteger(maxInstances) && maxInstances >= instances, `backend.maxInstances (${maxInstances}) must be >= backend.instances (${instances})`);
    need(!b.region || REGIONS.includes(b.region), `backend.region must be one of ${REGIONS.join(", ")}`);
    const vars = b.vars || {};
    const secrets = b.secrets || [];
    need(Array.isArray(secrets) && secrets.every((s) => typeof s === "string"), `backend.secrets must be an array of env var names`);
    for (const k of Object.keys(vars)) {
      need(typeof vars[k] === "string", `backend.vars.${k} must be a string (Worker vars are strings)`);
      need(!RESERVED_VARS.includes(k) && !CONTROL_VARS.includes(k), `backend.vars.${k} is set automatically by the tooling — remove it`);
      need(!secrets.includes(k), `${k} is listed in both backend.vars and backend.secrets`);
    }
    for (const s of secrets) need(!CONTROL_VARS.includes(s), `backend.secrets: ${s} is a reserved name`);
    const dirAbs = path.resolve(root, b.dir || "backend");
    const buildContextAbs = path.resolve(root, b.buildContext || b.dir || "backend");
    ctx.backend = {
      ...b,
      dirAbs,
      buildContextAbs,
      dockerfileAbs: path.resolve(root, b.dockerfile || path.join(path.relative(root, buildContextAbs), "Dockerfile")),
      hostname: b.hostname || null,
      url: b.hostname ? `https://${b.hostname}` : null,
      port: b.port || 8000,
      healthPath: b.healthPath || "/health",
      instanceType,
      instances,
      maxInstances,
      sleepAfter: b.sleepAfter || "30m",
      region: b.region || null,
      envFileAbs: path.resolve(root, b.envFile || path.join(path.relative(root, dirAbs), ".env")),
      vars,
      secrets,
      prodManagedSecrets: b.prodManagedSecrets || [],
      extraOrigins: b.extraOrigins || [],
      workerName: `${app}-api${suffix}`,
      imageName: `${app}-api${suffix}`,
      workersDev: !!b.workersDev,
    };
  }

  // ---------- storage ----------
  const s = m.storage || {};
  const bucketName = (cfg, def) => (cfg && cfg.bucket) || `${app}-${def}${suffix}`;
  if (s.files?.enabled) {
    need(!!ctx.backend, `storage.files needs a backend`);
    ctx.storage.files = {
      bucket: bucketName(s.files, "files"),
      browserUploads: s.files.browserUploads !== false,
      devOrigins: s.files.devOrigins || ["http://localhost:5173", "http://localhost:3000"],
    };
  }
  if (s.sqlite?.enabled) {
    need(!!ctx.backend, `storage.sqlite needs a backend`);
    const paths = s.sqlite.paths || ["/data/app.db"];
    need(paths.every((p) => p.startsWith("/data/")), `storage.sqlite.paths must live under /data/ (got ${paths.join(", ")})`);
    // Two containers replicating the same SQLite file to R2 fork the replica and lose writes.
    if (ctx.backend) need(ctx.backend.instances === 1 && ctx.backend.maxInstances === 1, `storage.sqlite requires backend.instances = 1 and backend.maxInstances = 1 (one writer only)`);
    ctx.storage.sqlite = { bucket: bucketName(s.sqlite, "db"), paths };
  }
  if (s.public?.enabled) {
    checkHost(s.public.hostname, "storage.public.hostname");
    need(!!s.public.hostname, `storage.public.hostname is required (r2.dev URLs are rate-limited and not for production)`);
    ctx.storage.public = { bucket: bucketName(s.public, "public"), hostname: s.public.hostname, baseUrl: `https://${s.public.hostname}` };
  }
  for (const b of [ctx.storage.files, ctx.storage.sqlite, ctx.storage.public].filter(Boolean))
    need(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(b.bucket), `bucket name "${b.bucket}" is invalid (3-63 chars, a-z 0-9 -)`);

  need(ctx.frontend || ctx.backend, `manifest needs a "frontend" and/or "backend" section`);
  const hosts = [ctx.frontend?.hostname, ctx.backend?.hostname, ctx.storage.public?.hostname].filter(Boolean);
  need(new Set(hosts).size === hosts.length, `frontend, backend and public-bucket hostnames must all be different`);

  if (errors.length) fail(`${MANIFEST_FILE} (stage ${stage}) has problems:\n  - ${errors.join("\n  - ")}`);
  return ctx;
}

/** Every hostname this stage will claim, with what should own it. */
export function hostnames(ctx) {
  const out = [];
  if (ctx.frontend?.hostname) out.push({ hostname: ctx.frontend.hostname, kind: "worker", service: ctx.frontend.workerName });
  if (ctx.backend?.hostname) out.push({ hostname: ctx.backend.hostname, kind: "worker", service: ctx.backend.workerName });
  if (ctx.storage.public) out.push({ hostname: ctx.storage.public.hostname, kind: "r2", bucket: ctx.storage.public.bucket });
  return out;
}
