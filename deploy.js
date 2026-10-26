// Preview and live use the AEM admin bulk APIs (one job per chunk of paths) instead of one request per file.

const ADMIN_URL = 'https://admin.hlx.page';
const RETRYABLE_STATUS_CODES = [400, 429, 500, 502, 503, 504];
const BULK_CHUNK_SIZE = 1000;
const JOB_POLL_INTERVAL_MS = 5000;
const JOB_TIMEOUT_MS = 60 * 60 * 1000;

// Utility function to add a 300 millisecond delay
const delay = (ms = 300) => new Promise(resolve => setTimeout(resolve, ms));

// Utility function to fetch with retry logic for transient errors
const fetchWithRetry = async (url, options = {}, maxRetries = 5) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, options);
    if (!RETRYABLE_STATUS_CODES.includes(res.status) || attempt === maxRetries - 1) {
      return res;
    }
    const waitTime = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s
    console.log(`HTTP ${res.status} from ${url}. Retrying in ${waitTime / 1000}s... (attempt ${attempt + 1}/${maxRetries})`);
    await delay(waitTime);
  }
};

const describeError = (res) => `HTTP ${res.status}${res.headers.get('x-error') ? ` - ${res.headers.get('x-error')}` : ''}`;

const getJson = async (url) => {
  const res = await fetchWithRetry(url);
  if (!res.ok) {
    throw new Error(`${describeError(res)} fetching ${url}`);
  }
  return res.json();
};

// Starts a bulk preview/live job, waits for it to stop and returns the per-resource results
const runBulkJob = async ({ url, headers, paths, isDelete }) => {
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths, forceUpdate: true, delete: isDelete }),
  });
  if (!res.ok) {
    throw new Error(`${describeError(res)} starting bulk job`);
  }

  const { job: startedJob, links } = await res.json();
  // Small jobs run synchronously (HTTP 200): results are inline and the job URL is not pollable
  if (startedJob?.state === 'stopped') {
    console.log(`Bulk job for ${paths.length} path(s) completed synchronously`);
    return startedJob.data?.resources ?? [];
  }
  console.log(`Started bulk job for ${paths.length} path(s): ${links.self}`);

  const deadline = Date.now() + JOB_TIMEOUT_MS;
  let job;
  do {
    if (Date.now() > deadline) {
      throw new Error(`Bulk job did not finish within ${JOB_TIMEOUT_MS / 60000} minutes: ${links.self}`);
    }
    await delay(JOB_POLL_INTERVAL_MS);
    job = await getJson(links.self);
    const { processed = 0, total = paths.length, failed = 0 } = job.progress ?? {};
    console.log(`  ${job.state}: ${processed}/${total} processed, ${failed} failed`);
  } while (job.state !== 'stopped');

  const details = await getJson(`${links.self}/details`);
  return details.data?.resources ?? [];
};

const chunk = (array, size) => {
  const chunks = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
};

module.exports = async ({ core, changes, deletions, operation, siteEnv, branch, pathPrefix }) => {
  let edsSiteEnv, codeRepoBranch;
  if (!['preview', 'live'].includes(operation)) {
    core.setFailed(`Unknown operation: ${operation}`);
    return;
  }

  if (siteEnv.includes('stage')) {
    edsSiteEnv = "adp-devsite-stage";
    codeRepoBranch = "stage";
  } else if (siteEnv.includes('prod')) {
    edsSiteEnv = "adp-devsite";
    codeRepoBranch = "main";
  } else {
    core.setFailed(`Unknown env to deploy to: ${siteEnv}`);
    return;
  }

  // hacky way to do operations on our adp-devsite-stage env
  const headers = siteEnv.includes('stage') && operation === 'preview'
    ? { 'x-content-source-authorization': branch }
    : {};

  const operationUrl = `${ADMIN_URL}/${operation}/adobedocs/${edsSiteEnv}/${codeRepoBranch}`;
  const isAllowed = (file) => file.endsWith('.md') || file.endsWith('.json');
  // have to pop src/pages from the file path
  const toPath = (file) => `${pathPrefix}/${file.replace('src/pages/', '')}`;

  let summaryData = [];
  let hasErrors = false;

  [...changes, ...deletions].filter((file) => !isAllowed(file)).forEach((file) => {
    summaryData.push([`${file}`, `⚠️ Skipped`, `Only .md or .json files are allowed`]);
    console.error(`::group:: Skipping ${file} \nOnly file types .md or .json file are allowed \n::endgroup::`);
  });
  const changedPaths = changes.filter(isAllowed).map(toPath);
  const deletedPaths = deletions.filter(isAllowed).map(toPath);

  const runBulk = async (paths, isDelete) => {
    const label = isDelete ? `Delete ${operation}` : operation;
    for (const pathChunk of chunk(paths, BULK_CHUNK_SIZE)) {
      console.log(`::group:: ${label} (bulk) on ${pathChunk.length} path(s)`);
      try {
        const resources = await runBulkJob({ url: `${operationUrl}/*`, headers, paths: pathChunk, isDelete });
        resources.forEach(({ path, status, error }) => {
          if (!error && (status === undefined || (status >= 200 && status < 400))) {
            summaryData.push([path, `✅ Success`, `${status ? `HTTP ${status} - ` : ''}${label} completed`]);
          } else {
            if (!isDelete) hasErrors = true;
            summaryData.push([path, `❌ Error`, `HTTP ${status}${error ? ` - ${error}` : ''} - ${label} failed`]);
            console.error(`::error::${label} failed for ${path}: HTTP ${status}${error ? ` - ${error}` : ''}`);
          }
        });
      } catch (error) {
        if (!isDelete) hasErrors = true;
        pathChunk.forEach((path) => summaryData.push([path, `❌ Error`, `${error.message} - ${label} failed`]));
        console.error(`::error::${label} bulk job failed: ${error.message}`);
      }
      console.log('::endgroup::');
    }
  };
  await runBulk(changedPaths, false);
  await runBulk(deletedPaths, true);

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
