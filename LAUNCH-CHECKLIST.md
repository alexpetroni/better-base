# better-sleep launch checklist

Every box below needs a HUMAN — none of this can be automated away. Work top
to bottom; `DEPLOYMENT.md` has the technical details for each step. The same
list applies later to better-life (with its own domain/accounts).

## Accounts & access

- [ ] Registrar access for `bettersleep.ro` confirmed (renewal date noted).
- [ ] Cloudflare account (DNS + R2 + imgproxy cache) with 2FA; team members invited.
- [ ] Stripe account for the business entity, activated for live payments in RON
      (business verification takes days — start early).
- [ ] Resend account; billing configured.
- [ ] Anthropic API account with billing + usage limits set (chat assistant).
- [ ] Deploy target decided and provisioned: a VPS/PaaS + Postgres 16
      (adapter-node, DEPLOYMENT.md §3–§4) or Vercel + Neon (§12); automated
      database backups enabled and restore tested once.
- [ ] Fly.io account for imgproxy on the Vercel target
      (`deploy/imgproxy/README.md`; an adapter-node VPS can host imgproxy
      itself instead — §6).

## Legal (lawyer required)

- [ ] Privacy policy reviewed by a lawyer — the seeded text at
      `/pagini/politica-de-confidentialitate` is a working skeleton, NOT
      final legal copy. Edit it in `/admin/pages`.
- [ ] Terms & conditions reviewed likewise (`/pagini/termeni-si-conditii`),
      especially: 14-day withdrawal right (OUG 34/2014), pricing/VAT wording,
      the not-medical-advice disclaimers.
- [ ] Company identification (legal name, CUI, Reg. Com., registered address,
      contact email/phone — legally required in RO) filled in at
      `/admin/settings` → "Identificarea companiei". The seed leaves
      `PLACEHOLDER — …` values and `pnpm launch:check` refuses to pass while
      any stand. (Rendering this block in the footer/legal pages is the next
      code phase; the data entry is this box.)
- [ ] ANPC SAL / SOL (online dispute resolution) URLs — required for RO
      e-commerce — filled in at `/admin/settings` → "Linkuri legale"
      (enforced by `pnpm launch:check` the same way).
- [ ] Decision recorded: who answers GDPR requests, and the process for
      `pnpm subscriber:delete -- --email …` (who runs it, response deadline
      30 days).
- [ ] VAT/invoicing decision: current build does NOT issue invoices
      (suggested next phase) — confirm the accountant's interim process for
      Stripe orders. The invoice series, place of issue and VAT rate the
      future invoicing phase will consume are set at `/admin/settings` →
      "Facturare" (launch:check requires them saved).

## DNS & TLS

- [ ] `bettersleep.ro` → app host (A/CNAME); `www` redirect decided.
- [ ] `img.bettersleep.ro` → imgproxy, proxied through Cloudflare with
      "Cache Everything" rule (see DEPLOYMENT.md §6; on the Vercel target
      imgproxy itself deploys per `deploy/imgproxy/README.md`).
- [ ] TLS live on both hostnames; `PUBLIC_SITE_URL=https://bettersleep.ro`.

## Environment & secrets (prod values, never the dev defaults)

- [ ] `BETTER_AUTH_SECRET` generated fresh (`openssl rand -base64 32`) and
      stored in the team secret manager.
- [ ] `IMGPROXY_KEY`/`IMGPROXY_SALT` generated fresh (`openssl rand -hex 32`
      twice), set identically on imgproxy and the app.
- [ ] R2 bucket `bettersleep-media` created; scoped API tokens issued (app:
      read+write; imgproxy: read-only).
- [ ] `CHAT_PROVIDER=anthropic` + `ANTHROPIC_API_KEY` set (or a conscious
      decision to launch with the widget off / mock).
- [ ] `pnpm launch:check` exits 0 with the prod env exported — it knows every
      committed dev default, checks https + domain + per-target secrets,
      probes imgproxy signature agreement, and reads the database to refuse
      unset/placeholder launch-required site settings (DEPLOYMENT.md §2
      "Preflight").

## Stripe (live)

- [ ] Products re-checked in `/admin/products`: names, prices in lei, stock.
- [ ] Live keys set (`sk_live_…`); live webhook endpoint
      `https://bettersleep.ro/api/stripe/webhook` created with events
      `checkout.session.completed` + `charge.refunded`; its `whsec_…` set.
- [ ] One real LIVE purchase made with a real card and refunded — order
      appears as `plătită`, then `rambursată` in `/admin/orders`; the
      confirmation email arrives.
- [ ] Stripe receipt/branding settings (logo, statement descriptor) filled.

## Email (Resend)

- [ ] Domain `bettersleep.ro` verified in Resend (SPF + DKIM records added).
- [ ] `EMAIL_DRYRUN=false` set only AFTER domain verification.
- [ ] Test double-opt-in on a real inbox: signup → confirm → unsubscribe.
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

## Ops

Pick the deploy target first — adapter-node on a machine you run
(DEPLOYMENT.md §3) or Vercel + Neon (§12) — then tick the branch that applies
in the split boxes.

- [ ] GitHub Actions repository secret `DIRECT_DATABASE_URL` set (repo →
      Settings → Secrets and variables → Actions) and the `migrate` workflow
      run green once by hand (Actions → migrate → Run workflow) — its log
      prints the applied migration list (§12 "CI migrations").
- [ ] First-deploy setup ran from a checkout with the prod env:
      `pnpm db:seed`, `pnpm content:init`, `pnpm user:create` (§12 "Deploy
      order"; §4 for adapter-node).
- [ ] Retention job, per target:
      - adapter-node: machine cron runs `pnpm chat:prune` daily (§9).
      - Vercel: `CRON_SECRET` set in the project env — `vercel.json` already
        schedules `GET /api/cron/chat-prune` daily; verified once by hand
        with `curl -H "Authorization: Bearer $CRON_SECRET" …` (§12).
- [ ] Uptime monitor pointed at `https://bettersleep.ro/api/health`
      (alert on non-200).
- [ ] Log collection captures the app's stderr JSON lines (Vercel: a log
      drain on the project); someone is notified on `level:error` spikes.
- [ ] Database backup + restore drill done ONCE before launch (Neon: a
      point-in-time restore tried once from the console).

## Final smoke (on production, after everything above)

- [ ] DEPLOYMENT.md §11 walked end-to-end on the live site.
- [ ] Cookie banner appears on first visit; accepting/refusing sticks.
- [ ] Chat answers in Romanian and declines medical questions
      (live Anthropic provider, not canned mock replies).
- [ ] Lighthouse spot-check on `/`, an article and a product page (a11y ≥ 90,
      no layout shifts).
