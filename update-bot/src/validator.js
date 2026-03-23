import { getRepo } from "./github-api.js";

export function validateReposConfig(repos) {
  if (!Array.isArray(repos)) {
    throw new Error("repos.json must be a JSON array");
  }
  if (repos.length === 0) {
    throw new Error("repos.json is empty — add at least one target repo");
  }
  const seen = new Set();
  for (const entry of repos) {
    if (!entry.owner || typeof entry.owner !== "string") {
      throw new Error(`Invalid repo entry: "owner" must be a non-empty string. Got: ${JSON.stringify(entry)}`);
    }
    if (!entry.repo || typeof entry.repo !== "string") {
      throw new Error(`Invalid repo entry: "repo" must be a non-empty string. Got: ${JSON.stringify(entry)}`);
    }
    if (entry.ownerRequired !== undefined && typeof entry.ownerRequired !== "boolean") {
      throw new Error(`Invalid repo entry: "ownerRequired" must be a boolean if provided. Got: ${JSON.stringify(entry)}`);
    }
    const key = `${entry.owner}/${entry.repo}`;
    if (seen.has(key)) {
      throw new Error(`Duplicate repo entry: ${key}`);
    }
    seen.add(key);
  }
}

const VALID_ACTIONS = ["add", "delete"];

export function validateFileMappings(mappings) {
  if (!Array.isArray(mappings)) {
    throw new Error("file-mappings.json must be a JSON array");
  }
  if (mappings.length === 0) {
    throw new Error("file-mappings.json is empty — add at least one file mapping");
  }
  const seenPaths = new Set();
  for (const entry of mappings) {
    const action = entry.action ?? "add";
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(
        `Invalid mapping entry: "action" must be one of ${JSON.stringify(VALID_ACTIONS)}. Got: ${JSON.stringify(entry)}`
      );
    }
    if (!entry.path || typeof entry.path !== "string") {
      throw new Error(`Invalid mapping entry: "path" must be a non-empty string. Got: ${JSON.stringify(entry)}`);
    }
    if (seenPaths.has(entry.path)) {
      throw new Error(`Duplicate path in file-mappings.json: ${entry.path}`);
    }
    seenPaths.add(entry.path);
  }
}

export async function validateReposAccessible(repos, token) {
  for (const { owner, repo } of repos) {
    try {
      await getRepo(owner, repo, token);
    } catch {
      throw new Error(
        `Cannot access repo ${owner}/${repo}. Verify it exists and your GITHUB_TOKEN has access.`
      );
    }
  }
}
