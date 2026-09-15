#!/usr/bin/env python3
"""Generate the static PSAP report hub shell.

Report metadata and bundles are loaded from S3 at runtime; this generator never
reads report source from the repository.
"""

import json
from datetime import datetime, timezone
from pathlib import Path

OUTPUT_FILE = Path("index.html")
S3_CONFIG_PATH = Path(__file__).parent / "s3_config.json"



def load_s3_config():
    if S3_CONFIG_PATH.exists():
        with open(S3_CONFIG_PATH) as f:
            return json.load(f)
    return None


def render_index():

    generated_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    s3_config = load_s3_config()
    cf_domain = s3_config["cloudfront_domain"] if s3_config else ""

    token_api = s3_config.get("token_api_url", "") if s3_config else ""

    html = INDEX_TEMPLATE.replace("__ENTRIES_JSON__", "[]")
    html = html.replace("__GENERATED_AT__", generated_at)
    html = html.replace("__REPORT_COUNT__", "0")
    html = html.replace("__CLOUDFRONT_DOMAIN__", cf_domain)
    html = html.replace("__TOKEN_API_URL__", token_api)

    OUTPUT_FILE.write_text(html)
    print(f"Generated {OUTPUT_FILE} as an S3-backed report hub shell")


INDEX_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PSAP Report Hub</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#fff;--bg-card:#fff;--bg-hover:#f0f0f0;--border:#d2d2d2;
  --text:#151515;--text-secondary:#6a6e73;--accent:#EE0000;
  --pill-bg:#fde8e8;--pill-text:#c00;--pill-active-bg:#EE0000;--pill-active-text:#fff;
  --badge-final:#1a7f37;--badge-draft:#9a6700;--badge-archived:#6a6e73;
  --shadow:0 1px 3px rgba(0,0,0,0.06);
}
body{font-family:"Red Hat Text","Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--text);line-height:1.5}
.site-header{background:#151515;border-bottom:3px solid #EE0000;padding:0.75rem 0;position:sticky;top:0;z-index:100}
.site-header .container{display:flex;align-items:center;justify-content:space-between}
.site-header .brand{color:#fff;font-size:1.3rem;font-weight:700;text-decoration:none;letter-spacing:-0.01em}
.site-header .brand span{color:#a0a0a0;font-size:0.8rem;font-weight:400;margin-left:0.75rem}
.manage-link{color:#fff;text-decoration:none;border:1px solid #a0a0a0;border-radius:5px;padding:0.35rem 0.65rem;font-size:0.78rem;font-weight:600}
.manage-link:hover{border-color:#fff;background:#303030}
.container{max-width:960px;margin:0 auto;padding:1rem}
header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem;padding:1.5rem 0;border-bottom:1px solid var(--border)}
header h1{font-size:1.5rem;font-weight:600;display:none}
.search-box{padding:0.5rem 0.75rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);font-size:0.875rem;width:280px;max-width:100%}
.search-box:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px rgba(238,0,0,0.12)}
.filters{padding:1rem 0;display:flex;flex-direction:column;gap:0.75rem;border-bottom:1px solid var(--border)}
.filter-row{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap}
.filter-label{font-size:0.75rem;font-weight:600;text-transform:uppercase;color:var(--text-secondary);min-width:80px}
.pill{display:inline-block;padding:0.25rem 0.75rem;border-radius:99px;font-size:0.75rem;font-weight:500;cursor:pointer;border:1px solid transparent;background:var(--pill-bg);color:var(--pill-text);transition:all 0.15s ease;user-select:none}
.pill:hover{opacity:0.85}
.pill.active{background:var(--pill-active-bg);color:var(--pill-active-text)}
.toolbar{display:flex;align-items:center;justify-content:space-between;padding:0.75rem 0}
.counter{font-size:0.875rem;color:var(--text-secondary)}
.sort-select{padding:0.35rem 0.5rem;border:1px solid var(--border);border-radius:6px;background:var(--bg-card);color:var(--text);font-size:0.8rem}
.cards{display:flex;flex-direction:column;gap:0.75rem;padding-bottom:2rem}
.card{display:block;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;background:var(--bg-card);text-decoration:none;color:inherit;box-shadow:var(--shadow);transition:border-color 0.15s ease,background 0.15s ease}
.card:hover{border-color:var(--accent);background:var(--bg-hover)}
.card-top{display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.35rem}
.card-meta{display:flex;align-items:center;gap:0.5rem;font-size:0.75rem;color:var(--text-secondary)}
.category-badge{padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600;text-transform:uppercase;background:var(--pill-bg);color:var(--pill-text)}
.status-badge{padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600;text-transform:uppercase}
.status-final{color:var(--badge-final);border:1px solid var(--badge-final)}
.status-draft{color:var(--badge-draft);border:1px solid var(--badge-draft)}
.status-archived{color:var(--badge-archived);border:1px solid var(--badge-archived)}
.card-title{font-size:1rem;font-weight:600;margin-bottom:0.25rem}
.card-desc{font-size:0.85rem;color:var(--text-secondary);margin-bottom:0.5rem}
.card-bottom{display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;font-size:0.75rem;color:var(--text-secondary)}
.card-tag{padding:0.1rem 0.4rem;border-radius:4px;background:var(--pill-bg);color:var(--pill-text);font-size:0.7rem}
.card-size{margin-left:auto}
.lock-badge{display:inline-flex;align-items:center;gap:0.25rem;padding:0.15rem 0.5rem;border-radius:4px;font-size:0.7rem;font-weight:600;text-transform:uppercase;color:var(--badge-draft);border:1px solid var(--badge-draft)}
.lock-badge svg{width:0.7rem;height:0.7rem;fill:currentColor}
.tag-suggestion{padding:0.35rem 0.6rem;font-size:0.75rem;cursor:pointer;transition:background 0.1s}
.tag-suggestion:hover,.tag-suggestion.highlighted{background:var(--bg-hover)}
.active-tag{display:inline-flex;align-items:center;gap:0.25rem;padding:0.2rem 0.5rem;border-radius:99px;font-size:0.72rem;font-weight:500;background:var(--pill-active-bg);color:var(--pill-active-text);cursor:pointer;user-select:none}
.active-tag:hover{opacity:0.85}
.active-tag .x{font-size:0.85rem;line-height:1;margin-left:0.15rem}
footer{text-align:center;padding:1.5rem 0;font-size:0.75rem;color:#888;border-top:1px solid var(--border)}
.empty-state{text-align:center;padding:3rem 1rem;color:var(--text-secondary)}
.empty-state p{font-size:1rem;margin-bottom:0.5rem}
@media(max-width:600px){
  header{flex-direction:column;align-items:stretch}
  .search-box{width:100%}
  .filter-row{flex-direction:column;align-items:flex-start}
}
</style>
</head>
<body>
<div class="site-header"><div class="container"><a class="brand" href="#">PSAP<span>Report Hub</span></a><a class="manage-link" href="https://__CLOUDFRONT_DOMAIN__/admin/index.html">Sign in / Manage reports</a></div></div>
<div class="container">
  <header>
    <h1>PSAP Report Hub</h1>
    <input type="text" class="search-box" id="search" placeholder="Search reports..." autocomplete="off">
  </header>

  <div class="filters">
    <div class="filter-row">
      <span class="filter-label">Category</span>
      <div id="category-filters"></div>
    </div>
    <div class="filter-row" id="tag-filter-row" style="display:none">
      <span class="filter-label">Tags</span>
      <div id="tag-filters" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <div style="position:relative">
          <input type="text" id="tag-search" class="search-box" placeholder="Search tags..." style="width:180px;font-size:0.75rem;padding:0.3rem 0.6rem" autocomplete="off">
          <div id="tag-suggestions" style="display:none;position:absolute;top:100%;left:0;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;margin-top:2px;max-height:160px;overflow-y:auto;min-width:180px;box-shadow:var(--shadow)"></div>
        </div>
        <div id="active-tags"></div>
      </div>
    </div>
    <div class="filter-row" id="author-filter-row" style="display:none">
      <span class="filter-label">Submitter</span>
      <div id="author-filters" style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap">
        <div style="position:relative">
          <input type="text" id="author-search" class="search-box" placeholder="Search submitters..." style="width:180px;font-size:0.75rem;padding:0.3rem 0.6rem" autocomplete="off">
          <div id="author-suggestions" style="display:none;position:absolute;top:100%;left:0;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;margin-top:2px;max-height:160px;overflow-y:auto;min-width:180px;box-shadow:var(--shadow)"></div>
        </div>
        <div id="active-authors"></div>
      </div>
    </div>
    <div class="filter-row">
      <span class="filter-label">Access</span>
      <div id="access-filters"></div>
    </div>
    <div class="filter-row">
      <span class="filter-label">Status</span>
      <div id="status-filters"></div>
    </div>
  </div>

  <div class="toolbar">
    <span class="counter" id="counter"></span>
    <select class="sort-select" id="sort">
      <option value="date-desc">Newest first</option>
      <option value="date-asc">Oldest first</option>
      <option value="title-asc">Title A-Z</option>
      <option value="title-desc">Title Z-A</option>
    </select>
  </div>

  <div class="cards" id="cards"></div>

  <div id="submit-signin" style="margin-top:2rem;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;background:#f8f8f8;font-size:0.9rem">
    Want to publish a report? <a href="https://__CLOUDFRONT_DOMAIN__/_auth/github?state=/admin/index.html" style="color:#c00;font-weight:600">Sign in with GitHub</a>.
  </div>

  <div id="admin-panel" hidden style="margin-top:2rem;padding-top:1.5rem;border-top:2px solid var(--border)">
    <h2 style="font-size:1.1rem;font-weight:600;margin-bottom:0.5rem">Submit a report</h2>
    <p style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:1rem">Report files upload directly to S3. They are not committed to GitHub.</p>
    <p id="report-oauth-required" hidden style="font-size:0.85rem;color:var(--text-secondary);margin-bottom:1rem">Report submission requires GitHub identity. <a href="/_auth/github?state=/admin/index.html" style="color:#c00;font-weight:600">Sign in with GitHub</a>.</p>
    <form id="report-upload-form" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.65rem;margin-bottom:1.5rem">
      <input id="report-title" class="search-box" placeholder="Report title" required style="width:100%">
      <input id="report-author" class="search-box" readonly aria-label="Submitter GitHub handle" style="width:100%">
      <select id="report-category" class="sort-select"><option value="benchmarks">Benchmarks</option><option value="ci">CI</option><option value="investigations">Investigations</option><option value="presentations">Presentations</option></select>
      <select id="report-access" class="sort-select"><option value="authenticated">Red Hat Internal</option><option value="public">Public</option></select>
      <select id="report-source" class="sort-select"><option value="upload">Upload HTML</option><option value="external">External HTTPS link</option></select>
      <input id="report-tags" class="search-box" placeholder="Tags, comma-separated" style="width:100%">
      <input id="report-description" class="search-box" placeholder="Short description (optional)" style="grid-column:1 / -1;width:100%">
      <label id="report-file-label" style="grid-column:1 / -1;font-size:0.85rem;color:var(--text-secondary)">Report HTML file<br><input id="report-files" type="file" accept="text/html,.html,.htm" style="margin-top:0.35rem"><br><span style="font-size:0.8rem">Any HTML filename is accepted. For assets or multiple files, use the CLI uploader.</span></label>
      <input id="report-external-url" class="search-box" type="url" placeholder="https://external-report.example/" hidden style="grid-column:1 / -1;width:100%">
      <button id="report-upload-btn" type="submit" style="justify-self:start;padding:0.45rem 1rem;background:#EE0000;color:#fff;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer">Upload report</button>
      <span id="report-upload-status" style="align-self:center;font-size:0.8rem;color:var(--text-secondary)"></span>
    </form>
    <h2 style="font-size:1.1rem;font-weight:600;margin-bottom:1rem">Access Token Admin</h2>
    <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap">
      <input type="text" id="token-group" class="search-box" placeholder="Group (e.g. sales, engineering)" style="width:200px;font-size:0.8rem;padding:0.4rem 0.6rem">
      <input type="text" id="token-note" class="search-box" placeholder="Note" style="flex:1;min-width:150px;font-size:0.8rem;padding:0.4rem 0.6rem">
      <select id="token-lifetime" class="sort-select" title="Token lifetime">
        <option value="7">Expires in 7 days</option>
        <option value="30">Expires in 30 days</option>
        <option value="90">Expires in 90 days</option>
        <option value="365">Expires in 1 year</option>
        <option value="0">Long-lived</option>
      </select>
      <button id="token-generate-btn" style="padding:0.4rem 1rem;background:#EE0000;color:#fff;border:none;border-radius:6px;font-size:0.8rem;font-weight:600;cursor:pointer">Generate Token</button>
    </div>
    <div id="token-result" style="display:none;background:#f0f0f0;border:1px solid #d2d2d2;border-radius:6px;padding:0.75rem 1rem;margin-bottom:1rem;font-family:monospace;font-size:0.8rem;word-break:break-all"></div>
    <table id="token-table" style="width:100%;border-collapse:collapse;font-size:0.8rem">
      <thead><tr style="border-bottom:2px solid var(--border)">
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Token</th>
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Group</th>
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Note</th>
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Created</th>
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Expires</th>
        <th style="text-align:left;padding:0.4rem;font-size:0.7rem;text-transform:uppercase;color:var(--text-secondary)">Status</th>
        <th style="padding:0.4rem"></th>
      </tr></thead>
      <tbody id="token-tbody"></tbody>
    </table>
  </div>

  <footer>Generated __GENERATED_AT__ &middot; __REPORT_COUNT__ reports indexed</footer>
</div>

<script>
const REPORTS = __ENTRIES_JSON__;
const CF_DOMAIN = "__CLOUDFRONT_DOMAIN__";

let activeCategory = null;
let activeTags = new Set();
let activeAuthors = new Set();
let searchQuery = "";
let sortBy = "date-desc";
let statusFilter = null;
let accessFilter = null;
let tagSearchBound = false;
let authorSearchBound = false;
let currentGithubHandle = "";
let updatingReport = null;

function getCategories() { return [...new Set(REPORTS.map(r => r.category))].sort(); }
function getAllTags() { return [...new Set(REPORTS.flatMap(r => r.tags))].sort(); }
function getAllAuthors() { return [...new Set(REPORTS.map(r => r.author).filter(Boolean))].sort(); }

function init() {
  document.getElementById("search").addEventListener("input", e => { searchQuery = e.target.value.trim(); render(); });
  document.getElementById("sort").addEventListener("change", e => { sortBy = e.target.value; render(); });
  rebuildFilters();
  render();
  loadPublicEntries();
}

function rebuildFilters() {
  rebuildPillFilter("category-filters", getCategories(), activeCategory, v => { activeCategory = v; });
  rebuildTagSearch();
  rebuildAuthorSearch();
  rebuildAccessFilter();
  rebuildPillFilter("status-filters", ["final", "draft", "archived"], statusFilter, v => { statusFilter = v; });
}

function rebuildPillFilter(containerId, values, activeValue, setter, hideRowId) {
  const container = document.getElementById(containerId);
  container.innerHTML = "";
  if (hideRowId) {
    document.getElementById(hideRowId).style.display = values.length ? "" : "none";
    if (!values.length) return;
  }
  const allPill = makePill("All", () => { setter(null); render(); rebuildPillStates(); });
  if (!activeValue) allPill.classList.add("active");
  container.appendChild(allPill);
  values.forEach(v => {
    const pill = makePill(v, () => { setter(activeValue === v ? null : v); render(); rebuildPillStates(); });
    if (activeValue === v) pill.classList.add("active");
    container.appendChild(pill);
  });
}

function rebuildPillStates() {
  rebuildPillFilter("category-filters", getCategories(), activeCategory, v => { activeCategory = v; });
  rebuildAccessFilter();
  rebuildPillFilter("status-filters", ["final", "draft", "archived"], statusFilter, v => { statusFilter = v; });
}

function rebuildAccessFilter() {
  const hasAuth = REPORTS.some(r => r.authenticated);
  const container = document.getElementById("access-filters");
  container.parentElement.style.display = hasAuth ? "" : "none";
  if (!hasAuth) return;
  container.innerHTML = "";
  const allPill = makePill("All", () => { accessFilter = null; render(); rebuildPillStates(); });
  if (!accessFilter) allPill.classList.add("active");
  container.appendChild(allPill);
  [["public", "Public"], ["authenticated", "SSO Required"]].forEach(([key, label]) => {
    const pill = makePill(label, () => { accessFilter = accessFilter === key ? null : key; render(); rebuildPillStates(); });
    if (accessFilter === key) pill.classList.add("active");
    container.appendChild(pill);
  });
}

function rebuildTagSearch() {
  const allTags = getAllTags();
  const row = document.getElementById("tag-filter-row");
  row.style.display = allTags.length ? "" : "none";
  if (!allTags.length) return;
  if (tagSearchBound) return;
  tagSearchBound = true;
  const input = document.getElementById("tag-search");
  const suggestions = document.getElementById("tag-suggestions");
  let highlightIdx = -1;
  function showSuggestions(query) {
    const tags = getAllTags();
    const matches = tags.filter(t => !activeTags.has(t) && t.toLowerCase().includes(query.toLowerCase()));
    if (!matches.length || !query) { suggestions.style.display = "none"; highlightIdx = -1; return; }
    suggestions.innerHTML = matches.map(t => `<div class="tag-suggestion" data-tag="${escHtml(t)}">${escHtml(t)}</div>`).join("");
    suggestions.style.display = "block"; highlightIdx = -1;
    suggestions.querySelectorAll(".tag-suggestion").forEach(el => { el.addEventListener("click", () => { addTag(el.dataset.tag); }); });
  }
  function addTag(tag) { activeTags.add(tag); input.value = ""; suggestions.style.display = "none"; renderActiveTags(); render(); }
  window.renderActiveTags = function() {
    const container = document.getElementById("active-tags"); container.innerHTML = "";
    activeTags.forEach(tag => {
      const chip = document.createElement("span"); chip.className = "active-tag";
      chip.innerHTML = `${escHtml(tag)}<span class="x">&times;</span>`;
      chip.addEventListener("click", () => { activeTags.delete(tag); renderActiveTags(); render(); });
      container.appendChild(chip);
    });
  };
  input.addEventListener("input", () => showSuggestions(input.value));
  input.addEventListener("keydown", e => {
    const items = suggestions.querySelectorAll(".tag-suggestion");
    if (e.key === "ArrowDown") { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("highlighted", i === highlightIdx)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, 0); items.forEach((el, i) => el.classList.toggle("highlighted", i === highlightIdx)); }
    else if (e.key === "Enter" && highlightIdx >= 0 && items[highlightIdx]) { e.preventDefault(); addTag(items[highlightIdx].dataset.tag); }
    else if (e.key === "Escape") { suggestions.style.display = "none"; }
  });
  input.addEventListener("focus", () => { if (input.value) showSuggestions(input.value); });
  document.addEventListener("click", e => { if (!e.target.closest("#tag-filters")) suggestions.style.display = "none"; });
}

function rebuildAuthorSearch() {
  const allAuthors = getAllAuthors();
  const row = document.getElementById("author-filter-row");
  row.style.display = allAuthors.length ? "" : "none";
  if (!allAuthors.length) return;
  if (authorSearchBound) return;
  authorSearchBound = true;
  const input = document.getElementById("author-search");
  const suggestions = document.getElementById("author-suggestions");
  let highlightIdx = -1;
  function showSuggestions(query) {
    const authors = getAllAuthors();
    const matches = authors.filter(a => !activeAuthors.has(a) && a.toLowerCase().includes(query.toLowerCase()));
    if (!matches.length || !query) { suggestions.style.display = "none"; highlightIdx = -1; return; }
    suggestions.innerHTML = matches.map(a => `<div class="tag-suggestion" data-author="${escHtml(a)}">${escHtml(a)}</div>`).join("");
    suggestions.style.display = "block"; highlightIdx = -1;
    suggestions.querySelectorAll(".tag-suggestion").forEach(el => { el.addEventListener("click", () => { addAuthor(el.dataset.author); }); });
  }
  function addAuthor(author) { activeAuthors.add(author); input.value = ""; suggestions.style.display = "none"; renderActiveAuthors(); render(); }
  window.renderActiveAuthors = function() {
    const container = document.getElementById("active-authors"); container.innerHTML = "";
    activeAuthors.forEach(author => {
      const chip = document.createElement("span"); chip.className = "active-tag";
      chip.innerHTML = `${escHtml(author)}<span class="x">&times;</span>`;
      chip.addEventListener("click", () => { activeAuthors.delete(author); renderActiveAuthors(); render(); });
      container.appendChild(chip);
    });
  };
  input.addEventListener("input", () => showSuggestions(input.value));
  input.addEventListener("keydown", e => {
    const items = suggestions.querySelectorAll(".tag-suggestion");
    if (e.key === "ArrowDown") { e.preventDefault(); highlightIdx = Math.min(highlightIdx + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("highlighted", i === highlightIdx)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); highlightIdx = Math.max(highlightIdx - 1, 0); items.forEach((el, i) => el.classList.toggle("highlighted", i === highlightIdx)); }
    else if (e.key === "Enter" && highlightIdx >= 0 && items[highlightIdx]) { e.preventDefault(); addAuthor(items[highlightIdx].dataset.author); }
    else if (e.key === "Escape") { suggestions.style.display = "none"; }
  });
  input.addEventListener("focus", () => { if (input.value) showSuggestions(input.value); });
  document.addEventListener("click", e => { if (!e.target.closest("#author-filters")) suggestions.style.display = "none"; });
}

function reportsApiUrl(access) {
  const root = CF_DOMAIN ? `https://${CF_DOMAIN}` : window.location.origin;
  return `${root}/_admin-api/reports?access=${encodeURIComponent(access)}`;
}

async function loadPublicEntries() {
  try {
    const resp = await fetch(reportsApiUrl("public"));
    if (!resp.ok) return;
    const data = await resp.json();
    REPORTS.splice(0, REPORTS.length, ...(data.reports || []));
    rebuildFilters(); render();
  } catch (e) { /* temporary API/network error */ }
}

async function loadPrivateEntries() {
  if (!CF_DOMAIN) return;
  try {
    const resp = await fetch(reportsApiUrl("authenticated"), { credentials: "include" });
    if (!resp.ok) return;
    const data = await resp.json();
    const entries = data.reports || [];
    entries.forEach(e => REPORTS.push(e));
    REPORTS.sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));
    rebuildFilters();
    render();
  } catch (e) { /* not authenticated or network error */ }
}

function makePill(label, onClick) {
  const el = document.createElement("span");
  el.className = "pill";
  el.textContent = label;
  el.addEventListener("click", onClick);
  return el;
}

function filterReports() {
  return REPORTS.filter(r => {
    if (activeCategory && r.category !== activeCategory) return false;
    if (activeTags.size > 0 && !r.tags.some(t => activeTags.has(t))) return false;
    if (statusFilter && r.status !== statusFilter) return false;
    if (activeAuthors.size > 0 && !activeAuthors.has(r.author)) return false;
    if (accessFilter === "public" && r.authenticated) return false;
    if (accessFilter === "authenticated" && !r.authenticated) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      const haystack = [r.title, r.description, r.category, r.author, ...r.tags].join(" ").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function sortReports(list) {
  const copy = [...list];
  switch (sortBy) {
    case "date-desc": copy.sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date))); break;
    case "date-asc": copy.sort((a, b) => String(a.submittedAt || a.date).localeCompare(String(b.submittedAt || b.date))); break;
    case "title-asc": copy.sort((a, b) => a.title.localeCompare(b.title)); break;
    case "title-desc": copy.sort((a, b) => b.title.localeCompare(a.title)); break;
  }
  return copy;
}

function render() {
  const filtered = sortReports(filterReports());
  const container = document.getElementById("cards");
  document.getElementById("counter").textContent =
    filtered.length === REPORTS.length
      ? `${REPORTS.length} reports`
      : `Showing ${filtered.length} of ${REPORTS.length} reports`;

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No reports match your filters.</p></div>';
    return;
  }

  container.innerHTML = filtered.map(r => {
    return `
    <div class="card" onclick="window.open('${escHtml(r.path)}','_blank')" style="cursor:pointer">
      <div class="card-top">
        <div class="card-meta">
          <span class="category-badge">${escHtml(r.category)}</span>
          <span>${escHtml(formatSubmittedTime(r))}</span>
          ${r.author ? `<span>&middot; ${escHtml(r.author)}</span>` : ""}
        </div>
        ${r.authenticated ? '<span class="lock-badge"><svg viewBox="0 0 16 16"><path d="M4 6V4a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1zm2-2a2 2 0 1 1 4 0v2H6V4z"/></svg>SSO</span>' : ''}
        <span class="status-badge status-${escHtml(r.status)}">${escHtml(r.status)}</span>
      </div>
      <div class="card-title">${escHtml(r.title)}</div>
      ${r.description ? `<div class="card-desc">${escHtml(r.description)}</div>` : ""}
      <div class="card-bottom">
        ${r.tags.map(t => `<span class="card-tag">${escHtml(t)}</span>`).join("")}
        <span class="card-size">${escHtml(r.size)}</span>
        ${currentGithubHandle && r.author && r.author.toLowerCase() === currentGithubHandle.toLowerCase() ? `<button onclick="event.stopPropagation();updateReport('${escHtml(r.id)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer">Update</button>${r.status !== 'archived' ? `<button onclick="event.stopPropagation();archiveReport('${escHtml(r.id)}','${r.authenticated ? 'authenticated' : 'public'}','${escHtml(r.title)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer">Archive</button>` : ''}<button onclick="event.stopPropagation();deleteReport('${escHtml(r.id)}','${r.authenticated ? 'authenticated' : 'public'}','${escHtml(r.title)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid #c00;border-radius:4px;font-size:0.7rem;cursor:pointer;color:#c00">Delete</button>` : ""}
      </div>
    </div>`;
  }).join("");
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatSubmittedTime(report) {
  if (!report.submittedAt) return report.date || "";
  const date = new Date(report.submittedAt);
  return Number.isNaN(date.getTime()) ? report.date || "" : date.toLocaleString();
}

const TOKEN_API = "__TOKEN_API_URL__";

function updateReport(id) {
  const report = REPORTS.find(item => item.id === id); if (!report) return;
  updatingReport = report;
  document.getElementById("report-title").value = report.title;
  document.getElementById("report-category").value = report.category;
  document.getElementById("report-access").value = report.authenticated ? "authenticated" : "public";
  document.getElementById("report-tags").value = (report.tags || []).join(", ");
  document.getElementById("report-description").value = report.description || "";
  document.getElementById("report-upload-btn").textContent = `Upload revision ${Number(report.version || 1) + 1}`;
  document.getElementById("report-upload-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteReport(id, access, title) {
  if (!confirm(`Permanently delete “${title}” and all its files?`)) return;
  const response = await fetch(`${TOKEN_API}/reports?access=${encodeURIComponent(access)}&id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
  const data = await response.json();
  if (!response.ok) return alert(data.error || "Could not delete report");
  const index = REPORTS.findIndex(report => report.id === id);
  if (index >= 0) REPORTS.splice(index, 1);
  rebuildFilters(); render();
}

async function archiveReport(id, access, title) {
  if (!confirm(`Archive “${title}”? Its files will remain available.`)) return;
  const response = await fetch(`${TOKEN_API}/reports?access=${encodeURIComponent(access)}&id=${encodeURIComponent(id)}`, { method: "PATCH", credentials: "include" });
  const data = await response.json();
  if (!response.ok) return alert(data.error || "Could not archive report");
  const report = REPORTS.find(item => item.id === id);
  if (report) Object.assign(report, data.report);
  rebuildFilters(); render();
}

async function initAdmin() {
  const panel = document.getElementById("admin-panel");
  if (!TOKEN_API) {
    panel.style.display = "";
    renderTokenTable([
      { id: "psap_rht_demo12345678...", group: "everyone", note: "Demo token (no API configured)", created: "—", active: true },
    ]);
    document.getElementById("token-generate-btn").disabled = true;
    document.getElementById("token-generate-btn").title = "Set token_api_url in s3_config.json to enable";
    return;
  }
  try {
    const resp = await fetch(`${TOKEN_API}/tokens`, { credentials: "include" });
    if (!resp.ok) return;
    const data = await resp.json();
    panel.hidden = false;
    document.getElementById("submit-signin").hidden = true;
    const submitter = document.getElementById("report-author");
    currentGithubHandle = data.githubHandle || "";
    submitter.value = data.githubHandle || "";
    submitter.placeholder = data.githubHandle ? "" : "GitHub sign-in required to submit";
    document.getElementById("report-upload-form").hidden = !data.githubHandle;
    document.getElementById("report-oauth-required").hidden = !!data.githubHandle;
    renderTokenTable(data.tokens);
    render();
    loadPrivateEntries();
    initReportUpload();
  } catch (e) { return; }

  document.getElementById("token-generate-btn").addEventListener("click", async () => {
    const group = document.getElementById("token-group").value.trim() || "everyone";
    const note = document.getElementById("token-note").value.trim() || `${group} access`;
    const lifetimeDays = Number(document.getElementById("token-lifetime").value);
    const btn = document.getElementById("token-generate-btn");
    btn.disabled = true; btn.textContent = "Generating...";
    try {
      const resp = await fetch(`${TOKEN_API}/tokens`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ group, note, lifetimeDays }),
      });
      const data = await resp.json();
      if (data.token) {
        const result = document.getElementById("token-result");
        result.style.display = "";
        const expiry = data.expires ? `Expires ${escHtml(data.expires.slice(0, 10))}.` : "Long-lived token.";
        result.innerHTML = `<strong>New token (${escHtml(group)}):</strong><br>${escHtml(data.token)}<br><br><em>${expiry} Copy and share with ${escHtml(group)} users. This is the only time it will be shown in full.</em>`;
        document.getElementById("token-group").value = "";
        document.getElementById("token-note").value = "";
        const listResp = await fetch(`${TOKEN_API}/tokens`, { credentials: "include" });
        const listData = await listResp.json();
        renderTokenTable(listData.tokens);
      }
    } catch (e) { console.error(e); }
    btn.disabled = false; btn.textContent = "Generate Token";
  });
}

function initReportUpload() {
  const form = document.getElementById("report-upload-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "true";
  const githubHandle = document.getElementById("report-author").value;
  const source = document.getElementById("report-source");
  source.addEventListener("change", () => { const external = source.value === "external"; document.getElementById("report-file-label").hidden = external; document.getElementById("report-external-url").hidden = !external; });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = document.getElementById("report-upload-btn");
    const status = document.getElementById("report-upload-status");
    const externalUrl = document.getElementById("report-source").value === "external" ? document.getElementById("report-external-url").value.trim() : "";
    const files = externalUrl ? [] : [...document.getElementById("report-files").files].map(file => ({ file, name: file.name, size: file.size, contentType: file.type || "text/html" }));
    const payload = {
      title: document.getElementById("report-title").value,
      category: document.getElementById("report-category").value,
      access: document.getElementById("report-access").value,
      tags: document.getElementById("report-tags").value.split(",").map(tag => tag.trim()).filter(Boolean),
      description: document.getElementById("report-description").value,
      entryFile: files[0] && files[0].name,
      externalUrl,
      parentId: updatingReport ? updatingReport.id : undefined,
      files: files.map(({ name, size, contentType }) => ({ name, size, contentType })),
    };
    button.disabled = true;
    try {
      status.textContent = "Preparing secure upload…";
      const planResponse = await fetch(`${TOKEN_API}/reports`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const plan = await planResponse.json();
      if (!planResponse.ok) throw new Error(plan.error || "Could not prepare upload");
      if (plan.external) { status.textContent = "Published."; form.reset(); await loadPublicEntries(); await loadPrivateEntries(); return; }
      const byName = new Map(files.map(item => [item.name, item.file]));
      let uploaded = 0;
      for (const target of plan.uploads) {
        status.textContent = `Uploading ${++uploaded} of ${plan.uploads.length}…`;
        const file = byName.get(target.name);
        const upload = await fetch(target.url, { method: "PUT", headers: { "Content-Type": file.type || "application/octet-stream", "Cache-Control": "no-cache" }, body: file });
        if (!upload.ok) throw new Error(`Upload failed for ${target.name}`);
      }
      status.textContent = "Publishing report…";
      const completeResponse = await fetch(`${TOKEN_API}/reports/${plan.id}/complete`, { method: "POST", credentials: "include" });
      const complete = await completeResponse.json();
      if (!completeResponse.ok) throw new Error(complete.error || "Could not publish report");
      status.textContent = "Published.";
      form.reset();
      updatingReport = null;
      document.getElementById("report-upload-btn").textContent = "Upload report";
      document.getElementById("report-author").value = githubHandle;
      await loadPublicEntries(); await loadPrivateEntries();
    } catch (error) {
      status.textContent = error.message || "Upload failed.";
    } finally { button.disabled = false; }
  });
}

function renderTokenTable(tokens) {
  const tbody = document.getElementById("token-tbody");
  tbody.innerHTML = tokens.map(t => `<tr style="border-bottom:1px solid var(--border)">
    <td style="padding:0.4rem;font-family:monospace">${escHtml(t.id)}</td>
    <td style="padding:0.4rem">${escHtml(t.group)}</td>
    <td style="padding:0.4rem">${escHtml(t.note)}</td>
    <td style="padding:0.4rem">${escHtml(t.created)}</td>
    <td style="padding:0.4rem">${escHtml(t.expires ? t.expires.slice(0, 10) : "Never")}</td>
    <td style="padding:0.4rem"><span style="color:${t.active ? 'var(--badge-final)' : 'var(--badge-archived)'}">${t.active ? 'Active' : (t.expires ? 'Expired' : 'Revoked')}</span></td>
    <td style="padding:0.4rem">${t.active ? `<button onclick="revokeToken('${escHtml(t.id)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer;color:var(--text-secondary)">Revoke</button>` : ''}</td>
  </tr>`).join("");
}

async function revokeToken(prefix) {
  if (!confirm(`Revoke token ${prefix}?`)) return;
  await fetch(`${TOKEN_API}/tokens`, {
    method: "DELETE", credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  const resp = await fetch(`${TOKEN_API}/tokens`, { credentials: "include" });
  const data = await resp.json();
  renderTokenTable(data.tokens);
}

init();
initAdmin();
</script>
</body>
</html>
"""


MANIFEST_FILE = Path("public-reports.json")


def generate_manifest(entries):
    """Write the retired legacy path manifest.

    Public content is now intentionally isolated below /public/, which the
    edge authorizer permits directly. Keeping this empty closes the former
    git-derived category paths after migration.
    """
    MANIFEST_FILE.write_text(json.dumps({"paths": []}, indent=2) + "\n")
    print(f"Generated {MANIFEST_FILE} with no legacy public paths")


if __name__ == "__main__":
    render_index()
    generate_manifest([])
