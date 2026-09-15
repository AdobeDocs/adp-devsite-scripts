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

async function getCodeowners(owner, repo, token) {
  for (const p of ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']) {
    const r = await fetch(`${API}/repos/${owner}/${repo}/contents/${p}`, { headers: authHeaders(token) });
    if (r.ok) {
      const j = await r.json();
      const text = Buffer.from(j.content || '', 'base64').toString('utf8');
      // Collect every @owner / @org/team token mentioned in the file.
      const owners = [...new Set(text.match(/@[A-Za-z0-9/_-]+/g) || [])];
      if (owners.length) return owners;
    }
  }
  return [];
}

const MAX_ROWS = 50; // keep issues readable and under GitHub's body-size limit
function issueBody(pathPrefix, env, findings, owners) {
  const shown = findings.slice(0, MAX_ROWS);
  const rows = shown
    .map((f) => `| \`${f.file}:${f.line}\` | ${f.type} | ${f.raw} |`)
    .join('\n');
  const more = findings.length > MAX_ROWS ? `\n\n_…and ${findings.length - MAX_ROWS} more._` : '';
  const mention = owners.length ? `\n${owners.join(' ')} — flagging for your team.\n` : '';
  return `${ISSUE_MARKER}
Automated link-health check for pages published under **\`${pathPrefix}\`** (checked against **${env}**).
**${findings.length}** link(s) in this repo's \`src/pages\` currently return a 404.
${mention}
| Source (file:line) | Type | Broken link |
|---|---|---|
${rows}${more}

_Filed by \`adp-devsite-scripts/broken-link-bot\`. This issue updates on each run and closes automatically when all links resolve._`;
}

async function findExistingIssue(owner, repo, token) {
  const r = await fetch(`${API}/repos/${owner}/${repo}/issues?state=open&per_page=100`, { headers: authHeaders(token) });
  if (!r.ok) return null;
  const issues = await r.json();
  return issues.find((i) => i.title === ISSUE_TITLE(repo) && (i.body || '').includes(ISSUE_MARKER)) || null;
}

async function fileIssue(site, env, findings, token) {
  const { owner, repo, pathPrefix } = site;
  const owners = await getCodeowners(owner, repo, token);
  const body = issueBody(pathPrefix || '/', env, findings, owners);
  const existing = await findExistingIssue(owner, repo, token);
  if (existing) {
    const r = await fetch(`${API}/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      headers: authHeaders(token),
      body: JSON.stringify({ body }),
    });
    if (!r.ok) throw new Error(`update issue -> HTTP ${r.status}`);
    return { url: existing.html_url, action: 'updated', owners };
  }
  const r = await fetch(`${API}/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ title: ISSUE_TITLE(repo), body }),
  });
  if (!r.ok) throw new Error(`create issue -> HTTP ${r.status}`);
  return { url: (await r.json()).html_url, action: 'created', owners };
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
const SKIP_REPOS = new Set(['adp-devsite', 'adp-devsite-github-actions-test']);

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

  console.log(`▶ link sweep  env=${args.env}  against=${origin}  (dry-run)`);

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

  const byRepo = {}; // "owner/repo" -> [ findings ]
  const siteByLabel = {}; // "owner/repo" -> site (for issue filing)
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
        // isAlive/externalResult are per-host throttled, so prod stays protected.
        const aliveMap = new Map();
        const misses = [...targets].filter((t) => !(manifest && manifest.has(t)));
        await pool(misses, 10, async (t) => aliveMap.set(t, await isAlive(t)));
        const extMap = new Map();
        await pool([...extUrls], 10, async (u) => extMap.set(u, await externalResult(u)));

        const findings = [];
        for (const c of internal) {
          const dead = c.targets.every((t) => (manifest && manifest.has(t) ? false : aliveMap.get(t) === false));
          if (dead) findings.push({ ...c, type: 'internal', target: c.targets[0] });
        }
        for (const c of external) {
          if (extMap.get(c.url) === 'broken') findings.push({ ...c, type: 'external', target: c.url });
        }

        console.log(`  • ${label} (${files.length} md) → ${findings.length} broken`);
        if (findings.length) {
          byRepo[label] = findings;
          siteByLabel[label] = site;
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
  if (notDeployed.length) console.log(`\n⚠️  not deployed (skipped): ${notDeployed.length}`);
  if (errored.length) console.log(`✗ errored: ${errored.map((e) => e.label).join(', ')}`);

  if (args.out) {
    fs.writeFileSync(
      args.out,
      JSON.stringify({ generatedAt: new Date().toISOString(), env: args.env, byRepo, notDeployed, errored }, null, 2),
    );
    console.log(`\nSaved results → ${args.out}`);
  }

  // File/update one GitHub issue per broken repo (only with --file).
  if (args.file) {
    if (!token) {
      console.error('\n✗ --file needs GITHUB_TOKEN (issues: write).');
      return;
    }
    console.log(`\n• Filing issues for ${Object.keys(byRepo).length} repo(s)…`);
    for (const [label, findings] of Object.entries(byRepo)) {
      try {
        const r = await fileIssue(siteByLabel[label], args.env, findings, token);
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
