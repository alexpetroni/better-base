# Launch-completion batch (docs/next)

Ten phases that close everything still standing between the current build and a real
better-sleep launch: the unproven Neon driver, the un-executable deploy, and the product
gaps `docs/STATE.md` § "Known gaps" and `LAUNCH-CHECKLIST.md` list.

One agent per phase (the runner starts a fresh agent for each file); a phase is not
finished until its Definition of Done holds and the gate
`pnpm lint && pnpm check && pnpm test:unit` passes independently of what the agent claims.
The runner does not start phase N+1 until phase N is recorded done.

| # | Phase | Closes | Depends on |
|---|---|---|---|
| 1 | `NEXT-1-NEON-PROOF.md` | The `neon` driver has never opened a connection | — |
| 2 | `NEXT-2-DEPLOY-PIPELINE.md` | CI migrations, `pnpm launch:check`, image host | 1 |
| 3 | `NEXT-3-SETTINGS.md` | The last admin stub; operator-editable data layer | — |
| 4 | `NEXT-4-LEGAL-ANALYTICS.md` | RO company identification, ANPC/SOL, consent-gated analytics | 3 |
| 5 | `NEXT-5-ORDER-LIFECYCLE.md` | Audit L6 event ledger; fulfillment states; work queue | — |
| 6 | `NEXT-6-INVOICE-DATA.md` | Invoices: numbering, snapshot, VAT, storno, GDPR split | 3, 5 |
| 7 | `NEXT-7-INVOICE-DOCUMENT.md` | Invoice PDF + e-Factura XML + delivery + admin | 6 |
| 8 | `NEXT-8-SHIPPING.md` | Shipping cost, courier seam, AWB, tracking, status cron | 3, 5 |
| 9 | `NEXT-9-NURTURE.md` | Scheduled/drip email on the cron seam | 5 |
| 10 | `NEXT-10-POLISH.md` | Chat history restore, blurhash, rehearsed launch | all |

Order is dependency order, then launch value: the deploy path first (it is what makes the
rest shippable), then the legal surface, then money, then growth, then polish.

## Running it

```bash
git push -u origin feat/vercel-neon          # the runner pushes after every phase
cd /home/alex/work/claude-phase-runner
DRY_RUN=1 bash run.sh /home/alex/work/better-base/docs/next/runner.env   # read the prompt
bash run.sh preflight /home/alex/work/better-base/docs/next/runner.env  # → state/TOOLING.md
bash run.sh /home/alex/work/better-base/docs/next/runner.env            # build
bash run.sh review /home/alex/work/better-base/docs/next/runner.env     # → state/REVIEW.md
```

Phases 1, 5–9 need the local stack up (`docker compose up -d`) for their
integration tests.

## What this batch deliberately does not do

Human-only launch items stay human: lawyer review of the privacy policy and T&C, company
and Stripe/Resend/Anthropic/Cloudflare accounts, DNS and TLS, live keys, one real card
purchase and refund, ANAF e-Factura enrollment, the courier contract, and the
backup/restore drill. Where a phase touches one of these it makes the step shorter and
verifiable (a seam, a config file, a `launch:check` rule) and updates
`LAUNCH-CHECKLIST.md` — it never simulates it.
