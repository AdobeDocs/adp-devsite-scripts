const API_BASE = "https://api.github.com";

const HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
};

function authHeaders(token) {
  return { ...HEADERS, Authorization: `Bearer ${token}` };
}

// https://docs.github.com/en/rest/repos/repos#get-a-repository
export async function getRepo(owner, repo, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET /repos/${owner}/${repo} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/refs#get-a-reference
export async function getRef(owner, repo, ref, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/ref/${ref}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ref ${ref} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// getRef but returns null when the ref does not exist.
export async function tryGetRef(owner, repo, ref, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/ref/${ref}`, {
    headers: authHeaders(token),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET ref ${ref} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/refs#create-a-reference
export async function createRef(owner, repo, ref, sha, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ ref: `refs/${ref}`, sha }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST create ref ${ref} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/refs#delete-a-reference
export async function deleteRef(owner, repo, ref, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs/${ref}`, {
    method: "DELETE",
    headers: authHeaders(token),
  });
  if (!res.ok && res.status !== 404 && res.status !== 422) {
    const text = await res.text();
    throw new Error(`DELETE ref ${ref} failed: ${res.status} - ${text}`);
  }
}

// https://docs.github.com/en/rest/git/commits#get-a-commit-object
export async function getCommit(owner, repo, sha, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/commits/${sha}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET commit ${sha} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/repos/contents#get-repository-content
export async function getContents(owner, repo, filePath, ref, token) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
  const res = await fetch(url, { headers: authHeaders(token) });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET contents ${filePath} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/repos/contents#get-repository-content (raw)
export async function getRawContent(owner, repo, filePath, ref, token) {
  const url = `${API_BASE}/repos/${owner}/${repo}/contents/${filePath}?ref=${ref}`;
  const res = await fetch(url, {
    headers: { ...authHeaders(token), Accept: "application/vnd.github.raw+json" },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET raw content ${filePath} failed: ${res.status} - ${text}`);
  }
  return res.text();
}

// https://docs.github.com/en/rest/git/blobs#create-a-blob
export async function createBlob(owner, repo, content, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/blobs`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ content, encoding: "utf-8" }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST create blob failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/trees#create-a-tree
export async function createTree(owner, repo, baseTreeSha, tree, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/trees`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST create tree failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/commits#create-a-commit
export async function createCommit(owner, repo, message, treeSha, parentSha, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/commits`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({
      message,
      tree: treeSha,
      parents: [parentSha],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST create commit failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/git/refs#update-a-reference
export async function updateRef(owner, repo, ref, sha, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/git/refs/${ref}`, {
    method: "PATCH",
    headers: authHeaders(token),
    body: JSON.stringify({ sha, force: false }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PATCH update ref ${ref} failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request
export async function createPullRequest(owner, repo, head, base, title, body, token) {
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ title, head, base, body }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST create PR failed: ${res.status} - ${text}`);
  }
  return res.json();
}

// https://docs.github.com/en/rest/pulls/pulls#list-pull-requests
export async function listPullRequests(owner, repo, head, base, state, token) {
  const params = new URLSearchParams({ state, head: `${owner}:${head}`, base });
  const res = await fetch(`${API_BASE}/repos/${owner}/${repo}/pulls?${params}`, {
    headers: authHeaders(token),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GET list PRs failed: ${res.status} - ${text}`);
  }
  return res.json();
}
