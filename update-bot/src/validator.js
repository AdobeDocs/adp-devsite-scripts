import fs from "node:fs";
import path from "node:path";
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
    if (typeof entry.ownerRequired !== "boolean") {
      throw new Error(`Invalid repo entry: "ownerRequired" must be a boolean. Got: ${JSON.stringify(entry)}`);
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
  const seenSources = new Set();
  for (const entry of mappings) {
    const action = entry.action ?? "add";
    if (!VALID_ACTIONS.includes(action)) {
      throw new Error(
        `Invalid mapping entry: "action" must be one of ${JSON.stringify(VALID_ACTIONS)}. Got: ${JSON.stringify(entry)}`
      );
    }
    if (action === "add") {
      if (!entry.source || typeof entry.source !== "string") {
        throw new Error(`Invalid mapping entry: "source" must be a non-empty string for action "add". Got: ${JSON.stringify(entry)}`);
      }
      if (seenSources.has(entry.source)) {
        throw new Error(`Duplicate source in file-mappings.json: ${entry.source}`);
      }
      seenSources.add(entry.source);
    }
    if (!entry.destination || typeof entry.destination !== "string") {
      throw new Error(`Invalid mapping entry: "destination" must be a non-empty string. Got: ${JSON.stringify(entry)}`);
    }
  }
}

export function validateResourceFiles(mappings, resourcesDir) {
  for (const entry of mappings) {
    const action = entry.action ?? "add";
    if (action !== "add") continue;
    const fullPath = path.resolve(resourcesDir, entry.source);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Resource file not found: ${entry.source} (expected at ${fullPath})`);
    }
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      throw new Error(`Resource path is not a file: ${entry.source}`);
    }
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
