// Everything that talks to Cloudflare: the wrangler CLI, the REST API (using whatever
// credentials wrangler is using — OAuth login or API token), DNS-over-HTTPS, HTTPS probes,
// and SigV4-signed R2 requests for verifying S3 credentials.

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { extractJson, fail, fmt, log, run, runLive } from "./util.mjs";

const API = "https://api.cloudflare.com/client/v4";

function wranglerEnv(ctx) {
  const env = { WRANGLER_SEND_METRICS: "false", FORCE_COLOR: "0" };
  if (ctx.accountId) env.CLOUDFLARE_ACCOUNT_ID = ctx.accountId;
  return env;
}

/** Install the pinned deploy toolchain (wrangler, @cloudflare/containers) into deploy/. */
export function ensureDeployDeps(ctx) {
  const pkg = path.join(ctx.deployDir, "package.json");
  if (!fs.existsSync(pkg)) fail(`deploy/package.json is missing — run \`init\` first.`);
  if (fs.existsSync(path.join(ctx.deployDir, "node_modules", "wrangler"))) return;
  log(fmt.info("Installing deploy toolchain in deploy/ (wrangler, @cloudflare/containers)…"));
  runLive("npm", ["install", "--no-fund", "--no-audit"], { cwd: ctx.deployDir });
}

/** Run wrangler from deploy/ so the pinned version is used. */
export function wrangler(ctx, args, { live = false, allowFail = false } = {}) {
  const opts = { cwd: ctx.deployDir, env: wranglerEnv(ctx) };
  if (live) return runLive("npx", ["wrangler", ...args], { ...opts, allowFail });
  const r = run("npx", ["wrangler", ...args], opts);
  if (r.code !== 0 && !allowFail) fail(`wrangler ${args.slice(0, 3).join(" ")} failed:\n${(r.stderr || r.stdout).trim().slice(-1500)}`);
  return r;
}

export function whoami(ctx) {
  const r = wrangler(ctx, ["whoami", "--json"], { allowFail: true });
  const j = extractJson(r.stdout);
  if (r.code !== 0 || !j || j.loggedIn === false) return { loggedIn: false, raw: (r.stderr || r.stdout).trim() };
  return j;
}

/** Fill ctx.accountId from manifest, env, or the single account the credentials can see. */
export function resolveAccountId(ctx, who) {
  if (ctx.accountId) return ctx.accountId;
  const accounts = who?.accounts || [];
  if (accounts.length === 1) {
    ctx.accountId = accounts[0].id;
    return ctx.accountId;
  }
  if (accounts.length === 0) fail(`Could not determine the Cloudflare account. Set "accountId" in cloudflare.deploy.json or CLOUDFLARE_ACCOUNT_ID.`);
  fail(
    `These credentials can see ${accounts.length} accounts — set "accountId" in cloudflare.deploy.json (or CLOUDFLARE_ACCOUNT_ID):\n` +
      accounts.map((a) => `    ${a.id}  ${a.name}`).join("\n")
  );
}

let cachedAuth = null;
function authHeaders(ctx) {
  if (cachedAuth) return cachedAuth;
  const r = wrangler(ctx, ["auth", "token", "--json"], { allowFail: true });
  const j = extractJson(r.stdout);
  if (!j) fail(`Could not read Cloudflare credentials from wrangler (\`wrangler auth token --json\`). Is wrangler logged in?`);
  if (j.type === "api_key") cachedAuth = { "X-Auth-Email": j.email, "X-Auth-Key": j.key };
  else cachedAuth = { Authorization: `Bearer ${j.token}` };
  cachedAuth.__type = j.type;
  return cachedAuth;
}

export function authType(ctx) {
  return authHeaders(ctx).__type;
}

/** Cloudflare REST call with wrangler's credentials. Never throws on HTTP errors; inspect .ok. */
export async function api(ctx, method, urlPath, body) {
  const { __type, ...headers } = authHeaders(ctx);
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: { ...headers, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return {
    ok: res.ok && json?.success !== false,
    status: res.status,
    result: json?.result,
    errors: json?.errors || [],
    message: (json?.errors || []).map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${res.status}`,
  };
}

export async function getZone(ctx) {
  const q = `/zones?name=${encodeURIComponent(ctx.zone)}${ctx.accountId ? `&account.id=${ctx.accountId}` : ""}`;
  const r = await api(ctx, "GET", q);
  if (!r.ok) return { error: r.message, status: r.status };
  const z = (r.result || [])[0];
  return z ? { id: z.id, status: z.status, name: z.name, accountId: z.account?.id } : { notFound: true };
}

// ---------------------------------------------------------------- DNS + HTTPS

/** Resolve via Cloudflare DoH so we never poison (or get fooled by) the local resolver cache. */
export async function doh(hostname, type = "A") {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, {
      headers: { accept: "application/dns-json" },
    });
    const j = await res.json();
    return (j.Answer || []).map((a) => ({ type: a.type, data: a.data }));
  } catch {
    return null;
  }
}

/**
 * HTTPS request that resolves the hostname through DoH and pins that IP (keeping SNI + Host),
 * so a freshly created DNS record is usable immediately even if the OS cached an NXDOMAIN.
 */
export async function probe(url, { method = "GET", headers = {}, timeoutMs = 20000 } = {}) {
  const u = new URL(url);
  const answers = (await doh(u.hostname, "A")) || [];
  const ip = answers.filter((a) => a.type === 1).map((a) => a.data)[0];
  return new Promise((resolve) => {
    const req = https.request(
      {
        method,
        host: u.hostname,
        servername: u.hostname,
        path: u.pathname + u.search,
        headers: { "user-agent": "cloudflare-app-deploy/1", ...headers },
        timeout: timeoutMs,
        ...(ip ? { lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: ip, family: 4 }]) : cb(null, ip, 4)) } : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d) => {
          if (body.length < 4096) body += d;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, error: e.message, headers: {}, body: "" }));
    req.end();
  });
}

// ---------------------------------------------------------------- R2 S3 credentials

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}
const sha256hex = (d) => crypto.createHash("sha256").update(d).digest("hex");

const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Minimal SigV4-signed request against the R2 S3 endpoint (no body). */
async function r2Fetch({ accountId, accessKeyId, secretAccessKey }, method, bucket, key = "", query = {}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256hex("");
  const uri = `/${bucket}${key ? "/" + key.split("/").map(rfc3986).join("/") : ""}`;
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(String(query[k]))}`)
    .join("&");
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = [method, uri, qs, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${date}/auto/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256hex(canonicalRequest)].join("\n");
  let k = hmac(`AWS4${secretAccessKey}`, date);
  k = hmac(k, "auto");
  k = hmac(k, "s3");
  k = hmac(k, "aws4_request");
  const signature = crypto.createHmac("sha256", k).update(stringToSign).digest("hex");
  return fetch(`https://${host}${uri}${qs ? `?${qs}` : ""}`, {
    method,
    headers: {
      "x-amz-date": amzDate,
      "x-amz-content-sha256": payloadHash,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  });
}

/** Signed HEAD on a bucket: 200 = keys work for it, 403 = wrong keys/scope, 404 = no bucket. */
export async function r2HeadBucket({ accountId, bucket, accessKeyId, secretAccessKey }) {
  try {
    return (await r2Fetch({ accountId, accessKeyId, secretAccessKey }, "HEAD", bucket)).status;
  } catch {
    return 0;
  }
}

/** Delete every object in a bucket (teardown only). Returns the number deleted. */
export async function r2EmptyBucket(creds, bucket) {
  let deleted = 0;
  let token;
  const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  for (;;) {
    const res = await r2Fetch(creds, "GET", bucket, "", { "list-type": "2", "max-keys": "1000", ...(token ? { "continuation-token": token } : {}) });
    if (!res.ok) throw new Error(`list ${bucket} failed: HTTP ${res.status}`);
    const xml = await res.text();
    for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) {
      const d = await r2Fetch(creds, "DELETE", bucket, unxml(m[1]));
      if (!d.ok && d.status !== 404) throw new Error(`delete ${bucket}/${unxml(m[1])} failed: HTTP ${d.status}`);
      deleted++;
    }
    const next = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) return deleted;
    token = unxml(next[1]);
  }
}

/**
 * Fallback: derive S3 keys from the deploy API token itself (id + sha256(value)).
 * Works without token-creation rights, but the keys can reach EVERY bucket the token can, and
 * rotating the deploy token rotates them. Opt-in only (--r2-keys-from-token).
 */
export async function deriveR2KeysFromToken(ctx) {
  const { __type, Authorization } = authHeaders(ctx);
  if (__type !== "api_token" || !Authorization) return { error: "only possible when deploying with CLOUDFLARE_API_TOKEN" };
  const value = Authorization.replace(/^Bearer /, "");
  let v = await api(ctx, "GET", `/accounts/${ctx.accountId}/tokens/verify`);
  if (!v.ok) v = await api(ctx, "GET", `/user/tokens/verify`);
  if (!v.ok || !v.result?.id) return { error: `cannot read the token id (${v.message})` };
  return { accessKeyId: v.result.id, secretAccessKey: sha256hex(value) };
}

/**
 * Create a bucket-scoped R2 API token (Object Read & Write on just these buckets) and derive
 * S3 credentials from it: access key = token id, secret = sha256(token value).
 * Requires the deploy credentials to be allowed to create account API tokens.
 */
export async function createScopedR2Keys(ctx, buckets, name) {
  const groups = await api(ctx, "GET", `/accounts/${ctx.accountId}/tokens/permission_groups`);
  if (!groups.ok) return { error: `cannot list permission groups (${groups.message})` };
  const group = (groups.result || []).find((g) => g.name === "Workers R2 Storage Bucket Item Write");
  if (!group) return { error: `permission group "Workers R2 Storage Bucket Item Write" not found` };
  const resources = Object.fromEntries(buckets.map((b) => [`com.cloudflare.edge.r2.bucket.${ctx.accountId}_default_${b}`, "*"]));
  const created = await api(ctx, "POST", `/accounts/${ctx.accountId}/tokens`, {
    name,
    policies: [{ effect: "allow", resources, permission_groups: [{ id: group.id }] }],
  });
  if (!created.ok) return { error: `cannot create account API token (${created.message})` };
  return { accessKeyId: created.result.id, secretAccessKey: sha256hex(created.result.value) };
}
