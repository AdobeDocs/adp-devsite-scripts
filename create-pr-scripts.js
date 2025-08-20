const fs = require('fs');
const { getFileContent, getLatestCommit, createBranch, createBlob, createTree, commitChanges, pushCommit, createPR } = require('./github-api');
const { hasMetadata } = require('./file-operation');

async function processAIContent(owner, repo, githubToken) {
    let tree = [];
    try {
        // Read the ai_content.txt file
        const content = fs.readFileSync('ai_content.txt', 'utf8');

        // Split the content using the regex pattern
        const files = content.split(/--- File: (?=.*? ---)/);

        // Remove empty first element if exists
        if (files[0].trim() === '') {
            files.shift();
        }

        for (const file of files) {
            if (!file.trim()) continue;

            const pathMatch = file.match(/(.*?) ---\n([\s\S]*)/);
            const [, path, suggestion] = pathMatch;

            console.log("path", path);
            let fileContent = await getFileContent(owner, repo, path, githubToken);

            if (hasMetadata(fileContent)) {
                const metadataEnd = fileContent.indexOf("---", fileContent.indexOf("---") + 1);
                fileContent = suggestion + fileContent.slice(metadataEnd + 3);
            }
            else {
                fileContent = suggestion + "\n" + fileContent
            }
            let blob = await createBlob(owner, repo, fileContent, githubToken);
            tree.push({ path: path, mode: '100644', type: 'blob', sha: blob.sha });
        }

        return tree;
    } catch (error) {
        console.error('Error processing AI content:', error);
        throw error;
    }
}


module.exports = async ({ core, githubToken, owner, repo }) => {
    // Use provided values or fallback to defaults for backwards compatibility
    const ownerName = owner || "AdobeDocs";
    const repoName = repo || "adp-devsite-github-actions-test";
    const branchRef = "heads/ai-metadata";
    const mainRef = "heads/main";
    const token = githubToken || process.env.GITHUB_TOKEN;

    try {
        // get latest commit sha from main branch
        const latestCommit = await getLatestCommit(ownerName, repoName, mainRef, token);

        // create a new branch from the latest commit
        const createdBranch = await createBranch(ownerName, repoName, branchRef, latestCommit.object.sha, token);

        const treeArray = await processAIContent(ownerName, repoName, token);

        const tree = await createTree(ownerName, repoName, createdBranch.object.sha, treeArray, token);

        const commit = await commitChanges(ownerName, repoName, tree.sha, createdBranch.object.sha, token);

        const pushCommitResult = await pushCommit(ownerName, repoName, branchRef, commit.sha, token);

        const pr = await createPR(ownerName, repoName, "ai-metadata", "main", token);

        console.log('PR created successfully:', pr);
    } catch (error) {
        console.error('Error in create-pr-scripts:', error);
        throw error;
    }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    module.exports({ 
        githubToken: process.env.GITHUB_TOKEN,
        owner: "AdobeDocs",
        repo: "adp-devsite-github-actions-test"
    });
}