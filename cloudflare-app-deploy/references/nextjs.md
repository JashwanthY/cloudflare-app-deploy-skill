# Next.js frontends

This skill deploys Next.js as a **static export** (`framework: "next-static"`): every page is
pre-rendered to HTML at build time and served from Workers static assets, with data fetched from
the FastAPI backend in the browser. That covers dashboards, internal tools and most apps whose
logic lives in FastAPI. It's the same hosting path as Vite, so it's simple and reliable.

## Setup

```js
// next.config.mjs
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true }, // next/image's optimizer needs a server
  trailingSlash: false,
};
export default nextConfig;
```

Manifest:

```json
"frontend": { "dir": "web", "framework": "next-static", "outputDir": "out", "apiUrlVar": "NEXT_PUBLIC_API_URL", "hostname": "app.acme.ai" }
```

The API base URL:
- In code: `process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000"`.
- It is inlined at build time, so only `NEXT_PUBLIC_*` vars reach the browser.

## What must change in the app

| Uses… | Static-export replacement |
|---|---|
| `getServerSideProps`, server components that fetch per request | Fetch from FastAPI in a client component (`"use client"` + `useEffect`/SWR/React Query) |
| `app/api/*` route handlers / `pages/api/*` | Move the logic into FastAPI |
| `middleware.ts` (auth redirects, rewrites) | Client-side guard, or check in FastAPI |
| Dynamic routes `app/posts/[id]/page.tsx` | `generateStaticParams()` for known ids, or one client-rendered page that reads the id from the URL (`/posts?id=…`) |
| `next/image` optimization | `images.unoptimized: true`, or pre-sized images in `public/` or the public R2 bucket |
| ISR / `revalidate` | Rebuild and redeploy (`$CFDEPLOY frontend`) or fetch client-side |
| Cookies/headers in server code | Read in FastAPI |

`next build` fails loudly when something can't be exported. Read the error, then apply the row above.

Routing details:
- The output has one `.html` per route and a `404.html`. The tool sets `not_found_handling: "404-page"`.
- Asset requests for `/about` are served from `about.html` automatically.

## If the app really needs server-side rendering

SSR on Cloudflare means running Next.js inside a Worker, which is a different deployment from this skill's static path. The current options (October 2026):

| Option | Status | Notes |
|---|---|---|
| **vinext** (`npx vinext init --platform=cloudflare`) | Beta; Cloudflare's default recommendation | Generates `cloudflare.config.ts` and uses the new `cf` CLI by default. Add `--legacy-wrangler-cloudflare-init` to stay on Wrangler. |
| **OpenNext** (`@opennextjs/cloudflare`) | Maintenance mode ("existing apps only") | `main: ".open-next/worker.js"`, `nodejs_compat`, `assets.binding: "ASSETS"` |

Don't improvise SSR inside this skill's frontend step. Tell the user that SSR needs one of the options above and what it costs them (beta tooling, or maintenance-mode tooling). Recommend the static-export conversion when the table above covers their needs, since it usually does.

If they still want SSR:
1. Deploy the backend with this skill (`--only backend`).
2. Deploy the Next.js app with the official `nextjs-on-cloudflare` skill, pointing its `NEXT_PUBLIC_API_URL` at the API hostname.
3. Add the SSR app's origin to `backend.extraOrigins` so CORS allows it.
