# Phase 3 — Blog: articles, pillar tagging, admin editor, public routes, SEO

## Objective

A publishable blog: markdown articles stored in the DB, tagged to pillars,
edited in the admin with media picking, rendered on config-driven public routes
with proper SEO.

## Deliverables

1. **`modules/blog` schema**: `articles` — id, slug (unique), title, excerpt,
   body_md, cover_media_id (FK media), status (`draft`|`published`),
   published_at, seo_title, seo_description, created_by, timestamps.
   `article_pillars` (article_id, pillar_id). Migrations committed.
2. **Services**: create/update/publish/unpublish; `listPublished({ pillarSlugs,
   page })` filtering by the ACTIVE SITE's pillars from config; `getBySlug`
   (published only for public callers); slug generation with ro-diacritics
   transliteration + uniqueness suffixing.
3. **Markdown rendering**: server-side md → sanitized HTML (marked/markdown-it +
   sanitizer). Support images by media reference (e.g. `![alt](media:KEY)` →
   `<Img>`-equivalent picture markup through imgproxy) and video-embed rows.
4. **Admin** (`/admin/articles`): list (status filter, search), editor page —
   title, slug (editable, auto-suggested), excerpt, markdown textarea with
   preview toggle, cover picker + inline-image picker from the media library,
   pillar multi-select (from the site's pillars), SEO fields, draft/publish.
   Editors and admins both allowed.
5. **Public routes**: `/blog` (paginated list, cards with cover via `<Img>`),
   `/blog/[slug]` (article page), pillar landing pages now list that pillar's
   latest articles. Drafts 404 publicly.
6. **SEO**: per-page `<title>`/meta description, OpenGraph + twitter card (cover
   via imgproxy fixed-size), canonical URL from `PUBLIC_SITE_URL`, `sitemap.xml`
   (published articles + static pages), `robots.txt`, JSON-LD `Article`.
7. **Seed**: `pnpm db:seed` additionally inserts 3 demo articles (ro) tagged to
   the sleep pillar so both sites have visible content in dev.

## Steps

1. Schema + services + unit tests.
2. Markdown pipeline (sanitization tests first — script tags, event handlers,
   javascript: URLs must be stripped).
3. Admin list + editor.
4. Public routes + SEO.

## Tests

- Unit: slug generation (diacritics, collisions), pillar filtering respects site
  config, sanitizer strips XSS vectors, media-reference rendering.
- Integration: publish flow — draft invisible on `/blog` + 404s by slug;
  published appears in list, detail, and sitemap.
- E2E: admin creates an article with a cover image from the media library,
  publishes it, sees it on the public blog with the cover rendered through
  imgproxy; sitemap.xml contains it.

## Definition of Done

- [ ] Gate green; e2e above green.
- [ ] With `SITE_ID=life`, an article tagged only `sleep` appears; one tagged to
      no active pillar of the current site does not (covered by a test).
- [ ] Lighthouse (or playwright a11y/meta assertions) confirm title, meta
      description, canonical, and OG tags on list + article pages.
- [ ] `docs/STATE.md` updated; all work committed.
