const fs = require('fs');
const path = require('path');
const aiScripts = require('./ai-scripts');
const createPrScripts = require('./create-pr-scripts');

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

module.exports = async ({ core, githubToken, owner, repo, changedFiles, targetBranch, azureOpenAIEndpoint, azureOpenAIAPIKey, fileName }) => {
    // Validate required parameters
    if (!repo) {
        throw new Error('Missing required parameter: repo must be specified');
    }
    if (!changedFiles || !Array.isArray(changedFiles)) {
        throw new Error('Missing required parameter: changedFiles must be an array');
    }
    if (!azureOpenAIEndpoint || !azureOpenAIAPIKey) {
        throw new Error('Missing required parameters: azureOpenAIEndpoint and azureOpenAIAPIKey must be specified');
    }

    // Use provided values or fallback to defaults
    const ownerName = owner || "AdobeDocs";
    const repoName = repo;
    const targetBranchName = targetBranch || "main";
    const inputFileName = fileName || "changed_files_content.txt";
    const token = githubToken || process.env.GITHUB_TOKEN;

    if (!token) {
        throw new Error('Missing required parameter: githubToken must be provided or GITHUB_TOKEN environment variable must be set');
    }

    console.log(`Processing ${changedFiles.length} changed files for AI metadata generation`);
    console.log('Changed files:', changedFiles);

    try {
        // Step 1: Fetch content for changed files
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

        // Step 2: Run AI metadata generation
        console.log('Running AI metadata generation...');
        await aiScripts({
            core,
            azureOpenAIEndpoint,
            azureOpenAIAPIKey,
            fileName: inputFileName
        });

        // Check if AI generated content
        if (!fs.existsSync('ai_content.txt')) {
            throw new Error('AI scripts did not generate ai_content.txt file');
        }

        const aiContent = fs.readFileSync('ai_content.txt', 'utf8');
        if (!aiContent || aiContent.trim() === '') {
            throw new Error('AI scripts generated empty content');
        }

        // Check for warning messages from AI scripts
        if (aiContent.includes('--- Warning ---') || aiContent.includes('No files were found to process')) {
            console.log('AI scripts reported no files to process - skipping PR creation');
            console.log('AI content:', aiContent.trim());
            return;
        }

        // Step 3: Create PR with the generated metadata
        console.log('Creating PR with generated metadata...');
        await createPrScripts({
            core,
            githubToken: token,
            owner: ownerName,
            repo: repoName,
            targetBranch: targetBranchName
        });

        console.log('Successfully completed changed files processing pipeline');

    } catch (error) {
        console.error('Error in changed files processing pipeline:', error);
        throw error;
    } finally {
        // Clean up temporary files
        try {
            if (fs.existsSync(inputFileName)) {
                fs.unlinkSync(inputFileName);
                console.log(`Cleaned up temporary file: ${inputFileName}`);
            }
        } catch (cleanupError) {
            console.warn('Failed to clean up temporary file:', cleanupError);
        }
    }
};

// Keep backwards compatibility - if run directly, use environment variables
if (require.main === module) {
    const owner = process.env.GITHUB_OWNER;
    const repo = process.env.GITHUB_REPO;
    const githubToken = process.env.GITHUB_TOKEN;
    const targetBranch = process.env.TARGET_BRANCH;
    const azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
    const azureOpenAIAPIKey = process.env.AZURE_OPENAI_API_KEY;
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
    if (!azureOpenAIEndpoint) {
        console.error('Error: AZURE_OPENAI_ENDPOINT environment variable must be set when running directly');
        process.exit(1);
    }
    if (!azureOpenAIAPIKey) {
        console.error('Error: AZURE_OPENAI_API_KEY environment variable must be set when running directly');
        process.exit(1);
    }
    
    module.exports({ 
        core: null,
        githubToken,
        owner,
        repo,
        changedFiles,
        targetBranch,
        azureOpenAIEndpoint,
        azureOpenAIAPIKey,
        fileName
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}
