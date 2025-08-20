const { getFilesInPR } = require('./github-api');
const fs = require('fs');

module.exports = async ({ core, prId, githubToken, owner, repo }) => {
    try {
        // fetch the files changed in this PR
        const filesData = await getFilesInPR(owner, repo, prId, githubToken);

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
                    'Authorization': `Bearer ${githubToken}`
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
    }
};