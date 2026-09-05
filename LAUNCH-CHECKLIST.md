# better-sleep launch checklist

Every box below needs a HUMAN — none of this can be automated away. Work top
to bottom; `DEPLOYMENT.md` has the technical details for each step. The same
list applies later to better-life (with its own domain/accounts).

## Accounts & access

- [ ] Registrar access for `bettersleep.ro` confirmed (renewal date noted).
- [ ] Cloudflare account (DNS + R2 + Image Transformations) with 2FA; team
      members invited. Transformations must be ENABLED for the zone —
      dashboard → Images → Transformations (DEPLOYMENT.md §6).
- [ ] Stripe account for the business entity, activated for live payments in RON
      (business verification takes days — start early).
- [ ] Resend account; billing configured.
- [ ] Anthropic API account with billing + usage limits set (chat assistant).
- [ ] Courier contract signed — Sameday is the implemented adapter (business
      contract + eAWB portal credentials; negotiating rates takes days —
      start early). A different courier means implementing another
      `CourierProvider` adapter first (DEPLOYMENT.md §7 "Shipping").
- [ ] Deploy target decided and provisioned: a VPS/PaaS + Postgres 16
      (adapter-node, DEPLOYMENT.md §3–§4) or Vercel + Neon (§12); automated
      database backups enabled and restore tested once.
- [ ] Image provider decided: `IMAGE_PROVIDER=cloudflare` needs no extra
      account or box (the default — §6). Only if you deliberately choose
      `imgproxy` instead: a Fly.io account, or the adapter-node VPS hosting it
      (`deploy/imgproxy/README.md`).

## Legal (lawyer required)

- [ ] Privacy policy reviewed by a lawyer — the seeded text at
      `/pagini/politica-de-confidentialitate` is a working skeleton, NOT
      final legal copy. Edit it in `/admin/pages`.
- [ ] Terms & conditions reviewed likewise (`/pagini/termeni-si-conditii`),
      especially: 14-day withdrawal right (OUG 34/2014), pricing/VAT wording,
      the not-medical-advice disclaimers.
- [ ] Cookie policy prose reviewed likewise (`/pagini/politica-de-cookie-uri`).
      Only the PROSE needs review: the cookie table below it is rendered from
      code (`modules/gdpr/cookies.ts`) and always matches what the app
      actually sets — do not paste a cookie list into the markdown.
- [ ] Company identification (legal name, CUI, Reg. Com., registered address,
      contact email/phone — legally required in RO) filled in at
      `/admin/settings` → "Identificarea companiei". The seed leaves
      `PLACEHOLDER — …` values and `pnpm launch:check` refuses to pass while
      any stand. Once saved, the block renders automatically in the footer of
      every page and on the legal pages — nothing else to do.
- [ ] ANPC SAL / SOL (online dispute resolution) URLs — required for RO
      e-commerce — filled in at `/admin/settings` → "Linkuri legale"
      (enforced by `pnpm launch:check` the same way). They render as footer
      links automatically once saved.
- [ ] Analytics decision: leave `PUBLIC_ANALYTICS_*` unset (no script ships)
      or set the trio for a Plausible/Umami instance (DEPLOYMENT.md §2). The
      script loads only after the visitor consents, and consent can be
      revoked on the cookie-policy page — both enforced by tests, nothing to
      configure beyond the env vars.
- [ ] Decision recorded: who answers GDPR requests, and the process for
      `pnpm subscriber:delete -- --email …` (who runs it, response deadline
      30 days). Note for the answer template: erasure anonymizes account,
      order-contact and marketing data but KEEPS issued invoices — legally
      retained accounting records (GDPR art. 17(3)(b); see
      `modules/invoice/README.md`); the CLI reports how many were kept.
- [ ] VAT/invoicing: the app ISSUES and DELIVERS invoices automatically —
      every paid Stripe order gets a numbered invoice in the declared series
      with a PDF + e-Factura XML (stored in the bucket, PDF attached to the
      confirmation email, downloadable by the buyer from the order page), a
      refund issues the storno, and `/admin/orders` has a monthly zip export
      for the accountant (see `apps/web/src/lib/modules/invoice/`). What
      remains human:
      - fill in `/admin/settings` → "Facturare": series prefix, first number
        (continue the accountant's interim numbering, or start a fresh
        declared series at 1), place of issue, VAT rate, and — while the
        entity is not VAT-registered — leave "Plătitor de TVA" unchecked so
        invoices carry the neplătitor mention (launch:check enforces the
        required ones);
      - confirm with the accountant: the declared series/number regime, the
        per-line VAT rounding documented in `modules/invoice/README.md`, and
        the invoice TEMPLATE itself — download a test PDF from an order page
        and have them sign off the layout/fields before live sales;
      - orders paid before this phase went live have no invoice — the admin
        work queue filter "Fără factură" lists them; issue each with the
        one-click button on the order page if the accountant did not already
        invoice them by hand.
- [ ] e-Factura (ANAF) — the duty is real and dated: every invoice and
      storno MUST reach SPV within 5 calendar days of issuance (B2C included
      since 2025-01-01). The app queues each document at issuance and
      `/admin/orders` → "De trimis la ANAF" shows what is still due with the
      days left, but it does NOT submit until a human completes the
      enrollment (qualified certificate + SPV enrollment + ANAF OAuth app +
      implementing the `EFacturaSubmitter` adapter — exact steps in
      DEPLOYMENT.md §7 "Fiscal documents"). Until then: name the person who
      uploads the XML (order page / monthly export) in the SPV web interface
      every working day and checks the queue, and confirm the
      `efactura-submit` cron is scheduled (below) so the queue is drained
      the moment the adapter exists.
- [ ] e-Factura XML validated against ANAF's public validator BEFORE the
      first live invoice: upload BOTH golden fixtures from
      `apps/web/tests/fixtures/efactura/` (`factura-cluj.xml`,
      `factura-bucuresti-sector-b2b.xml`) to ANAF's e-Factura validator
      (anaf.ro → e-Factura → "Validare XML") and record the result here; the
      build only runs the offline validator and has NOT called ANAF. Then
      validate the first real invoice's XML the same way. Any rejection is a
      renderer bug: fix it and bump `EFACTURA_RENDERER_VERSION` so stored
      documents re-render.

## DNS & TLS

- [ ] `bettersleep.ro` → app host (A/CNAME); `www` redirect decided.
- [ ] `media.bettersleep.ro` → the R2 bucket, bound as a public custom domain
      in the R2 dashboard, on the SAME zone as the site; set as
      `MEDIA_PUBLIC_BASE_URL` (DEPLOYMENT.md §5/§6).
      Only on `IMAGE_PROVIDER=imgproxy`: `img.bettersleep.ro` → imgproxy
      instead, proxied through Cloudflare with a "Cache Everything" rule.
- [ ] TLS live on both hostnames; `PUBLIC_SITE_URL=https://bettersleep.ro`.

## Environment & secrets (prod values, never the dev defaults)

- [ ] `BETTER_AUTH_SECRET` generated fresh (`openssl rand -base64 32`) and
      stored in the team secret manager.
- [ ] `IMAGE_PROVIDER=cloudflare` + `MEDIA_PUBLIC_BASE_URL` set.
      `launch:check` REFUSES the `direct` dev default — it would serve
      unresized originals to every visitor.
      Only on `IMAGE_PROVIDER=imgproxy`: `IMGPROXY_KEY`/`IMGPROXY_SALT`
      generated fresh (`openssl rand -hex 32` twice), set identically on
      imgproxy and the app.
- [ ] R2 bucket `bettersleep-media` created; scoped API token issued for the
      app (read+write). Only on the imgproxy provider: a second, read-only
      token for imgproxy.
- [ ] R2 bucket `bettersleep-fiscal` created (invoice PDFs + e-Factura XML;
      DEPLOYMENT.md §5), the same app token granted read+write on it,
      `S3_INVOICE_BUCKET=bettersleep-fiscal` set, and NO public domain bound
      to it. `pnpm launch:check` refuses a cloudflare deploy without it and
      probes that the media domain does not serve `/invoices/`. If any
      invoice was issued before this bucket existed, run
      `pnpm storage:fiscal-migrate` once with the prod env.
- [ ] `CHAT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` set (or a conscious
      decision to launch with the widget off / mock). `pnpm launch:check`
      refuses a live env (`EMAIL_DRYRUN=false`) still on the mock chat or
      courier provider unless `--allow-mock-providers` is passed; the boot
      log prints `chat provider: <kind>` and `GET /api/health` returns it as
      `chatProvider`, so verify the deployed kind there.
- [ ] `COURIER_PROVIDER=sameday` + `SAMEDAY_USERNAME`/`SAMEDAY_PASSWORD`/
      `SAMEDAY_PICKUP_POINT` set from the courier contract (DEPLOYMENT.md §2,
      §7 "Shipping"). The mock default generates FAKE AWBs — fine for
      staging, never for a customer parcel.
- [ ] Shipping prices decided and saved at `/admin/settings` → "Magazin":
      standard price (launch-required — `launch:check` refuses until it is
      consciously saved; 0 = deliberate free shipping), optional express
      option, free-shipping threshold, delivery estimates. They render in the
      cart and are charged by Stripe automatically once saved.
- [ ] `pnpm launch:check` exits 0 with the prod env exported — it knows every
      committed dev default, checks https + domain + per-target secrets,
      probes the image provider end-to-end (including that Cloudflare really
      transforms rather than passing originals through), and reads the
      database to refuse
      unset/placeholder launch-required site settings (DEPLOYMENT.md §2
      "Preflight").

## Stripe (live)

- [ ] Products re-checked in `/admin/products`: names, prices in lei, stock.
- [ ] Live keys set (`sk_live_…`); live webhook endpoint
      `https://bettersleep.ro/api/stripe/webhook` created with the four
      events `checkout.session.completed`,
      `checkout.session.async_payment_succeeded`,
      `checkout.session.async_payment_failed`, `charge.refunded`
      (DEPLOYMENT.md §7); its `whsec_…` set.
- [ ] Checkout asks for a **phone number** on the test-mode purchase (it lands
      on the order's shipping address next to the county; the courier refuses
      an AWB without either — DEPLOYMENT.md §7 "Stripe" 6).
- [ ] Payment methods: sessions are card-only by default; only enable
      "Permite toate metodele de plată" in `/admin/settings` → Magazin if a
      delayed method (bank debit, voucher) is wanted — then a pending order
      becomes paid only on `async_payment_succeeded`.
- [ ] One real LIVE purchase made with a real card and refunded — order
      appears as `plătită`, then `rambursată` in `/admin/orders`; the
      confirmation email arrives WITH the invoice PDF attached; the success
      page offers the invoice download; the refund's storno shows on the
      order page next to the invoice.
- [ ] One PARTIAL refund from the Stripe dashboard on a second test order:
      the order stays `plătită` with the "rambursare parțială" badge and the
      refunded amount, no storno is issued automatically, and "Emite storno
      parțial (…)" on the order page issues one for exactly that amount.
- [ ] Stripe receipt/branding settings (logo, statement descriptor) filled.

## Email (Resend)

- [ ] Domain `bettersleep.ro` verified in Resend (SPF + DKIM records added).
- [ ] `EMAIL_DRYRUN=false` set only AFTER domain verification. The dry-run
      soak before that is harmless: a dry-run record is not a delivery, the
      same idempotency keys send for real once live (DEPLOYMENT §8).
- [ ] Resend webhook endpoint `https://<site>/api/webhooks/resend` created
      for `email.bounced` + `email.complained`, its signing secret set as
      `RESEND_WEBHOOK_SECRET`, and a dashboard test event answered `200`
      (`503` means the secret is missing) — DEPLOYMENT §8 step 4.
- [ ] Test double-opt-in on a real inbox: signup → confirm (the link shows
      a button; press it) → unsubscribe (same: button). Re-subscribe after
      the unsubscribe and check a NEW confirm email arrives.
- [ ] On a delivered nurture email, "show original" contains
      `List-Unsubscribe` and `List-Unsubscribe-Post` (Gmail/Yahoo bulk-sender
      requirement); the mail client's own "Unsubscribe" control works.
- [ ] Deliverability spot-check (Gmail + Yahoo, not in spam).

## Content

- [ ] Demo content reviewed: keep or delete the 3 seeded articles, the demo
      quiz copy and the 3 demo products (they are real-looking!). Delete via
      admin, or replace their copy.
- [ ] At least the launch set of real articles published and tagged `somn`.
- [ ] Quiz copy (questions, bands, advice) reviewed by the content owner —
      it is health-adjacent wording.
- [ ] Product photos uploaded (replace SVG placeholders), alt texts filled.
- [ ] Admin + editor accounts created with strong passwords
      (`pnpm user:create`); dev/e2e accounts NOT present in the prod db.
      Since FIX-9: staff sessions expire after ~12 h (re-login is expected),
      failed logins are capped per IP AND per account, and logins, PII/zip
      exports, media deletes, nurture toggles and legal-page saves land in
      the append-only `admin_audit` table — review it (`select * from
      admin_audit order by at desc`) as part of any incident response.
      Editors can no longer open `/admin/pages` (legal pages are admin-only)
      or see subscriber emails in the quiz editor. TOTP for admins is NOT
      shipped yet — planned next batch (see STATE.md, FIX-9 section).

## Ops

Pick the deploy target first — adapter-node on a machine you run
(DEPLOYMENT.md §3) or Vercel + Neon (§12) — then tick the branch that applies
in the split boxes.

- [ ] GitHub Actions repository secret `DIRECT_DATABASE_URL` set (repo →
      Settings → Secrets and variables → Actions) and the `migrate` workflow
      run green once by hand (Actions → migrate → Run workflow) — its log
      prints the applied migration list (§12 "CI migrations").
- [ ] First-deploy setup ran from a checkout with the prod env:
      `pnpm db:seed`, `pnpm content:init`, `pnpm media:blurhash` (image
      placeholders for imported media; idempotent), `pnpm user:create`
      (§12 "Deploy order"; §4 for adapter-node).
- [ ] Retention job, per target:
      - adapter-node: machine cron runs `pnpm chat:prune` daily (§9).
      - Vercel: `CRON_SECRET` set in the project env — `vercel.json` already
        schedules `GET /api/cron/chat-prune` daily; verified once by hand
        with `curl -H "Authorization: Bearer $CRON_SECRET" …` (§12).
- [ ] Shipment-status sync, per target (§9): Vercel — `vercel.json` already
      schedules `GET /api/cron/shipment-sync` hourly (same `CRON_SECRET`);
      adapter-node — machine cron curls the same route hourly. Verified once
      by hand: the authorized curl answers `{"polled":…,"errors":0}` with no
      `"aborted"` key; someone is alerted when `errors` > 0 or `aborted`
      appears, and `/admin` shows no "sincronizarea eșuează" banner.
- [ ] Nurture email queue, per target (§9): Vercel — `vercel.json` already
      schedules `GET /api/cron/nurture-send` every 15 minutes (same
      `CRON_SECRET`) **and the project is on the Pro plan** (Hobby coalesces
      every cron to once a day — §12 "Scheduled jobs"); adapter-node —
      machine cron curls the same route. Verified once by hand: the
      authorized curl answers `{"claimed":…,"stale":0,…}`. The seeded
      sequences are live-checked in `/admin/nurture` (deactivate any you do
      not want sending at launch — sends only leave while
      `EMAIL_DRYRUN=false`); parked sends show a **retry** button there.
- [ ] e-Factura submission queue, per target (§9): Vercel — `vercel.json`
      already schedules `GET /api/cron/efactura-submit` hourly (same
      `CRON_SECRET`); adapter-node — machine cron curls the same route
      hourly. Verified once by hand: the authorized curl answers
      `{"claimed":…,"submitted":0,"skipped":…,"retried":0,"parked":0}`
      (`skipped` = no enrollment yet — the manual SPV upload above still
      applies); someone watches `/admin/orders` → "De trimis la ANAF" for
      red (overdue) badges and `parked` > 0.
- [ ] One real AWB generated against the live Sameday account from an order
      with phone + county (DEPLOYMENT.md §7 "Shipping" step 4) — the adapter
      follows the public API but is unverified against a live account until
      this passes; the shipping email (with tracking link) arrives; the AWB
      shows in eAWB with our order id as client reference; cancelled IN eAWB,
      one hand-run sync moves the order back to `împachetată` ("AWB anulat de
      curier" on the trail) and the page offers a new AWB.
- [ ] Sameday status payloads captured as fixtures during that step
      (DEPLOYMENT.md §7 "Shipping" step 5) and every observed `statusId`
      added to `SAMEDAY_STATUS_BY_ID`; no "Sameday status unknown" warn line
      in the logs afterwards.
- [ ] Uptime monitor pointed at `https://bettersleep.ro/api/health`
      (alert on non-200).
- [ ] Log collection captures the app's stderr JSON lines (Vercel: a log
      drain on the project); someone is notified on `level:error` spikes.
- [ ] Database backup + restore drill done ONCE before launch (Neon: a
      point-in-time restore tried once from the console).

## Final smoke (on production, after everything above)

The §11 walk was rehearsed against the local stack with the full feature set
on 2026-08-08 — `docs/LAUNCH-DRY-RUN.md` records every command and result, so
this section is executing a proven script, not exploring.

- [ ] DEPLOYMENT.md §11 walked end-to-end on the live site.
- [ ] Cookie banner appears on first visit; accepting/refusing sticks;
      "Retrage acordul" on `/pagini/politica-de-cookie-uri` revokes it (and,
      if analytics is enabled, the script stops loading after revocation).
- [ ] Footer shows the company identification + working ANPC SAL/SOL links
      on the live site (they come from `/admin/settings`, not the deploy).
- [ ] Chat answers in Romanian and declines medical questions
      (live Anthropic provider, not canned mock replies); reloading the page
      restores the conversation (server-side history behind the session
      cookie).
- [ ] Lighthouse spot-check on `/`, an article and a product page (a11y ≥ 90,
      no layout shifts).
