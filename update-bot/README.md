# update-bot

Push the same file updates to multiple GitHub repos in one run. The bot creates a branch, commits the changes, and opens a PR on each target repo.

## Setup

1. Install dependencies:
  ```bash
   npm install
  ```
2. Create a `.env` file with your GitHub token (use `.env.example` as reference):
  ```
   GITHUB_TOKEN=ghp_your_token_here
  ```
   The token needs **repo** scope (read/write access to code and pull requests).

> 💡How to generate a GitHub token:  
> 1. Navigate to Settings page from github profile tab
> ![GitHub profile tab screenshot](./images/github%20tab.png)
> 2. Select Developer Settings from the left Navbar
> ![Github Setting Page](./images/settings.png)
> 3. Select Personal access tokens -> Tokens(classic) -> Generate new token -> Generate new token (classic)
> ![Github DEveloper Settings](./images/token.png)
> 4. Grant repo and workflow access to the token
> ![Github DEveloper Access](./images/token%20access.png)
> 5. Generate token
> 5. Save the token somewhere

## Configuration

### `repos.json` — target repositories

An array of repos the bot will push updates to.


| Field           | Type    | Required | Description                                                       |
| --------------- | ------- | -------- | ----------------------------------------------------------------- |
| `owner`         | string  | Yes      | GitHub org or user (e.g. `"AdobeDocs"`)                           |
| `repo`          | string  | Yes      | Repository name                                                   |
| `ownerRequired` | boolean | No       | Force the PR to note that owner review is required. If omitted, auto-detected: `true` when any file in the PR overwrites an existing file, `false` when all files are new additions or deletions. |


```json
[
  {
    "owner": "AdobeDocs",
    "repo": "dev-docs-template"
  }
]
```

### `file-mappings.json` — files and their paths

An array of entries that describe files to add or delete in the target repos. Each entry supports two actions: **add** (default) to push a file, and **delete** to remove one.

For `add` entries, `path` is the file path in the source template repo ([AdobeDocs/dev-docs-template](https://github.com/AdobeDocs/dev-docs-template)). By default the file is written to the same path in the target repo. Use `destPath` to write it to a different path — useful for private repos where workflow files have different names than their public equivalents.

| Field      | Type   | Required           | Description                                                                                      |
| ---------- | ------ | ------------------ | ------------------------------------------------------------------------------------------------ |
| `action`   | string | No (default `add`) | `"add"` to create/update a file, `"delete"` to remove it                                        |
| `path`     | string | Yes                | Source file path in the template repo (for `add`) and target path in the target repo (for both) |
| `destPath` | string | No                 | Destination path in the target repo. Only valid for `add`. If omitted, defaults to `path`.      |

#### Adding a file

Set `action` to `"add"` (or omit it) and provide `path`. The file is fetched from `dev-docs-template` at the given path and created or overwritten in each target repo.

```json
{
  "action": "add",
  "path": ".github/workflows/lint.yml"
}
```

#### Adding a file with a different destination path

Use `destPath` when the file needs to land at a different path in the target repo than it has in the template. This is needed for private repos, where the `-private` workflow variants must be renamed on copy.

```json
{
  "action": "add",
  "path": ".github/workflows/deploy-private.yml",
  "destPath": ".github/workflows/deploy.yml"
}
```

#### Deleting a file

Set `action` to `"delete"` and provide `path`. If the file does not exist in the target repo, the deletion is skipped with a warning.

```json
{
  "action": "delete",
  "path": "dev.mjs"
}
```

#### Full example (private repo workflow cleanup)

```json
[
  {
    "action": "add",
    "path": ".github/workflows/lint.yml"
  },
  {
    "action": "delete",
    "path": ".github/workflows/deploy.yml"
  },
  {
    "action": "delete",
    "path": ".github/workflows/stage.yml"
  },
  {
    "action": "delete",
    "path": ".github/workflows/build-auto-generated-files.yml"
  },
  {
    "action": "add",
    "path": ".github/workflows/deploy-private.yml",
    "destPath": ".github/workflows/deploy.yml"
  },
  {
    "action": "add",
    "path": ".github/workflows/stage-private.yml",
    "destPath": ".github/workflows/stage.yml"
  },
  {
    "action": "add",
    "path": ".github/workflows/build-auto-generated-files-private.yml",
    "destPath": ".github/workflows/build-auto-generated-files.yml"
  }
]
```

## Usage

1. Edit `file-mappings.json` to list the file paths to sync from [dev-docs-template](https://github.com/AdobeDocs/dev-docs-template).
2. Edit `repos.json` to list the target repos.
3. Run:
  ```bash
   npm start
  ```

The bot will:

- Validate configuration and that every repo in `repos.json` is accessible with the provided token. The bot aborts if any check fails.
- Fetch each `add` file from the [AdobeDocs/dev-docs-template](https://github.com/AdobeDocs/dev-docs-template) repo on GitHub.
- For each target repo, check if a branch called `auto-content-update` already exists. If it does, the bot commits on top of it; otherwise a new branch is created from `main`.
- Compare the resulting tree with the current branch state. If all files already match the template content, no commit is created and the repo is reported as skipped.
- Check if an open pull request from `auto-content-update` into `main` already exists. If so, the bot skips PR creation and reports the repo as "PR updated"; otherwise a new PR is opened.
- Print a summary grouped by PR created, PR updated, skipped, warnings, and failures.