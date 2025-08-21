const fs = require('fs');
const { getFileContent, getLatestCommit, createBranch, createBlob, createTree, commitChanges, pushCommit, createPR } = require('./github-api');
const { hasMetadata, replaceOrPrependFrontmatter } = require('./file-operation');

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
            fileContent = replaceOrPrependFrontmatter(fileContent, suggestion.trim());
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
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    
    // Use provided values or fallback to defaults where appropriate
    const ownerName = owner || "AdobeDocs";
    const repoName = repo;
    const branchRef = "heads/ai-metadata";
    const mainRef = "heads/main";
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    try {
        // get latest commit sha from main branch
        const latestCommit = await getLatestCommit(ownerName, repoName, mainRef, token);

        // create a new branch from the latest commit
        const createdBranch = await createBranch(ownerName, repoName, branchRef, latestCommit.object.sha, token);

        // get the tree SHA from the latest commit
        const baseCommitSha = createdBranch.object.sha;
        const baseCommitResponse = await fetch(`https://api.github.com/repos/${ownerName}/${repoName}/git/commits/${baseCommitSha}`, {
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`
            }
        }).then(res => res.json());
        const baseTreeSha = baseCommitResponse.tree.sha;

        const treeArray = await processAIContent(ownerName, repoName, token);

        const tree = await createTree(ownerName, repoName, baseTreeSha, treeArray, token);

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
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const githubToken = process.env.GITHUB_TOKEN;
    
    if (!repo) {
        console.error('Error: GITHUB_REPO environment variable must be set when running directly');
        process.exit(1);
    }
    
    module.exports({ 
        githubToken,
        owner,
        repo
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}

