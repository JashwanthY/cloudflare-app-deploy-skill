# Authentication, permissions and CI

`cfdeploy` uses whatever credentials wrangler resolves, in this order:
1. `CLOUDFLARE_API_TOKEN` in the environment (wins over everything)
2. `--profile` / a directory-bound profile
3. the OAuth session from `wrangler login`

It reads them back through `wrangler auth token --json` to make the few REST calls wrangler has no command for:
- zone lookup
- hostname conflict check
- R2 token creation

`preflight` prints which auth type is active.

## Which to use

| Situation | Use |
|---|---|
| Developer laptop, interactive | `cd deploy && npx wrangler login` (browser OAuth). On a remote or headless box, add `--device`. |
| Agent running unattended, CI, shared machine | An **API token** in `CLOUDFLARE_API_TOKEN` plus `CLOUDFLARE_ACCOUNT_ID` |
| Several Cloudflare accounts | Either one, plus `accountId` in the manifest or `CLOUDFLARE_ACCOUNT_ID` |

Differences that matter:
- **OAuth login cannot read DNS records.** Wrangler's OAuth scopes include no DNS scope, so preflight falls back to public DNS to detect hostname conflicts. Records that exist but don't resolve publicly are missed.
- **OAuth login cannot create R2 S3 keys.** The user creates them once in the dashboard, and `storage` prints the steps.
- A token can be scoped to one account and one zone. Prefer that for agents.

## API token permissions

Create the token under **My Profile → API Tokens → Create Token → Custom token**, or as an account-owned token under **Manage Account → Account API Tokens**.

| Scope | Permission | Why |
|---|---|---|
| Account | Workers Scripts: Edit (role "Workers Admin" in the new RBAC model) | Create and update the `-web` and `-api` Workers. Creating a *new* Worker needs Admin-level rights. |
| Account | Containers: Edit | Push images to `registry.cloudflare.com` and deploy container apps |
| Account | Workers R2 Storage: Edit | Create buckets, set CORS, attach public domains |
| Account | Account Settings: Read | Account lookups |
| Zone (your zone only) | Workers Routes: Edit | Attach custom domains (`app.`, `api.`) |
| Zone (your zone only) | Zone: Read | Verify the zone is active and get its id |
| Zone (your zone only) | DNS: Read | Preflight can see existing records before claiming a hostname |
| User | User Details: Read, Memberships: Read | `wrangler whoami` (user tokens only; optional) |
| Account (optional) | Account API Tokens: Edit | Lets `storage` mint bucket-scoped R2 keys by itself. It is powerful, so leave it off and create the R2 token once in the dashboard if you prefer. |

Notes:
- Custom domains create their own DNS record and certificate, so **DNS: Edit is not needed**.
- If a permission is missing, preflight or the failing step names the operation.
- Containers on the Free plan also return 403. Check the plan before blaming the token.

Rotating the deploy token doesn't affect running apps, unless the R2 keys were derived from it (see below). R2 keys from their own token are rotated separately: delete the two `R2_*` lines from the env file, re-run `storage`, then `backend`.

### R2 keys without token-creation rights (`--r2-keys-from-token`)

If the deploy token has **Workers R2 Storage: Edit** but not *Account API Tokens: Edit*, `storage --r2-keys-from-token` derives S3 credentials from the deploy token itself:
- access key = the token's id
- secret = SHA-256 of the token value

Some production apps run this way. The trade-offs:
- The keys can read and write **every bucket in the account**, not just this app's.
- Rotating or deleting the deploy token breaks the running app until you re-run `storage` and `backend`.

Prefer a bucket-scoped token from the dashboard for anything long-lived, and ask the user before using this flag.

## CI

Example GitHub Actions workflow. The skill folder must be reachable from the job, either vendored into the repo or checked out from your team's skills repo.

```yaml
name: deploy
on:
  push:
    branches: [main]
concurrency: deploy-production   # never run two deploys at once

jobs:
  deploy:
    runs-on: ubuntu-latest       # has Docker
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with: { repository: your-org/skills, path: .skills, token: ${{ secrets.SKILLS_REPO_TOKEN }} }
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: node .skills/cloudflare-app-deploy/scripts/cfdeploy.mjs deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          # every name in backend.secrets, plus the R2 keys when storage is on:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          R2_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY_ID }}
          R2_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_ACCESS_KEY }}
```

How secrets resolve in CI:
- Values come from the environment when the env file is absent.
- `prodManagedSecrets` are never pushed, so set those once with `wrangler secret put`.
- Commit `cloudflare.deploy.json` and `deploy/` (except `deploy/node_modules` and `deploy/.generated`, which are gitignored).
