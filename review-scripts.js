const fs = require('fs');
const { hasMetadata } = require('./file-operation');
const matter = require('gray-matter');
const { getFileContentByContentURL, getFilesInPR, createReview } = require('./github-api');

// File content utilities
function readAiContent() {
    try {
        const aiContent = fs.readFileSync('ai_content.txt', 'utf8');
        
        // Check if content is empty
        if (!aiContent || aiContent.trim() === '') {
            throw new Error('ai_content.txt is empty - no content to process');
        }

        // Check for warning messages from ai-scripts.js
        if (aiContent.includes('--- Warning ---') || aiContent.includes('No files were found to process')) {
            console.log('AI scripts reported no files to process:', aiContent.trim());
            throw new Error('No files were found by AI processing - skipping review creation');
        }
        
        // Split content by file markers using a simpler approach
        const fileContents = aiContent.split(/--- File: /);
        // Remove the first empty element if exists
        if (fileContents[0].trim() === '') {
            fileContents.shift();
        }

        // Check if we have any valid file sections
        if (fileContents.length === 0) {
            throw new Error('No valid file sections found in ai_content.txt');
        }

        const files = [];
        for (const fileContent of fileContents) {
            if (!fileContent.trim()) continue;

            // Extract file path and content - the format is "path ---\ncontent"
            const pathMatch = fileContent.match(/^(.+?) ---\n([\s\S]*)$/);
            if (!pathMatch) {
                console.warn('Could not parse file content:', fileContent.substring(0, 100));
                continue;
            }

            const [, path, suggestion] = pathMatch;
            if (!path || !suggestion.trim()) {
                console.warn(`Skipping file with empty path or content: ${path}`);
                continue;
            }
            
            files.push({ path: path.trim(), suggestion: suggestion.trim() });
        }

        if (files.length === 0) {
            throw new Error('No valid files were processed - no review comments to create');
        }

        return files;
    } catch (error) {
        console.error('Error reading ai_content.txt:', error);
        throw error;
    }
}

function findMetadataEnd(content) {
    const lines = content.split('\n');
    let dashCount = 0;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
            dashCount++;
            if (dashCount === 2) {
                return i + 1; // Line after the closing ---
            }
        }
    }
    return 0;
}

// Prepare the body of review comment
// DOCS: https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#create-a-review-for-a-pull-request
function prepareReviewComment(targetFile, content, suggestion) {
    const hasFileMetadata = hasMetadata(content);
    
    // The suggestion should be clean frontmatter (no file headers after parsing fix)
    const cleanSuggestion = suggestion.trim();
    
    // if has metadata, replace it
    if (hasFileMetadata) {
        const metadataEnd = findMetadataEnd(content);
        if (metadataEnd > 0) {
            return {
                path: targetFile.filename,
                start_line: 1,
                start_side: 'RIGHT',
                line: metadataEnd,
                side: 'RIGHT',
                body: `\`\`\`suggestion\n${cleanSuggestion}\n\`\`\``
            };
        }
    }
    
    // if no metadata, add it to the first line (replace, don't append)
    const firstLine = content.split('\n')[0] || '';
    return {
        path: targetFile.filename,
        line: 1,
        side: 'RIGHT',
        body: `\`\`\`suggestion\n${cleanSuggestion}\n${firstLine}\n\`\`\``
    };
}


module.exports = async ({ core, githubToken, prId, owner, repo }) => {
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
        // Read AI content for all files
        const files = readAiContent();
        console.log(`Found ${files.length} files to process`);

        const PRFiles = await getFilesInPR(ownerName, repo, prId, token);
        console.log(`Found ${PRFiles.length} files in PR`);

        // Process each file and prepare comments
        const comments = [];
        for (const { path, suggestion } of files) {
            console.log(`Processing file: ${path}`);
            
            const targetFile = PRFiles.find(file => file.filename === path);
            if (!targetFile) {
                console.warn(`Target file ${path} not found in PR, skipping...`);
                continue;
            }

            // Only process files that were actually added or modified in the PR
            if (targetFile.status === 'removed') {
                console.warn(`File ${path} was removed, skipping review...`);
                continue;
            }

            const content = await getFileContentByContentURL(targetFile.raw_url, token);

            // Prepare comment for this file
            const comment = prepareReviewComment(targetFile, content, suggestion);
            
            // Validate comment before adding
            if (comment.line && comment.line > 0) {
                console.log(`Adding comment for ${path} at line ${comment.line}`);
                comments.push(comment);
            } else {
                console.warn(`Invalid line number for ${path}: ${comment.line}, skipping...`);
            }
        }

        if (comments.length === 0) {
            console.log('No valid comments to create');
            return;
        }

        console.log(`Creating review with ${comments.length} comments`);

        // Create single review with all comments
        const reviewData = await createReview(ownerName, repo, prId, comments, token);

        console.log('Review created successfully:', {
            id: reviewData.id,
            state: reviewData.state,
            html_url: reviewData.html_url
        });

    } catch (error) {
        // Check if this is a "no content" error - if so, exit gracefully
        if (error.message && (
            error.message.includes('No files were found by AI processing') ||
            error.message.includes('no content to process') ||
            error.message.includes('No valid files were processed')
        )) {
            console.log('No content changes detected - skipping review creation');
            console.log('Reason:', error.message);
            return; // Exit gracefully instead of throwing
        }
        
        console.error('Error in reviewPR:', error.message);
        console.error('Full error:', error);
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
        githubToken,
        prId,
        owner,
        repo
    }).catch(error => {
        console.error('Error:', error.message);
        process.exit(1);
    });
}