#!/usr/bin/env node
// Undeploy everything published under a devsite path prefix (the reverse of deploy.js).
// Usage: node undeploy-site.js --path-prefix /adobe-for-creativity/ [--env prod|stage] [--yes]
const { parseArgs } = require('util');

const ENVS = {
  prod: { host: 'https://main--adp-devsite--adobedocs.aem.live', site: 'adp-devsite', ref: 'main', ops: ['live', 'preview', 'cache'] },
  stage: { host: 'https://main--adp-devsite-stage--adobedocs.aem.page', site: 'adp-devsite-stage', ref: 'stage', ops: ['preview', 'cache'] },
};
const METHOD = { live: 'DELETE', preview: 'DELETE', cache: 'POST' };

const { values: args } = parseArgs({
  options: {
    'path-prefix': { type: 'string' },
    env: { type: 'string', default: 'prod' },
    yes: { type: 'boolean', default: false },
  },
});

const fail = (msg) => { console.error(`Error: ${msg}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = ENVS[args.env] ?? fail(`Unknown --env ${args.env}`);
const prefix = '/' + (args['path-prefix'] ?? fail('Provide --path-prefix')).replace(/^\/+|\/+$/g, '');
if (prefix === '/') fail('Refusing to run on the site root.');

const admin = `https://admin.hlx.page/{op}/adobedocs/${env.site}/${env.ref}`;

async function request(url, options = {}) {
  for (let i = 0; ; i++) {
    const res = await fetch(url, options);
    if (res.status !== 429 || i === 4) return res;
    await sleep(2 ** i * 1000);
  }
}

async function listPublished() {
  const res = await request(`${admin.replace('{op}', 'status')}/*`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths: [`${prefix}/*`], select: ['preview', 'live'] }),
  });
  if (!res.ok) fail(`${res.status} starting bulk status job`);
  const { links } = await res.json();

  let job;
  do {
    await sleep(1000);
    job = await (await request(links.self)).json();
  } while (job.state !== 'stopped');

  const details = await (await request(`${links.self}/details`)).json();
  return details.data.resources.map((r) => r.path);
}

// Other sites nested under this prefix (e.g. hub -> spokes) live in their own repos.
async function listSpokes() {
  const res = await fetch(`${env.host}/franklin_assets/devsitepaths.json`);
  if (!res.ok) fail(`${res.status} fetching devsitepaths.json`);
  const { data } = await res.json();
  return data.map((d) => d.pathPrefix.replace(/\/+$/, '')).filter((p) => p.startsWith(`${prefix}/`));
}

(async () => {
  const [published, spokes] = await Promise.all([listPublished(), listSpokes()]);
  const isSpoke = (p) => spokes.some((s) => p === s || p.startsWith(`${s}/`));
  const pages = published.filter((p) => !isSpoke(p)).sort();

  console.log(`${args.env} | ${prefix} | ${pages.length} pages | ${env.ops.join(', ')}`);
  if (spokes.length) console.log(`Skipping nested sites: ${spokes.join(', ')}`);
  pages.forEach((p) => console.log(`  ${p}`));
  if (!args.yes) return console.log('\nDry run. Add --yes to execute.');

  let failed = 0;
  for (const op of env.ops) {
    console.log(`\n== ${op} ==`);
    for (const page of pages) {
      const url = `${admin.replace('{op}', op)}${encodeURI(page)}`;
      const status = await request(url, { method: METHOD[op] }).then((r) => r.status, (e) => e.message);
      const ok = status === 404 || (status >= 200 && status < 300);
      if (!ok) failed++;
      console.log(`  ${ok ? '✅' : '❌'} ${status} ${METHOD[op]} ${url}`);
    }
  }
  console.log(`\nDone. Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
})();