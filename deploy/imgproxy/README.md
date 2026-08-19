# imgproxy on Fly.io — the OPTIONAL self-hosted image provider

> **Not the default any more.** Image URLs are built by a provider seam
> (`IMAGE_PROVIDER`, DEPLOYMENT.md §6) and deploys default to `cloudflare`,
> which needs no always-on box. Everything here applies only if you
> deliberately set `IMAGE_PROVIDER=imgproxy` — for full control of the
> transform pipeline, or because you already run a VPS.

With that provider selected, the app never serves image bytes: every `<img>`
on every page is a signed URL pointing at one imgproxy instance, which reads
originals from the private R2 bucket. Vercel cannot host imgproxy (long-lived
container, not a function), so it runs on Fly.io — `fly.toml` in this
directory is the committed config. The decision, its cost and the rejected
alternatives are recorded in DEPLOYMENT.md §12.

One instance serves both sites (the signed URL names the bucket), which is why
the app name here is generic. Run one per site only if you want separate
hostnames/blast radius — same steps, different `--app` and secrets.

## Deploy (once)

Prerequisites: `flyctl` installed and logged in; the R2 bucket exists
(DEPLOYMENT.md §5); the app's `IMGPROXY_KEY`/`IMGPROXY_SALT` pair has been
generated (`openssl rand -hex 32`, twice — LAUNCH-CHECKLIST "Environment &
secrets").

```bash
# from the repo root — create the app without deploying yet:
fly launch --config deploy/imgproxy/fly.toml --copy-config --no-deploy

# secrets: the SAME key/salt pair the app gets, plus a READ-ONLY R2 token
# of its own (imgproxy only ever reads originals) and the account endpoint:
fly secrets set --config deploy/imgproxy/fly.toml \
  IMGPROXY_KEY=<hex, identical to the app env> \
  IMGPROXY_SALT=<hex, identical to the app env> \
  IMGPROXY_S3_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com \
  AWS_ACCESS_KEY_ID=<read-only R2 token id> \
  AWS_SECRET_ACCESS_KEY=<read-only R2 token secret>

fly deploy --config deploy/imgproxy/fly.toml
```

## Hostname + Cloudflare cache

imgproxy re-transforms on every request, so the public hostname must sit
behind Cloudflare's cache (DEPLOYMENT.md §6 has the reasoning):

1. `fly certs add img.bettersleep.ro --config deploy/imgproxy/fly.toml`, then
   add the CNAME Fly prints to Cloudflare DNS, **proxied** (orange cloud).
2. Cloudflare → Caching → Cache Rules: hostname `img.bettersleep.ro` →
   **Cache Everything**, edge TTL long (e.g. 1 month). Transformed URLs are
   immutable — the signature encodes the exact transform and source key, and
   re-uploads get new keys — so a long TTL can never serve a stale image.
3. Set `IMGPROXY_URL=https://img.bettersleep.ro` in the app's environment.

## Verify

```bash
fly status --config deploy/imgproxy/fly.toml         # 1 machine, health passing
curl -s https://img.bettersleep.ro/health            # imgproxy answers "imgproxy is running"
pnpm launch:check                                    # probes signed=200 / unsigned=403
```

The `launch:check` probe is the real test: it uploads a 1×1 PNG with the
app's credentials and requires the signed imgproxy URL to answer 200 and an
unsigned one 403 — proving key/salt agree between app and imgproxy, and that
imgproxy's R2 credentials can read the bucket.

## Key rotation

Generate a new pair, then update **both** sides together
(`fly secrets set …` restarts imgproxy; redeploy the app with the new env):
pages sign URLs per request, so newly rendered pages work immediately, and
already-CDN-cached images keep serving from the edge until their TTL expires.
DEPLOYMENT.md §6 "Key/salt hygiene & rotation" has the details.
