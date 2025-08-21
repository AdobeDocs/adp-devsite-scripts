const fs = require('fs');
const { hasMetadata } = require('./file-operation');
const matter = require('gray-matter');
const { getFileContentByContentURL, getFilesInPR, createReview } = require('./github-api');

// File content utilities
function readAiContent() {
    try {
        const aiContent = fs.readFileSync('ai_content.txt', 'utf8');

        // Split content by file markers
        const fileContents = aiContent.split(/--- File: (?=.*? ---)/);
        // Remove the first empty element if exists
        if (fileContents[0].trim() === '') {
            fileContents.shift();
        }

        const files = [];
        for (const fileContent of fileContents) {
            if (!fileContent.trim()) continue;

            // Extract file path and content
            const pathMatch = fileContent.match(/(.*?) ---\n([\s\S]*)/);
            if (!pathMatch) continue;

            const [, path, suggestion] = pathMatch;
            files.push({ path, suggestion: suggestion.trim() });
        }

        if (files.length === 0) {
            throw new Error('Could not extract any file content from ai_content.txt');
        }

        return files;
    } catch (error) {
        console.error('Error reading ai_content.txt:', error);
        throw error;
    }
}

function findMetadataEnd(content) {
    try {
        const parsed = matter(content);
        if (parsed.matter && parsed.matter.trim().length > 0) {
            // Count how many lines the frontmatter occupies (including closing ---)
            const fm = `---\n${parsed.matter}\n---`;
            const fmLines = fm.split('\n').length;
            return fmLines + 0; // metadata ends at this line
        }
    } catch (_e) {}
    return 0;
}

// Prepare the body of review comment
// DOCS: https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28#create-a-review-for-a-pull-request
function prepareReviewComment(targetFile, content, suggestion) {
    const firstLine = content.split('\n')[0];
    const hasFileMetadata = hasMetadata(content);

    // if has metadata, replace it
    if (hasFileMetadata) {
        const metadataEnd = findMetadataEnd(content);
        return {
            path: targetFile.filename,
            start_line: 1,
            start_side: 'RIGHT', // "RIGHT" means the content after PR, "LEFT" means the content before PR
            line: metadataEnd, // end_line
            side: 'RIGHT', // end_side, "LEFT" and "RIGHT" meaning same above
            body: `\`\`\`suggestion\n${suggestion}\n\`\`\``
        };
    }

    // if no metadata, add it to the first line
    return {
        path: targetFile.filename,
        line: 1,
        side: 'RIGHT',
        body: `\`\`\`suggestion\n${suggestion}\n${firstLine}\n\`\`\`` // this action is overwriting the first line with metadata, so should append the origianl first line to the suggtion's end.
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

        const PRFiles = await getFilesInPR(ownerName, repo, prId, token);

        // Process each file and prepare comments
        const comments = [];
        for (const { path, suggestion } of files) {
            const targetFile = PRFiles.find(file => file.filename === path);
            if (!targetFile) { // for safety, should not happen
                console.warn(`Target file ${path} not found in PR, skipping...`);
                continue;
            }

            const content = await getFileContentByContentURL(targetFile.raw_url, token);

            // Prepare comment for this file
            const comment = prepareReviewComment(targetFile, content, suggestion);
            comments.push(comment);
        }

        if (comments.length === 0) {
            throw new Error('No valid files to review');
        }

        // Create single review with all comments
        const reviewData = await createReview(ownerName, repo, prId, comments, token);

        console.log('Review created successfully:', {
            id: reviewData.id,
            state: reviewData.state,
            html_url: reviewData.html_url
        });

    } catch (error) {
        console.error('Error in reviewPR:', error.message);
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