# Phase 2 — Media: storage, imgproxy, media library

## Objective

The media pipeline end to end: originals uploaded to S3-compatible storage,
served through signed imgproxy URLs via an `<Img>` component, managed in an
admin media library. Local stack = MinIO + imgproxy in docker compose; prod
(R2) differs only by env vars.

## Deliverables

1. **Compose services**: `minio` (with console) + `imgproxy` (keyed: signature
   required, S3 source enabled against MinIO). A bootstrap step/script creates
   the bucket (`better-base-media`) idempotently.
2. **`modules/media` schema**: `media` table — id, key (storage path), filename,
   mime, size, width, height, alt, blurhash (nullable), created_by, created_at.
   Migration committed.
3. **Upload service**: server-side upload via presigned PUT (admin requests a
   presigned URL, browser PUTs directly to storage, server records the row after
   confirmation). Validate mime (jpeg/png/webp/avif/gif/svg) and size ≤ 15 MB.
   Extract width/height server-side; compute blurhash if cheap to add (optional).
4. **URL builder**: pure function `imgUrl(key, { w, h, fit, format, dpr })` →
   signed imgproxy URL (HMAC per imgproxy spec, key/salt from env). No network
   needed — fully unit-testable.
5. **`<Img>` component**: takes a `media` row (or key) + sizes; renders
   `<img>` with `srcset` (1x/2x, webp/avif via imgproxy), lazy loading, alt
   required (empty string allowed only with explicit `decorative` prop).
6. **Admin media library** (`/admin/media`): grid with thumbnails (via imgproxy),
   upload (drag & drop), edit alt text, delete (removes object + row; refuse if
   referenced — reference check is a service function other modules will feed).
7. **Video**: `media.kind = 'image' | 'video-embed'`; video rows store a
   provider + external id (YouTube/Bunny) only — no video file handling.
8. **Env**: `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKET`,
   `S3_REGION`, `IMGPROXY_URL`, `IMGPROXY_KEY`, `IMGPROXY_SALT` in `.env.example`
   with MinIO defaults documented; remember `host.docker.internal` in your own
   `.env`, and that the presigned-PUT host the BROWSER uses must be reachable
   from the e2e browser (same container network situation — document what you did).

## Steps

1. Compose services + bucket bootstrap; verify imgproxy serves a hand-uploaded
   object with a hand-signed URL (curl) before writing app code.
2. URL builder + unit tests (test vectors from imgproxy docs).
3. Upload flow + media table + admin library UI.
4. `<Img>` component; use it for the library thumbnails.

## Tests

- Unit: URL signing (known key/salt → expected signature; tampered path fails),
  mime/size validation, srcset generation.
- Integration (MinIO + imgproxy running): presign → PUT a fixture image → row
  recorded with correct dimensions; GET the imgproxy URL → 200 and
  content-type image/webp when webp requested; unsigned URL → 403.
- E2E: admin uploads an image in the library, sees its thumbnail, edits alt,
  deletes it.

## Definition of Done

- [ ] Gate green; integration + e2e above green with the compose stack up.
- [ ] `docker compose up -d` brings a fresh stack (db+minio+imgproxy) to working
      state with one bootstrap command documented in STATE.md.
- [ ] Switching to R2 requires only env var changes (no MinIO-specific code
      paths) — asserted by reading the code, noted in STATE.md.
- [ ] `docs/STATE.md` updated; all work committed.
