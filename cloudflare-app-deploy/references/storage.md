# Storage on Cloudflare: what goes where

Container disk is **ephemeral**. It is wiped when the container:
- restarts or crashes,
- is redeployed,
- goes to sleep after `sleepAfter` of idle time,
- is moved by the platform.

Anything the app writes to local disk and expects to read later must go to one of the places below.

| Data | Where | Manifest |
|---|---|---|
| User uploads, generated files, exports, media | R2 private bucket via S3 API | `storage.files.enabled` |
| SQLite database | Local `/data/*.db` + continuous Litestream replica in R2 | `storage.sqlite.enabled` |
| Postgres / MySQL | The existing managed DB (Neon, Supabase, RDS, PlanetScale…) | `DATABASE_URL` in `backend.secrets` |
| Public assets anyone may fetch | R2 public bucket on `files.<zone>` | `storage.public` |
| Caches, temp files | Local disk, but treated as disposable | — |

The container has **no R2 binding**. It talks to R2 over the S3 API using a bucket-scoped key pair (`R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`).

`cfdeploy storage` creates that key pair:
- **Automatically:** when the credentials may create account API tokens.
- **Manually otherwise:** the user creates it in the dashboard (R2 → Manage API tokens → Account API token → Object Read & Write → specific buckets) and pastes the two values into the env file.

## Private files (storage.files)

### Backend

`cloudflare_runtime.storage` wraps boto3; add `boto3` to requirements.

```python
from uuid import uuid4
from fastapi import APIRouter
from pydantic import BaseModel
from cloudflare_runtime import storage

router = APIRouter(prefix="/api/files")

class UploadRequest(BaseModel):
    filename: str
    content_type: str

@router.post("/upload-url")
def create_upload_url(req: UploadRequest):
    key = f"uploads/{uuid4()}/{req.filename}"
    return {"key": key, "url": storage.presigned_upload_url(key, req.content_type)}

@router.get("/{key:path}/download-url")
def create_download_url(key: str):
    return {"url": storage.presigned_download_url(key, filename=key.rsplit("/", 1)[-1])}
```

Server-side writes, for example generated files, use `storage.put_bytes(key, data, content_type)` or `storage.upload_file(path, key)`.

Prefer presigned URLs over streaming files through FastAPI:
- The Worker in front of the container caps request bodies at 100 MB (Free/Pro zone plans).
- Every byte through the container costs container time.

### Frontend (browser upload)

```ts
const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

export async function uploadFile(file: File) {
  const contentType = file.type || "application/octet-stream";
  const r = await fetch(`${API}/api/files/upload-url`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, content_type: contentType }),
  });
  const { key, url } = await r.json();
  // Must send exactly the Content-Type that was signed, or R2 returns 403 SignatureDoesNotMatch.
  const put = await fetch(url, { method: "PUT", headers: { "Content-Type": contentType }, body: file });
  if (!put.ok) throw new Error(`upload failed: ${put.status}`);
  return key;
}
```

`cfdeploy storage` sets the bucket CORS to allow `GET`/`PUT`/`HEAD` from the frontend origin. Non-production stages also allow localhost.

Presigned URL rules:
- Only `GET`, `PUT`, `HEAD` and `DELETE` work. HTML form `POST` uploads don't.
- Presigned URLs work only on `*.r2.cloudflarestorage.com`, never on a custom domain.
- Expiry can be up to 7 days.
- An expired URL returns 403 without CORS headers, so the browser reports a CORS error.

## SQLite (storage.sqlite)

The pattern a real production app runs:
1. The entrypoint restores each DB from R2.
2. It runs uvicorn under `litestream replicate`, which streams WAL changes to R2 about once a second.
3. On SIGTERM, Litestream flushes and exits.

`init --sqlite` creates the parts:
- `cfdeploy-entrypoint.sh` and `litestream.yml`
- a Dockerfile that installs Litestream 0.3.13

The app must open its database at a path under `/data`:

```python
DB_PATH = os.getenv("DATABASE_PATH") or os.path.join(os.getenv("DATA_DIR", "."), "app.db")
```

List every DB file in `storage.sqlite.paths`.

Rules:
- **Exactly one container.** `instances` and `maxInstances` must both be `1`, and the manifest rejects anything else. Two writers replicating one database fork the replica and lose writes.
- **Recovery point:** about 1 second of writes can be lost on a hard crash. That is acceptable for app data, but not for payments ledgers; use Postgres for those.
- **Cold start** includes the restore. A larger DB means a slower first request after sleep. Raise `sleepAfter` if that hurts.
- **Never run the production image locally against the production bucket.** A second replicator writing to the same replica path forks it. Use the staging stage's bucket or a scratch bucket locally.
- **Failed restores stop startup.** The entrypoint refuses to start after 5 failed restore attempts rather than serve an empty database, which Litestream would then replicate. The platform restarts it.
- **Restore by hand** (to inspect data), from a laptop with the R2 keys:

  ```bash
  litestream restore -o ./app.db s3://<app>-db/app.db
  ```

  Set the `endpoint` to the R2 endpoint in a local config first.

If the app also keeps **folders of files** on disk, don't sync those folders with rclone. A production app lost data that way: an `rclone sync` after a partial restore deleted objects in R2. Move the files to `storage.files` instead, writing to R2 when the file is created and reading from R2 or a presigned URL.

## External Postgres/MySQL

Nothing to configure in R2. Steps:
1. Put `DATABASE_URL` in the env file.
2. Add it to `backend.secrets`.
3. Make sure the DB accepts connections from the internet over TLS. Container egress IPs aren't fixed, so IP allow-lists don't work; use the provider's TLS and password auth, or its proxy.
4. Keep connection pools small (`pool_size` 5 or less per container), because containers sleep and wake.

## Public assets (storage.public)

What `storage` sets up:
- a separate bucket (public access applies to a whole bucket, so never make the private bucket public)
- the bucket attached to `files.<zone>` as an R2 custom domain, which creates DNS and a certificate and puts it behind Cloudflare's cache and WAF
- CORS for `GET` from the frontend

Upload and link:

```python
url = storage.put_public(f"avatars/{user_id}.png", data, "image/png")  # -> https://files.acme.ai/avatars/<id>.png
```

Don't use the `r2.dev` URL in production. It is rate-limited and not cached.
