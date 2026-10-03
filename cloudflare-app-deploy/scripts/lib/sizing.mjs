// Recommends a Cloudflare Containers instance type from what the backend actually depends on:
// Python packages (requirements*.txt / pyproject.toml) and system packages in the Dockerfile.
// Heuristic, deliberately conservative: it picks the smallest tier that comfortably fits the
// heaviest thing it finds, and always explains why.

import fs from "node:fs";
import path from "node:path";

export const TIERS = ["lite", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];

// vCPU, memory (GiB), disk (GB) per tier — Cloudflare Containers limits, Oct 2026.
export const SPECS = {
  lite: { vcpu: "1/16", memGiB: 0.25, diskGB: 2 },
  basic: { vcpu: "1/4", memGiB: 1, diskGB: 4 },
  "standard-1": { vcpu: "1/2", memGiB: 4, diskGB: 8 },
  "standard-2": { vcpu: "1", memGiB: 6, diskGB: 12 },
  "standard-3": { vcpu: "2", memGiB: 8, diskGB: 16 },
  "standard-4": { vcpu: "4", memGiB: 12, diskGB: 20 },
};

const PY_RULES = [
  {
    tier: "standard-3",
    why: "ML framework — model weights need RAM/CPU and the image is several GB",
    pkgs: ["torch", "torchvision", "torchaudio", "tensorflow", "tensorflow-cpu", "jax", "transformers", "sentence-transformers", "diffusers", "ultralytics", "openai-whisper", "faster-whisper", "llama-cpp-python", "easyocr", "paddleocr", "paddlepaddle", "timm", "accelerate"],
  },
  {
    tier: "standard-2",
    why: "headless browser / computer vision / heavy native libraries",
    pkgs: ["playwright", "selenium", "pyppeteer", "opencv-python", "opencv-python-headless", "opencv-contrib-python", "onnxruntime", "spacy", "weasyprint", "moviepy", "librosa", "xgboost", "lightgbm", "catboost", "numba", "pytesseract", "unstructured", "docling"],
  },
  {
    tier: "standard-1",
    why: "data / document processing libraries",
    pkgs: ["pandas", "numpy", "scipy", "scikit-learn", "polars", "pyarrow", "duckdb", "pillow", "langchain", "langchain-community", "llama-index", "chromadb", "faiss-cpu", "pymupdf", "pdfplumber", "pypdf", "openpyxl", "matplotlib", "celery"],
  },
];

const APT_RULES = [
  { tier: "standard-2", why: "system packages that are heavy at runtime", pkgs: ["ffmpeg", "chromium", "chromium-driver", "libreoffice", "tesseract-ocr", "google-chrome-stable"] },
];

const normalize = (n) => n.toLowerCase().replace(/[_.]/g, "-");

/** Python dependency names declared by the backend (best effort, no third-party parsers). */
export function pythonDeps(beAbs) {
  const names = new Set();
  if (!beAbs || !fs.existsSync(beAbs)) return names;
  for (const f of fs.readdirSync(beAbs)) {
    if (!/^requirements.*\.txt$/.test(f)) continue;
    for (const raw of fs.readFileSync(path.join(beAbs, f), "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      const m = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
      if (m && !line.startsWith("-")) names.add(normalize(m[1]));
    }
  }
  const pyproject = path.join(beAbs, "pyproject.toml");
  if (fs.existsSync(pyproject)) {
    const src = fs.readFileSync(pyproject, "utf8");
    // Quoted requirement strings inside dependency arrays, e.g. "torch>=2.4", "psycopg[binary]>=3".
    for (const block of src.matchAll(/(?:dependencies|requires)\s*=\s*\[([\s\S]*?)\]/g))
      for (const m of block[1].matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) names.add(normalize(m[1]));
  }
  return names;
}

function aptPackages(dockerfileAbs) {
  const out = new Set();
  if (!dockerfileAbs || !fs.existsSync(dockerfileAbs)) return out;
  // Join backslash continuations so multi-line RUN instructions read as one.
  const src = fs.readFileSync(dockerfileAbs, "utf8").replace(/\\\r?\n/g, " ");
  for (const m of src.matchAll(/apt-get\s+install([^\n&;|]*)/g))
    for (const tok of m[1].split(/\s+/)) if (/^[a-z0-9][a-z0-9.+-]+$/.test(tok)) out.add(tok);
  return out;
}

/**
 * Smallest tier that fits the heaviest finding, with the reasons.
 * @returns {{tier: string, reasons: string[]}}
 */
export function recommendInstanceType({ backendDir, dockerfile, sqlite = false }) {
  let tier = "basic";
  const reasons = [];
  const bump = (t, why) => {
    if (TIERS.indexOf(t) > TIERS.indexOf(tier)) tier = t;
    reasons.push(`${why} → ${t}`);
  };
  const deps = pythonDeps(backendDir);
  for (const rule of PY_RULES) {
    const hit = rule.pkgs.filter((p) => deps.has(p));
    if (hit.length) bump(rule.tier, `${hit.join(", ")}: ${rule.why}`);
  }
  const apt = aptPackages(dockerfile);
  for (const rule of APT_RULES) {
    const hit = rule.pkgs.filter((p) => apt.has(p));
    if (hit.length) bump(rule.tier, `${hit.join(", ")} (Dockerfile): ${rule.why}`);
  }
  if (sqlite) bump("standard-1", "SQLite + Litestream: restore at boot and continuous replication need CPU headroom");
  if (!reasons.length) reasons.push("plain API dependencies (no heavy ML/browser/native libraries) → basic");
  return { tier, reasons };
}

export function describeTier(t) {
  const s = SPECS[t];
  return s ? `${t} (${s.vcpu} vCPU, ${s.memGiB} GiB RAM, ${s.diskGB} GB disk)` : JSON.stringify(t);
}

/** Disk (bytes) available to the image for a tier name or a custom {disk_mb} object. */
export function diskBytes(instanceType) {
  if (typeof instanceType === "string") return SPECS[instanceType] ? SPECS[instanceType].diskGB * 1e9 : null;
  return instanceType?.disk_mb ? instanceType.disk_mb * 1e6 : null;
}
