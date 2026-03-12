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


| Field           | Type    | Description                                                       |
| --------------- | ------- | ----------------------------------------------------------------- |
| `owner`         | string  | GitHub org or user (e.g. `"AdobeDocs"`)                           |
| `repo`          | string  | Repository name                                                   |
| `ownerRequired` | boolean | `true` if the PR should note that a repo owner review is required |


```json
[
  {
    "owner": "AdobeDocs",
    "repo": "dev-docs-template",
    "ownerRequired": false
  }
]
```

### `file-mappings.json` — files and their destinations

An array of entries that describe files to add or delete in the target repos. Each entry supports two actions: **add** (default) to push a file, and **delete** to remove one.


| Field         | Type   | Required           | Description                                                            |
| ------------- | ------ | ------------------ | ---------------------------------------------------------------------- |
| `action`      | string | No (default `add`) | `"add"` to create/update a file, `"delete"` to remove it              |
| `source`      | string | For `add` only     | Filename inside the `resources/` folder                                |
| `destination` | string | Yes                | Path in the target repo where the file should be placed (or removed)   |

#### Adding a file

Set `action` to `"add"` (or omit it) and provide both `source` and `destination`. The file from `resources/` will be created or overwritten at the destination path.

```json
{
  "action": "add",
  "source": "lint.yml",
  "destination": ".github/workflows/lint.yml"
}
```

#### Deleting a file

Set `action` to `"delete"` and provide only `destination`. No `source` is needed. If the file does not exist in the target repo, the deletion is skipped with a warning.

```json
{
  "action": "delete",
  "destination": "dev.mjs"
}
```

#### Full example

```json
[
  {
    "action": "add",
    "source": "lint.yml",
    "destination": ".github/workflows/lint.yml"
  },
  {
    "action": "delete",
    "destination": "dev.mjs"
  }
]
```

### `resources/` — files to distribute

Place the actual files you want to push into this folder. Every `source` value in `file-mappings.json` must have a corresponding file here.

## Usage

1. Drop the files you want to distribute into `resources/`.
2. Edit `file-mappings.json` to map each file to its destination path.
3. Edit `repos.json` to list the target repos.
4. Run:
  ```bash
   npm start
  ```

The bot will:

- Validate that all resource files exist and all repos are accessible.
- For each repo, create (or recreate) a branch called `auto-content-update`.
- Commit all file changes to that branch.
- Open a pull request from `auto-content-update` into `main`.
- Print a summary with PR links.

