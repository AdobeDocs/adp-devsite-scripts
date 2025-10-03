const { exec } = require('child_process');

// Utility function to process arrays in batches
const processBatch = async (array, batchSize, processFn) => {
  for (let i = 0; i < array.length; i += batchSize) {
    const batch = array.slice(i, i + batchSize);
    await Promise.all(batch.map(processFn));
  }
};

module.exports = async ({ core, changes, deletions, operation, siteEnv, branch, pathPrefix }) => {
  let httpMethod, edsSiteEnv, codeRepoBranch, args;
  if (operation.includes('cache') || operation.includes('preview') || operation.includes('live')) {
    httpMethod = 'POST';
  } else {
    console.error('Unknown operation method');
  }

  if (siteEnv.includes('stage')) {
    edsSiteEnv = "adp-devsite-stage";
    codeRepoBranch = "stage";
  } else if (siteEnv.includes('prod')) {
    edsSiteEnv = "adp-devsite";
    codeRepoBranch = "main";
  } else {
    console.error('Unknown env to deploy to');
  }

  // hacky way to do operations on our adp-devsite-stage env
  if ((siteEnv.includes('stage') && operation.includes('preview')) || (siteEnv.includes('stage') && operation.includes('cache'))) {
    args = `--header "x-content-source-authorization: ${branch}"`;
  } else {
    args = '';
  }

  let summaryData = [];

  // Process changes in batches of 5
  const processChangeFile = async (file) => {
    return new Promise((resolve) => {
      if (!file.endsWith('.md') && !file.endsWith('.json')) {
        summaryData.push([`${file}`, `⚠️ Skipped`, `Only .md or .json files are allowed`]);
        console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
        resolve();
        return;
      }

      // have to pop src/pages from the file path
      const processedFile = file.replace('src/pages/', '');
      const theFilePath = `${pathPrefix}/${processedFile}`;
      const url = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
      const cmd = `curl -X${httpMethod} -w "HTTP_STATUS:%{http_code}" -vif ${args} ${url}`;

      exec(cmd, (error, execOut, execErr) => {
        // Extract HTTP status code from curl output
        const statusMatch = execOut.match(/HTTP_STATUS:(\d+)/);
        const httpStatus = statusMatch ? statusMatch[1] : 'Unknown';
        console.log()
        if (error) {
          summaryData.push([`${theFilePath}`, `❌ Error`, `HTTP ${httpStatus} - ${operation} failed`]);
          console.error(`::group:: Error ${theFilePath} \nThe command: ${cmd} \n${execOut} \n${execErr} \n::endgroup::`);
        } else {
          summaryData.push([`${theFilePath}`, `✅ Success`, `HTTP ${httpStatus} - ${operation} completed`]);
          console.log(`::group:: Running ${operation} on ${theFilePath} \nThe command: ${cmd} \n${execOut} \n::endgroup::`);
        }
        resolve();
      });
    });
  };

  await processBatch(changes, 5, processChangeFile);

  // Process deletions in batches of 5
  const processDeleteFile = async (file) => {
    return new Promise((resolve) => {
      if (!file.endsWith('.md') && !file.endsWith('.json')) {
        summaryData.push([`${file}`, `⚠️ Skipped`, `Only .md or .json files are allowed`]);
        console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
        resolve();
        return;
      }

      // have to pop src/pages from the file path
      const processedFile = file.replace('src/pages/', '');
      const theFilePath = `${pathPrefix}/${processedFile}`;
      const deleteUrl = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
      const deleteCmd = `curl -XDELETE -w "HTTP_STATUS:%{http_code}" -vif ${args} ${deleteUrl}`;

      exec(deleteCmd, (deleteError, deleteExecOut, deleteExecErr) => {
        // Extract HTTP status code from curl output
        const statusMatch = deleteExecOut.match(/HTTP_STATUS:(\d+)/);
        const httpStatus = statusMatch ? statusMatch[1] : 'Unknown';

        if (deleteError) {
          summaryData.push([`${theFilePath}`, `❌ Error`, `HTTP ${httpStatus} - ${operation} failed`]);
          console.error(`::group:: Deleting error ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n${deleteExecErr} \n::endgroup::`);
        } else {
          summaryData.push([`${theFilePath}`, `✅ Success`, `HTTP ${httpStatus} - Delete ${operation} completed`]);
          console.log(`::group:: Deleting ${operation} on ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n::endgroup::`);
        }
        resolve();
      });
    });
  };

  await processBatch(deletions, 5, processDeleteFile);

  // Sort summaryData: Error first, then Success, then Skipped
  summaryData.sort((a, b) => {
    const statusA = a[1]; // Deploy Status column
    const statusB = b[1]; // Deploy Status column

    const statusOrder = {
      '❌ Error': 0,
      '✅ Success': 1,
      '⚠️ Skipped': 2
    };

    return statusOrder[statusA] - statusOrder[statusB];
  });

  // write out summary for action
  const tableHeader = [{ data: 'Upload File Path', header: true }, { data: 'Deploy Status', header: true }, { data: 'Notes', header: true }];
  const tableContent = [tableHeader, ...summaryData];
  core.summary
    .addHeading(`Operation: ${operation}`)
    .addTable(tableContent)
    .write();
}
