# broken-link-bot

Find broken links in your content repo before (or after) they ship to
developer.adobe.com — including links to **other** repos that silently broke
when the other team renamed or removed a page.

## Run it

From the root of your content repo:

```bash
node path/to/broken-link-bot/check-links.js
```

No install, no dependencies, no token — just Node 18+. It reads your
`src/pages` markdown, works out the real developer.adobe.com URL each internal
link points to, and checks each one over HTTP (following redirects). It lists
only links that genuinely 404.

Example output:

```
❌ 6 broken link(s):

   src/pages/guides/oauth.md:8
     link:  https://developer.adobe.com/developer-console/docs/.../IMS/#refreshing-access-tokens
     404:   https://developer.adobe.com/developer-console/docs/.../IMS
```

It exits non-zero when it finds broken links, so you can use it in a script.

## Options

| Flag | Default | Meaning |
|---|---|---|
| `--dir <path>` | `.` | Repo to check (defaults to current directory) |
| `--path-prefix <prefix>` | from `config.md` | Override the site pathPrefix |

```bash
# check another repo without cd-ing into it
node check-links.js --dir ../commerce-webapi

# force a pathPrefix (normally auto-read from src/pages/config.md)
node check-links.js --path-prefix /commerce/webapi
```

## Make it a one-liner (optional)

Add a script to your repo's `package.json`:

```json
"scripts": { "check-links": "node ../adp-devsite-scripts/broken-link-bot/check-links.js" }
```

then just:

```bash
npm run check-links
```

## Notes

- It reads your **working copy**, so unsaved edits are checked too — good for a
  "did my fix work?" loop.
- If your site root itself 404s (repo not deployed yet, or wrong pathPrefix), it
  says so and stops, instead of reporting every link as broken.
- Redirects are treated as fine; only a real 404/410 at the end of the chain is
  reported. Transient network errors are treated as "alive", never reported.
```
