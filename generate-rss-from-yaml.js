/**
 * Builds an RSS 2.0 feed from a YAML changelog (e.g. src/pages/guides/changelog/changelog-data.yaml).
 *
 * The YAML's `rssfeed` key says where the feed lives, e.g.
 *   rssfeed: "https://raw.githubusercontent.com/AdobeDocs/cc-everywhere/refs/heads/main/src/pages/guides/changelog/feed.xml"
 * -> the feed is meant for src/pages/guides/changelog/feed.xml, and that URL is the feed's atom:link (self).
 * Without `rssfeed`, the feed goes to `feedFilePath` (the workflow's feedPath input).
 *
 * An optional changelog-settings.yaml next to the data file supplies the page description and kind labels.
 *
 * The markdown helpers (links, assets, escaping) are shared with generate-rss-feed.js.
 */
const path = require("path");
const { parseYaml } = require("./yaml-parser.js");
const {
    fetchFileContent,
    extractPathPrefix,
    escapeXml,
    unescapeXml,
    resolveAssetUrl,
    resolveLink,
    slugify,
    SITE_ORIGIN,
    PAGES_DIR,
    CONFIG_PATH
} = require("./generate-rss-feed.js");

const DEFAULT_FEED_PATH = "src/pages/feed.xml";

// Order here is the order sections appear in each feed item
const TYPE_HEADINGS = {
    breaking: "Breaking Changes",
    removed: "Removed",
    deprecated: "Deprecated",
    new: "Added",
    improved: "Improved",
    fixed: "Fixed",
    docs: "Documentation",
};

async function getYamlChangeLogXmlContent(owner, repo, githubToken, changeLogFilePath, feedFilePath = DEFAULT_FEED_PATH, ref) {
    const content = await fetchFileContent(owner, repo, githubToken, changeLogFilePath, ref);
    if (!content) {
        return null;
    }

    const data = toObject(parseYaml(content));
    if (!Array.isArray(data.releases) || !data.releases.length) {
        console.warn(`No releases found in ${changeLogFilePath}`);
        return null;
    }

    const normalizedChangeLogPath = changeLogFilePath.replace(/\\/g, "/");
    const changelogRepoDir = path.posix.dirname(normalizedChangeLogPath);
    const settingsPath = `${changelogRepoDir}/changelog-settings.yaml`;
    const settings = toObject(parseYaml(await fetchFileContent(owner, repo, githubToken, settingsPath, ref) || ""));

    const configContent = await fetchFileContent(owner, repo, githubToken, CONFIG_PATH, ref);
    const siteBase = `${SITE_ORIGIN}${extractPathPrefix(configContent)}`;

    const branch = ref ? ref.replace(/^refs\/heads\//, "") : "main";
    const repoRawBaseUrl = (owner && repo) ? `https://raw.githubusercontent.com/${owner}/${repo}/${branch}` : "";

    // "src/pages/guides/changelog/changelog-data.yaml" -> page dir "guides/changelog"
    const changelogDir = changelogRepoDir.replace(/^src\/pages\/?/, "");
    const changelogUrl = `${siteBase}/${changelogDir}/`;

    const rssfeed = data.rssfeed ? String(data.rssfeed).trim() : "";
    const target = resolveFeedTarget(rssfeed, siteBase, feedFilePath, repoRawBaseUrl);

    const xmlContent = buildFeed(data.releases, {
        title: data.title || settings.page?.title || "Changelog",
        description: data.description || settings.page?.description || "Release notes and changelog updates.",
        modules: data.modules || {},
        kinds: settings.kinds || data.kinds || {},
        siteBase,
        rawBaseUrl: target.rawBaseUrl,
        changelogDir,
        changelogRepoDir,
        changelogUrl,
        feedUrl: target.feedUrl,
    });

    return { xmlContent, feedPath: target.feedPath };
}

function toObject(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * Works out where the feed is written in the repo, its public URL and the raw GitHub base
 * used for static assets, from the `rssfeed` value.
 *
 * Supported forms:
 *   https://raw.githubusercontent.com/<owner>/<repo>/refs/heads/<branch>/<repo path>
 *   https://raw.githubusercontent.com/<owner>/<repo>/<branch>/<repo path>
 *   https://developer.adobe.com/<pathPrefix>/<page path>   -> src/pages/<page path>
 *   src/pages/feed.xml (a plain repo-relative path)
 */
function resolveFeedTarget(rssfeed, siteBase, defaultFeedPath = DEFAULT_FEED_PATH, repoRawBaseUrl = "") {
    const target = resolveFeedLocation(rssfeed, siteBase, defaultFeedPath, repoRawBaseUrl);

    // The path comes from repo content and is written by the workflow, so keep it inside src/pages
    const feedPath = path.posix.normalize(target.feedPath);
    if (!feedPath.startsWith(PAGES_DIR) || !/\.xml$/i.test(feedPath)) {
        throw new Error(`rssfeed must point to an .xml file under ${PAGES_DIR}, got "${target.feedPath}".`);
    }
    return { ...target, feedPath };
}

function resolveFeedLocation(rssfeed, siteBase, defaultFeedPath, repoRawBaseUrl) {
    const toRepoPath = value => value.replace(/\\/g, "/").replace(/^\/+/, "");
    const urlFor = repoPath => repoRawBaseUrl
        ? `${repoRawBaseUrl}/${repoPath}`
        : `${siteBase}/${repoPath.replace(PAGES_DIR, "")}`;

    if (!rssfeed) {
        const feedPath = toRepoPath(defaultFeedPath || DEFAULT_FEED_PATH);
        return { feedPath, feedUrl: urlFor(feedPath), rawBaseUrl: repoRawBaseUrl };
    }

    const raw = rssfeed.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/(?:refs\/heads\/)?([^/]+)\/(.+)$/i);
    if (raw) {
        const [, owner, repo, branch, repoPath] = raw;
        return {
            feedPath: repoPath,
            feedUrl: rssfeed,
            rawBaseUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`
        };
    }

    if (rssfeed.startsWith(`${siteBase}/`)) {
        return {
            feedPath: `${PAGES_DIR}${rssfeed.slice(siteBase.length + 1)}`,
            feedUrl: rssfeed,
            rawBaseUrl: repoRawBaseUrl
        };
    }

    if (!/^[a-z][a-z0-9+.-]*:/i.test(rssfeed)) {
        const feedPath = toRepoPath(rssfeed);
        return { feedPath, feedUrl: urlFor(feedPath), rawBaseUrl: repoRawBaseUrl };
    }

    throw new Error(`Cannot map rssfeed "${rssfeed}" to a file in this repository.`);
}

function formatInline(text, ctx) {
    const { changelogDir, siteBase, rawBaseUrl, changelogRepoDir } = ctx;
    const link = href => resolveLink(unescapeXml(href), changelogDir, siteBase, rawBaseUrl, changelogRepoDir);
    const asset = src => resolveAssetUrl(unescapeXml(src), changelogRepoDir, rawBaseUrl, siteBase);

    // code spans are swapped out first so their content is not treated as markdown
    const codeSpans = [];
    let formatted = String(text ?? "").replace(/`([^`]+)`/g, (_, code) => {
        codeSpans.push(`<code>${escapeXml(code)}</code>`);
        return `\u0000${codeSpans.length - 1}\u0000`;
    });

    formatted = escapeXml(formatted);

    // Linked images: [![alt](imgSrc)](linkHref)
    formatted = formatted.replace(
        /\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g,
        (_, alt, imgSrc, linkHref) =>
            `<a href="${escapeXml(link(linkHref))}"><img src="${escapeXml(asset(imgSrc))}" alt="${alt}" /></a>`
    );

    // Standalone images: ![alt](imgSrc)
    formatted = formatted.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g,
        (_, alt, imgSrc) => `<img src="${escapeXml(asset(imgSrc))}" alt="${alt}" />`);

    // Regular links: [linkText](href)
    formatted = formatted.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,
        (_, linkText, href) => `<a href="${escapeXml(link(href))}">${linkText}</a>`);

    formatted = formatted.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    formatted = formatted.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    formatted = formatted.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>");

    return formatted.replace(/\u0000(\d+)\u0000/g, (_, index) => codeSpans[index]);
}

// `list: |` block -> <ul>; each non-empty line is an item (a leading "-" / "*" is optional)
function formatList(listText, ctx) {
    const items = String(listText)
        .split("\n")
        .map(line => line.trim().replace(/^[-*]\s+/, ""))
        .filter(Boolean);
    if (!items.length) return "";
    return `<ul>\n${items.map(item => `<li>${formatInline(item, ctx)}</li>`).join("\n")}\n</ul>`;
}

// `code: |` block -> <pre><code>
function formatCode(codeText, language) {
    const code = String(codeText).replace(/\n+$/, "");
    if (!code) return "";
    const langAttr = language ? ` class="language-${escapeXml(language)}"` : "";
    return `<pre><code${langAttr}>${escapeXml(code)}</code></pre>`;
}

function typeKeys(rawType) {
    return String(rawType || "")
        .split(",")
        .map(part => part.trim().toLowerCase())
        .filter(Boolean);
}

function formatTypeHeading(rawType) {
    const parts = typeKeys(rawType);
    if (!parts.length) return "Updates";
    return parts
        .map(part => TYPE_HEADINGS[part] || part.replace(/\b\w/g, ch => ch.toUpperCase()))
        .join(", ");
}

function formatChangeItem(change, ctx) {
    let html = formatInline(change.text || "", ctx);

    const moduleLabels = (Array.isArray(change.modules) ? change.modules : [])
        .map(id => ctx.modules[id] || id)
        .filter(Boolean);
    if (moduleLabels.length) {
        html += ` <em>(${escapeXml(moduleLabels.join(", "))})</em>`;
    }
    if (change.action) {
        html += ` <strong>Action:</strong> ${formatInline(change.action, ctx)}`;
    }
    if (change.open) {
        html += " <em>(Still open)</em>";
    }
    if (change.list) {
        const list = formatList(change.list, ctx);
        if (list) html += `\n${list}`;
    }
    if (change.code) {
        const code = formatCode(change.code, change.language || change.lang);
        if (code) html += `\n${code}`;
    }
    return `<li>${html}</li>`;
}

function buildChangesHtml(changes, ctx) {
    // Group by heading; known types follow TYPE_HEADINGS order, unknown ones keep YAML order
    const order = Object.keys(TYPE_HEADINGS);
    const groups = new Map();
    for (const change of changes) {
        const heading = formatTypeHeading(change.type);
        if (!groups.has(heading)) {
            const rank = order.indexOf(typeKeys(change.type)[0]);
            groups.set(heading, { rank: rank < 0 ? order.length : rank, items: [] });
        }
        groups.get(heading).items.push(change);
    }

    return [...groups.entries()]
        .sort((a, b) => a[1].rank - b[1].rank)
        .map(([heading, { items }]) =>
            `<h3>${escapeXml(heading)}</h3>\n<ul>\n${items.map(c => formatChangeItem(c, ctx)).join("\n")}\n</ul>`)
        .join("\n");
}

function buildDescriptionHtml(release, ctx) {
    const blocks = [];
    if (release.title) {
        blocks.push(`<p><strong>${formatInline(release.title, ctx)}</strong></p>`);
    }
    if (release.summary) {
        if (release.breaking) blocks.push("<h3>Breaking Changes</h3>");
        blocks.push(`<p>${formatInline(release.summary, ctx)}</p>`);
    }
    if (Array.isArray(release.changes) && release.changes.length) {
        blocks.push(buildChangesHtml(release.changes, ctx));
    }
    if (!blocks.length) {
        const kindLabel = ctx.kinds[release.kind] || "Maintenance";
        blocks.push(`<p>${escapeXml(kindLabel)} release.</p>`);
    }
    return blocks.join("\n");
}

function normalizeDate(value) {
    if (!value) return null;
    const match = String(value).match(/\d{4}-\d{2}-\d{2}/);
    return match ? match[0] : null;
}

function buildItem(release, ctx) {
    const version = release.version ? String(release.version).replace(/^v/i, "") : null;
    const date = normalizeDate(release.date);

    const title = version ? `v${version}` : (release.title || date || "Update");

    // Anchor matching the rendered changelog heading, e.g. "## [v4.58.15] 2026-10-21"
    let anchor;
    if (version) {
        anchor = slugify(`v${version} ${date || ""}`);
    } else if (date) {
        anchor = date.replace(/^\d{4}-/, "");
    } else {
        anchor = slugify(title);
    }

    const guid = [version, date].filter(Boolean).join("-") || slugify(title);
    const link = anchor ? `${ctx.changelogUrl}#${anchor}` : ctx.changelogUrl;
    const pubDate = date ? new Date(`${date}T00:00:00Z`).toUTCString() : null;
    const description = buildDescriptionHtml(release, ctx).replace(/]]>/g, "]]]]><![CDATA[>");

    return `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(guid)}</guid>${pubDate ? `\n      <pubDate>${pubDate}</pubDate>` : ""}
      <description><![CDATA[${description}]]></description>
    </item>`;
}

function buildFeed(releases, ctx) {
    // Newest first; releases without a date keep their YAML order
    const sorted = releases
        .map((release, index) => ({ release, index, date: normalizeDate(release.date) }))
        .sort((a, b) => (a.date && b.date ? b.date.localeCompare(a.date) : 0) || a.index - b.index)
        .map(entry => entry.release);

    const items = sorted.map(release => buildItem(release, ctx)).join("\n");
    const newestDate = sorted.map(r => normalizeDate(r.date)).find(Boolean);
    const lastBuildDate = newestDate
        ? new Date(`${newestDate}T00:00:00Z`).toUTCString()
        : new Date().toUTCString();

    return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(ctx.title)}</title>
    <link>${escapeXml(ctx.changelogUrl)}</link>
    <atom:link href="${escapeXml(ctx.feedUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(ctx.description)}</description>
    <language>en-us</language>
    <lastBuildDate>${lastBuildDate}</lastBuildDate>
${items}
  </channel>
</rss>
`;
}

module.exports = {
    getYamlChangeLogXmlContent,
    resolveFeedTarget,
    buildFeed
}
