const path = require("path");

const SITE_ORIGIN = "https://developer.adobe.com";
const PAGES_DIR = "src/pages/";
const CONFIG_PATH = "src/pages/config.md";
const STATIC_ASSET_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|xml|json|mp4|webm|mov)$/i;

// "## [v4.57.22] 2026-10-08", "## [4.54.18] 2026-09-02", "## [4.16.11] - 2024-11-18", "## 2025-11-14"
const RELEASE_HEADING_RE = /^##\s+(?:\[?\s*(v?[\d.]+)\s*\]?\s*[-–—]?\s*)?\(?(\d{4}-\d{2}-\d{2})\)?\s*$/i;
// "### Added", "### Fixed", "### Documentation"
const SECTION_HEADING_RE = /^###\s+(.+?)\s*$/;

async function fetchFileContent(owner, repo, githubToken, filePath, ref) {
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const response = await fetch(apiUrl, {
        headers: {
            'Accept': 'application/vnd.github.v3.raw',
            'Authorization': `Bearer ${githubToken}`
        }
    });

    const content = await response.text();
    if (!response.ok) {
        console.warn(`Failed to fetch content for ${filePath}: ${response.status}`);
        return null;
    }

    return content;
}

async function getChangeLogXmlContent(owner, repo, githubToken, changeLogFilePath, feedFilePath = "src/pages/feed.xml", ref) {
    const content = await fetchFileContent(owner, repo, githubToken, changeLogFilePath, ref);
    if (!content) {
        return null;
    }

    const releases = parseReleases(content);
    if (!releases.length) {
        console.warn(`No release headings found in ${changeLogFilePath}`);
        return null;
    }

    const configContent = await fetchFileContent(owner, repo, githubToken, CONFIG_PATH, ref);
    const siteBase = `${SITE_ORIGIN}${extractPathPrefix(configContent)}`;

    const branch = ref ? ref.replace(/^refs\/heads\//, "") : "main";
    const rawBaseUrl = (owner && repo) ? `https://raw.githubusercontent.com/${owner}/${repo}/${branch}` : "";

    // "src/pages/guides/changelog/index.md" -> page "guides/changelog", links resolve from "guides/changelog"
    const normalizedChangeLogPath = changeLogFilePath.replace(/\\/g, "/");
    const changelogRepoDir = path.posix.dirname(normalizedChangeLogPath);
    const pagePath = normalizedChangeLogPath.replace(PAGES_DIR, "");
    const changelogDir = path.posix.dirname(pagePath);
    const changelogUrl = `${siteBase}/${pagePath.replace(/(\/?index)?\.md$/i, "")}/`;

    const cleanFeedPath = feedFilePath.replace(/\\/g, "/");
    const feedUrl = rawBaseUrl
        ? `${rawBaseUrl}/${cleanFeedPath}`
        : `${siteBase}/${cleanFeedPath.replace(PAGES_DIR, "")}`;

    const { title, description } = extractFeedMetadata(content);

    return buildFeed(releases, {
        title,
        description,
        changelogUrl,
        feedUrl,
        changelogDir,
        siteBase,
        rawBaseUrl,
        changelogRepoDir
    });
}

function extractFeedMetadata(markdown) {
    let title = "";
    let description = "";

    if (markdown) {
        const fmMatch = markdown.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
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

// Returns the config.md pathPrefix without trailing slash, e.g. "/express/embed-sdk/docs"
function extractPathPrefix(configContent) {
    if (!configContent) return "";
    const lines = configContent.split(/\r?\n/);
    const keyIndex = lines.findIndex(line => line.includes("pathPrefix:"));
    if (keyIndex < 0) return "";

    const inline = lines[keyIndex].split("pathPrefix:")[1].trim();
    const nextValue = lines.slice(keyIndex + 1).find(line => line.trimStart().startsWith("-")) ?? "";
    const pathPrefix = (inline || nextValue.trimStart().substring(1)).trim().replace(/^['"]|['"]$/g, "");

    return pathPrefix.replace(/\/+$/, "");
}

// Splits the changelog into releases (## version date), each with its sections (### Added, ### Fixed, ...)
function parseReleases(markdown) {
    const lines = markdown
        .replace(/\r\n/g, "\n")
        .replace(/^---\n[\s\S]*?\n---\n/, "")
        .split("\n");
    const releases = [];
    let release = null;
    let section = null;

    for (const line of lines) {
        const releaseMatch = line.match(RELEASE_HEADING_RE);
        if (releaseMatch) {
            // lines before the first ### of a release go into an untitled section
            section = { title: null, lines: [] };
            const rawVersion = releaseMatch[1] || null;
            const version = rawVersion ? rawVersion.replace(/^v/i, "").trim() : null;
            release = { version, rawVersion, date: releaseMatch[2], sections: [section] };
            releases.push(release);
            continue;
        }
        if (!release) continue;

        const sectionMatch = line.match(SECTION_HEADING_RE);
        if (sectionMatch) {
            section = { title: sectionMatch[1], lines: [] };
            release.sections.push(section);
        } else {
            section.lines.push(line);
        }
    }

    return releases;
}

function escapeXml(text) {
    if (!text) return "";
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function unescapeXml(text) {
    if (!text) return "";
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"');
}

function resolveAssetUrl(src, changelogRepoDir, rawBaseUrl, siteBase) {
    if (!src) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
        return src;
    }

    let repoRelativePath = "";
    if (src.startsWith("/")) {
        const clean = src.replace(/^\/+/, "");
        repoRelativePath = clean.startsWith("src/pages/") ? clean : path.posix.join("src/pages", clean);
    } else {
        repoRelativePath = path.posix.normalize(path.posix.join(changelogRepoDir || "", src));
    }

    if (rawBaseUrl) {
        return `${rawBaseUrl}/${repoRelativePath}`;
    }

    const pageRelative = repoRelativePath.replace(/^src\/pages\//, "");
    return `${siteBase}/${pageRelative}`;
}

function resolveLink(href, changelogDir, siteBase, rawBaseUrl, changelogRepoDir) {
    if (!href) return "";
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#") || href.startsWith("//")) {
        return href;
    }

    const [file, hash] = href.split("#");

    // Static assets (.png, .pdf, .zip, etc.) must resolve to raw GitHub URL since EDS only publishes .md/.json
    if (file && STATIC_ASSET_EXTENSIONS.test(file)) {
        const assetUrl = resolveAssetUrl(file, changelogRepoDir, rawBaseUrl, siteBase);
        return hash ? `${assetUrl}#${hash}` : assetUrl;
    }

    if (href.startsWith("/")) {
        return `${SITE_ORIGIN}${href}`;
    }

    const resolved = path.posix
        .join(changelogDir, file)
        .replace(/(^|\/)index\.md$/i, "$1")
        .replace(/\.md$/i, "/");
    return `${siteBase}/${resolved}${hash ? `#${hash}` : ""}`;
}

function formatInline(text, changelogDir, siteBase, rawBaseUrl, changelogRepoDir) {
    // code spans are swapped out first so their content is not treated as markdown
    const codeSpans = [];
    let formatted = text.replace(/`([^`]+)`/g, (_, code) => {
        codeSpans.push(`<code>${escapeXml(code)}</code>`);
        return `\u0000${codeSpans.length - 1}\u0000`;
    });

    formatted = escapeXml(formatted);

    // Linked images: [![alt](imgSrc)](linkHref)
    formatted = formatted.replace(
        /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g,
        (_, alt, imgSrc, linkHref) => {
            const resolvedLink = resolveLink(unescapeXml(linkHref), changelogDir, siteBase, rawBaseUrl, changelogRepoDir);
            const resolvedImg = resolveAssetUrl(unescapeXml(imgSrc), changelogRepoDir, rawBaseUrl, siteBase);
            return `<a href="${escapeXml(resolvedLink)}"><img src="${escapeXml(resolvedImg)}" alt="${alt}" /></a>`;
        }
    );

    // Standalone images: ![alt](imgSrc)
    formatted = formatted.replace(
        /!\[([^\]]*)\]\(([^)\s]+)\)/g,
        (_, alt, imgSrc) => {
            const resolvedImg = resolveAssetUrl(unescapeXml(imgSrc), changelogRepoDir, rawBaseUrl, siteBase);
            return `<img src="${escapeXml(resolvedImg)}" alt="${alt}" />`;
        }
    );

    // Regular links: [linkText](href)
    formatted = formatted.replace(
        /\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, linkText, href) => {
            const resolvedLink = resolveLink(unescapeXml(href), changelogDir, siteBase, rawBaseUrl, changelogRepoDir);
            return `<a href="${escapeXml(resolvedLink)}">${linkText}</a>`;
        }
    );

    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/__([^_]+)__/g, "<strong>$1</strong>");

    return formatted.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[index]);
}

function sectionToHtml(section, changelogDir, siteBase, rawBaseUrl, changelogRepoDir) {
    const html = [];
    if (section.title) {
        html.push(`<h3>${formatInline(section.title, changelogDir, siteBase, rawBaseUrl, changelogRepoDir)}</h3>`);
    }

    let inList = false;
    for (const line of section.lines) {
        const bullet = line.match(/^\s*[-*]\s+(.*)$/);
        if (bullet) {
            if (!inList) html.push("<ul>");
            inList = true;
            html.push(`<li>${formatInline(bullet[1], changelogDir, siteBase, rawBaseUrl, changelogRepoDir)}</li>`);
            continue;
        }
        if (!line.trim()) continue;
        if (inList) html.push("</ul>");
        inList = false;
        html.push(`<p>${formatInline(line.trim(), changelogDir, siteBase, rawBaseUrl, changelogRepoDir)}</p>`);
    }
    if (inList) html.push("</ul>");

    return html.join("\n");
}

function slugify(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/\./g, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

function buildItem(release, { changelogUrl, changelogDir, siteBase, rawBaseUrl, changelogRepoDir }) {
    const title = release.version ? `v${release.version}` : release.date;

    // Anchor ID generation matching AEM EDS:
    let anchor = "";
    if (release.rawVersion && /^v/i.test(release.rawVersion)) {
        anchor = slugify(`${release.rawVersion} ${release.date}`);
    } else if (release.rawVersion) {
        anchor = release.date;
    } else if (release.date) {
        anchor = release.date.replace(/^\d{4}-/, "");
    }

    const guid = [release.version, release.date].filter(Boolean).join("-");
    const link = anchor ? `${changelogUrl}#${anchor}` : changelogUrl;
    const description = release.sections
        .map(section => sectionToHtml(section, changelogDir, siteBase, rawBaseUrl, changelogRepoDir))
        .filter(Boolean)
        .join("\n")
        .replace(/]]>/g, "]]]]><![CDATA[>");

    return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>
      <pubDate>${new Date(`${release.date}T00:00:00Z`).toUTCString()}</pubDate>
      <description><![CDATA[${description}]]></description>
    </item>`;
}

function buildFeed(releases, options) {
    const { title, description, changelogUrl, feedUrl } = options;
    // newest first; releases sharing a date keep their changelog order
    const sorted = [...releases].sort((a, b) => b.date.localeCompare(a.date));
    const items = sorted.map(release => buildItem(release, options)).join("\n");
    // taken from the newest release instead of "now", so an unchanged changelog always produces an identical feed
    const lastBuildDate = new Date(`${sorted[0].date}T00:00:00Z`).toUTCString();

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(changelogUrl)}</link>
    <atom:link href="${escapeXml(feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

module.exports = {
    getChangeLogXmlContent,
    extractFeedMetadata,
    extractPathPrefix,
    parseReleases,
    buildFeed
}
