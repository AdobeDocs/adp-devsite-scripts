# adp-devsite-scripts
A collection of common scripts to be used by repos that deal with developer.adobe.com

## undeploy-site.js

Removes everything published under a devsite path prefix, the reverse of `deploy.js`. Requires Node 20+.

Before running it, set `AEM_ADMIN_API_KEY` in your terminal. This must be the AEM admin API key for the site you are targeting; the script does not read the GitHub secret names used by workflows.

```bash
# Set the stage API key for this terminal session.
export AEM_ADMIN_API_KEY='<your-stage-site-api-key>'

# Dry run (lists pages only; does not undeploy anything)
node undeploy-site.js --path-prefix /adobe-for-creativity/ --env stage

# Execute after confirming the dry-run list.
node undeploy-site.js --path-prefix /adobe-for-creativity/ --env stage --yes
```

- Replace `<your-stage-site-api-key>` with the actual key; do not include the angle brackets.
- The `export` applies only to the current terminal session. Set it again in a new terminal.
- Use `--env stage` when testing. The default is `prod`.
- `--env prod` (default): unpublishes live, deletes preview, and purges cache.
- `--env stage`: deletes preview and purges cache.
- Pages come from the AEM bulk status API, so a re-run picks up anything left over.
- Nested sites listed in `devsitepaths.json` (e.g. spokes under a hub prefix) are skipped.