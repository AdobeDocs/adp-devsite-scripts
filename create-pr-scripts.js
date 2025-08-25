const fs = require('fs');
const { getFileContent, getLatestCommit, createBranch, createBlob, createTree, commitChanges, pushCommit, createPR } = require('./github-api');
const { hasMetadata, replaceOrPrependFrontmatter } = require('./file-operation');

async function processAIContent(owner, repo, githubToken) {
    let tree = [];
    try {
        // Read the ai_content.txt file
        const content = fs.readFileSync('ai_content.txt', 'utf8');

        // Check if content is empty or contains warning message
        if (!content || content.trim() === '') {
            throw new Error('ai_content.txt is empty - no content to process');
        }

        // Check for warning messages from ai-scripts.js
        if (content.includes('--- Warning ---') || content.includes('No files were found to process')) {
            console.log('AI scripts reported no files to process:', content.trim());
            throw new Error('No files were found by AI processing - skipping PR creation');
        }

        // Split the content using the regex pattern
        const files = content.split(/--- File: (?=.*? ---)/);

        // Remove empty first element if exists
        if (files[0].trim() === '') {
            files.shift();
        }

        // Check if we have any valid file sections
        if (files.length === 0) {
            throw new Error('No valid file sections found in ai_content.txt');
        }

        let processedFiles = 0;
        for (const file of files) {
            if (!file.trim()) continue;

            const pathMatch = file.match(/(.*?) ---\n([\s\S]*)/);
            if (!pathMatch) {
                console.warn(`Skipping invalid file section: ${file.substring(0, 50)}...`);
                continue;
            }

            const [, path, suggestion] = pathMatch;
            if (!path || !suggestion.trim()) {
                console.warn(`Skipping file with empty path or content: ${path}`);
                continue;
            }

            console.log("Processing path:", path);
            let fileContent = await getFileContent(owner, repo, path, githubToken);
            fileContent = replaceOrPrependFrontmatter(fileContent, suggestion.trim());
            let blob = await createBlob(owner, repo, fileContent, githubToken);
            tree.push({ path: path, mode: '100644', type: 'blob', sha: blob.sha });
            processedFiles++;
        }

        if (processedFiles === 0) {
            throw new Error('No valid files were processed - no changes to commit');
        }

        console.log(`Successfully processed ${processedFiles} files for PR`);
        return tree;
    } catch (error) {
        console.error('Error processing AI content:', error);
        throw error;
    }
}

module.exports = async ({ core, githubToken, owner, repo, targetBranch }) => {
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    
    // Use provided values or fallback to defaults where appropriate
    const ownerName = owner || "AdobeDocs";
    const repoName = repo;
    const targetBranchName = targetBranch || "main";
    
    // Generate branch name with current date/time
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').replace('T', '-').substring(0, 19);
    const branchName = `ai-metadata-${timestamp}`;
    const branchRef = `heads/${branchName}`;
    const mainRef = `heads/${targetBranchName}`;
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    console.log(`Creating branch: ${branchName}`);

    try {
        // First, try to process AI content to check if there's anything to do
        const treeArray = await processAIContent(ownerName, repoName, token);

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

        const tree = await createTree(ownerName, repoName, baseTreeSha, treeArray, token);

        const commit = await commitChanges(ownerName, repoName, tree.sha, createdBranch.object.sha, token);

        const pushCommitResult = await pushCommit(ownerName, repoName, branchRef, commit.sha, token);

        const pr = await createPR(ownerName, repoName, branchName, targetBranchName, token);

        console.log('PR created successfully:', pr);
    } catch (error) {
        // Check if this is a "no content" error - if so, exit gracefully
        if (error.message && (
            error.message.includes('No files were found by AI processing') ||
            error.message.includes('no content to process') ||
            error.message.includes('No valid files were processed')
        )) {
            console.log('No content changes detected - skipping PR creation');
            console.log('Reason:', error.message);
            return; // Exit gracefully instead of throwing
        }
        
        console.error('Error in create-pr-scripts:', error);
        throw error;
    }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const githubToken = process.env.GITHUB_TOKEN;
    const targetBranch = process.env.TARGET_BRANCH;
    
    if (!repo) {
        console.error('Error: GITHUB_REPO environment variable must be set when running directly');
        process.exit(1);
    }
    
    module.exports({ 
        githubToken,
        owner,
        repo,
        targetBranch
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}

