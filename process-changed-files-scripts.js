const fs = require('fs');
const path = require('path');

// List of file extensions to skip (images and binary files)
const SKIP_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
    '.mp4', '.webm', '.mov', '.mp3', '.wav',
    '.pdf', '.zip', '.tar', '.gz', '.json'
];

async function fetchChangedFilesContent(changedFiles, owner, repo, githubToken) {
    let allContent = '';
    let processedFilesCount = 0;

    for (const filePath of changedFiles) {
        try {
            // Skip if not in src/pages directory
            if (!filePath.startsWith('src/pages/')) {
                console.log(`Skipping file outside src/pages: ${filePath}`);
                continue;
            }

            // Skip config.md files
            if (filePath.endsWith('config.md')) {
                console.log(`Skipping config file: ${filePath}`);
                continue;
            }

            // Skip if it's a binary/image file
            const fileExt = path.extname(filePath).toLowerCase();
            if (SKIP_EXTENSIONS.includes(fileExt)) {
                console.log(`Skipping binary/image file: ${filePath}`);
                continue;
            }

            // Only process markdown files
            if (!filePath.endsWith('.md')) {
                console.log(`Skipping non-markdown file: ${filePath}`);
                continue;
            }

            console.log(`Fetching content for: ${filePath}`);
            
            // Construct GitHub API URL for file content
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
            const response = await fetch(apiUrl, {
                headers: {
                    'Accept': 'application/vnd.github.v3.raw',
                    'Authorization': `Bearer ${githubToken}`
                }
            });

            if (!response.ok) {
                console.warn(`Failed to fetch content for ${filePath}: ${response.status}`);
                continue;
            }

            const content = await response.text();
            
            // Skip files that look like they embed React/JSX blocks while allowing simple HTML
            // Heuristic: skip if it contains lines starting with '<' followed by an uppercase letter (JSX components)
            const hasJSXComponent = /\n\s*<\s*[A-Z][A-Za-z0-9]*/.test(`\n${content}`);
            if (hasJSXComponent) {
                console.log(`Skipping JSX component file: ${filePath}`);
                continue;
            }

            allContent += `\n\n--- File: ${filePath} ---\n\n${content}`;
            processedFilesCount++;

        } catch (error) {
            console.error(`Error processing file ${filePath}:`, error);
        }
    }

    return { allContent, processedFilesCount };
}

module.exports = async ({ core, githubToken, owner, repo, changedFiles, fileName }) => {
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    if (!changedFiles || !Array.isArray(changedFiles)) {
        throw new Error('Missing required parameter: changedFiles must be an array');
    }

    // Use provided values or fallback to defaults
    const ownerName = owner || "AdobeDocs";
    const repoName = repo;
    const inputFileName = fileName || "changed_files_content.txt";
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    console.log(`Fetching content for ${changedFiles.length} changed files`);
    console.log('Changed files:', changedFiles);

    try {
        // Fetch content for changed files
        const { allContent, processedFilesCount } = await fetchChangedFilesContent(
            changedFiles, 
            ownerName, 
            repoName, 
            token
        );

        if (processedFilesCount === 0) {
            console.log('No matching files found in changed files (excluding config.md, binary files, and JSX components)');
            const warningContent = 'No matching files found in changed files (excluding config.md, binary files, and JSX components)';
            fs.writeFileSync(inputFileName, warningContent, 'utf8');
        } else {
            console.log(`Successfully processed ${processedFilesCount} changed files`);
            fs.writeFileSync(inputFileName, allContent, 'utf8');
        }

        console.log(`Content successfully written to ${inputFileName}`);

    } catch (error) {
        console.error('Error fetching changed files content:', error);
        throw error;
    }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const githubToken = process.env.GITHUB_TOKEN;
    const fileName = process.env.FILE_NAME;
    
    // Parse changed files from environment variable (JSON array)
    let changedFiles = [];
    try {
        const changedFilesStr = process.env.CHANGED_FILES;
        if (changedFilesStr) {
            changedFiles = JSON.parse(changedFilesStr);
        }
    } catch (error) {
        console.error('Error parsing CHANGED_FILES environment variable:', error);
        process.exit(1);
    }
    
    if (!repo) {
        console.error('Error: GITHUB_REPO environment variable must be set when running directly');
        process.exit(1);
    }
    if (!changedFiles.length) {
        console.error('Error: CHANGED_FILES environment variable must be set with a JSON array of file paths');
        process.exit(1);
    }
    
    module.exports({ 
        core: null,
        githubToken,
        owner,
        repo,
        changedFiles,
        fileName
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}
