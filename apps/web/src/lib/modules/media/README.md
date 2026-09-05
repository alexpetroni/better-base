Media module: S3/MinIO originals, provider-built image URLs, media library
(Phase 2).

Image URLs go through an `ImageProvider` (`image.ts`), selected by
`IMAGE_PROVIDER`: `cloudflare` (`/cdn-cgi/image`, the deploy default),
`imgproxy` (signed, self-hosted) or `direct` (originals as-is — local dev and
the test suite, so neither needs a transformer container). Pages only ever see
`ImageSources`, which is identical across all three. See DEPLOYMENT.md §6.

Two barrels: `index.ts` (universal — `<Img>`, validation, types) and `server.ts`
(providers, storage, services — server-only). See docs/ARCHITECTURE.md § Media.

Storage layout (`storage.ts`, `validation.ts`, `$lib/server/media-objects.ts`):

- `pending/<uuid>.<ext>` — quarantine. `requestUpload` presigns a PUT here;
  the public origin never serves this prefix (MinIO bucket policy `Deny`,
  Cloudflare WAF rule on R2 — DEPLOYMENT.md §5).
- `uploads/<yyyy>/<mm>/<slug>-<8 hex>.<ext>` — served originals, minted by
  `confirmUpload`, which produces the object through `finalizeMediaObject`
  (server-side copy for rasters, sanitized re-write + `Content-Disposition:
attachment` for SVGs, `Cache-Control: immutable` for both) and then deletes
  the pending object. Content import and `pnpm seed:demo` (`seed/…` keys)
  write through the same finalize step. A key's bytes never change; replacing
  an image is a new upload → new key → new row.
