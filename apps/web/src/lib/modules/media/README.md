Media module: S3/MinIO originals, provider-built image URLs, media library
(Phase 2).

Image URLs go through an `ImageProvider` (`image.ts`), selected by
`IMAGE_PROVIDER`: `cloudflare` (`/cdn-cgi/image`, the deploy default),
`imgproxy` (signed, self-hosted) or `direct` (originals as-is — local dev and
the test suite, so neither needs a transformer container). Pages only ever see
`ImageSources`, which is identical across all three. See DEPLOYMENT.md §6.

Two barrels: `index.ts` (universal — `<Img>`, validation, types) and `server.ts`
(providers, storage, services — server-only). See docs/STATE.md § Media.
