const { exec } = require('child_process');
const path = require('path');

module.exports = async ({ core, changes, deletions, operation, siteEnv, branch, pathPrefix }) => {
  let httpMethod, edsSiteEnv, codeRepoBranch, args;
  // payload="{\"messages\":[{\"role\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"You are an AI assistant that helps people find information.\"}]}],\"temperature\":1,\"top_p\":1,\"max_tokens\":800}"
  //  curl "https://ioevents-openai-test.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview" \
  // -H "Content-Type: application/json" \
  // -H "api-key: YOUR_API_KEY" \
  // -d "$payload"

  if (siteEnv.includes('stage')) {
    edsSiteEnv = "adp-devsite-stage";
    codeRepoBranch = "stage";
  } else if (siteEnv.includes('prod')) {
    edsSiteEnv = "adp-devsite";
    codeRepoBranch = "main";
  }

  changes.forEach((file) => {
    if (!file.endsWith('.md')) {
      console.error(`::group:: Skipping ${file} \nOnly file types .md are allowed \n::endgroup::`);
      return;
    }

    const theFilePath = `${pathPrefix}/${path.parse(file).name}`;
    const pageUrl = `${branch}--${edsSiteEnv}--adobedocs.aem.page${theFilePath}`;

    const aiQuery = `${pageUrl} Generate a summary in bulleted list form in 100 words of less`;
    const payload = `--data '{\"messages\":[{\"role\":\"system\",\"content\":[{\"type\":\"text\",\"text\":\"${aiQuery}\"}]}],\"temperature\":1,\"top_p\":1,\"max_tokens\":800}'`;

    const url = `--location 'https://ioevents-openai-test.openai.azure.com/openai/deployments/gpt-4.1-mini/chat/completions?api-version=2025-01-01-preview'`;
    const contentType = `--header 'Content-Type: application/json'`;
    const apiKey = `--header 'api-key: ${process.env.ADP_CHATGPT_API_KEY}'`;
    const cmdClean = `curl ${url} ${contentType} --header 'api-key: ***' ${payload}`;
    const cmd = `curl ${url} ${contentType} ${apiKey} ${payload}`;

    exec(cmd, (error, execOut, execErr) => {
      if (error) {
        console.error(`::group:: Error ${theFilePath} \nThe command: ${cmdClean} \n${execOut} \n${execErr} \n::endgroup::`)
        return;
      }

      console.log(`::group:: Running generate summary AI on ${theFilePath} \nThe command: ${cmdClean} \n${execOut} \n::endgroup::`);
    });
  
    // // have to pop src/pages from the file path
    // file = file.replace('src/pages/', '');

    // const theFilePath = `${pathPrefix}/${file}`;
    // const url = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
    // const cmd = `curl -X${httpMethod} -vif ${args} ${url}`;

    // exec(cmd, (error, execOut, execErr) => {
    //   if (error) {
    //     console.error(`::group:: Error ${theFilePath} \nThe command: ${cmd} \n${execOut} \n${execErr} \n::endgroup::`)
    //     return;
    //   }

    //   console.log(`::group:: Running ${operation} on ${theFilePath} \nThe command: ${cmd} \n${execOut} \n::endgroup::`);
    // });
  });


  // if (operation.includes('cache') || operation.includes('preview') || operation.includes('live')) {
  //   httpMethod = 'POST';
  // } else {
  //   console.error('Unknown operation method');
  // }

  // if (siteEnv.includes('stage')) {
  //   edsSiteEnv = "adp-devsite-stage";
  //   codeRepoBranch = "stage";
  // } else if (siteEnv.includes('prod')) {
  //   edsSiteEnv = "adp-devsite";
  //   codeRepoBranch = "main";
  // } else {
  //   console.error('Unknown env to deploy to');
  // }

  // // hacky way to do operations on our adp-devsite-stage env
  // if ((siteEnv.includes('stage') && operation.includes('preview')) || (siteEnv.includes('stage') && operation.includes('cache'))) {
  //   args = `--header "x-content-source-authorization: ${branch}"`;
  // } else {
  //   args = '';
  // }

  // const theFilePath = `${pathPrefix}/${file}`;
  // const url = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
  // const cmd = `curl -X${httpMethod} -vif ${args} ${url}`;

  // exec(cmd, (error, execOut, execErr) => {
  //   if (error) {
  //     console.error(`::group:: Error ${theFilePath} \nThe command: ${cmd} \n${execOut} \n${execErr} \n::endgroup::`)
  //     return;
  //   }

  //   console.log(`::group:: Running ${operation} on ${theFilePath} \nThe command: ${cmd} \n${execOut} \n::endgroup::`);
  // });


  // changes.forEach((file) => {
  //   if (!file.endsWith('.md') && !file.endsWith('.json')) {
  //     console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
  //     return;
  //   }

  //   // have to pop src/pages from the file path
  //   file = file.replace('src/pages/', '');

  //   const theFilePath = `${pathPrefix}/${file}`;
  //   const url = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
  //   const cmd = `curl -X${httpMethod} -vif ${args} ${url}`;

  //   exec(cmd, (error, execOut, execErr) => {
  //     if (error) {
  //       console.error(`::group:: Error ${theFilePath} \nThe command: ${cmd} \n${execOut} \n${execErr} \n::endgroup::`)
  //       return;
  //     }

  //     console.log(`::group:: Running ${operation} on ${theFilePath} \nThe command: ${cmd} \n${execOut} \n::endgroup::`);
  //   });
  // });

  // deletions.forEach((file) => {
  //   if (!file.endsWith('.md') && !file.endsWith('.json')) {
  //     console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
  //     return;
  //   }

  //   // have to pop src/pages from the file path
  //   file = file.replace('src/pages/', '');

  //   const theFilePath = `${pathPrefix}/${file}`;
  //   const deleteUrl = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
  //   const deleteCmd = `curl -XDELETE -vif ${args} ${deleteUrl}`;


  //   exec(deleteCmd, (deleteError, deleteExecOut, deleteExecErr) => {
  //     if (deleteError) {
  //       console.error(`::group:: Deleting error ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n${deleteExecErr} \n::endgroup::`)
  //       return;
  //     }

  //     console.log(`::group:: Deleting ${operation} on ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n::endgroup::`);
  //   });
  // });
}