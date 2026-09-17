#!/usr/bin/env node
/*
 * check-links.js — the simplest way for a content repo owner to find broken
 * links in their own repo. Checks BOTH internal and external links.
 *
 *   cd your-content-repo
 *   node path/to/check-links.js
 *
 * No install, no dependencies, no token. It:
 *   1. reads every markdown file under src/pages
 *   2. INTERNAL links (developer.adobe.com): resolves each to its real URL
 *      (handling EDS path rules: pathPrefix, index pages, /src/pages, trailing
 *      slashes) and reports any that 404.
 *   3. EXTERNAL links (other domains): checks each over HTTP and reports only
 *      genuine 404/410. Bot-blocked / auth / rate-limited / transient results
 *      (401/403/429/5xx/timeouts) are hidden as noise — nothing is skipped by
 *      domain, so a real 404 on any site still surfaces.
 *
 * pathPrefix is read from src/pages/config.md automatically.
 *
 * Options:
 *   --dir <path>       repo to check (default: current directory)
 *   --path-prefix <p>  override the site pathPrefix
 *   --env <prod|stage> which devsite to verify links against (default: prod)
 *   --origin <url>     verify against a custom origin (overrides --env)
 *   --internal-only    check only internal (devsite) links
 *   --external-only    check only external links
 *   --show-noise       list the hidden external noise results
 */

const fs = require('fs');
const path = require('path');

// Which site to verify links against. Repos deployed only to stage should be
// checked with --env stage; default is prod. Both hosts are treated as
// "internal" so hardcoded full URLs get verified against the chosen origin.
const ORIGINS = {
  prod: 'https://developer.adobe.com',
  stage: 'https://developer-stage.adobe.com',
};
let ORIGIN = ORIGINS.prod; // set from --env / --origin in main()

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {
    dir: '.',
    pathPrefix: null,
    showNoise: false,
    internalOnly: false,
    externalOnly: false,
    env: 'prod',
    origin: null,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i];
    else if (argv[i] === '--path-prefix') args.pathPrefix = argv[++i];
    else if (argv[i] === '--show-noise') args.showNoise = true;
    else if (argv[i] === '--internal-only') args.internalOnly = true;
    else if (argv[i] === '--external-only') args.externalOnly = true;
    else if (argv[i] === '--env') args.env = argv[++i];
    else if (argv[i] === '--origin') args.origin = argv[++i];
  }
  return args;
}

// ---------------------------------------------------------------------------
// pathPrefix: read from src/pages/config.md unless overridden
// ---------------------------------------------------------------------------
function readPathPrefix(repoDir) {
  const configPath = path.join(repoDir, 'src', 'pages', 'config.md');
  if (!fs.existsSync(configPath)) return '';
  const lines = fs.readFileSync(configPath, 'utf8').split('\n');
  const keyIndex = lines.findIndex((l) => l.includes('pathPrefix:'));
  if (keyIndex < 0) return '';
  const line = lines.slice(keyIndex + 1).find((l) => l.trimStart().startsWith('-')) || '';
  const prefix = line.trimStart().substring(1).trim();
  return prefix === '/' ? '' : prefix.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// list & read markdown files under src/pages
// ---------------------------------------------------------------------------
function listMarkdown(repoDir) {
  const pagesDir = path.join(repoDir, 'src', 'pages');
  if (!fs.existsSync(pagesDir)) {
    throw new Error(`No src/pages found in ${path.resolve(repoDir)}`);
  }
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && /\.md$/i.test(e.name)) {
        out.push(path.relative(pagesDir, full).split(path.sep).join('/'));
      }
    }
  })(pagesDir);
  return out;
}

// ---------------------------------------------------------------------------
// URL resolution (the EDS-specific part)
// ---------------------------------------------------------------------------
function toKey(urlOrPath) {
  if (!urlOrPath) return null;
  let pathname;
  try {
    pathname = new URL(urlOrPath).pathname;
  } catch {
    pathname = urlOrPath.split('#')[0].split('?')[0];
  }
  if (!pathname) return null;
  pathname = pathname.replace(/\/+$/, '');
  return pathname === '' ? '/' : pathname;
}

function normalizeTarget(pathname) {
  let p = pathname.replace(/\.md$/i, '');
  p = p.replace(/(^|\/)index$/i, ''); // index page -> its directory
  return toKey(p) || '/';
}

// Directory URL of a markdown file — relative links resolve against THIS,
// not the page's own slug.
function dirPath(pathPrefix, relPath) {
  const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  return toKey(`${pathPrefix}/${dir}`.replace(/\/+/g, '/')) || '/';
}

const TEMPLATE_TOKEN = /[%{}$`]|<[a-z]/i;
// A bare email address used as a link target (e.g. [contact](engcom@adobe.com))
// — no scheme, so it isn't caught by the mailto: check but also isn't a real
// internal path. local@domain.tld with no slashes.
const BARE_EMAIL = /^[^\s/@]+@[^\s/@]+\.[^\s/@]+$/;
// Both prod and stage devsite hosts count as "internal" regardless of the
// chosen --env, so a hardcoded full URL to either gets verified against ORIGIN.
function isExternal(url) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) &&
    !/^https?:\/\/(www\.)?developer(-stage)?\.adobe\.com/i.test(url)
  );
}
// RFC-2606/6761 reserved names — defined as non-real, so never worth checking.
function isReservedHost(url) {
  let h;
  try {
    h = new URL(url).hostname.toLowerCase();
  } catch {
    return false; // relative link -> not a reserved host
  }
  return (
    /(^|\.)example\.(com|org|net|edu)$/.test(h) ||
    h.endsWith('.example') ||
    h === 'localhost' ||
    h === '127.0.0.1'
  );
}

function isSkippable(url) {
  return (
    !url ||
    url.startsWith('#') ||
    url.startsWith('mailto:') ||
    url.startsWith('tel:') ||
    url.startsWith('data:') ||
    url.startsWith('javascript:') ||
    TEMPLATE_TOKEN.test(url) ||
    BARE_EMAIL.test(url) ||
    isReservedHost(url)
  );
}

// Returns candidate canonical paths; a link is broken only if ALL fail.
function resolveInternal(rawUrl, dirKey, pathPrefix) {
  if (isSkippable(rawUrl)) return [];
  const clean = rawUrl.split('#')[0].split('?')[0];
  if (!clean) return [];

  if (/^https?:\/\//i.test(rawUrl)) {
    if (isExternal(rawUrl)) return [];
    return uniq([normalizeTarget(new URL(rawUrl).pathname)]);
  }
  if (isExternal(rawUrl)) return [];
  if (/\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|json|ico|css|js)$/i.test(clean)) return [];

  if (clean.startsWith('/')) {
    const candidates = [];
    if (/^\/src\/pages\//i.test(clean)) {
      candidates.push(normalizeTarget(`${pathPrefix}${clean.replace(/^\/src\/pages/i, '')}`));
    }
    if (pathPrefix && !clean.startsWith(`${pathPrefix}/`) && clean !== pathPrefix) {
      candidates.push(normalizeTarget(`${pathPrefix}${clean}`));
    }
    candidates.push(normalizeTarget(clean));
    return uniq(candidates);
  }

  const base = `${ORIGIN}${dirKey}/`;
  return uniq([normalizeTarget(new URL(clean, base).pathname)]);
}

function uniq(a) {
  return [...new Set(a.filter(Boolean))];
}

// Only real link syntax counts. NOTE: we deliberately do NOT detect bare
// https://… URLs — the EDS renderer does not autolink bare URLs in prose (a URL
// written inside a sentence renders as plain text, not a clickable link), so
// treating them as links produces false positives.
// [text](url) — the URL may contain balanced parens, e.g. a Wikipedia link like
// .../SOLID_(object-oriented_design). Each step matches a SINGLE non-paren char
// OR a whole balanced (...) group. Note the single-char alternative (not [..]+):
// a nested quantifier here — (?:[^()\s>]+|\(...\))+ — backtracks catastrophically
// (ReDoS) on some content, so it must stay a single char to keep matching linear.
// The (?<!\\) guards against an ESCAPED bracket: markdown like
// `representations\[*\](type=application/vnd.adobe.color+json)` is a JSONPath in
// prose, not a link — a real link's closing `]` is never backslash-escaped.
const MD_LINK = /(?<!\\)\]\(\s*<?((?:[^()\s>]|\([^()]*\))+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
const HTML_HREF = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi; // <a href="url">
const ANGLE_URL = /<(https?:\/\/[^>\s]+)>/gi; // <https://…> explicit autolink
const LINK_SOURCES = [MD_LINK, HTML_HREF, ANGLE_URL];

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|json|ico|css|js)(\?|#|$)/i;

// Blank out a region while PRESERVING newlines, so reported line numbers still
// match the original file (deleting the region would shift every line after it).
const blankKeepingLines = (s) => s.replace(/[^\n]/g, ' ');

// Returns link records tagged as 'internal' (resolved to developer.adobe.com
// candidate paths) or 'external' (a full URL on another domain).
function extractLinks(content, dirKey, pathPrefix) {
  const body = content
    .replace(/^---\n[\s\S]*?\n---\n/, blankKeepingLines) // frontmatter
    .replace(/```[\s\S]*?```/g, blankKeepingLines) // fenced code blocks
    .replace(/`[^`]*`/g, blankKeepingLines); // inline code spans
  const results = [];
  const seen = new Set();
  for (const re of LINK_SOURCES) {
    let m;
    while ((m = re.exec(body)) !== null) {
      const raw = m[1];
      const line = body.slice(0, m.index).split('\n').length;
      if (isSkippable(raw)) continue;

      if (isExternal(raw)) {
        if (!/^https?:\/\//i.test(raw)) continue; // only http(s) is checkable
        const url = raw.split('#')[0];
        if (ASSET_EXT.test(url)) continue;
        const key = `ext::${url}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push({ kind: 'external', raw, url, line });
        continue;
      }

      const targets = resolveInternal(raw, dirKey, pathPrefix);
      if (!targets.length) continue;
      const key = `int::${raw}::${targets.join('|')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ kind: 'internal', raw, targets, line });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// live HTTP verification (follows redirects; tries trailing-slash form too)
//
// Per-host throttling: the global worker pool can put many requests in flight at
// once, but if they target the SAME host we'd burst it and get 429s (or add load
// to the production site). So each host is capped to PER_HOST concurrent requests
// independently, and we honor a 429's Retry-After before one retry. This keeps us
// a good citizen against developer.adobe.com and any busy external domain.
// ---------------------------------------------------------------------------
const PER_HOST = 4; // max concurrent requests to any single host (default)
// Some hosts rate-limit bots aggressively and return 429 for a live/dead page
// alike; hitting them one-at-a-time keeps their status STABLE run-to-run (a link
// that flaps 429↔404 otherwise looks "newly broken" and re-nags). github is the
// big one (blob/tree link checks).
const PER_HOST_OVERRIDE = new Map([
  ['github.com', 1],
  ['raw.githubusercontent.com', 1],
  ['api.github.com', 1],
]);
const perHostLimit = (host) => PER_HOST_OVERRIDE.get(host) ?? PER_HOST;
const MAX_RETRY_AFTER_MS = 5000; // cap how long we'll wait on a single 429 backoff
const MAX_429_RETRIES = 3; // retry a 429 a few times (backoff) so it resolves to its true status

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

const hostSem = new Map(); // host -> { count, waiters: [] }
async function acquireHost(host) {
  let s = hostSem.get(host);
  if (!s) {
    s = { count: 0, waiters: [] };
    hostSem.set(host, s);
  }
  if (s.count < perHostLimit(host)) {
    s.count++;
    return;
  }
  await new Promise((res) => s.waiters.push(res)); // slot handed over on release
}
function releaseHost(host) {
  const s = hostSem.get(host);
  if (!s) return;
  const next = s.waiters.shift();
  if (next) next(); // pass the held slot straight to the next waiter (count unchanged)
  else s.count--; // no one waiting -> free the slot
}

function parseRetryAfter(header) {
  if (!header) return null;
  const secs = Number(header);
  if (!Number.isNaN(secs)) return secs * 1000; // "Retry-After: 30"
  const date = Date.parse(header); // "Retry-After: <http-date>"
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
}

async function rawFetch(url, method, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method,
      redirect: 'follow',
      signal: controller.signal,
      // Identifies this crawler so ops can recognize/allowlist rather than block.
      headers: { 'user-agent': 'adp-check-links (link health bot)' },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function statusFor(url, method, timeoutMs = 15000) {
  const host = hostOf(url);
  await acquireHost(host);
  try {
    let res = await rawFetch(url, method, timeoutMs);
    // Retry a 429 a few times with exponential backoff (honoring Retry-After) so a
    // rate-limited link resolves to its real status instead of being written off.
    for (let attempt = 0; res.status === 429 && attempt < MAX_429_RETRIES; attempt++) {
      const wait = Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt, MAX_RETRY_AFTER_MS);
      await sleep(wait);
      res = await rawFetch(url, method, timeoutMs);
    }
    return { status: res.status, finalUrl: res.url }; // finalUrl = where redirects landed
  } finally {
    releaseHost(host);
  }
}

const toggleSlash = (u) => (u.endsWith('/') ? u.slice(0, -1) : `${u}/`);

const CONFIRM_DELAY_MS = 1500; // pause before re-checking a link that looks dead

// HEAD first (cheap), but fall back to GET whenever HEAD isn't clearly alive.
// Many servers mishandle HEAD (nuget.org returns 404, others 403/405) while GET
// works — GET is what a browser does, so it's authoritative.
async function probe(url, timeoutMs = 15000) {
  let r = await statusFor(url, 'HEAD', timeoutMs);
  if (!(r.status >= 200 && r.status < 400)) r = await statusFor(url, 'GET', timeoutMs);
  return r;
}

const ok = (s) => s >= 200 && s < 400;

async function isAliveOnce(key) {
  const forms = key === '/' ? ['/'] : [`${key}/`, key];
  for (const form of forms) {
    const url = `${ORIGIN}${form}`;
    try {
      const { status, finalUrl } = await probe(url);
      if (ok(status)) return true;
      // A redirect can land on a URL whose trailing slash 404s while the other
      // form is live (e.g. /a/b/ 301→ /c/d/ [404] but /c/d [200]). If we followed
      // a redirect to a 404, retry the destination with the slash toggled.
      if (status === 404 && finalUrl && finalUrl !== url) {
        if (ok((await probe(toggleSlash(finalUrl))).status)) return true;
      }
    } catch {
      return true; // transient/network error -> don't report as broken
    }
  }
  return false;
}

// Confirm a "dead" result before trusting it: many endpoints return a transient
// 404 (cold CDN edge, deploy blip, rate-limit-as-404). A genuine 404 stays 404
// on a second look; a flaky one recovers. Only the few links that look dead pay
// this cost, so healthy repos are unaffected.
async function isAlive(key) {
  if (await isAliveOnce(key)) return true;
  await sleep(CONFIRM_DELAY_MS);
  return isAliveOnce(key);
}

// Classify an external URL by outcome, not by domain:
//   'alive'  -> 2xx/3xx
//   'broken' -> 404/410 (genuinely gone; reported)
//   'noise'  -> 401/403/429/5xx/transient (bot-blocked, auth, rate-limited,
//               flaky) -> hidden by default, since the page likely exists
//
// No retry loop: a transient failure can only ever be classified 'noise' (never
// 'broken'), which is hidden anyway — so retrying just to re-confirm noise would
// waste time. A short timeout keeps a few slow/dead hosts from dominating.
const EXT_TIMEOUT = 8000;

// Text a real not-found page shows. A single-page app that soft-404s a deep link
// (returns a 404 status but ships the JS app shell, which then client-renders the
// page) has NONE of this — the "not found" only appears later if the route is
// truly invalid, which we can't see over HTTP.
const NOT_FOUND_TEXT =
  /page not found|not be found|couldn['’]t (?:be )?find|cannot be found|can['’]t be found|doesn['’]t exist|no longer (?:exists|available)|404 error|error 404|>\s*404\s*</i;

// SPA soft-404: a 404 status whose body is an HTML app shell (loads a JS bundle)
// with no not-found text — e.g. v5.reactrouter.com/web/api/Link. Such a URL
// renders fine in a browser but is indistinguishable over HTTP from a real 404
// on the same host, so we hide it (as noise) rather than report a false "broken".
// Only called on an already-404 link, so the extra GET is rare.
async function looksLikeSpaSoft404(url) {
  try {
    const res = await rawFetch(url, 'GET', EXT_TIMEOUT);
    if (!/text\/html/i.test(res.headers.get('content-type') || '')) return false;
    const body = await res.text();
    if (!/<script\b[^>]*\bsrc=/i.test(body)) return false; // no JS app -> not a shell
    return !NOT_FOUND_TEXT.test(body); // explicit "not found" -> real 404, keep it
  } catch {
    return false;
  }
}

async function externalResultOnce(url) {
  try {
    const { status, finalUrl } = await probe(url, EXT_TIMEOUT);
    if (ok(status)) return 'alive';
    // Same redirect-trailing-slash rescue as internal: a short-link (e.g.
    // adobe.com/go/…) can 301 to a URL whose trailing slash 404s while the
    // other form is live. If a followed redirect 404s, retry with slash toggled.
    if (status === 404 && finalUrl && finalUrl !== url) {
      if (ok((await probe(toggleSlash(finalUrl), EXT_TIMEOUT)).status)) return 'alive';
    }
    if (status === 404 || status === 410) {
      // Don't flag a single-page-app soft-404 (renders client-side) as broken.
      if (await looksLikeSpaSoft404(finalUrl || url)) return 'noise';
      return 'broken';
    }
    return 'noise';
  } catch {
    return 'noise'; // timeout / network error -> not broken
  }
}

// Same confirmation pass as internal: only re-check when it looks broken, so a
// transient 404 on an external host doesn't get falsely reported.
async function externalResult(url) {
  const r = await externalResultOnce(url);
  if (r !== 'broken') return r;
  await sleep(CONFIRM_DELAY_MS);
  return externalResultOnce(url);
}

// Speed-up: developer.adobe.com publishes a sitemap of every live page. Loading
// it once (a single request) lets us confirm most internal links WITHOUT any
// per-link HTTP call — only links missing from the sitemap need live verifying.
async function fetchManifest() {
  try {
    const res = await rawFetch(`${ORIGIN}/sitemap.xml`, 'GET', 20000);
    if (!res.ok) return null;
    const xml = await res.text();
    const set = new Set();
    const re = /<loc>\s*([^<\s]+)\s*<\/loc>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const key = toKey(m[1]); // normalize to pathname, no trailing slash
      if (key) set.add(key);
    }
    return set.size ? set : null;
  } catch {
    return null; // no manifest -> fall back to verifying every link live
  }
}

// ---------------------------------------------------------------------------
// curated redirects (redirects.json) — mirrors the site's own resolution
//
// A path can 404 at every server layer (Fastly's redirect table, the EDS origin)
// yet still resolve for real users: the 404 page's redirect() (in lib-adobeio.js)
// looks the path up in the owning repo's <pathPrefix>/redirects.json and
// client-redirects to the Destination. That client-side read is a permanent site
// feature, so a link it resolves is genuinely reachable — not broken. We
// replicate that exact lookup here (match pathPrefix via devsitepaths, then the
// repo's redirects.json), and only count it as resolved if the Destination itself
// is live.
// ---------------------------------------------------------------------------
let devsitePathsPromise; // fetched once per run
function getDevsitePaths() {
  if (!devsitePathsPromise) {
    devsitePathsPromise = (async () => {
      try {
        const res = await rawFetch(`${ORIGIN}/franklin_assets/devsitepaths.json`, 'GET', 20000);
        if (!res.ok) return null;
        const j = await res.json();
        return (j && j.data) || null;
      } catch {
        return null;
      }
    })();
  }
  return devsitePathsPromise;
}

const redirectsCache = new Map(); // pathPrefix -> Promise<Map<Source,Destination>|null>
function getRedirects(pathPrefix) {
  if (!redirectsCache.has(pathPrefix)) {
    redirectsCache.set(
      pathPrefix,
      (async () => {
        try {
          const res = await rawFetch(`${ORIGIN}${pathPrefix}/redirects.json`, 'GET', 15000);
          if (!res.ok) return null;
          const j = await res.json();
          const rows = (j && j.data) || [];
          const m = new Map();
          for (const r of rows) if (r && r.Source) m.set(r.Source, r.Destination);
          return m.size ? m : null;
        } catch {
          return null;
        }
      })(),
    );
  }
  return redirectsCache.get(pathPrefix);
}

// Same level-3 → level-2 → level-1 pathPrefix match the site's redirect() uses.
function matchDevsitePrefix(key, paths) {
  const s = key.split('/'); // ['', seg1, seg2, ...]
  const tries = [];
  if (s.length > 3) tries.push(`/${s[1]}/${s[2]}/${s[3]}`);
  if (s.length > 2) tries.push(`/${s[1]}/${s[2]}`);
  if (s.length > 1) tries.push(`/${s[1]}`);
  for (const p of tries) if (paths.some((e) => e.pathPrefix === p)) return p;
  return null;
}

// If `key` is a redirects.json Source whose Destination resolves, return the
// Destination; else null. Matches the site: exact Source match on the path,
// trying both slash forms (redirects.json lists both). Verifies the Destination.
async function redirectResolve(key) {
  const paths = await getDevsitePaths();
  if (!paths) return null;
  const prefix = matchDevsitePrefix(key, paths);
  if (!prefix) return null;
  const map = await getRedirects(prefix);
  if (!map) return null;
  const dest = map.get(key) || map.get(`${key}/`);
  if (!dest) return null;
  const destKey = toKey(dest);
  if (destKey && (await isAliveOnce(destKey))) return dest;
  return null; // redirect points at something that also 404s -> still broken
}

// Three-state classification for an internal path:
//   'alive'      -> reachable now (200, server redirect, or slash-sibling)
//   'redirected' -> 404, but rescued by curated redirects.json (Destination live)
//   'broken'     -> 404 and nothing rescues it
// Slash-toggle rescue already lives in isAliveOnce, so it lands in 'alive'
// (a permanent EDS fallback, not a page move) — redirects.json is checked only
// once the path itself is gone, matching the site's precedence.
async function classifyInternalOnce(key) {
  if (await isAliveOnce(key)) return { state: 'alive' };
  const dest = await redirectResolve(key);
  if (dest) return { state: 'redirected', destination: dest };
  return { state: 'broken' };
}
async function classifyInternal(key) {
  const r = await classifyInternalOnce(key);
  if (r.state !== 'broken') return r; // only re-confirm a "broken" verdict
  await sleep(CONFIRM_DELAY_MS);
  return classifyInternalOnce(key);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = parseArgs(process.argv);
  const repoDir = args.dir;

  // Resolve which site to check against: --origin wins, else --env (prod|stage).
  if (args.origin) ORIGIN = args.origin.replace(/\/$/, '');
  else if (ORIGINS[args.env]) ORIGIN = ORIGINS[args.env];
  else {
    console.error(`Unknown --env "${args.env}". Use "prod" or "stage" (or --origin <url>).`);
    process.exit(1);
  }

  const pathPrefix =
    args.pathPrefix != null ? args.pathPrefix.replace(/\/$/, '') : readPathPrefix(repoDir);

  console.log(`\n🔗 Checking links in ${path.resolve(repoDir)}`);
  console.log(`   against: ${ORIGIN}`);
  console.log(`   pathPrefix: ${pathPrefix || '(site root)'}\n`);

  // Pre-flight: is this site actually deployed? If the root 404s, every link
  // will "break" — tell the owner that instead of dumping a huge false list.
  const rootAlive = await isAlive(pathPrefix || '/');
  if (!rootAlive) {
    console.log(`⚠️  ${ORIGIN}${pathPrefix}/ is not reachable (404).`);
    console.log(`   This repo may not be deployed yet, or the pathPrefix is wrong.`);
    console.log(`   Skipping link checks to avoid a wall of false positives.\n`);
    return;
  }

  const files = listMarkdown(repoDir).filter((f) => !/(^|\/)config\.md$/i.test(f));
  console.log(`   ${files.length} markdown files\n`);

  // Collect internal + external candidates, verifying each unique URL once.
  const internal = [];
  const external = [];
  const uniqueTargets = new Set();
  const uniqueExtUrls = new Set();
  for (const rel of files) {
    const content = fs.readFileSync(path.join(repoDir, 'src', 'pages', rel), 'utf8');
    const dirKey = dirPath(pathPrefix, rel);
    for (const link of extractLinks(content, dirKey, pathPrefix)) {
      const rec = { file: `src/pages/${rel}`, ...link };
      if (link.kind === 'external') {
        if (!args.internalOnly) {
          external.push(rec);
          uniqueExtUrls.add(link.url);
        }
      } else if (!args.externalOnly) {
        internal.push(rec);
        link.targets.forEach((t) => uniqueTargets.add(t));
      }
    }
  }

  const CONCURRENCY = 30;
  async function runPool(items, worker) {
    const q = [...items];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, q.length) }, async () => {
        while (q.length) await worker(q.shift());
      }),
    );
  }

  // Pre-filter internal links against the sitemap: anything listed there is
  // live, so we skip the network for it and only verify the misses.
  const manifest = await fetchManifest();
  const internalState = new Map(); // key -> { state, destination? }
  let internalToVerify = [...uniqueTargets];
  if (manifest) {
    internalToVerify = [];
    for (const key of uniqueTargets) {
      if (manifest.has(key)) internalState.set(key, { state: 'alive' });
      else internalToVerify.push(key);
    }
  }

  const extStatus = new Map();
  process.stdout.write(
    `   ${uniqueTargets.size} internal (${manifest ? uniqueTargets.size - internalToVerify.length : 0} via sitemap, ${internalToVerify.length} live) ` +
      `+ ${uniqueExtUrls.size} external… `,
  );
  await runPool(internalToVerify, async (key) => internalState.set(key, await classifyInternal(key)));
  await runPool([...uniqueExtUrls], async (url) => extStatus.set(url, await externalResult(url)));
  console.log('done\n');

  // Internal per-link verdict from its candidate targets, mirroring the site:
  //   alive if ANY candidate is reachable; else redirected if ANY candidate is
  //   rescued by redirects.json; else broken (all candidates dead).
  const stateOf = (t) => internalState.get(t) || { state: 'broken' };
  function linkVerdict(c) {
    const states = c.targets.map(stateOf);
    if (states.some((s) => s.state === 'alive')) return { state: 'alive' };
    const red = states.find((s) => s.state === 'redirected');
    if (red) return { state: 'redirected', destination: red.destination };
    return { state: 'broken' };
  }
  const brokenInternal = internal.filter((c) => linkVerdict(c).state === 'broken');
  // Not broken, but resolves only through a curated redirects.json redirect.
  const redirectedInternal = internal
    .map((c) => ({ c, v: linkVerdict(c) }))
    .filter((x) => x.v.state === 'redirected')
    .map((x) => ({ ...x.c, destination: x.v.destination }));
  // External: broken = 404/410; noise = blocked/flaky (hidden unless --show-noise).
  const brokenExternal = external.filter((c) => extStatus.get(c.url) === 'broken');
  const noiseExternal = external.filter((c) => extStatus.get(c.url) === 'noise');

  let found = false;

  if (!args.externalOnly) {
    if (brokenInternal.length === 0) {
      console.log('✅ Internal links: none broken.');
    } else {
      found = true;
      console.log(`❌ Internal links: ${brokenInternal.length} broken`);
      for (const b of brokenInternal) {
        console.log(`   ${b.file}:${b.line}`);
        console.log(`     link:  ${b.raw}`);
        console.log(`     404:   ${ORIGIN}${b.targets[0]}\n`);
      }
    }
    // Not broken, but only reachable via a curated redirects.json redirect.
    // Informational (doesn't fail the run): the link works, but points at an old
    // URL — cleaner to update it to the destination.
    if (redirectedInternal.length) {
      console.log(
        `\nℹ️  Internal links: ${redirectedInternal.length} resolve via a redirect (redirects.json)`,
      );
      for (const r of redirectedInternal) {
        console.log(`   ${r.file}:${r.line}`);
        console.log(`     link: ${r.raw}`);
        console.log(`     →     ${r.destination}\n`);
      }
    }
  }

  if (!args.internalOnly) {
    if (brokenExternal.length === 0) {
      console.log('✅ External links: none broken (404/410).');
    } else {
      found = true;
      console.log(`\n❌ External links: ${brokenExternal.length} broken (404/410)`);
      for (const b of brokenExternal) {
        console.log(`   ${b.file}:${b.line}`);
        console.log(`     [${'404/410'}] ${b.url}\n`);
      }
    }
    if (noiseExternal.length) {
      console.log(
        `\nℹ️  ${noiseExternal.length} external link(s) hidden as noise ` +
          `(bot-blocked / auth / rate-limited / transient).` +
          (args.showNoise ? '' : ' Use --show-noise to list them.'),
      );
      if (args.showNoise) {
        for (const b of noiseExternal) console.log(`   ${b.url}\n     in ${b.file}:${b.line}`);
      }
    }
  }

  console.log('');
  if (found) process.exitCode = 1; // non-zero so it can gate a script/CI if desired
}

// Point verification at prod, stage, or a custom origin. Used by sweep.js so the
// multi-repo sweep reuses this file's exact checking logic.
function setOrigin(envOrUrl) {
  if (/^https?:\/\//i.test(envOrUrl)) ORIGIN = envOrUrl.replace(/\/$/, '');
  else if (ORIGINS[envOrUrl]) ORIGIN = ORIGINS[envOrUrl];
  else throw new Error(`unknown env "${envOrUrl}" (use prod|stage or a full URL)`);
  return ORIGIN;
}

// Run as a script → check one repo. Require as a module → reuse the primitives.
if (require.main === module) {
  main().catch((err) => {
    console.error('\n💥', err.message);
    process.exit(1);
  });
}

module.exports = {
  ORIGINS,
  setOrigin,
  fetchManifest,
  extractLinks,
  dirPath,
  isAlive,
  classifyInternal, // three-state: alive | redirected (redirects.json) | broken
  redirectResolve,
  externalResult,
  toKey,
};
