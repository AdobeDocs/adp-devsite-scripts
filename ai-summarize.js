const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');

module.exports = async ({ content }) => {
    const fileSections = content.split(/--- File: (.+?) ---/g).filter((_, index) => index % 2 !== 0);

    fileSections.forEach(filePath => {
        const theFilePath = `${pathPrefix}/${path.parse(filePath).name}`;
        const pageUrl = `${branch}--${edsSiteEnv}--adobedocs.aem.page${theFilePath}`;

        const aiQuery = `${pageUrl} Generate a summary in bulleted list form in 100 words of less`;
        const payload = `--data '{"messages":[{"role":"system","content":[{"type":"text","text":"${aiQuery}"}]}],"temperature":1,"top_p":1,"max_tokens":800}'`;

        const url = `--location 'https://ioevents-openai-test.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview'`;
        const contentType = `--header 'Content-Type: application/json'`;
        const apiKey = `--header 'api-key: ${process.env.ADP_CHATGPT_API_KEY}'`;
        const cmdClean = `curl ${url} ${contentType} --header 'api-key: ***' ${payload}`;
        const cmd = `curl ${url} ${contentType} ${apiKey} ${payload}`;

        // console.log(`Processing file: ${filePath}`);
        // console.log(cmd);
        exec(cmd, (error, execOut, execErr) => {
            if (error) {
                console.error(`::group:: Error ${theFilePath} \nThe command: ${cmdClean} \n${execOut} \n${execErr} \n::endgroup::`)
                return;
            }

            console.log(`::group:: Running generate summary AI on ${theFilePath} \nThe command: ${cmdClean} \n${execOut} \n::endgroup::`);
        });
    });
};
