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
// Both prod and stage devsite hosts count as "internal" regardless of the
// chosen --env, so a hardcoded full URL to either gets verified against ORIGIN.
function isExternal(url) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(url) &&
    !/^https?:\/\/(www\.)?developer(-stage)?\.adobe\.com/i.test(url)
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
    TEMPLATE_TOKEN.test(url)
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
const MD_LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g; // [text](url)
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
const PER_HOST = 4; // max concurrent requests to any single host
const MAX_RETRY_AFTER_MS = 5000; // cap how long we'll wait on a 429

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
  if (s.count < PER_HOST) {
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
    if (res.status === 429) {
      const wait = Math.min(parseRetryAfter(res.headers.get('retry-after')) ?? 1000, MAX_RETRY_AFTER_MS);
      await sleep(wait);
      res = await rawFetch(url, method, timeoutMs);
    }
    return res.status;
  } finally {
    releaseHost(host);
  }
}

const CONFIRM_DELAY_MS = 1500; // pause before re-checking a link that looks dead

async function isAliveOnce(key) {
  const forms = key === '/' ? ['/'] : [`${key}/`, key];
  for (const form of forms) {
    const url = `${ORIGIN}${form}`;
    try {
      let status = await statusFor(url, 'HEAD');
      if (status === 405 || status === 501) status = await statusFor(url, 'GET');
      if (status >= 200 && status < 400) return true;
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
async function externalResultOnce(url) {
  try {
    let status = await statusFor(url, 'HEAD', EXT_TIMEOUT);
    if (status === 405 || status === 501) status = await statusFor(url, 'GET', EXT_TIMEOUT);
    if (status >= 200 && status < 400) return 'alive';
    if (status === 404 || status === 410) return 'broken';
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
  const aliveInternal = new Map();
  let internalToVerify = [...uniqueTargets];
  if (manifest) {
    internalToVerify = [];
    for (const key of uniqueTargets) {
      if (manifest.has(key)) aliveInternal.set(key, true);
      else internalToVerify.push(key);
    }
  }

  const extStatus = new Map();
  process.stdout.write(
    `   ${uniqueTargets.size} internal (${manifest ? uniqueTargets.size - internalToVerify.length : 0} via sitemap, ${internalToVerify.length} live) ` +
      `+ ${uniqueExtUrls.size} external… `,
  );
  await runPool(internalToVerify, async (key) => aliveInternal.set(key, await isAlive(key)));
  await runPool([...uniqueExtUrls], async (url) => extStatus.set(url, await externalResult(url)));
  console.log('done\n');

  // Internal: broken only if EVERY candidate form is dead.
  const brokenInternal = internal.filter((c) => c.targets.every((t) => aliveInternal.get(t) === false));
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
  externalResult,
  toKey,
};
