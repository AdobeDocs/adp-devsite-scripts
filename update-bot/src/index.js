import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  getRef,
  getCommit,
  getContents,
  createRef,
  deleteRef,
  createBlob,
  createTree,
  createCommit,
  updateRef,
  createPullRequest,
} from "./github-api.js";
import {
  validateReposConfig,
  validateFileMappings,
  validateResourceFiles,
  validateReposAccessible,
} from "./validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RESOURCES_DIR = path.join(ROOT, "resources");
const REPOS_CONFIG = path.join(ROOT, "repos.json");
const MAPPINGS_CONFIG = path.join(ROOT, "file-mappings.json");

const BRANCH_NAME = "auto-content-update";
const BRANCH_REF = `heads/${BRANCH_NAME}`;
const BASE_REF = "heads/main";

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

async function processRepo(repoConfig, mappings, token) {
  const { owner, repo } = repoConfig;
  const label = `${owner}/${repo}`;

  try {
    console.log(`\n--- Processing ${label} ---`);

    console.log(`  Fetching main branch SHA...`);
    const mainRef = await getRef(owner, repo, BASE_REF, token);
    const commitSha = mainRef.object.sha;
    const baseCommit = await getCommit(owner, repo, commitSha, token);
    const baseTreeSha = baseCommit.tree.sha;
    console.log(`  main is at ${commitSha.slice(0, 7)}`);

    console.log(`  Preparing branch ${BRANCH_NAME}...`);
    await deleteRef(owner, repo, BRANCH_REF, token);
    await createRef(owner, repo, BRANCH_REF, commitSha, token);
    console.log(`  Branch ${BRANCH_NAME} created from main`);

    console.log(`  Processing ${mappings.length} file mapping(s)...`);
    const treeEntries = [];
    const warnings = [];

    for (const mapping of mappings) {
      const action = mapping.action ?? "add";
      const { destination } = mapping;

      if (action === "delete") {
        const exists = await getContents(owner, repo, destination, "main", token);
        if (!exists) {
          console.log(`    [delete] ${destination} — not found, skipping`);
          warnings.push(`${label}: delete target not found: ${destination}`);
          continue;
        }
        treeEntries.push({
          path: destination,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        console.log(`    [delete] ${destination}`);
      } else {
        const content = fs.readFileSync(path.join(RESOURCES_DIR, mapping.source), "utf-8");
        const blob = await createBlob(owner, repo, content, token);
        treeEntries.push({
          path: destination,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
        console.log(`    [add] ${mapping.source} -> ${destination}`);
      }
    }

    const tree = await createTree(owner, repo, baseTreeSha, treeEntries, token);

    if (tree.sha === baseTreeSha) {
      console.log(`  No changes detected — all files already up to date`);
      await deleteRef(owner, repo, BRANCH_REF, token);
      console.log(`  Cleaned up branch ${BRANCH_NAME}`);
      return { owner, repo, success: true, skipped: true, warnings };
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const commitMessage = `Auto content update (${timestamp})`;
    const commit = await createCommit(owner, repo, commitMessage, tree.sha, commitSha, token);
    console.log(`  Commit created: ${commit.sha.slice(0, 7)}`);

    await updateRef(owner, repo, BRANCH_REF, commit.sha, token);

    const addedFiles = mappings.filter((m) => (m.action ?? "add") === "add");
    const deletedFiles = mappings.filter((m) => m.action === "delete");

    const prBodyParts = [
      "## Auto Content Update",
      "",
      "This PR was created automatically by **update-bot**.",
    ];

    if (addedFiles.length > 0) {
      prBodyParts.push(
        "",
        "### Updated files",
        addedFiles.map((m) => `- \`${m.destination}\``).join("\n")
      );
    }

    if (deletedFiles.length > 0) {
      prBodyParts.push(
        "",
        "### Deleted files",
        deletedFiles.map((m) => `- \`${m.destination}\``).join("\n")
      );
    }

    prBodyParts.push(
      "",
      `_Owner review required: ${repoConfig.ownerRequired ? "Yes" : "No"}_`
    );

    const prBody = prBodyParts.join("\n");

    const pr = await createPullRequest(
      owner,
      repo,
      BRANCH_NAME,
      "main",
      `[update-bot] Content update (${timestamp})`,
      prBody,
      token
    );
    console.log(`  PR created: ${pr.html_url}`);

    return { owner, repo, success: true, prUrl: pr.html_url, warnings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAILED: ${message}`);
    return { owner, repo, success: false, error: message };
  }
}

async function main() {
  console.log("=== update-bot ===\n");

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is not set.");
    console.error("Copy .env.example to .env and fill in your token.");
    process.exit(1);
  }

  console.log("Loading configuration...");
  const rawRepos = loadJson(REPOS_CONFIG);
  const rawMappings = loadJson(MAPPINGS_CONFIG);

  console.log("Validating configuration...");
  validateReposConfig(rawRepos);
  validateFileMappings(rawMappings);
  validateResourceFiles(rawMappings, RESOURCES_DIR);
  console.log(`  ${rawRepos.length} repo(s), ${rawMappings.length} file mapping(s) — all valid`);

  console.log("Checking repo access...");
  await validateReposAccessible(rawRepos, token);
  console.log("  All repos accessible");

  const results = [];
  for (const repoConfig of rawRepos) {
    const result = await processRepo(repoConfig, rawMappings, token);
    results.push(result);
  }

  console.log("\n=== Summary ===\n");
  const created = results.filter((r) => r.success && !r.skipped);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failures = results.filter((r) => !r.success);

  if (created.length > 0) {
    console.log(`PR created (${created.length}):`);
    for (const r of created) {
      console.log(`  ${r.owner}/${r.repo}: ${r.prUrl}`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped — already up to date (${skipped.length}):`);
    for (const r of skipped) {
      console.log(`  ${r.owner}/${r.repo}`);
    }
  }

  const allWarnings = results.flatMap((r) => r.warnings ?? []);
  if (allWarnings.length > 0) {
    console.log(`\nWarnings (${allWarnings.length}):`);
    for (const w of allWarnings) {
      console.log(`  ${w}`);
    }
  }

  if (failures.length > 0) {
    console.log(`\nFailed (${failures.length}):`);
    for (const r of failures) {
      console.log(`  ${r.owner}/${r.repo}: ${r.error}`);
    }
    process.exit(1);
  }

  console.log("\nDone.");
}

main();
