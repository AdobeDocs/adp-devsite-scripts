const { getFilesInPR } = require('./github-api');
const fs = require('fs');

module.exports = async ({ core, prId, githubToken, owner, repo }) => {
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    if (!prId) {
        throw new Error('Missing required parameter: prId must be specified');
    }
    
    // Use provided values or fallback to defaults where appropriate
    const ownerName = owner || "AdobeDocs";
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    try {
        // fetch the files changed in this PR
        const filesData = await getFilesInPR(ownerName, repo, prId, token);

        // Filter files in src/pages directory and exclude config.md
        const pagesFiles = filesData.filter(file =>
            file.filename.startsWith('src/pages/') &&
            !file.filename.endsWith('config.md')
        );

        let allContent = '';

        for (const file of pagesFiles) {
            const contentResponse = await fetch(file.raw_url, {
                headers: {
                    'Accept': 'application/vnd.github.v3.raw',
                    'Authorization': `Bearer ${token}`
                }
            });

            if (contentResponse.ok) {
                const content = await contentResponse.text();
                // append the content to allContent string with identifier "--- File: ${file.filename} ---" for further processing
                allContent += `\n\n--- File: ${file.filename} ---\n\n${content}`;
            } else {
                console.error(`Failed to fetch content for ${file.filename}`);
            }
        }

        if (pagesFiles.length === 0) {
            console.log('No matching files found in src/pages directory (excluding config.md)');
            allContent = 'No matching files found in src/pages directory (excluding config.md)';
        }

        // Write content to pr_content.txt
        try {
            fs.writeFileSync('pr_content.txt', allContent);
            console.log('Content successfully written to pr_content.txt');
        } catch (error) {
            console.error('Error writing to pr_content.txt:', error);
        }

    } catch (error) {
        console.error('Error fetching PR information:', error);
        throw error;
    }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const prId = process.env.PR_ID;
    const githubToken = process.env.GITHUB_TOKEN;
    
    if (!repo) {
        console.error('Error: GITHUB_REPO environment variable must be set when running directly');
        process.exit(1);
    }
    if (!prId) {
        console.error('Error: PR_ID environment variable must be set when running directly');
        process.exit(1);
    }
    
    module.exports({
        core: null,
        prId,
        githubToken,
        owner,
        repo
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}