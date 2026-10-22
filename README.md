# adp-devsite-scripts
A collection of common scripts to be used by repos that deal with developer.adobe.com

## undeploy-site.js

Removes everything published under a devsite path prefix, the reverse of `deploy.js`. Requires Node 20+.

```bash
# Dry run (lists pages only)
node undeploy-site.js --path-prefix /adobe-for-creativity/ --env stage

# Execute
node undeploy-site.js --path-prefix /adobe-for-creativity/ --env stage --yes
```

- `--env prod` (default): unpublishes live, deletes preview, and purges cache.
- `--env stage`: deletes preview and purges cache.
- Pages come from the AEM bulk status API, so a re-run picks up anything left over.
- Nested sites listed in `devsitepaths.json` (e.g. spokes under a hub prefix) are skipped.