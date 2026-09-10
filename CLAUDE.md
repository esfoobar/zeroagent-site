# CLAUDE.md

## What this is

This repo is zeroagenthq.com, ZeroAgent's public site: a landing page, a download page, terms, privacy, and a private stats dashboard. Plain static HTML, no package.json, no build step, no tests, no CI. Deployed on Vercel as project `zeroagent-site`, team `mvpl-ean`, production branch `main`, output served straight from the repo root: `/index.html` is `/`, `/download/index.html` is `/download`, and so on.

This repo was split out of MVPLean Canvas (mvplean.com), where these pages used to live under `/zeroagent/`. The HTML, CSS and JS here started as a copy of those pages with paths rewritten for the new domain; MVPLean Canvas is not touched by this move and is not kept in sync with this repo going forward.

## Git rules

- Never commit to `main`.
- One issue, one branch, one PR. Tickets are `ZA-` issues tracked in the `esfoobar/zeroagent` repo, not in this one, so a PR body says `Closes esfoobar/zeroagent#<n>`, not a bare `Closes #<n>`.
- `gh auth switch -u esfoobar` before any `gh` command. The default account on this machine is often the wrong one.
- Work in a worktree rather than switching branches in the default checkout.

## The stats page

`/stats` is a private download-metrics dashboard, token gated client side. Three rules protect it, and all three matter:

- It keeps its `noindex, nofollow` meta tag exactly as it is.
- It stays out of `sitemap.xml`.
- `robots.txt` never gains a `Disallow` line for it.

The reason for the third rule is the first two: a crawler that is told to stay away from `/stats` via `Disallow` never fetches the page at all, which means it never sees the `noindex` meta tag either, and a `Disallow`'d URL can still show up in search results by path alone. Leaving `/stats` fetchable but marked `noindex` is what actually keeps it out of search indexes.

## Where the API lives

- The API is in this repo, under `api/`: Vercel functions served at `https://api.zeroagenthq.com` and equally at `https://zeroagenthq.com/api/` (one project, two domains). Nine endpoint files, eight shared modules in `api/_lib/`, and a node:test suite in `test/` (`npm test`; no network and no database, the stores take an injected collection). `package.json` holds only what the functions need: `@vercel/blob`, `@vercel/functions`, `mongodb`. Moved here from mvplean.com under ZA-289 on 2026-09-10; what each endpoint does is documented in the `zeroagent` repo's `docs/ACCOUNT.md`, `docs/DATABASE.md`, `docs/DOWNLOADS.md` and `docs/FEEDBACK.md`.
- The counted download links (`/download/arm64`, `/download/x64`) are a same-project rewrite in `vercel.json` to `api/download.js`, which records the event (a Vercel Blob object plus a GA4 hit) and 302s to the dmg on `https://releases.zeroagenthq.com`. A rewrite and not a redirect on purpose: the function reads the visitor's own IP, user agent and `x-vercel-ip-*` geo headers, and a same-project rewrite hands them through unchanged. `/stats` calls `/api/download-stats` with a relative URL.
- Env vars live on the `zeroagent-site` Vercel project, Production and Preview, sensitive (write only): `ZEROAGENT_JWT_SECRET` (the same value the relay verifies with), `MONGODB_URI`, `MONGODB_DB`, `DOWNLOAD_STATS_TOKEN`, `GA4_API_SECRET`, plus `BLOB_READ_WRITE_TOKEN`, which the connected `zeroagent-downloads` Blob store manages. Add one with `printf '%s' "$value" | vercel env add NAME production --sensitive`, never `echo` (a trailing newline corrupts the value). A worktree of this repo is not linked to Vercel: link a scratch directory with `vercel link --yes --scope mvpl-ean --project zeroagent-site` and run `vercel env` commands there.
- JWT issuer: since 2026-09-10 (ZA-291) tokens are minted with `iss https://zeroagenthq.com`, because `ZEROAGENT_JWT_ISSUER=https://zeroagenthq.com` is set on the project, Production and Preview. It was set only after the relay was deployed accepting both issuers. Unset, `api/_lib/issuer.js` falls back to the legacy `https://mvplean.com`. `api/_lib/jwt.js` keeps accepting both, and the legacy value has to stay until the last token minted with it has expired: 2026-10-11 for a desktop's thirty-day account token, but as late as 2027-09-10 for a paired phone's 365-day device token (`api/auth/pair/claim.js`). A Vercel env change or redeploy here is Zero Agent's work, done by a worker, never a step handed to Jorge.
- The old URLs still answer: mvplean.com rewrites `/api/*` to `api.zeroagenthq.com` and redirects `/zeroagent/download/:arch` to `/download/:arch` here, until every shipped client is updated (ZA-291) and the old copies of these files are removed from that repo (ZA-292).
- `trailingSlash: false` in `vercel.json` keeps `/download` (no trailing slash) the canonical form, matching the old site.
- The release feed is `https://releases.zeroagenthq.com` (CloudFront in front of S3, documented in the `zeroagent` repo's `docs/RELEASE.md`). `static/js/zeroagent-release.js` fetches it directly, unproxied, because that feed answers CORS with `Access-Control-Allow-Origin: *`.

## Styling and static assets

The site has one stylesheet, `static/css/zeroagent.css`: tokens (black page, off white text, hairlines, the app's coral as a status colour only), the type scale (Geist from Google Fonts, Geist Mono only for commands and checksums), the nav and footer, and the components the pages use. Pages carry no inline styles. The stats page is the exception: it is self contained on purpose (inline CSS, no nav or footer) and only mirrors the tokens.

The MVPLean Canvas theme files that the first import copied over (Bootstrap, the theme's `style.css` and friends, its icon fonts, jQuery, the plugin bundle, `functions.js`, the header logo images) were removed in ZA-294 once no page referenced them. `static/images/footer-widget-logo.png` is the one MVPLean asset left, for the footer. The screenshots, hero poster, video and Open Graph image under `static/images/zeroagent/` and `static/videos/zeroagent/` are the brand assets; the landing page frames each screenshot in a `.za-window`.

## GA4

The Google Analytics measurement id wired into these pages is `G-9J7FZ4N6Z0`, the web stream for the GA4 property "ZeroAgent" (property id 553596634), zeroagenthq.com's own stream. It replaced mvplean.com's `G-BTHHJB4E4T` in ZA-286.

## Durable documentation

Anything durable about ZeroAgent itself (the app, its architecture, its release process) lives in the `zeroagent` repo's `docs/`, never only here. This repo's own CLAUDE.md is about the site: what it is, how it is deployed, and how it depends on mvplean.com today.

## The `vercel dev` worktree pitfall

`vercel link` and `vercel dev` resolve the linked project from the repository root. Run them from a worktree of this repo and they still operate on the main checkout's link, not the worktree's, because there is only one `.vercel` project link per repository and it lives at the root.
