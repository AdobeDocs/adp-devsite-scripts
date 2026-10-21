# adp-devsite-scripts
A collection of common scripts to be used by repos that deal with developer.adobe.com

## unpublish-site.js

Unpublishes all pages of a devsite listed in its published `config.md`. Requires Node 20+.

```bash
# Dry run (lists pages only)
node unpublish-site.js --path-prefix /adobe-for-creativity/ --env stage

# Execute
node unpublish-site.js --path-prefix /adobe-for-creativity/ --env stage --yes
```

- `--env prod` (default): unpublishes live and purges cache.
- `--env stage`: deletes preview and purges cache.
- Only pages linked in `config.md` are removed.