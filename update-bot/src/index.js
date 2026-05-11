import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  getRef,
  tryGetRef,
  getCommit,
  getContents,
  getRawContent,
  createRef,
  createBlob,
  createTree,
  createCommit,
  updateRef,
  createPullRequest,
  listPullRequests,
} from "./github-api.js";
import {
  validateReposConfig,
  validateFileMappings,
  validateReposAccessible,
} from "./validator.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPOS_CONFIG = path.join(ROOT, "repos.json");
const MAPPINGS_CONFIG = path.join(ROOT, "file-mappings.json");

const TEMPLATE_OWNER = "AdobeDocs";
const TEMPLATE_REPO = "dev-docs-template";
const TEMPLATE_REF = "main";

const BRANCH_NAME = "auto-content-update";
const BRANCH_REF = `heads/${BRANCH_NAME}`;
const BASE_REF = "heads/main";

function loadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

async function processRepo(repoConfig, mappings, templateContents, token) {
  const { owner, repo } = repoConfig;
  const label = `${owner}/${repo}`;

  try {
    console.log(`\n--- Processing ${label} ---`);

    console.log(`  Fetching main branch SHA...`);
    const mainRef = await getRef(owner, repo, BASE_REF, token);
    const mainSha = mainRef.object.sha;
    console.log(`  main is at ${mainSha.slice(0, 7)}`);

    console.log(`  Checking for existing branch ${BRANCH_NAME}...`);
    const existingBranch = await tryGetRef(owner, repo, BRANCH_REF, token);

    let parentSha, baseTreeSha, contentRef;

    if (existingBranch) {
      parentSha = existingBranch.object.sha;
      const branchCommit = await getCommit(owner, repo, parentSha, token);
      baseTreeSha = branchCommit.tree.sha;
      contentRef = BRANCH_NAME;
      console.log(`  Branch exists at ${parentSha.slice(0, 7)}, will commit on top`);
    } else {
      parentSha = mainSha;
      const mainCommit = await getCommit(owner, repo, mainSha, token);
      baseTreeSha = mainCommit.tree.sha;
      contentRef = "main";
      await createRef(owner, repo, BRANCH_REF, mainSha, token);
      console.log(`  Branch ${BRANCH_NAME} created from main`);
    }

    console.log(`  Processing ${mappings.length} file mapping(s)...`);
    const treeEntries = [];
    const warnings = [];
    const overwrittenFiles = [];

    for (const mapping of mappings) {
      const action = mapping.action ?? "add";
      const srcPath = mapping.path;
      const destPath = mapping.destPath ?? srcPath;

      if (action === "delete") {
        const exists = await getContents(owner, repo, srcPath, contentRef, token);
        if (!exists) {
          console.log(`    [delete] ${srcPath} — not found, skipping`);
          warnings.push(`${label}: delete target not found: ${srcPath}`);
          continue;
        }
        treeEntries.push({
          path: srcPath,
          mode: "100644",
          type: "blob",
          sha: null,
        });
        console.log(`    [delete] ${srcPath}`);
      } else {
        const existing = await getContents(owner, repo, destPath, contentRef, token);
        if (existing) {
          overwrittenFiles.push(destPath);
        }
        const content = templateContents.get(srcPath);
        const blob = await createBlob(owner, repo, content, token);
        treeEntries.push({
          path: destPath,
          mode: "100644",
          type: "blob",
          sha: blob.sha,
        });
        const label2 = mapping.destPath ? `${srcPath} → ${destPath}` : srcPath;
        console.log(`    [${existing ? "overwrite" : "add"}] ${label2}`);
      }
    }

    const tree = await createTree(owner, repo, baseTreeSha, treeEntries, token);

    if (tree.sha === baseTreeSha) {
      console.log(`  No changes detected — all files already up to date`);
      return { owner, repo, success: true, skipped: true, warnings };
    }

    const timestamp = new Date().toISOString().slice(0, 19).replace("T", " ");
    const commitMessage = `Auto content update (${timestamp})`;
    const commit = await createCommit(owner, repo, commitMessage, tree.sha, parentSha, token);
    console.log(`  Commit created: ${commit.sha.slice(0, 7)}`);

    await updateRef(owner, repo, BRANCH_REF, commit.sha, token);

    const openPRs = await listPullRequests(owner, repo, BRANCH_NAME, "main", "open", token);

    if (openPRs.length > 0) {
      const existingPR = openPRs[0];
      console.log(`  Open PR already exists: ${existingPR.html_url} — skipping PR creation`);
      return { owner, repo, success: true, prUrl: existingPR.html_url, prExisted: true, warnings };
    }

    const addedFiles = mappings.filter((m) => (m.action ?? "add") === "add");
    const deletedFiles = mappings.filter((m) => m.action === "delete");

    const ownerRequired = repoConfig.ownerRequired ?? overwrittenFiles.length > 0;

    const prBodyParts = [
      "## Auto Content Update",
      "",
      "This PR was created automatically by **update-bot**.",
    ];

    if (overwrittenFiles.length > 0) {
      prBodyParts.push(
        "",
        "### Overwritten files (already existed in repo)",
        overwrittenFiles.map((f) => `- \`${f}\``).join("\n")
      );
    }

    const newFiles = addedFiles.filter((m) => !overwrittenFiles.includes(m.destPath ?? m.path));
    if (newFiles.length > 0) {
      prBodyParts.push(
        "",
        "### New files",
        newFiles.map((m) => `- \`${m.destPath ?? m.path}\``).join("\n")
      );
    }

    if (deletedFiles.length > 0) {
      prBodyParts.push(
        "",
        "### Deleted files",
        deletedFiles.map((m) => `- \`${m.path}\``).join("\n")
      );
    }

    prBodyParts.push(
      "",
      `_Owner review required: ${ownerRequired ? "Yes" : "No"}_`
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
  console.log(`  ${rawRepos.length} repo(s), ${rawMappings.length} file mapping(s) — all valid`);

  console.log("Checking repo access...");
  await validateReposAccessible(rawRepos, token);
  console.log("  All repos accessible");

  console.log(`Fetching template files from ${TEMPLATE_OWNER}/${TEMPLATE_REPO}...`);
  const templateContents = new Map();
  for (const mapping of rawMappings) {
    if ((mapping.action ?? "add") !== "add") continue;
    const content = await getRawContent(TEMPLATE_OWNER, TEMPLATE_REPO, mapping.path, TEMPLATE_REF, token);
    templateContents.set(mapping.path, content);
    console.log(`  Fetched ${mapping.path}`);
  }

  const results = [];
  for (const repoConfig of rawRepos) {
    const result = await processRepo(repoConfig, rawMappings, templateContents, token);
    results.push(result);
  }

  console.log("\n=== Summary ===\n");
  const created = results.filter((r) => r.success && !r.skipped && !r.prExisted);
  const updated = results.filter((r) => r.success && r.prExisted);
  const skipped = results.filter((r) => r.success && r.skipped);
  const failures = results.filter((r) => !r.success);

  if (created.length > 0) {
    console.log(`PR created (${created.length}):`);
    for (const r of created) {
      console.log(`  ${r.owner}/${r.repo}: ${r.prUrl}`);
    }
  }

  if (updated.length > 0) {
    console.log(`\nPR updated (${updated.length}):`);
    for (const r of updated) {
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
