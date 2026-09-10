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

## Where the API and release feed live today, and when that changes

- The API endpoints this site calls (`/api/download`, `/api/download-stats`, feedback, auth) still run on mvplean.com, in the MVPLean Canvas repo. This site reaches them two ways: the counted download links (`/download/arm64`, `/download/x64`) are a temporary redirect in `vercel.json` to `https://mvplean.com/zeroagent/download/:arch`, and everything else under `/api/*` is proxied through a rewrite to `https://mvplean.com/api/:path*`. Both go away once **ZA-289** moves those endpoints to `api.zeroagenthq.com`.
- The counted download redirect is a redirect and not a rewrite on purpose: the counter on the other end needs the real visitor's IP, user agent and geo to do its job, and a rewrite would hide all of that behind Vercel's own proxy. The stats JSON has no such concern, a machine is reading it either way, so it is proxied through a rewrite instead, which lets `/stats` call a relative `/api/download-stats?...` URL with no CORS change needed on the mvplean.com side.
- `trailingSlash: false` in `vercel.json` keeps `/download` (no trailing slash) the canonical form, matching the old site.
- The release feed is `https://releases.zeroagenthq.com` (CloudFront in front of S3, moved there under **ZA-290**), documented in the `zeroagent` repo's `docs/RELEASE.md`. `static/js/zeroagent-release.js` fetches it directly, unproxied, because that feed answers CORS with `Access-Control-Allow-Origin: *`. The old `releases.zeroagent.mvplean.com` is a second alias on the same distribution and keeps answering until **ZA-291** has moved every installed copy of the app off it, which is why the privacy page names both.

## Styling and static assets

The site has one stylesheet, `static/css/zeroagent.css`: tokens (black page, off white text, hairlines, the app's coral as a status colour only), the type scale (Geist from Google Fonts, Geist Mono only for commands and checksums), the nav and footer, and the components the pages use. Pages carry no inline styles. The stats page is the exception: it is self contained on purpose (inline CSS, no nav or footer) and only mirrors the tokens.

The MVPLean Canvas theme files that the first import copied over (Bootstrap, the theme's `style.css` and friends, its icon fonts, jQuery, the plugin bundle, `functions.js`, the header logo images) were removed in ZA-294 once no page referenced them. `static/images/footer-widget-logo.png` is the one MVPLean asset left, for the footer. The screenshots, hero poster, video and Open Graph image under `static/images/zeroagent/` and `static/videos/zeroagent/` are the brand assets; the landing page frames each screenshot in a `.za-window`.

## GA4

The Google Analytics measurement id wired into these pages is `G-9J7FZ4N6Z0`, the web stream for the GA4 property "ZeroAgent" (property id 553596634), zeroagenthq.com's own stream. It replaced mvplean.com's `G-BTHHJB4E4T` in ZA-286.

## Durable documentation

Anything durable about ZeroAgent itself (the app, its architecture, its release process) lives in the `zeroagent` repo's `docs/`, never only here. This repo's own CLAUDE.md is about the site: what it is, how it is deployed, and how it depends on mvplean.com today.

## The `vercel dev` worktree pitfall

`vercel link` and `vercel dev` resolve the linked project from the repository root. Run them from a worktree of this repo and they still operate on the main checkout's link, not the worktree's, because there is only one `.vercel` project link per repository and it lives at the root.
