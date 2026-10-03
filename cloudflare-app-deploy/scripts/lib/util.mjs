// Small shared helpers: process execution, logging, .env parsing, file utilities.
// No third-party dependencies on purpose — this runs before anything is installed.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const isWin = process.platform === "win32";

const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const fmt = {
  ok: (s) => `${paint(32, "✔")} ${s}`,
  warn: (s) => `${paint(33, "!")} ${s}`,
  err: (s) => `${paint(31, "✘")} ${s}`,
  info: (s) => `${paint(36, "•")} ${s}`,
  step: (s) => `\n${paint(1, `▸ ${s}`)}`,
  dim: (s) => paint(2, s),
};
export const log = (...a) => console.log(...a);

export class DeployError extends Error {}
export function fail(msg) {
  throw new DeployError(msg);
}

/** Run a command and capture output. Never throws on non-zero exit. */
export function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    shell: isWin, // npx/npm are .cmd shims on Windows
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, ...(opts.env || {}) },
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    stdout: r.stdout || "",
    stderr: r.stderr || "",
    error: r.error,
  };
}

/** Run a command with output streamed to the terminal. Throws on non-zero exit unless allowFail. */
export function runLive(cmd, args, opts = {}) {
  const { allowFail, ...rest } = opts;
  log(fmt.dim(`$ ${cmd} ${args.map(redactArg).join(" ")}`));
  const r = spawnSync(cmd, args, {
    stdio: "inherit",
    shell: isWin,
    ...rest,
    env: { ...process.env, ...(rest.env || {}) },
  });
  const code = r.status ?? 1;
  if (code !== 0 && !allowFail) fail(`Command failed (exit ${code}): ${cmd} ${args.slice(0, 3).join(" ")}`);
  return code;
}

function redactArg(a) {
  return /secret|token|password|key=/i.test(a) && a.length > 24 ? "<redacted>" : a;
}

/**
 * Parse a .env file with python-dotenv semantics: `export` prefix allowed, surrounding quotes
 * stripped, `#` comments ignored, and the LAST occurrence of a key wins.
 * (A production deploy once shipped literal quotes into a secret and broke OpenAI auth — this avoids that.)
 */
export function parseEnvFile(file) {
  const out = {};
  if (!file || !fs.existsSync(file)) return out;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    const q = val[0];
    if (q === '"' || q === "'") {
      // Quoted value, possibly spanning multiple lines.
      let body = val.slice(1);
      let end = findClosingQuote(body, q);
      while (end === -1 && i + 1 < lines.length) {
        body += "\n" + lines[++i];
        end = findClosingQuote(body, q);
      }
      val = end === -1 ? body : body.slice(0, end);
      if (q === '"') val = val.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    } else {
      val = val.replace(/\s+#.*$/, "").trim();
    }
    out[key] = val;
  }
  return out;
}

function findClosingQuote(s, q) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && q === '"') {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

/** Append or replace KEY=value lines in an env file, preserving everything else. */
export function upsertEnvFile(file, entries, comment) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const missing = [];
  for (const [k, v] of Object.entries(entries)) {
    const re = new RegExp(`^\\s*(export\\s+)?${k}\\s*=.*$`, "m");
    if (re.test(text)) text = text.replace(re, `${k}="${v}"`);
    else missing.push(`${k}="${v}"`);
  }
  if (missing.length) {
    if (text && !text.endsWith("\n")) text += "\n";
    if (comment) text += `\n# ${comment}\n`;
    text += missing.join("\n") + "\n";
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
}

/** Copy a template only if the destination does not exist. Returns true if written. */
export function copyIfMissing(src, dest, transform) {
  if (fs.existsSync(dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let content = fs.readFileSync(src, "utf8");
  if (transform) content = transform(content);
  fs.writeFileSync(dest, content);
  if (dest.endsWith(".sh")) fs.chmodSync(dest, 0o755);
  return true;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Pull the first JSON value out of noisy CLI output (wrangler sometimes prints banners). */
export function extractJson(text) {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {}
  for (const open of ["{", "["]) {
    const start = t.indexOf(open);
    const end = t.lastIndexOf(open === "{" ? "}" : "]");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(t.slice(start, end + 1));
      } catch {}
    }
  }
  return null;
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) args[a.slice(2, eq)] = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) args[a.slice(2)] = argv[++i];
      else args[a.slice(2)] = true;
    } else args._.push(a);
  }
  return args;
}
