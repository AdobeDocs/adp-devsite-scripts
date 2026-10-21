#!/usr/bin/env node
// Unpublish all pages listed in a devsite's published config.md.
// Usage: node unpublish-site.js --path-prefix /adobe-for-creativity/ [--env prod|stage] [--yes]
const { parseArgs } = require('util');

const ENVS = {
  prod: { host: 'https://developer.adobe.com', site: 'adp-devsite', ref: 'main', ops: ['live', 'cache'] },
  stage: { host: 'https://developer-stage.adobe.com', site: 'adp-devsite-stage', ref: 'stage', ops: ['preview', 'cache'] },
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
const env = ENVS[args.env] ?? fail(`Unknown --env ${args.env}`);
const prefix = '/' + (args['path-prefix'] ?? fail('Provide --path-prefix')).replace(/^\/+|\/+$/g, '');
if (prefix === '/') fail('Refusing to run on the site root.');

// /x/foo.md -> /x/foo, /x/index.md -> /x/
const toPath = (link) => {
  const p = link.replace(/^https?:\/\/[^/]+/, '').split(/[?#]/)[0];
  return p.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
};

(async () => {
  const configUrl = `${env.host}${prefix}/config.md`;
  const res = await fetch(configUrl);
  if (!res.ok) fail(`${res.status} fetching ${configUrl}`);
  const config = await res.text();

  const links = [...config.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => toPath(m[1]));
  const pages = [...new Set([`${prefix}/`, `${prefix}/config`, ...links])]
    .filter((p) => p === `${prefix}/` || p.startsWith(`${prefix}/`))
    .sort();

  console.log(`${args.env} | ${prefix} | ${pages.length} pages | ${env.ops.join(', ')}`);
  pages.forEach((p) => console.log(`  ${p}`));
  if (!args.yes) return console.log('\nDry run. Add --yes to execute.');

  let failed = 0;
  for (const op of env.ops) {
    console.log(`\n== ${op} ==`);
    for (const page of pages) {
      const url = `https://admin.hlx.page/${op}/adobedocs/${env.site}/${env.ref}${encodeURI(page)}`;
      const status = await fetch(url, { method: METHOD[op] }).then((r) => r.status, (e) => e.message);
      const ok = status === 404 || (status >= 200 && status < 300);
      if (!ok) failed++;
      console.log(`  ${ok ? '✅' : '❌'} ${status} ${METHOD[op]} ${url}`);
    }
  }
  console.log(`\nDone. Failed: ${failed}`);
  process.exitCode = failed ? 1 : 0;
})();