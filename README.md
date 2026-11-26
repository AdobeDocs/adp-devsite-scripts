# adp-devsite-scripts
A collection of common scripts to be used by repos that deal with developer.adobe.com

### Authentication
Set `AEM_ADMIN_API_KEY` to an AEM admin API key for the target site:
- `--env stage` → `adobedocs/adp-devsite-stage` (same key as the `AEM_ADMIN_API_KEY_STAGE` org secret)
- `--env prod`  → `adobedocs/adp-devsite` (same key as `AEM_ADMIN_API_KEY_PROD`)

Key values can't be retrieved from AEM or GitHub after creation, so a copy of each key is kept in Vault: [stage](https://vault-amer.adobe.net/ui/vault/secrets-engines/dme_adobe_developer_platform/kv/developer_website%2Fstg%2Fadobe%2Faem%2Fsites%2Fadp-devsite-stage/details) for `--env stage`, [prod](https://vault-amer.adobe.net/ui/vault/secrets-engines/dme_adobe_developer_platform/kv/developer_website%2Fprd%2Fadobe%2Faem%2Fsites%2Fadp-devsite/details) for `--env prod`. Use only the `api_key` value, not the full JSON or the `key_id`.

- No Vault access: ask a site admin (`admin` role) to run the script or to create a temporary key with the needed roles. Delete temporary keys when you're done.
- Creating or rotating the keys: the deploy keys expire yearly. Follow [AEM Authentication §6](https://wiki.corp.adobe.com/spaces/AdobeCloudPlatform/pages/4098581925/AEM+Authentication#AEMAuthentication-6.RotatethedeployAPIkeys(yearly)); [§6b](https://wiki.corp.adobe.com/spaces/AdobeCloudPlatform/pages/4098581925/AEM+Authentication#AEMAuthentication-6b.Createnewkeys) creates replacements, and [§6c](https://wiki.corp.adobe.com/spaces/AdobeCloudPlatform/pages/4098581925/AEM+Authentication#AEMAuthentication-6c.UpdatethekeysinGitHubandVault) updates the GitHub secrets and Vault entries.

## undeploy-site.js

Removes everything published under a devsite path prefix, the reverse of `deploy.js`. Requires Node 20+.

Before running it, set `AEM_ADMIN_API_KEY` in your terminal. This must be the [AEM admin API key](#authentication) for the site you are targeting; the script does not read the GitHub secret names used by workflows.

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