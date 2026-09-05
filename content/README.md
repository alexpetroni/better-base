# Initial content

Content bundles imported into a fresh database. `pnpm seed:base` (and
`pnpm db:seed`) reads them after seeding pillars; `pnpm content:init` re-runs just this
step against an existing database.

## Layout

```
content/
  common/        imported for EVERY site
  sleep/         imported when SITE_ID=sleep
  life/          imported when SITE_ID=life
  examples/      NOT imported — reference bundles to copy from
```

`common/` is imported first, then the site directory — so a site-local file
with the same slug updates the common item rather than fighting it. Within a
directory, files are imported in **filename order**; prefix them (`010-`,
`020-`) when one must land before another. Missing directories are skipped,
so a site that ships no initial content needs no directory at all.

Override the base directory with `CONTENT_DIR` (absolute path). Import a
one-off directory with `pnpm content import-dir <dir>`.

## File format

Each `*.json` file is one content bundle — exactly what `pnpm content export`
produces, so the normal way to add initial content is to author it in the
admin UI and export it:

```sh
pnpm content export --type article --slug igiena-somnului-7-reguli \
  --out content/common/010-igiena-somnului.json
```

A bundle is self-contained: it carries the bytes of every image it references
(base64), so importing never needs access to the source site's bucket. Pillars
travel as **slugs**, not numeric ids.

`examples/article.json` is a complete, importable minimal bundle — copy it into
`common/` or a site directory to start from scratch instead of exporting.

Shape (see `apps/web/src/lib/modules/content/bundle.ts` for the full contract):

```json
{
  "version": 2,
  "type": "article",
  "pillars": ["somn"],
  "media": [
    {
      "id": "…uuid…",
      "kind": "image",
      "key": "media/2026/…-cover.png",
      "filename": "cover.png",
      "mime": "image/png",
      "size": 12345,
      "width": 1200,
      "height": 630,
      "alt": "…",
      "blurhash": null,
      "videoProvider": null,
      "videoExternalId": null,
      "dataBase64": "…"
    }
  ],
  "article": {
    "slug": "igiena-somnului-7-reguli",
    "title": "…",
    "excerpt": "…",
    "bodyMd": "…",
    "coverMediaId": "…uuid…",
    "status": "published",
    "publishedAt": "2026-06-10T08:00:00.000Z",
    "seoTitle": null,
    "seoDescription": null
  }
}
```

`type` is `article`, `quiz` or `product`, with the payload under the matching
key (`article` / `quiz` / `product`).

## Behaviour

- **Idempotent.** Items upsert by slug, media matches by storage key — running
  the seed twice imports nothing twice and creates no duplicates.
- **Edits are overwritten.** A re-run resets an item to what the file says. Keep
  the file as the source of truth, or drop it once the content lives in admin.
- **Pillars must exist.** A bundle whose pillars are all inactive on the target
  site is refused (the item would be invisible in every listing). This is how
  `life`-only content stays out of the `sleep` site. Pass `--allow-untagged` to
  `pnpm content import-dir` to override.
- **One bad file doesn't stop the rest.** Failures are reported per file and the
  run continues, but `pnpm seed:base` exits non-zero if any file failed.
- Import is create-only: a bundle whose slug already exists in the database
  is skipped (reported as such) so re-running never reverts admin edits;
  `pnpm content import-dir --overwrite` replaces existing items on purpose.
