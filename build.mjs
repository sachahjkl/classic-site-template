// Builds the classic site into dist/: every fragment of pages/ in the classic frame (header line, nav line,
// footer line from site.json), the home's NEWS column from the newest entries of news/, a news page with all of
// them, the logo and favicons (logo.mjs, from site.json's "logo"), assets/ copied as it is, then checks every
// internal link and anchor of dist/. Plain Node >= 20, no packages: node build.mjs
// Exits non-zero when site.json, a news entry or a link is wrong.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, rmSync, cpSync, existsSync } from "node:fs";
import { join, dirname, extname, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { makeLogo, readLogo, LOGO_FILES } from "./logo.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, "dist");
const PAGES = join(ROOT, "pages");
const NEWS = join(ROOT, "news");
const ASSETS = join(ROOT, "assets");
const THEME_CSS = join(ROOT, "theme", "classic.css");

const NEWS_ON_HOME = 3;                // how many entries the home's NEWS column shows
const HOME_PAGE = "index.html";
const NEWS_PAGE = "news.html";
const FACTS_MARKER = "<!-- facts -->"; // where a page fragment wants the facts table
const LOGO_SIZE = 48;                  // px, the header's logo (theme/classic.css draws it at that size)
const FAVICON_PNG_SIZE = 32;           // the PNG favicon, beside favicon.ico and the SVG one
const TOUCH_ICON_SIZE = 256;           // the icon a phone puts on its home screen
const NEWS_FILE = /^(\d{4}-\d{2}-\d{2})-([a-z0-9-]+)\.json$/; // news/2026-10-28-release-1-2.json

const failures = [];
const fail = (message) => failures.push(message);

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const stripTags = (html) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
const isExternal = (href) => /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//");

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (e) { fail(`${path}: ${e.message}`); return null; }
}

// site.json: the fields a page needs, checked once so a typo says where it is.
function loadSite() {
  const site = readJson(join(ROOT, "site.json"));
  if (!site) return null;
  for (const key of ["name", "tagline"]) if (typeof site[key] !== "string" || !site[key]) fail(`site.json: "${key}" is missing`);
  for (const key of ["nav", "facts"]) if (!Array.isArray(site[key])) fail(`site.json: "${key}" must be a list`);
  if (!site.footer || !Array.isArray(site.footer.links)) fail(`site.json: "footer.links" must be a list`);
  return site;
}

// news/: one JSON file per entry, its date and anchor from its name, newest first.
function loadNews() {
  const entries = [];
  for (const file of readdirSync(NEWS).sort()) {
    const match = NEWS_FILE.exec(file);
    if (!match) { fail(`news/${file}: the name must be YYYY-MM-DD-some-words.json`); continue; }
    const entry = readJson(join(NEWS, file));
    if (!entry) continue;
    if (typeof entry.title !== "string" || typeof entry.text !== "string") { fail(`news/${file}: "title" and "text" are needed`); continue; }
    entries.push({ date: match[1], id: `news-${match[1]}-${match[2]}`, title: entry.title, link: entry.link, text: entry.text });
  }
  return entries.reverse();
}

const navLine = (site, page) => site.nav
  .map(({ label, href }) => `<a href="${escape(href)}"${href === page ? ' aria-current="page"' : ""}>${escape(label)}</a>`)
  .join('\n<span class="sep" aria-hidden="true">-</span>');

function footerLine(site) {
  const links = [...site.footer.links];
  if (site.modern) links.push({ label: "Modern version", href: site.modern });
  return [site.footer.text ?? "", ...links.map(({ label, href }) => `- <a href="${escape(href)}">${escape(label)}</a>`)].join("\n");
}

function factsTable(facts) {
  const rows = facts.map(({ number, unit, text }) =>
    `<tr><td class="n">${escape(number)}</td><td class="u">${escape(unit ?? "")}</td><td>${escape(text)}</td></tr>`);
  return `<div class="table-box"><table class="facts"><tbody>\n${rows.join("\n")}\n</tbody></table></div>`;
}

// An entry: its date, its title (a link to its page, or to its place on the news page), its text (HTML).
function newsItem(entry, attributes = "") {
  const href = entry.link ?? `${NEWS_PAGE}#${entry.id}`;
  return `<div class="item"${attributes}>
<time class="date" datetime="${entry.date}">${entry.date}</time>: <a href="${escape(href)}">${escape(entry.title)}</a><br>
${entry.text}
</div>`;
}

function newsColumn(news) {
  return `<aside aria-labelledby="news">
<h2 id="news">News</h2>
${news.slice(0, NEWS_ON_HOME).map((entry) => newsItem(entry)).join("\n")}
<p><a class="all" href="${NEWS_PAGE}">- all news -</a></p>
</aside>`;
}

function frame(site, page, title, body) {
  return `<!doctype html>
<html lang="${escape(site.lang ?? "en")}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escape(title)}</title>
<meta name="description" content="${escape(site.description ?? site.tagline)}">
<link rel="icon" href="${LOGO_FILES.ico}" sizes="any">
<link rel="icon" type="image/png" sizes="${FAVICON_PNG_SIZE}x${FAVICON_PNG_SIZE}" href="${LOGO_FILES.png(FAVICON_PNG_SIZE)}">
<link rel="icon" type="image/svg+xml" href="${LOGO_FILES.svg}">
<link rel="apple-touch-icon" href="${LOGO_FILES.png(TOUCH_ICON_SIZE)}">
<link rel="stylesheet" href="classic.css">
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="page">
<header class="masthead">
<img src="${LOGO_FILES.svg}" alt="" width="${LOGO_SIZE}" height="${LOGO_SIZE}">
<a class="name" href="${HOME_PAGE}">${escape(site.name)}</a>
<span class="tagline">${escape(site.tagline)}</span>
</header>
<nav class="site" aria-label="Site">
${navLine(site, page)}
</nav>
${body}
<footer class="foot">
${footerLine(site)}
</footer>
</div>
</body>
</html>
`;
}

// A page's title: its first <h1>, then the site's name; the home's is the name and the tagline.
function pageTitle(site, page, fragment) {
  if (page === HOME_PAGE) return `${site.name} - ${site.tagline}`;
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(fragment);
  if (!h1) fail(`pages/${page}: no <h1>`);
  return h1 ? `${stripTags(h1[1])} - ${site.name}` : site.name;
}

function buildPages(site, news) {
  const pages = readdirSync(PAGES).filter((f) => extname(f) === ".html");
  if (!pages.includes(HOME_PAGE)) fail(`pages/${HOME_PAGE} is missing`);
  if (pages.includes(NEWS_PAGE)) fail(`pages/${NEWS_PAGE}: that name is the generated news page`);
  for (const page of pages) {
    const fragment = readFileSync(join(PAGES, page), "utf8").replace(FACTS_MARKER, () => factsTable(site.facts));
    const main = `<main id="main">\n${fragment.trim()}\n</main>`;
    const body = page === HOME_PAGE ? `<div class="columns">\n${main}\n${newsColumn(news)}\n</div>` : main;
    writeFileSync(join(OUT, page), frame(site, page, pageTitle(site, page, fragment), body));
  }
  const list = news.map((entry) => newsItem(entry, ` id="${entry.id}"`)).join("\n");
  const main = `<main id="main">\n<h1>News</h1>\n<div class="news-list">\n${list}\n</div>\n</main>`;
  writeFileSync(join(OUT, NEWS_PAGE), frame(site, NEWS_PAGE, `News - ${site.name}`, main));
}

// The link check: every href and src of dist/'s pages that stays on the site must name a file of dist/, and its
// #anchor an id of that file; every <img> needs an alt (empty when it is decoration).
function checkLinks() {
  const pages = readdirSync(OUT).filter((f) => extname(f) === ".html");
  const ids = new Map(pages.map((p) => {
    const html = readFileSync(join(OUT, p), "utf8");
    return [p, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))];
  }));
  let checked = 0;
  for (const page of pages) {
    const html = readFileSync(join(OUT, page), "utf8");
    for (const img of html.matchAll(/<img\b[^>]*>/gi)) if (!/\salt=/i.test(img[0])) fail(`${page}: an <img> has no alt: ${img[0]}`);
    for (const [, raw] of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) {
      const href = raw.replaceAll("&amp;", "&");
      if (isExternal(href)) continue;
      checked++;
      const [pathAndQuery, anchor] = href.split("#");
      const path = pathAndQuery.split("?")[0];
      const target = path === "" ? page : posix.normalize(posix.join(posix.dirname(page), decodeURI(path)));
      if (target.startsWith("..") || !existsSync(join(OUT, target))) { fail(`${page}: "${href}" leads to no file of dist/`); continue; }
      if (anchor && !ids.get(target)?.has(decodeURIComponent(anchor))) fail(`${page}: "${href}": ${target} has no id "${anchor}"`);
    }
  }
  return checked;
}

function main() {
  const site = loadSite();
  const news = loadNews();
  let logo = null;
  try { logo = site && readLogo(site.logo, ROOT); } catch (e) { fail(`site.json "logo": ${e.message}`); }
  if (failures.length) return;
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  cpSync(THEME_CSS, join(OUT, "classic.css"));
  if (existsSync(ASSETS)) cpSync(ASSETS, join(OUT, "assets"), { recursive: true });
  makeLogo(logo, OUT);
  buildPages(site, news);
  const checked = checkLinks();
  if (!failures.length) console.log(`dist/: ${readdirSync(OUT).filter((f) => extname(f) === ".html").length} pages, ${news.length} news entries, ${checked} internal links checked`);
}

main();
if (failures.length) {
  for (const message of failures) console.error(`error: ${message}`);
  process.exit(1);
}
