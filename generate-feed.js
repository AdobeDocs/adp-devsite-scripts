const path = require("path");
const fs = require("fs");

// Regex patterns for release headings
// Matches "## [v4.57.22] 2026-10-08", "## [4.54.18] 2026-09-02", "## [4.16.11] - 2024-11-18", "## 2025-11-14", "## [1.0.0]"
const HEADING_RE = /^##\s+(?:\[?\s*v?([\d.]+)\s*\]?\s*[-–—]?\s*)?\(?(\d{4}-\d{2}-\d{2})\)?\s*$/i;
const HEADING_VERSION_ONLY_RE = /^##\s+\[?\s*v?([\d.]+)\s*\]?\s*$/i;

// Common candidate relative paths for changelog files (relative to src/pages or repo root)
const CHANGELOG_CANDIDATE_PATHS = [
    "changelog/index.md",
    "changelog.md",
    "release-notes/index.md",
    "release-notes.md"
];

function stripFrontmatter(markdown) {
    return markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
}

function normalizeLineEndings(markdown) {
    return markdown.replace(/\r\n/g, "\n");
}

function parseReleases(markdown) {
    const lines = stripFrontmatter(normalizeLineEndings(markdown)).split("\n");
    const releases = [];
    let current = null;

    for (const line of lines) {
        const matchWithDate = line.match(HEADING_RE);
        const matchVersionOnly = !matchWithDate ? line.match(HEADING_VERSION_ONLY_RE) : null;

        if (matchWithDate || matchVersionOnly) {
            if (current) releases.push(current);
            let version = null;
            let date = null;

            if (matchWithDate) {
                const [, rawVersion, matchedDate] = matchWithDate;
                version = rawVersion ? rawVersion.replace(/^v/i, "").trim() : null;
                date = matchedDate;
            } else if (matchVersionOnly) {
                const [, rawVersion] = matchVersionOnly;
                version = rawVersion ? rawVersion.replace(/^v/i, "").trim() : null;
                date = null;
            }

            current = { version, date, bodyLines: [] };
        } else if (current) {
            current.bodyLines.push(line);
        }
    }
    if (current) releases.push(current);

    return releases;
}

function slugify(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function resolveRelativeLink(href, changelogUrlPath = "guides/changelog", siteBase = "") {
    if (/^https?:\/\//.test(href) || href.startsWith("#")) return href;
    const resolved = path.posix
        .normalize(path.posix.join(changelogUrlPath, href))
        .replace(/\.md(#.*)?$/, (_, hash) => hash || "/");
    return siteBase ? `${siteBase}/${resolved}` : `/${resolved}`;
}

function escapeXml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function formatInline(text, changelogUrlPath, siteBase) {
    // 1. Inline code: `code` -> <code>code</code>
    let formatted = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeXml(code)}</code>`);

    // 2. Links: [text](href) -> <a href="...">text</a>
    formatted = formatted.replace(
        /\[([^\]]+)\]\(([^)]+)\)/g,
        (_, linkText, href) => `<a href="${escapeXml(resolveRelativeLink(href, changelogUrlPath, siteBase))}">${linkText}</a>`
    );

    // 3. Bold: **text** or __text__ -> <strong>text</strong>
    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, (_, boldText) => `<strong>${boldText}</strong>`);
    formatted = formatted.replace(/__([^_]+)__/g, (_, boldText) => `<strong>${boldText}</strong>`);

    return formatted;
}

function bodyToHtml(bodyLines, changelogUrlPath, siteBase) {
    const body = bodyLines.join("\n").trim();
    if (!body) return "";

    const html = body
        .split("\n")
        .map((line) => {
            const heading = line.match(/^###\s+(.*)$/);
            if (heading) return `<h3>${formatInline(heading[1], changelogUrlPath, siteBase)}</h3>`;
            const bullet = line.match(/^\s*-\s+(.*)$/);
            if (bullet) return `<li>${formatInline(bullet[1], changelogUrlPath, siteBase)}</li>`;
            if (!line.trim()) return "";
            return `<p>${formatInline(line, changelogUrlPath, siteBase)}</p>`;
        })
        .join("\n");

    // Wrap consecutive <li> lines in <ul>
    return html.replace(/(<li>[\s\S]*?<\/li>\n?)+/g, (match) => `<ul>\n${match}</ul>\n`);
}

function toRfc822(dateStr) {
    if (!dateStr) return new Date().toUTCString();
    const date = new Date(`${dateStr}T00:00:00Z`);
    return isNaN(date.getTime()) ? new Date().toUTCString() : date.toUTCString();
}

function buildItem(release, changelogUrl, changelogUrlPath, siteBase) {
    const title = release.version ? `v${release.version}` : (release.date || "Release");
    const headingText = release.version && release.date
        ? `${release.version} ${release.date}`
        : (release.version ? `${release.version}` : release.date);
    const anchor = slugify(headingText || "release");
    const guid = release.version && release.date
        ? `${release.version}-${release.date}`
        : (release.version ? `v${release.version}` : (release.date || anchor));
    const link = `${changelogUrl}#${anchor}`;
    const description = bodyToHtml(release.bodyLines, changelogUrlPath, siteBase);

    return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${toRfc822(release.date)}</pubDate>
      <description><![CDATA[${description}]]></description>
    </item>`;
}

function buildFeed(releases, { changelogUrl, feedUrl, title, description, changelogUrlPath, siteBase }) {
    const sorted = [...releases].sort((a, b) => {
        if (a.date && b.date) {
            return new Date(b.date) - new Date(a.date);
        }
        return 0;
    });
    const items = sorted.map(release => buildItem(release, changelogUrl, changelogUrlPath, siteBase)).join("\n");
    const lastBuildDate = new Date().toUTCString();
    const feedTitle = title || "Changelog";
    const feedDescription = description || "Release notes and changelog updates.";

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(feedTitle)}</title>
    <link>${changelogUrl}</link>
    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(feedDescription)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

/**
 * Extracts the pathPrefix value from config.md content.
 * Supports:
 *   - pathPrefix:
 *       - /express/embed-sdk/docs/
 *   - pathPrefix: /express/embed-sdk/docs/
 *   pathPrefix: /express/embed-sdk/docs/
 */
function extractPathPrefix(configContent) {
    if (!configContent) return "";
    const lines = configContent.split(/\r?\n/);
    const keyIndex = lines.findIndex(line => line.includes("pathPrefix:"));
    if (keyIndex === -1) return "";

    const keyLine = lines[keyIndex];
    // Inline value: "pathPrefix: /path/" or "- pathPrefix: /path/"
    const inlineMatch = keyLine.match(/pathPrefix:\s*(?:-\s*)?([^\s#]+)/);
    if (inlineMatch && inlineMatch[1]) {
        return inlineMatch[1].trim().replace(/^['"]|['"]$/g, "");
    }

    // Value on subsequent line(s) starting with "-"
    for (let i = keyIndex + 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        if (line.startsWith("-")) {
            return line.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
        }
        if (line.includes(":") && !line.startsWith("-")) break;
    }
    return "";
}

/**
 * Finds config.md file in standard locations within a repository.
 */
function findConfigFile(rootDir) {
    const candidates = [
        path.join(rootDir, "src", "pages", "config.md"),
        path.join(rootDir, "config.md")
    ];
    for (const p of candidates) {
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            return p;
        }
    }
    return null;
}

/**
 * Discovers the changelog file in a repository.
 * Checks priority locations first, followed by a recursive search in src/pages.
 */
function findChangelogFile(rootDir) {
    const pagesDir = fs.existsSync(path.join(rootDir, "src", "pages"))
        ? path.join(rootDir, "src", "pages")
        : rootDir;

    // 1. Check priority paths under src/pages
    for (const rel of CHANGELOG_CANDIDATE_PATHS) {
        const candidate = path.join(pagesDir, rel);
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    // 2. Check root-level changelog files
    const rootChangelogs = [
        path.join(rootDir, "CHANGELOG.md"),
        path.join(rootDir, "changelog.md")
    ];
    for (const candidate of rootChangelogs) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
        }
    }

    // 3. Fallback: recursive search within pagesDir
    function searchDir(dir, depth = 0) {
        if (depth > 6) return null;
        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (entry.name === "node_modules" || entry.name === ".git") continue;
                    const found = searchDir(fullPath, depth + 1);
                    if (found) return found;
                } else if (entry.isFile() && entry.name.endsWith(".md")) {
                    const lower = entry.name.toLowerCase();
                    const fullLower = fullPath.toLowerCase();
                    if (lower === "changelog.md" ||
                        lower === "release-notes.md" ||
                        lower === "releasenotes.md" ||
                        (lower === "index.md" && (fullLower.includes("changelog") || fullLower.includes("release-notes") || fullLower.includes("releasenotes")))) {
                        return fullPath;
                    }
                }
            }
        } catch (_e) {
            return null;
        }
        return null;
    }

    return searchDir(pagesDir);
}

/**
 * Resolves the site base URL dynamically from:
 * 1. Explicit siteBase option or process.env.SITE_BASE
 * 2. Window URL (passed in options, env.WINDOW_URL, or typeof window !== 'undefined' ? window.location : null)
 * 3. config.md's pathPrefix combined with origin (default: https://developer.adobe.com)
 */
function getSiteBase(options = {}) {
    if (options.siteBase) {
        return options.siteBase.replace(/\/+$/, "");
    }
    if (process.env.SITE_BASE) {
        return process.env.SITE_BASE.replace(/\/+$/, "");
    }

    let origin = process.env.SITE_DOMAIN || "https://developer.adobe.com";
    let windowPathname = "";

    const winUrlStr = options.windowUrl || process.env.WINDOW_URL ||
        (typeof window !== "undefined" && window.location ? window.location.href : null);

    if (winUrlStr) {
        try {
            const parsedUrl = new URL(winUrlStr);
            origin = parsedUrl.origin;
            windowPathname = parsedUrl.pathname;
        } catch (_e) {
            // Invalid URL string, ignore
        }
    }

    // Extract pathPrefix from config.md
    let pathPrefix = "";
    if (options.configContent) {
        pathPrefix = extractPathPrefix(options.configContent);
    } else {
        const configPath = options.configPath || findConfigFile(options.rootDir || process.cwd());
        if (configPath && fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, "utf-8");
            pathPrefix = extractPathPrefix(content);
        }
    }

    if (pathPrefix) {
        const cleanPrefix = pathPrefix.startsWith("/") ? pathPrefix : `/${pathPrefix}`;
        const normalizedPrefix = cleanPrefix.replace(/\/+$/, "");
        return `${origin.replace(/\/+$/, "")}${normalizedPrefix}`;
    }

    // Fallback: strip changelog / guides segments from window pathname if available
    if (winUrlStr && windowPathname) {
        const trimmedPath = windowPathname
            .replace(/\/(?:guides\/)?(?:changelog|release-notes)(?:\/.*)?$/i, "")
            .replace(/\/+$/, "");
        if (trimmedPath) {
            return `${origin.replace(/\/+$/, "")}${trimmedPath}`;
        }
    }

    return origin.replace(/\/+$/, "");
}

/**
 * Extracts feed channel title and description from markdown frontmatter/H1 or config.md.
 */
function extractFeedMetadata(markdown, configContent, customTitle, customDescription) {
    if (customTitle && customDescription) {
        return { title: customTitle, description: customDescription };
    }

    let title = customTitle || "";
    let description = customDescription || "";

    // 1. Try markdown frontmatter & H1
    if (markdown) {
        const fmMatch = markdown.match(/^---\n([\s\S]*?)\n---/);
        if (fmMatch) {
            const fm = fmMatch[1];
            const titleMatch = fm.match(/^title:\s*(.+)$/m);
            const descMatch = fm.match(/^description:\s*(.+)$/m);
            if (!title && titleMatch) title = titleMatch[1].trim().replace(/^['"]|['"]$/g, "");
            if (!description && descMatch) description = descMatch[1].trim().replace(/^['"]|['"]$/g, "");
        }

        if (!title) {
            const h1Match = markdown.match(/^#\s+(.+)$/m);
            if (h1Match) {
                title = h1Match[1].trim();
            }
        }
    }

    // 2. Try config.md
    if (configContent) {
        const lines = configContent.split(/\r?\n/);
        if (!title) {
            const titleIndex = lines.findIndex(l => l.includes("title:"));
            if (titleIndex >= 0) {
                const inlineTitle = lines[titleIndex].match(/title:\s*(?:-\s*)?([^\r\n#]+)/);
                if (inlineTitle && inlineTitle[1].trim()) {
                    title = inlineTitle[1].trim().replace(/^['"]|['"]$/g, "");
                } else if (titleIndex + 1 < lines.length) {
                    const nextLine = lines[titleIndex + 1].trim();
                    if (nextLine.startsWith("-")) {
                        title = nextLine.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
                    }
                }
            }
            if (title && !title.toLowerCase().includes("changelog")) {
                title = `${title} Changelog`;
            }
        }

        if (!description) {
            const descIndex = lines.findIndex(l => l.includes("description:"));
            if (descIndex >= 0) {
                const inlineDesc = lines[descIndex].match(/description:\s*(?:-\s*)?([^\r\n#]+)/);
                if (inlineDesc && inlineDesc[1].trim()) {
                    description = inlineDesc[1].trim().replace(/^['"]|['"]$/g, "");
                } else if (descIndex + 1 < lines.length) {
                    const nextLine = lines[descIndex + 1].trim();
                    if (nextLine.startsWith("-")) {
                        description = nextLine.replace(/^-\s*/, "").trim().replace(/^['"]|['"]$/g, "");
                    }
                }
            }
        }
    }

    if (!title) title = "Changelog";
    if (!description) {
        if (title.toLowerCase() === "changelog") {
            description = "Release notes and changelog updates.";
        } else if (title.toLowerCase().includes("changelog")) {
            const base = title.replace(/\s*Changelog$/i, "").trim();
            description = `Release notes for ${base || title}.`;
        } else {
            description = `Release notes for ${title}.`;
        }
    }

    return { title, description };
}

/**
 * Resolves the root directory of the target repository.
 */
function resolveRootDir(customDir) {
    if (customDir && fs.existsSync(customDir)) {
        return path.resolve(customDir);
    }
    if (process.env.REPO_DIR && fs.existsSync(process.env.REPO_DIR)) {
        return path.resolve(process.env.REPO_DIR);
    }
    if (process.env.GITHUB_WORKSPACE && fs.existsSync(process.env.GITHUB_WORKSPACE)) {
        return path.resolve(process.env.GITHUB_WORKSPACE);
    }

    // Check process.cwd()
    const cwd = process.cwd();
    if (fs.existsSync(path.join(cwd, "src", "pages", "config.md")) ||
        fs.existsSync(path.join(cwd, "config.md"))) {
        return cwd;
    }

    // Check parent of __dirname (if script is inside scripts/ subfolder)
    const parentDir = path.resolve(__dirname, "..");
    if (fs.existsSync(path.join(parentDir, "src", "pages", "config.md")) ||
        fs.existsSync(path.join(parentDir, "config.md"))) {
        return parentDir;
    }

    return cwd;
}

/**
 * Fetches file content from GitHub repository API.
 */
async function fetchRemoteGitHubFile(owner, repo, filePath, token) {
    const headers = {
        "Accept": "application/vnd.github.v3.raw"
    };
    if (token) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`, { headers });
    if (!response.ok) {
        return null;
    }
    return response.text();
}

/**
 * Main generateFeed function.
 * Supports:
 * - Local repository (filesystem-based)
 * - Remote repository via GitHub API (when owner & repo are provided)
 * - GitHub Actions workflow integration via core
 */
async function generateFeed(options = {}) {
    const core = options.core;
    const logInfo = (msg) => {
        if (core && core.info) core.info(msg);
        else console.log(msg);
    };
    const logWarn = (msg) => {
        if (core && core.warning) core.warning(msg);
        else console.warn(msg);
    };

    // Mode A: Remote repository via GitHub API
    if (options.owner && options.repo) {
        const owner = options.owner;
        const repo = options.repo;
        const token = options.githubToken || process.env.GITHUB_TOKEN;

        logInfo(`Checking changelog in remote repository ${owner}/${repo}...`);

        // 1. Fetch config.md to extract pathPrefix
        let configContent = options.configContent || "";
        if (!configContent) {
            configContent = await fetchRemoteGitHubFile(owner, repo, "src/pages/config.md", token) ||
                await fetchRemoteGitHubFile(owner, repo, "config.md", token) || "";
        }

        // 2. Discover changelog file in remote repo
        let changelogPath = "";
        let markdown = "";
        for (const rel of CHANGELOG_CANDIDATE_PATHS) {
            const candidate = `src/pages/${rel}`;
            const content = await fetchRemoteGitHubFile(owner, repo, candidate, token);
            if (content) {
                changelogPath = rel;
                markdown = content;
                break;
            }
        }

        if (!markdown) {
            const rootCandidate = await fetchRemoteGitHubFile(owner, repo, "CHANGELOG.md", token) ||
                await fetchRemoteGitHubFile(owner, repo, "changelog.md", token);
            if (rootCandidate) {
                changelogPath = "changelog";
                markdown = rootCandidate;
            }
        }

        if (!markdown) {
            logInfo(`No changelog file found in ${owner}/${repo}. Skipping feed.xml generation.`);
            if (core && core.setOutput) {
                core.setOutput("feed_generated", "false");
            }
            return { success: true, generated: false, reason: "No changelog file found" };
        }

        // 3. Resolve siteBase and changelogUrl
        const siteBase = getSiteBase({ ...options, configContent });
        const changelogUrlPath = changelogPath.replace(/\/index\.md$/i, "").replace(/\.md$/i, "");
        const changelogUrl = `${siteBase}/${changelogUrlPath}/`;
        const feedUrl = `${siteBase}/feed.xml`;

        const { title, description } = extractFeedMetadata(markdown, configContent, options.title, options.description);
        const releases = parseReleases(markdown);

        if (releases.length === 0) {
            logWarn(`No release headings found in changelog of ${owner}/${repo}. Skipping feed generation.`);
            return { success: true, generated: false, reason: "No release headings found" };
        }

        const feedXml = buildFeed(releases, {
            changelogUrl,
            feedUrl,
            title,
            description,
            changelogUrlPath,
            siteBase
        });

        if (options.outputFile) {
            fs.writeFileSync(options.outputFile, feedXml, "utf-8");
            logInfo(`Wrote ${releases.length} releases to ${options.outputFile}`);
        }

        if (core && core.setOutput) {
            core.setOutput("feed_generated", "true");
            core.setOutput("feed_xml", feedXml);
            core.setOutput("releases_count", releases.length.toString());
        }

        return { success: true, generated: true, releasesCount: releases.length, feedXml };
    }

    // Mode B: Local repository filesystem
    const rootDir = resolveRootDir(options.rootDir);
    const pagesDir = fs.existsSync(path.join(rootDir, "src", "pages"))
        ? path.join(rootDir, "src", "pages")
        : rootDir;

    // 1. Check if repository has a changelog file first
    const changelogFile = options.changelogFile || findChangelogFile(rootDir);

    if (!changelogFile || !fs.existsSync(changelogFile)) {
        logInfo(`No changelog file found in repository (${rootDir}). Skipping feed.xml generation.`);
        if (core && core.setOutput) {
            core.setOutput("feed_generated", "false");
        }
        return { success: true, generated: false, reason: "No changelog file found" };
    }

    logInfo(`Found changelog file: ${path.relative(rootDir, changelogFile)}`);

    // 2. Fetch/read changelog content
    const markdown = fs.readFileSync(changelogFile, "utf-8");

    // 3. Resolve config.md and siteBase
    const configPath = options.configPath || findConfigFile(rootDir);
    let configContent = options.configContent || "";
    if (!configContent && configPath && fs.existsSync(configPath)) {
        configContent = fs.readFileSync(configPath, "utf-8");
    }

    const siteBase = getSiteBase({ ...options, rootDir, configPath, configContent });

    // 4. Calculate relative changelog url path
    const relFromPages = path.relative(pagesDir, changelogFile).replace(/\\/g, "/");
    const changelogUrlPath = relFromPages
        .replace(/\/index\.md$/i, "")
        .replace(/\.md$/i, "");

    const changelogUrl = `${siteBase}/${changelogUrlPath}/`;
    const feedUrl = `${siteBase}/feed.xml`;
    const feedFile = options.feedFile || path.join(pagesDir, "feed.xml");

    // 5. Parse releases and extract metadata
    const { title, description } = extractFeedMetadata(markdown, configContent, options.title, options.description);
    const releases = parseReleases(markdown);

    if (releases.length === 0) {
        logWarn(`No release headings found in ${changelogFile}. Skipping feed.xml generation.`);
        if (core && core.setOutput) {
            core.setOutput("feed_generated", "false");
        }
        return { success: true, generated: false, reason: "No release headings found" };
    }

    // 6. Build and write feed.xml
    const feedXml = buildFeed(releases, {
        changelogUrl,
        feedUrl,
        title,
        description,
        changelogUrlPath,
        siteBase
    });

    fs.writeFileSync(feedFile, feedXml, "utf-8");
    logInfo(`Wrote ${releases.length} releases to ${path.relative(rootDir, feedFile)}`);

    if (core && core.setOutput) {
        core.setOutput("feed_generated", "true");
        core.setOutput("feed_file", feedFile);
        core.setOutput("releases_count", releases.length.toString());
        core.setOutput("site_base", siteBase);
        core.setOutput("changelog_url", changelogUrl);
        core.setOutput("feed_url", feedUrl);
    }

    return {
        success: true,
        generated: true,
        releasesCount: releases.length,
        feedFile,
        changelogFile,
        siteBase,
        changelogUrl,
        feedUrl
    };
}

/**
 * CLI argument parser
 */
function parseArgs(args) {
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--dir" || arg === "-d") {
            parsed.rootDir = args[++i];
        } else if (arg === "--site-base" || arg === "-s") {
            parsed.siteBase = args[++i];
        } else if (arg === "--window-url" || arg === "-u" || arg === "--url") {
            parsed.windowUrl = args[++i];
        } else if (arg === "--owner" || arg === "-o") {
            parsed.owner = args[++i];
        } else if (arg === "--repo" || arg === "-r") {
            parsed.repo = args[++i];
        } else if (arg === "--token" || arg === "-t") {
            parsed.githubToken = args[++i];
        } else if (arg === "--output" || arg === "--out") {
            parsed.outputFile = args[++i];
        } else if (!arg.startsWith("-") && !parsed.rootDir) {
            parsed.rootDir = arg;
        }
    }
    return parsed;
}

// Module export and CLI execution
generateFeed.parseReleases = parseReleases;
generateFeed.buildFeed = buildFeed;
generateFeed.extractPathPrefix = extractPathPrefix;
generateFeed.getSiteBase = getSiteBase;
generateFeed.findConfigFile = findConfigFile;
generateFeed.findChangelogFile = findChangelogFile;
generateFeed.extractFeedMetadata = extractFeedMetadata;
generateFeed.resolveRootDir = resolveRootDir;

module.exports = generateFeed;

if (require.main === module) {
    const cliOptions = parseArgs(process.argv.slice(2));
    generateFeed(cliOptions).catch((err) => {
        console.error("Error generating feed:", err);
        process.exit(1);
    });
}
