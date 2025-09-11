// DOCS: https://docs.github.com/en/rest/repos/contents?apiVersion=2022-11-28#get-repository-content
async function getFileContent(owner, repo, path, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try{
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
            method: 'GET',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to get file content meta ${path}: ${response.status} - ${text}`);
        }

        const data = await response.json();
        const rawRes = await fetch(data.download_url, {
            headers: {
                'accept': 'application/vnd.github.v3.raw',
                'authorization': `Bearer ${token}`
            }
        });
        if (!rawRes.ok) {
            const text = await rawRes.text();
            throw new Error(`Failed to download raw file ${path}: ${rawRes.status} - ${text}`);
        }
        const fileContent = await rawRes.text();
        return fileContent;
    } catch (error) {
        console.error('Error getting file content:', error);
        throw error;
    }
}

async function getFileContentByContentURL(contentURL, githubToken){
    const token = githubToken || process.env.GITHUB_TOKEN;
    try{
        const response = await fetch(contentURL, {
            method: 'GET',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`
            }
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to get file by content URL: ${response.status} - ${text}`);
        }
        return response.text();
    } catch (error) {
        console.error('Error getting file content by content URL:', error);
        throw error;
    }
}


// DOCS: https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#get-a-reference
async function getLatestCommit(owner, repo, ref, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/ref/${ref}`, {
            method: 'GET',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`Failed to fetch ref: ${ref} - ${response.status} - ${response.statusText}`);
        }

        return response.json();
    } catch (error) {
        console.error(`Error fetching latest commit for ref ${ref}:`, error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#create-a-reference
async function createBranch(owner, repo, branchRef, baseRefSha, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    
    // Try to get the existing branch first
    try {
        const existingBranch = await getLatestCommit(owner, repo, branchRef, token);
        console.log(`Branch ${branchRef} already exists, using existing branch`);
        return existingBranch;
    } catch (error) {
        // Branch doesn't exist, create it
        console.log(`Branch ${branchRef} doesn't exist, creating new branch`);
    }

    // Create the new branch
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs`, {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                ref: `refs/${branchRef}`,
                sha: baseRefSha
            }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create branch: ${response.status} - ${errorText}`);
        }

        const result = await response.json();
        console.log(`Successfully created branch ${branchRef}`);
        return result;
    } catch (error) {
        console.error('Error creating branch:', error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/git/blobs?apiVersion=2022-11-28#create-a-blob
// Blob is a file change record  in git
async function createBlob(owner, repo, content, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/blobs`, {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                content: content, // this is a overwrite action, no insert/update/delete available
                encoding: 'utf-8'
            })
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create blob: ${response.status} - ${text}`);
        }
        return response.json();

    } catch (error) {
        console.error('Error creating blob:', error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/git/trees?apiVersion=2022-11-28#create-a-tree
// Tree is a collection of blobs
async function createTree(owner, repo, branchRefSha, treeArray, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/trees`, {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                base_tree: branchRefSha,
                tree: treeArray
            })
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create tree: ${response.status} - ${text}`);
        }
        return response.json();
    } catch (error) {
        console.error('Error creating tree:', error);
        throw error
    }
}

// DOCS: https://docs.github.com/en/rest/git/commits?apiVersion=2022-11-28#create-a-commit
async function commitChanges(owner, repo, treeSha, parentCommitSha, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/commits`, {
            method: 'POST',
            headers: {
                'accept': 'application/vnd.github+json',
                'authorization': `Bearer ${token}`,
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                message: '[ai-generated]Update metadata for all documentation files',
                tree: treeSha,
                parents: [parentCommitSha]
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to create commit: ${response.status} - ${errorText}`);
        }

        return await response.json();

    } catch (error) {
        console.error('Error committing changes:', error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/git/refs?apiVersion=2022-11-28#update-a-reference
async function pushCommit(owner, repo, branchRef, commitSha, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/${branchRef}`, {
            method: 'PATCH',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                sha: commitSha,
                force: false
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Failed to update ref: ${response.status} - ${errorText}`);
        }

        return await response.json();
    } catch (error) {
        console.error('Error pushing commit:', error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28#create-a-pull-request
async function createPR(owner, repo, headRef, baseRef, githubToken) {
    const token = githubToken || process.env.GITHUB_TOKEN;
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                title: '[AI PR] Metadata Update: Generated metadata for documentation files',
                head: headRef,
                base: baseRef
            })
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create PR: ${response.status} - ${text}`);
        }
        return response.json();
    } catch (error) {
        console.error('Error creating PR:', error);
        throw error;
    }
}

async function getFilesInPR(owner, repo, prNumber, githubToken){
    const token = githubToken || process.env.GITHUB_TOKEN;
    try{
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, {
            method: 'GET',
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `Bearer ${token}`
            }
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to get PR files: ${response.status} - ${text}`);
        }
        return response.json();
    } catch (error) {
        console.error('Error getting files in PR:', error);
        throw error;
    }
}

// DOCS: https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#create-a-review-for-a-pull-request
async function createReview(owner, repo, prNumber, comments, githubToken){
    const token = githubToken || process.env.GITHUB_TOKEN;
    try{
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
            method: 'POST',
            headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                body: 'AI suggestions',
                event: 'COMMENT',
                comments: comments
            })
        });
        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Failed to create review: ${response.status} - ${text}`);
        }
        return response.json();
    } catch (error) {
        console.error('Error creating review:', error);
        throw error;
    }
}


// doing module export instead of exporting functions directly to avoid "SyntaxError: Unexpected token 'export'" in github actions environment
module.exports = {
    getFileContent,
    getFileContentByContentURL,
    getLatestCommit,
    createBranch,
    createBlob,
    createTree,
    commitChanges,
    pushCommit,
    createPR,
    getFilesInPR,
    createReview
};