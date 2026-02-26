const { exec } = require('child_process');

const RETRYABLE_STATUS_CODES = ['400', '429', '500', '502', '503', '504'];

// Utility function to add a 300 millisecond delay
const delay = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

// Utility function to execute command with retry logic for transient errors
const execWithRetry = async (cmd, maxRetries = 5) => {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await new Promise((resolve) => {
      exec(cmd, (error, execOut, execErr) => {
        const statusMatch = execOut.match(/HTTP_STATUS:(\d+)/);
        const httpStatus = statusMatch ? statusMatch[1] : null;
        resolve({ error, execOut, execErr, httpStatus });
      });
    });

    if (!RETRYABLE_STATUS_CODES.includes(result.httpStatus)) {
      return result;
    }

    // Retryable status and we have retries left, wait with exponential backoff
    if (attempt < maxRetries - 1) {
      const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
      console.log(`HTTP ${result.httpStatus} error. Retrying in ${waitTime / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
      await delay(waitTime);
    } else {
      // Last attempt failed with retryable status
      return result;
    }
  }
};

// Utility function to process arrays in batches
const processBatch = async (array, batchSize, processFn) => {
  for (let i = 0; i < array.length; i += batchSize) {
    const batch = array.slice(i, i + batchSize);
    await Promise.all(batch.map(processFn));

    // Add delay between batches (but not after the last batch)
    if (i + batchSize < array.length) {
      await delay();
    }
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
  let hasErrors = false;

  // Sort changes array to process valid files (.md, .json) first, invalid files last
  const sortedChanges = changes.sort((a, b) => {
    const aValid = a.endsWith('.md') || a.endsWith('.json');
    const bValid = b.endsWith('.md') || b.endsWith('.json');
    if (aValid && !bValid) return -1; // a comes first
    if (!aValid && bValid) return 1;  // b comes first
    return 0; // maintain original order for files of same type
  });

  // Process changes in batches of 5
  const processChangeFile = async (file) => {
    if (!file.endsWith('.md') && !file.endsWith('.json')) {
      summaryData.push([`${file}`, `⚠️ Skipped`, `Only .md or .json files are allowed`]);
      console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
      return;
    }

    // have to pop src/pages from the file path
    const processedFile = file.replace('src/pages/', '');
    const theFilePath = `${pathPrefix}/${processedFile}`;
    const url = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
    const cmd = `curl -X${httpMethod} -w "HTTP_STATUS:%{http_code}" -vif ${args} ${url}`;

    const { error, execOut, execErr, httpStatus } = await execWithRetry(cmd);

    if (error) {
      if (operation.includes('preview') || operation.includes('live')) {
        hasErrors = true;
      }
      summaryData.push([`${theFilePath}`, `❌ Error`, `HTTP ${httpStatus} - ${operation} failed`]);
      console.error(`::group:: Error ${theFilePath} \nThe command: ${cmd} \n${execOut} \n${execErr} \n::endgroup::`);
    } else {
      summaryData.push([`${theFilePath}`, `✅ Success`, `HTTP ${httpStatus} - ${operation} completed`]);
      console.log(`::group:: Running ${operation} on ${theFilePath} \nThe command: ${cmd} \n${execOut} \n::endgroup::`);
    }
  };

  await processBatch(sortedChanges, 5, processChangeFile);

  // Sort deletions array to process valid files (.md, .json) first, invalid files last
  const sortedDeletions = deletions.sort((a, b) => {
    const aValid = a.endsWith('.md') || a.endsWith('.json');
    const bValid = b.endsWith('.md') || b.endsWith('.json');
    if (aValid && !bValid) return -1; // a comes first
    if (!aValid && bValid) return 1;  // b comes first
    return 0; // maintain original order for files of same type
  });

  // Process deletions in batches of 5
  const processDeleteFile = async (file) => {
    if (!file.endsWith('.md') && !file.endsWith('.json')) {
      summaryData.push([`${file}`, `⚠️ Skipped`, `Only .md or .json files are allowed`]);
      console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
      return;
    }

    // have to pop src/pages from the file path
    const processedFile = file.replace('src/pages/', '');
    const theFilePath = `${pathPrefix}/${processedFile}`;
    const deleteUrl = `https://admin.hlx.page/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}${theFilePath}`;
    const deleteCmd = `curl -XDELETE -w "HTTP_STATUS:%{http_code}" -vif ${args} ${deleteUrl}`;

    const { error: deleteError, execOut: deleteExecOut, execErr: deleteExecErr, httpStatus } = await execWithRetry(deleteCmd);

    if (deleteError) {
      summaryData.push([`${theFilePath}`, `❌ Error`, `HTTP ${httpStatus} - ${operation} failed`]);
      console.error(`::group:: Deleting error ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n${deleteExecErr} \n::endgroup::`);
    } else {
      summaryData.push([`${theFilePath}`, `✅ Success`, `HTTP ${httpStatus} - Delete ${operation} completed`]);
      console.log(`::group:: Deleting ${operation} on ${theFilePath} \nThe command: ${deleteCmd} \n${deleteExecOut} \n::endgroup::`);
    }
  };

  await processBatch(sortedDeletions, 5, processDeleteFile);

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

  // Fail the action if any errors occurred
  if (hasErrors) {
    core.setFailed('One or more files failed to upload');
  }
}
