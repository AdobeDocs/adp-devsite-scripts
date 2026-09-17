#!/usr/bin/env node
/*
 * sweep.js — run the check-links engine across ALL content repos (from the
 * registry), fetching each repo's markdown from GitHub. No local clones.
 *
 * It reuses check-links.js for the actual link resolution + verification, so the
 * two tools can never drift. This file only adds: the repo list (registry),
 * fetching files from GitHub, batching (to spread load over the night), and a
 * combined report.
 *
 *   GITHUB_TOKEN=$(gh auth token) node sweep.js                 # all repos, prod
 *   node sweep.js --env stage --limit 10                        # first 10, stage
 *   node sweep.js --batch-size 5 --batch-delay 120              # 5 repos / 2 min
 *   node sweep.js --repos analytics-2.0-apis,commerce-webapi    # specific repos
 *   node sweep.js --out report.json                             # save results
 *
 * Dry-run only: it reports, it never files anything.
 */

const fs = require('fs');
const {
  setOrigin,
  fetchManifest,
  extractLinks,
  dirPath,
  isAlive,
  classifyInternal,
  externalResult,
} = require('./check-links');

const API = 'https://api.github.com';
const UA = 'adp-check-links (link health bot)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DEVSITE_PATHS = {
  prod: 'https://main--adp-devsite--adobedocs.aem.live/franklin_assets/devsitepaths.json',
  stage: 'https://main--adp-devsite-stage--adobedocs.aem.page/franklin_assets/devsitepaths.json',
};

function parseArgs(argv) {
  const a = {
    env: 'prod',
    start: 1, // 1-based position in the registry to begin at
    limit: null,
    repos: null,
    batchSize: 5,
    batchDelay: 120,
    out: null,
    external: false, // internal cross-repo links only by default (fast, focused)
    file: false, // when true, create/update a GitHub issue per broken repo
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--env') a.env = argv[++i];
    else if (argv[i] === '--start') a.start = parseInt(argv[++i], 10);
    else if (argv[i] === '--limit') a.limit = parseInt(argv[++i], 10);
    else if (argv[i] === '--repos') a.repos = argv[++i].split(',').map((s) => s.trim());
    else if (argv[i] === '--batch-size') a.batchSize = parseInt(argv[++i], 10);
    else if (argv[i] === '--batch-delay') a.batchDelay = parseInt(argv[++i], 10);
    else if (argv[i] === '--out') a.out = argv[++i];
    else if (argv[i] === '--external') a.external = true; // also check external links
    else if (argv[i] === '--file') a.file = true; // actually create/update GitHub issues
  }
  return a;
}

// ---------------------------------------------------------------------------
// GitHub issue filing (only when --file). One deduped issue per repo.
// ---------------------------------------------------------------------------
const ISSUE_TITLE = (repo) => `🔗 Broken links found on developer.adobe.com (${repo})`;
const ISSUE_MARKER = '<!-- adp-link-health -->';
// Owner escape hatch: add this label to the issue to silence the repo entirely
// (even for new links), separate from closing (which only dismisses the listed links).
const MUTE_LABELS = new Set(['link-health: ignore', 'link-health:ignore', 'link-health-mute']);
// Hidden machine-readable record of which links we've already reported — the
// issue itself is our state store, so no external DB is needed to dedup.
const KEYS_RE = /<!-- adp-link-health-keys:\s*(\[[\s\S]*?\])\s*-->/;
// Dedup key intentionally omits the line number: a still-broken, already-
// dismissed link that merely shifts lines (because the author edited unrelated
// content above it) must NOT look "new" and reopen a closed issue. Keyed on
// file + resolved target; the line is kept only for display. Two identical
// broken targets in the same file collapse to one key (acceptable).
const findingKey = (f) => `${f.file}|${f.target || f.url || f.raw}`;
const keysBlock = (keys) => `<!-- adp-link-health-keys: ${JSON.stringify(keys)} -->`;
function parseKeys(body) {
  const m = (body || '').match(KEYS_RE);
  if (!m) return [];
  try {
    return JSON.parse(m[1]);
  } catch {
    return [];
  }
}
function isMuted(existing) {
  return !!(existing && (existing.labels || []).some((l) => MUTE_LABELS.has(String(l.name || l).toLowerCase())));
}

// Pure decision (no network) so it's unit-testable. Given the existing issue
// (or null) and this run's findings, decide what to do:
//   'create'      -> no issue yet, links are broken
//   'update'      -> issue open, refresh the list
//   'close'       -> issue open, everything now resolves
//   'reopen'      -> issue closed, but NEW links appeared (shows only the new ones)
//   'noop-clean'  -> no issue, nothing broken
//   'noop-closed' -> issue closed, no new links -> respect the close, stay silent
//   'mute'        -> owner applied the ignore label
function decideIssueAction(existing, findings) {
  if (isMuted(existing)) return { op: 'mute' };
  const currentKeys = [...new Set(findings.map(findingKey))].sort();
  if (!existing) return findings.length ? { op: 'create', show: findings, storedKeys: currentKeys } : { op: 'noop-clean' };
  if (existing.state === 'open') {
    return findings.length ? { op: 'update', show: findings, storedKeys: currentKeys } : { op: 'close' };
  }
  // closed: only genuinely-new links (not in the dismissed set) may reopen it
  const prevKeys = parseKeys(existing.body);
  const prev = new Set(prevKeys);
  const newFindings = findings.filter((f) => !prev.has(findingKey(f)));
  if (!newFindings.length) return { op: 'noop-closed' };
  // remember everything ever reported so dismissed links never come back
  const storedKeys = [...new Set([...prevKeys, ...currentKeys])].sort();
  return {
    op: 'reopen',
    show: newFindings,
    dismissed: prevKeys, // preserved in a collapsed section so the prior record stays visible
    storedKeys,
    comment: `${ISSUE_MARKER}\n🔄 Reopened: ${newFindings.length} new broken link(s) found since this issue was closed. The previously-reported links are kept below in a collapsed section.`,
  };
}

// @-mention resolution: prefer CODEOWNERS (the declared owners), and only if the
// repo has none, fall back to the most recent human committer.
async function getCodeowners(owner, repo, token) {
  for (const p of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const r = await fetch(`${API}/repos/${owner}/${repo}/contents/${p}`, { headers: authHeaders(token) });
    if (r.ok) {
      const j = await r.json();
      const text = Buffer.from(j.content || '', 'base64').toString('utf8');
      const owners = [...new Set(text.match(/@[A-Za-z0-9/_-]+/g) || [])]; // every @owner / @org/team token
      if (owners.length) return owners;
    }
  }
  return [];
}

// Most recent human contributor (latest commit author on the default branch),
// skipping bot accounts (release bots, dependabot, etc.).
async function getLastContributor(owner, repo, token) {
  const r = await fetch(`${API}/repos/${owner}/${repo}/commits?per_page=15`, { headers: authHeaders(token) });
  if (!r.ok) return [];
  const commits = await r.json();
  for (const c of commits) {
    const login = c.author && c.author.login; // GitHub account (null if commit email isn't linked)
    const type = c.author && c.author.type;
    if (!login) continue;
    if (type === 'Bot' || /\[bot\]$/i.test(login) || /-bot$/i.test(login)) continue;
    return [`@${login}`];
  }
  return [];
}

// CODEOWNERS first; last contributor as fallback. Returns { owners, source }.
async function getMentions(owner, repo, token) {
  const codeowners = await getCodeowners(owner, repo, token);
  if (codeowners.length) return { owners: codeowners, source: 'codeowners' };
  const last = await getLastContributor(owner, repo, token);
  return { owners: last, source: last.length ? 'contributor' : '' };
}

const MAX_ROWS = 100; // keep issues readable and under GitHub's body-size limit
const MAX_DISMISSED = 300; // collapsed section can hold more; still cap for body-size safety
// Render a stored key ("file:line|target") as a table row for the collapsed
// "previously reported" section.
function dismissedTable(keys, blobBase = '') {
  const shown = keys.slice(0, MAX_DISMISSED);
  const rows = shown
    .map((k) => {
      const i = k.indexOf('|');
      const loc = i < 0 ? k : k.slice(0, i);
      const link = i < 0 ? '' : k.slice(i + 1);
      // Link the source file to its blob view so the owner can click straight to it.
      const locCell = blobBase ? `[\`${loc}\`](${blobBase}/${loc})` : `\`${loc}\``;
      return `| ${locCell} | ${link} |`;
    })
    .join('\n');
  const more = keys.length > MAX_DISMISSED ? `\n\n_…and ${keys.length - MAX_DISMISSED} more._` : '';
  return `\n<details><summary>Previously reported — ${keys.length} link(s) (dismissed when this issue was last closed)</summary>\n\n| Source (file) | Link |\n|---|---|\n${rows}${more}\n\n</details>\n`;
}

// `show` = the links to display; `storedKeys` = the full set to remember (hidden);
// `dismissed` = keys to preserve in a collapsed section (only on reopen).
function issueBody(pathPrefix, env, show, owners, storedKeys, dismissed = [], mentionSource = '', blobBase = '') {
  const shown = show.slice(0, MAX_ROWS);
  // Source cell links to the exact line in the repo's own file (blob/HEAD =
  // default branch) so the owner can click through to the broken link.
  const srcCell = (f) =>
    blobBase ? `[\`${f.file}:${f.line}\`](${blobBase}/${f.file}#L${f.line})` : `\`${f.file}:${f.line}\``;
  const rows = shown
    .map((f) => `| ${srcCell(f)} | ${f.type} | ${f.raw} |`)
    .join('\n');
  const more = show.length > MAX_ROWS ? `\n\n_…and ${show.length - MAX_ROWS} more._` : '';
  const note =
    mentionSource === 'codeowners'
      ? 'flagging for your team (CODEOWNERS).'
      : "flagging you as this repo's most recent contributor.";
  const mention = owners.length ? `\n${owners.join(' ')} — ${note}\n` : '';
  const dismissedSection = dismissed.length ? dismissedTable(dismissed, blobBase) : '';
  return `${ISSUE_MARKER}
Automated link-health check for pages published under **\`${pathPrefix}\`** (checked against **${env}**).
**${show.length}** link(s) in this repo's \`src/pages\` currently return a 404.
${mention}
| Source (file:line) | Type | Broken link |
|---|---|---|
${rows}${more}
${dismissedSection}
_False positive? **Close this issue** (a note on why, or a bug against \`AdobeDocs/adp-devsite-scripts\`, helps us fix the checker). We won't re-file these links — only genuinely new ones can reopen it. To disable the automated link-health check for this repository, add the label \`link-health: ignore\`._
_Filed by \`adp-devsite-scripts/broken-link-bot\`. Updates each run; auto-closes when all links resolve._
${keysBlock(storedKeys)}`;
}

const matchesOurIssue = (repo, i) =>
  i && i.title === ISSUE_TITLE(repo) && (i.body || '').includes(ISSUE_MARKER);

// Paginated scan of the issues list (newest-first), filtering out PRs. Bounded
// to a few pages so a repo with thousands of issues can't make this run forever;
// our issue, when it exists, is either brand-new (page 1) or old-but-unique.
async function findViaList(owner, repo, token, maxPages = 5) {
  for (let page = 1; page <= maxPages; page++) {
    const r = await fetch(
      `${API}/repos/${owner}/${repo}/issues?state=all&per_page=100&page=${page}`,
      { headers: authHeaders(token) },
    );
    if (!r.ok) return null;
    const issues = await r.json();
    if (!issues.length) return null; // ran off the end
    // The issues endpoint also returns PRs; skip anything with a pull_request key.
    const hit = issues.find((i) => !i.pull_request && matchesOurIssue(repo, i));
    if (hit) return hit;
    if (issues.length < 100) return null; // last page, not found
  }
  return null;
}

// Look up our issue whether it's OPEN or CLOSED — a closed issue is the owner's
// decision and must be honored, so we can't search open-only. We use the Search
// API first: it's a single call regardless of how many issues the repo has (the
// plain issues list is newest-first, so an older bot issue on a busy repo can
// fall off page 1 and we'd file a duplicate). Search can lag right after an
// issue is created, so we fall back to a paginated list scan (where a just-
// created issue is on page 1) whenever search finds nothing or is unavailable.
async function findExistingIssue(owner, repo, token) {
  const q = encodeURIComponent(`repo:${owner}/${repo} in:body "${ISSUE_MARKER}" type:issue`);
  const r = await fetch(`${API}/search/issues?q=${q}&per_page=20`, { headers: authHeaders(token) });
  if (r.ok) {
    const j = await r.json();
    const hit = (j.items || []).find((i) => matchesOurIssue(repo, i));
    if (hit) return hit;
  }
  // Search miss or error (rate limit / indexing lag) → authoritative list scan.
  return findViaList(owner, repo, token);
}

async function addComment(owner, repo, number, body, token) {
  await fetch(`${API}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ body }),
  });
}

async function fileIssue(site, env, findings, token) {
  const { owner, repo, pathPrefix } = site;
  const existing = await findExistingIssue(owner, repo, token);
  const decision = decideIssueAction(existing, findings);

  if (decision.op === 'mute') return { url: existing.html_url, action: 'muted (label)', owners: [] };
  if (decision.op === 'noop-clean') return { action: 'skipped (clean)', owners: [] };
  if (decision.op === 'noop-closed')
    return { url: existing.html_url, action: 'skipped (closed; no new)', owners: [] };

  const { owners, source } = await getMentions(owner, repo, token);

  if (decision.op === 'close') {
    await fetch(`${API}/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ state: 'closed' }),
    });
    await addComment(owner, repo, existing.number, `${ISSUE_MARKER}\n✅ All previously reported links now resolve. Closing automatically.`, token);
    return { url: existing.html_url, action: 'closed (resolved)', owners };
  }

  // blob/HEAD always resolves to the repo's default branch, so we don't need to
  // thread the branch name here just to build a clickable source link.
  const blobBase = `https://github.com/${owner}/${repo}/blob/HEAD`;
  const body = issueBody(pathPrefix || '/', env, decision.show, owners, decision.storedKeys, decision.dismissed || [], source, blobBase);

  if (decision.op === 'create') {
    const r = await fetch(`${API}/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ title: ISSUE_TITLE(repo), body }),
    });
    if (!r.ok) throw new Error(`create issue -> HTTP ${r.status}`);
    return { url: (await r.json()).html_url, action: 'created', owners };
  }

  // update (open) or reopen (closed + new links)
  const patch = decision.op === 'reopen' ? { state: 'open', body } : { body };
  const r = await fetch(`${API}/repos/${owner}/${repo}/issues/${existing.number}`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`${decision.op} issue -> HTTP ${r.status}`);
  if (decision.comment) await addComment(owner, repo, existing.number, decision.comment, token);
  const action = decision.op === 'reopen' ? `reopened (+${decision.show.length} new)` : 'updated';
  return { url: existing.html_url, action, owners };
}

// Run async fn over items with bounded concurrency. Per-host throttling still
// applies inside isAlive/externalResult, so this stays gentle on any one host.
async function pool(items, concurrency, fn) {
  const q = [...items];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, q.length) }, async () => {
      while (q.length) await fn(q.shift());
    }),
  );
}

function authHeaders(token) {
  const t = token || process.env.GITHUB_TOKEN;
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  };
}

// Always excluded from sweeps.
const SKIP_OWNERS = new Set(['GoogleDrive', 'AdobeDocsPrivate']);
const SKIP_REPOS = new Set([
  'adp-devsite',
  'adp-devsite-github-actions-test',
  'app-builder-template-registry',
  'adobe-io-runtime',
]);

async function fetchRegistry(env) {
  const res = await fetch(DEVSITE_PATHS[env], { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`registry -> HTTP ${res.status}`);
  const json = await res.json();
  // SKIP_OWNERS are dropped here (they can't be fetched from GitHub anyway).
  // SKIP_REPOS is applied later in main() so an explicit --repos can override it.
  return (json.data || [])
    .filter((e) => e.repo && e.owner && !SKIP_OWNERS.has(e.owner))
    .map((e) => ({
      owner: e.owner,
      repo: e.repo,
      // "/" -> "" so joins stay clean; strip trailing slash otherwise
      pathPrefix: e.pathPrefix === '/' ? '' : (e.pathPrefix || '').replace(/\/$/, ''),
    }));
}

// One repo lookup → default branch (registry branch pointers are stale) + the
// archived flag. Archived repos are read-only (can't file issues) and usually
// deprecated, so the sweep skips them.
async function repoInfo(owner, repo, token) {
  const res = await fetch(`${API}/repos/${owner}/${repo}`, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`repo lookup -> HTTP ${res.status}`);
  const j = await res.json();
  return { branch: j.default_branch || 'main', archived: !!j.archived };
}

async function listMarkdown(owner, repo, branch, token) {
  const url = `${API}/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`tree -> HTTP ${res.status}`);
  const json = await res.json();
  return (json.tree || [])
    .filter((n) => n.type === 'blob' && /^src\/pages\/.+\.md$/i.test(n.path))
    .map((n) => n.path.replace(/^src\/pages\//, ''));
}

async function getMarkdown(owner, repo, branch, rel) {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/src/pages/${rel}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`raw ${rel} -> HTTP ${res.status}`);
  return res.text();
}

async function main() {
  const args = parseArgs(process.argv);
  const token = process.env.GITHUB_TOKEN;
  const origin = setOrigin(args.env);
  if (!token) console.warn('⚠️  No GITHUB_TOKEN — GitHub API will be rate-limited/anonymous.\n');

  console.log(`▶ link sweep  env=${args.env}  against=${origin}  (${args.file ? 'FILING issues' : 'dry-run'})`);

  console.log('• Loading registry…');
  let sites = await fetchRegistry(args.env);
  if (args.repos) {
    // Explicit repo selection overrides the skip list (lets you target a repo
    // like adp-devsite-github-actions-test on purpose).
    sites = sites.filter((s) => args.repos.includes(s.repo));
  } else {
    sites = sites.filter((s) => !SKIP_REPOS.has(s.repo));
  }
  if (args.start > 1) sites = sites.slice(args.start - 1); // begin at the Nth entry
  if (args.limit) sites = sites.slice(0, args.limit);
  console.log(`  ${sites.length} site(s)${args.start > 1 ? ` (starting at #${args.start})` : ''}`);

  console.log('• Building sitemap manifest (one request, trusted for "alive")…');
  const manifest = await fetchManifest();
  console.log(`  ${manifest ? manifest.size : 0} live URLs\n`);

  const byRepo = {}; // "owner/repo" -> [ broken findings ]
  const redirectedByRepo = {}; // "owner/repo" -> [ links resolved via redirects.json ]
  const siteByLabel = {}; // "owner/repo" -> site (for issue filing)
  const processed = []; // every repo we fully checked (for --file: even clean ones, to auto-close)
  const notDeployed = [];
  const errored = [];
  const batchSize = Math.max(1, args.batchSize);
  const totalBatches = Math.ceil(sites.length / batchSize);

  for (let b = 0; b < sites.length; b += batchSize) {
    const batch = sites.slice(b, b + batchSize);
    console.log(`─ Batch ${Math.floor(b / batchSize) + 1}/${totalBatches} (${batch.length} repo(s)) ─`);

    for (const site of batch) {
      const label = `${site.owner}/${site.repo}`;
      try {
        const { branch, archived } = await repoInfo(site.owner, site.repo, token);
        // Archived repos are read-only (can't file issues) and usually
        // deprecated — skip silently.
        if (archived) continue;
        const files = (await listMarkdown(site.owner, site.repo, branch, token)).filter(
          (f) => !/(^|\/)config\.md$/i.test(f),
        );

        // Pre-flight: skip repos whose site root isn't deployed.
        if (!(await isAlive(site.pathPrefix || '/'))) {
          console.log(`  • ${label}: not deployed at ${site.pathPrefix}/ — skipping`);
          notDeployed.push(label);
          continue;
        }

        // Download files concurrently — these come from raw.githubusercontent
        // (NOT the prod CDN), so parallelizing adds no load to developer.adobe.com.
        const contents = new Map();
        await pool(files, 15, async (rel) => {
          try {
            contents.set(rel, await getMarkdown(site.owner, site.repo, branch, rel));
          } catch {
            /* skip unreadable file */
          }
        });

        // Extract links from every file, split internal vs external.
        const internal = [];
        const external = [];
        const targets = new Set();
        const extUrls = new Set();
        for (const [rel, content] of contents) {
          const dirKey = dirPath(site.pathPrefix, rel);
          for (const link of extractLinks(content, dirKey, site.pathPrefix)) {
            const rec = { file: `src/pages/${rel}`, line: link.line, raw: link.raw };
            if (link.kind === 'external') {
              if (!args.external) continue; // external links only with --external
              external.push({ ...rec, url: link.url });
              extUrls.add(link.url);
            } else {
              internal.push({ ...rec, targets: link.targets });
              link.targets.forEach((t) => targets.add(t));
            }
          }
        }

        // Verify only sitemap-misses (internal) + external, concurrently.
        // classifyInternal/externalResult are per-host throttled, so prod stays
        // protected. Sitemap hits are alive; misses get the three-state check
        // (alive | redirected-via-redirects.json | broken).
        const stateMap = new Map(); // target -> { state, destination? }
        const misses = [...targets].filter((t) => !(manifest && manifest.has(t)));
        await pool(misses, 10, async (t) => stateMap.set(t, await classifyInternal(t)));
        const stateOf = (t) =>
          manifest && manifest.has(t) ? { state: 'alive' } : stateMap.get(t) || { state: 'broken' };
        const extMap = new Map();
        await pool([...extUrls], 10, async (u) => extMap.set(u, await externalResult(u)));

        // Per-link verdict, mirroring the site: alive if any candidate is
        // reachable; else redirected if any resolves via redirects.json; else
        // broken. Redirected links work today (permanent client-side redirect)
        // so they're tracked separately, NOT counted or filed as broken.
        const findings = [];
        const redirected = [];
        for (const c of internal) {
          const states = c.targets.map(stateOf);
          if (states.some((s) => s.state === 'alive')) continue;
          const red = states.find((s) => s.state === 'redirected');
          if (red) redirected.push({ ...c, type: 'redirected', target: c.targets[0], destination: red.destination });
          else findings.push({ ...c, type: 'internal', target: c.targets[0] });
        }
        for (const c of external) {
          if (extMap.get(c.url) === 'broken') findings.push({ ...c, type: 'external', target: c.url });
        }

        console.log(
          `  • ${label} (${files.length} md) → ${findings.length} broken` +
            (redirected.length ? `, ${redirected.length} via redirect` : ''),
        );
        // Record every fully-checked repo (even clean ones) so --file can
        // auto-close a stale issue when a repo goes broken -> clean.
        processed.push({ label, site });
        if (findings.length || redirected.length) {
          siteByLabel[label] = site;
          if (findings.length) byRepo[label] = findings;
          if (redirected.length) redirectedByRepo[label] = redirected;
        }
      } catch (err) {
        console.log(`  ✗ ${label}: ${err.message}`);
        errored.push({ label, error: err.message });
      }
    }

    if (b + batchSize < sites.length && args.batchDelay > 0) {
      console.log(`  …pausing ${args.batchDelay}s\n`);
      await sleep(args.batchDelay * 1000);
    }
  }

  // Report
  const totalBroken = Object.values(byRepo).reduce((n, a) => n + a.length, 0);
  console.log(`\n══ ${totalBroken} broken link(s) across ${Object.keys(byRepo).length} repo(s) ══`);
  for (const [label, findings] of Object.entries(byRepo)) {
    console.log(`\n${label} (${findings.length})`);
    // Just the broken link as written, with its location — that's what an author
    // needs to find and fix it.
    for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.type}]  ${f.raw}`);
  }
  // redirects.json-resolved links are excluded from "broken" but intentionally
  // NOT reported (still kept in the saved JSON for reference).
  // not-deployed and errored repos are kept in the saved JSON for reference,
  // but intentionally NOT printed in the report.

  if (args.out) {
    fs.writeFileSync(
      args.out,
      JSON.stringify(
        { generatedAt: new Date().toISOString(), env: args.env, byRepo, redirectedByRepo, notDeployed, errored },
        null,
        2,
      ),
    );
    console.log(`\nSaved results → ${args.out}`);
  }

  // File/update one GitHub issue per broken repo (only with --file).
  if (args.file) {
    if (!token) {
      console.error('\n✗ --file needs GITHUB_TOKEN (issues: write).');
      return;
    }
    // File across ALL checked repos, not just broken ones: a clean repo may have
    // a stale open issue that should now auto-close. fileIssue/decideIssueAction
    // no-op (a single read, no write) when there's nothing to do.
    console.log(`\n• Reconciling issues across ${processed.length} repo(s)…`);
    for (const { label, site } of processed) {
      try {
        const r = await fileIssue(site, args.env, byRepo[label] || [], token);
        if (r.action.startsWith('skipped')) continue; // clean/no-op — keep the log quiet
        console.log(`  ${r.action}: ${r.url}${r.owners.length ? `  (mentioned ${r.owners.join(' ')})` : '  (no CODEOWNERS)'}`);
      } catch (err) {
        console.error(`  ✗ ${label}: ${err.message}`);
      }
    }
  }
}

// Only run when invoked directly (node sweep.js), not when require()'d — so
// importing this file (e.g. from a test) can't accidentally kick off a sweep.
if (require.main === module) {
  main().catch((err) => {
    console.error('\n💥', err.message);
    process.exit(1);
  });
}

// Exported for unit testing the (network-free) dedup decision logic.
module.exports = { decideIssueAction, findingKey, parseKeys, keysBlock, isMuted, issueBody };
