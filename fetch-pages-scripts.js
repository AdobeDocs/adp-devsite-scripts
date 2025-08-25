const fs = require('fs');

// List of file extensions to skip (images and binary files)
const SKIP_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.mp4', '.webm', '.mov', '.mp3', '.wav',
    '.pdf', '.zip', '.tar', '.gz', '.json'
];

module.exports = async ({ core, githubToken, owner, repo }) => {
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    
    // Use provided values or fallback to defaults where appropriate
    const ownerName = owner || "AdobeDocs";
    const repoName = repo;
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    try {
        // Recursively get all files in src/pages/ directory
        const contentsResponse = await fetch(`https://api.github.com/repos/${ownerName}/${repoName}/contents/src/pages`, {
            headers: {
                'Accept': 'application/vnd.github.v3+json',
                'Authorization': `Bearer ${token}`
            }
        });

        if (!contentsResponse.ok) {
            throw new Error(`GitHub API request failed: ${contentsResponse.status}`);
        }

        const contents = await contentsResponse.json();
        let allContent = '';

        // Process directories and files recursively
        async function processPath(path) {
            const pathResponse = await fetch(`https://api.github.com/repos/${ownerName}/${repoName}/contents/${path}`, {
                headers: {
                    'Accept': 'application/vnd.github.v3+json',
                    'Authorization': `Bearer ${token}`
                }
            });

            if (!pathResponse.ok) {
                throw new Error(`GitHub API request failed when fetching path ${path}: ${pathResponse.status}`);
            }

            const items = await pathResponse.json();

            for (const item of items) {
                // Skip if it's a binary/image file
                const fileExt = item.name.substring(item.name.lastIndexOf('.')).toLowerCase();
                if (SKIP_EXTENSIONS.includes(fileExt)) {
                    console.log(`Skipping binary/image file: ${item.path}`);
                    continue;
                }

                if (item.type === 'dir') {
                    // Recursively process subdirectories
                    await processPath(item.path);
                } else if (item.type === 'file' && !item.name.endsWith('config.md')) {
                    // Fetch content for files (excluding config.md)
                    const contentResponse = await fetch(item.download_url, {
                        headers: {
                            'Accept': 'application/vnd.github.v3.raw',
                            'Authorization': `Bearer ${token}`
                        }
                    });

                    if (contentResponse.ok) {
                        const content = await contentResponse.text();
                        // Skip files that look like they embed React/JSX blocks while allowing simple HTML
                        // Heuristic: skip if it contains lines starting with '<' followed by an uppercase letter (JSX components)
                        const hasJSXComponent = /\n\s*<\s*[A-Z][A-Za-z0-9]*/.test(`\n${content}`);
                        if (hasJSXComponent) {
                            console.log(`Skipping JSX component file: ${item.path}`);
                            continue;
                        }
                        allContent += `\n\n--- File: ${item.path} ---\n\n${content}`;
                    } else {
                        console.log(`Failed to fetch content for ${item.path}`);
                    }
                }
            }
        }

        // Start processing from src/pages
        await processPath('src/pages');

        if (allContent === '') {
            console.log('No matching files found in src/pages directory (excluding config.md, binary files, and JSX components)');
            allContent = 'No matching files found in src/pages directory (excluding config.md, binary files, and JSX components)';
        }

        // Write content to all_pages_content.txt
        try {
            fs.writeFileSync('all_pages_content.txt', allContent);
            console.log('Content successfully written to all_pages_content.txt');
        } catch (error) {
            console.error('Error writing to all_pages_content.txt:', error);
        }

    } catch (error) {
        console.error('Error fetching repository content:', error);
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