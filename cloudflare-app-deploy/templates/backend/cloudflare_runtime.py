"""Runtime glue for FastAPI apps deployed with the cloudflare-app-deploy skill.

Usage (in your app factory / main module):

    from cloudflare_runtime import install
    app = FastAPI()
    install(app)            # CORS for the deployed frontend + GET /health

    from cloudflare_runtime import storage
    url = storage.presigned_upload_url(f"uploads/{user_id}/{name}", content_type)

Env vars injected by the edge Worker (never hard-code these):
    APP_STAGE            production | staging | ... (unset when running locally)
    FRONTEND_ORIGINS     comma-separated allowed browser origins
    PUBLIC_API_URL       https URL of this API
    R2_ENDPOINT          https://<account>.r2.cloudflarestorage.com
    R2_BUCKET            private files bucket            (storage.files)
    R2_DB_BUCKET         SQLite replica bucket           (storage.sqlite, used by Litestream)
    R2_PUBLIC_BUCKET     public assets bucket            (storage.public)
    R2_PUBLIC_BASE_URL   https://files.example.com       (storage.public)
    R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY   bucket-scoped S3 credentials

Requires `boto3` in requirements.txt when storage is used.
"""

from __future__ import annotations

import os
from functools import lru_cache
from urllib.parse import quote

LOCAL_DEV_ORIGINS = ["http://localhost:5173", "http://localhost:3000", "http://127.0.0.1:5173"]


def allowed_origins() -> list[str]:
    origins = [o.strip() for o in os.getenv("FRONTEND_ORIGINS", "").split(",") if o.strip()]
    if not os.getenv("APP_STAGE"):  # running locally
        origins += LOCAL_DEV_ORIGINS
    return origins


def install(app) -> None:
    """Add CORS for the deployed frontend and a cheap /health route (if the app has none)."""
    from fastapi.middleware.cors import CORSMiddleware

    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins(),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "ETag"],
    )
    if not any(getattr(route, "path", None) == "/health" for route in app.routes):

        @app.get("/health", include_in_schema=False)
        def health() -> dict:
            # Keep this dependency-free: it is the deploy smoke test and the cold-start probe.
            return {"status": "ok"}


class _Storage:
    """Thin R2 (S3-compatible) helpers. Bucket defaults to the private files bucket."""

    @staticmethod
    @lru_cache(maxsize=1)
    def client():
        missing = [k for k in ("R2_ENDPOINT", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY") if not os.getenv(k)]
        if missing:
            raise RuntimeError(
                f"R2 is not configured (missing {', '.join(missing)}). Locally, point these at a DEV bucket — "
                "never the production bucket."
            )
        import boto3
        from botocore.config import Config

        return boto3.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
            region_name="auto",
            config=Config(signature_version="s3v4", retries={"max_attempts": 3, "mode": "standard"}),
        )

    @staticmethod
    def bucket(name: str | None = None) -> str:
        return name or os.environ["R2_BUCKET"]

    def put_bytes(self, key: str, data: bytes, content_type: str = "application/octet-stream", bucket: str | None = None) -> None:
        self.client().put_object(Bucket=self.bucket(bucket), Key=key, Body=data, ContentType=content_type)

    def upload_file(self, path: str, key: str, content_type: str | None = None, bucket: str | None = None) -> None:
        extra = {"ContentType": content_type} if content_type else None
        self.client().upload_file(path, self.bucket(bucket), key, ExtraArgs=extra)

    def get_bytes(self, key: str, bucket: str | None = None) -> bytes:
        return self.client().get_object(Bucket=self.bucket(bucket), Key=key)["Body"].read()

    def delete(self, key: str, bucket: str | None = None) -> None:
        self.client().delete_object(Bucket=self.bucket(bucket), Key=key)

    def presigned_upload_url(self, key: str, content_type: str, expires_in: int = 900, bucket: str | None = None) -> str:
        """Browser PUTs the file straight to R2 (bypasses the 100 MB Worker request limit).
        The browser MUST send the same Content-Type header or R2 answers 403 SignatureDoesNotMatch."""
        return self.client().generate_presigned_url(
            "put_object",
            Params={"Bucket": self.bucket(bucket), "Key": key, "ContentType": content_type},
            ExpiresIn=expires_in,
        )

    def presigned_download_url(self, key: str, expires_in: int = 3600, filename: str | None = None, bucket: str | None = None) -> str:
        params = {"Bucket": self.bucket(bucket), "Key": key}
        if filename:
            params["ResponseContentDisposition"] = f'attachment; filename="{filename}"'
        return self.client().generate_presigned_url("get_object", Params=params, ExpiresIn=expires_in)

    # ---- public bucket (storage.public) ----
    def put_public(self, key: str, data: bytes, content_type: str) -> str:
        self.put_bytes(key, data, content_type, bucket=os.environ["R2_PUBLIC_BUCKET"])
        return self.public_url(key)

    @staticmethod
    def public_url(key: str) -> str:
        return f"{os.environ['R2_PUBLIC_BASE_URL'].rstrip('/')}/{quote(key)}"


storage = _Storage()
