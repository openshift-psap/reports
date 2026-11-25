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
WORKSTREAMS_PATH = Path(__file__).parent / "workstreams.json"



def load_s3_config():
    if S3_CONFIG_PATH.exists():
        with open(S3_CONFIG_PATH) as f:
            return json.load(f)
    return None


def load_workstreams():
    if WORKSTREAMS_PATH.exists():
        with open(WORKSTREAMS_PATH) as f:
            return json.load(f).get("workstreams", [])
    return []


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
    html = html.replace("__WORKSTREAMS_JSON__", json.dumps(load_workstreams()))

    OUTPUT_FILE.write_text(html)
    print(f"Generated {OUTPUT_FILE} as an S3-backed report hub shell")


INDEX_TEMPLATE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="icon" href="data:,">
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
.workstream-section{padding-bottom:1.5rem}.workstream-heading{display:flex;align-items:baseline;gap:.6rem;margin:1.25rem 0 .6rem;font-size:1.1rem}.workstream-heading small{font-size:.75rem;color:var(--text-secondary);font-weight:400}.workstream-tags{display:flex;gap:.4rem;flex-wrap:wrap;margin:.4rem 0 .75rem}
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
.report-form-actions{grid-column:1 / -1;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap}
.report-form-button{flex:0 0 auto;padding:.45rem 1rem;background:var(--accent);color:#fff;border:1px solid var(--accent);border-radius:6px;font-family:inherit;font-size:.8rem;font-weight:600;line-height:1.25;cursor:pointer}
.report-form-button-secondary{background:transparent;color:var(--accent)}
.report-form-button-secondary:hover{background:var(--pill-bg)}
.report-form-button:disabled{opacity:.6;cursor:wait}
.report-update-modes{grid-column:1 / -1;border:0;padding:0;font-size:.85rem}
.report-update-modes legend{margin-bottom:.4rem;font-weight:600}
.report-mode-options{display:flex;gap:.5rem 1.25rem;flex-wrap:wrap}
.report-mode-options label{display:flex;align-items:center;gap:.4rem;cursor:pointer}
.report-mode-options input{accent-color:var(--accent)}
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
<div class="site-header"><div class="container"><a class="brand" href="#">PSAP<span>Report Hub</span></a><div style="display:flex;align-items:center;gap:.6rem"><span id="auth-status" style="color:#c7c7c7;font-size:.78rem">Not signed in</span><a id="submit-link" class="manage-link" href="/admin/index.html?submit=1">Submit report</a><a id="signin-link" class="manage-link" href="/admin/index.html">Sign in</a><a id="signout-link" class="manage-link" href="/_auth/logout" hidden>Sign out</a></div></div></div>
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

  <div id="workstream-tags"></div>
  <div class="cards" id="cards"></div>
  <dialog id="version-history" style="max-width:600px;width:calc(100% - 2rem);border:1px solid var(--border);border-radius:10px;padding:1.5rem"><button onclick="document.getElementById('version-history').close()" style="float:right;border:0;background:none;font-size:1.2rem;cursor:pointer">×</button><h2 id="version-history-title" style="margin-bottom:1rem;font-size:1.1rem">Version history</h2><div id="version-history-list"></div></dialog>

  <div id="submit-signin" style="margin-top:2rem;padding:1rem 1.25rem;border:1px solid var(--border);border-radius:8px;background:#f8f8f8;font-size:0.9rem">
    Want to publish a report? <a href="https://__CLOUDFRONT_DOMAIN__/_auth/github?state=/admin/index.html" style="color:#c00;font-weight:600">Sign in with GitHub</a>. Publishing a folder or using a local agent? Read the <a href="https://github.com/openshift-psap/reports/blob/main/CLI.md" style="color:#c00;font-weight:600">CLI guide</a>.
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
      <fieldset id="report-update-mode-label" class="report-update-modes" hidden>
        <legend>Update report</legend>
        <div class="report-mode-options">
          <label><input type="radio" name="report-update-mode" id="report-update-metadata" value="metadata" checked> Edit info only — keep existing report</label>
          <label><input type="radio" name="report-update-mode" id="report-update-replacement" value="replacement"> Replace report / change link</label>
        </div>
      </fieldset>
      <fieldset style="grid-column:1 / -1;border:1px solid var(--border);border-radius:6px;padding:.65rem"><legend>Workstream</legend><div id="report-workstreams" style="display:flex;gap:.5rem;flex-wrap:wrap"></div><p id="report-workstream-reminder" style="font-size:.8rem;color:var(--text-secondary);margin-top:.5rem">Choose a workstream when applicable to keep this report out of Unassigned.</p></fieldset>
      <div id="report-tag-picker" style="position:relative;width:100%"><div id="report-selected-tags" style="display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.35rem"></div><input id="report-tags" class="search-box" placeholder="Add tags…" autocomplete="off" style="width:100%"><div id="report-tag-suggestions" style="display:none;position:absolute;top:100%;left:0;z-index:50;background:var(--bg-card);border:1px solid var(--border);border-radius:6px;margin-top:2px;max-height:180px;overflow-y:auto;width:100%;box-shadow:var(--shadow)"></div></div>
      <input id="report-description" class="search-box" placeholder="Short description (optional)" style="grid-column:1 / -1;width:100%">
      <label id="report-file-label" style="grid-column:1 / -1;font-size:0.85rem;color:var(--text-secondary)">Report HTML file<br><input id="report-files" type="file" accept="text/html,.html,.htm" style="margin-top:0.35rem"><br><span style="font-size:0.8rem">Any HTML filename is accepted. For assets or multiple files, use the <a href="https://github.com/openshift-psap/reports/blob/main/CLI.md" style="color:#c00">CLI uploader</a>.</span></label>
      <input id="report-external-url" class="search-box" type="url" placeholder="https://external-report.example/" hidden style="grid-column:1 / -1;width:100%">
      <div class="report-form-actions">
        <button id="report-upload-btn" type="submit" class="report-form-button">Upload report</button>
        <button id="report-cancel-update" type="button" class="report-form-button report-form-button-secondary" hidden>Cancel update</button>
        <span id="report-upload-status" style="font-size:0.8rem;color:var(--text-secondary)" role="status"></span>
      </div>
    </form>
    <section id="incomplete-uploads" hidden style="margin:1.5rem 0">
      <h2>Incomplete uploads</h2>
      <p>Only your uploads are shown. You have six hours from submission creation to edit report details, re-upload files, and finish publishing. Use Edit and continue to get fresh upload links if a transfer fails or a link expires. Individual links last up to 15 minutes. Incomplete files stay private for seven days; retention does not extend the six-hour submission window. Finalized reports do not expire.</p>
      <button type="button" onclick="loadIncompleteUploads(false)">Refresh uploads</button>
      <label>Status <select id="upload-state-filter" onchange="renderIncompleteUploads()">
        <option value="">All loaded uploads</option><option value="OPEN">Awaiting files</option>
        <option value="PREPARING">Preparing</option><option value="ABORTED">Failed / cleanup pending</option>
      </select></label>
      <p id="upload-list-status" role="status" aria-live="polite">Refresh to load your incomplete uploads.</p>
      <div id="upload-list"></div>
      <button id="upload-list-more" type="button" hidden onclick="loadIncompleteUploads(true)">Load next page</button>
    </section>
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

  <footer>Generated __GENERATED_AT__ &middot; __REPORT_COUNT__ reports indexed &middot; <a href="/privacy.html">Privacy Policy</a></footer>
</div>

<script>
const REPORTS = __ENTRIES_JSON__;
const CF_DOMAIN = "__CLOUDFRONT_DOMAIN__";
const WORKSTREAMS = __WORKSTREAMS_JSON__;

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
let isAuthenticated = false;
let updatingReport = null;
const selectedReportTags = new Set();

function getCategories() { return [...new Set(REPORTS.map(r => r.category))].sort(); }
function getAllTags() { return [...new Set(REPORTS.flatMap(r => r.tags || []))].sort(); }
function getAllAuthors() { return [...new Set(REPORTS.map(r => r.author).filter(Boolean))].sort(); }

function init() {
  document.getElementById("search").addEventListener("input", e => { searchQuery = e.target.value.trim(); render(); });
  document.getElementById("sort").addEventListener("change", e => { sortBy = e.target.value; render(); });
  rebuildFilters();
  renderWorkstreamTags();
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
  return `${window.location.origin}/_admin-api/reports?access=${encodeURIComponent(access)}`;
}

function replaceReportEntries(isPrivate, entries) {
  const others = REPORTS.filter(r => Boolean(r.authenticated) !== isPrivate);
  REPORTS.splice(0, REPORTS.length, ...others, ...entries);
  REPORTS.sort((a, b) => String(b.submittedAt || b.date).localeCompare(String(a.submittedAt || a.date)));
  rebuildFilters();
  render();
}

async function loadPublicEntries() {
  try {
    const resp = await fetch(reportsApiUrl("public"));
    if (!resp.ok) return;
    const data = await resp.json();
    replaceReportEntries(false, data.reports || []);
  } catch (e) { /* temporary API/network error */ }
}

async function loadPrivateEntries() {
  try {
    const resp = await fetch(reportsApiUrl("authenticated"), { credentials: "include" });
    if (!resp.ok) return;
    const data = await resp.json();
    replaceReportEntries(true, data.reports || []);
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

  const assigned = new Set();
  const sections = WORKSTREAMS.map(workstream => {
    const reports = filtered.filter(report => !assigned.has(report) && (report.tags || []).some(tag => (workstream.match_tags || []).includes(tag.toLowerCase())));
    reports.forEach(report => assigned.add(report));
    return { ...workstream, reports };
  });
  const unassigned = filtered.filter(report => !assigned.has(report));
  if (unassigned.length) sections.push({ id: "unassigned", name: "Unassigned", reports: unassigned, legacy: true });
  container.innerHTML = sections.filter(section => section.reports.length).map(section => `<section class="workstream-section"><h2 class="workstream-heading">${escHtml(section.name)} <small>${section.legacy ? "Existing reports awaiting classification" : `${section.reports.length} report${section.reports.length === 1 ? "" : "s"}`}</small></h2>${section.reports.map(reportCard).join("")}</section>`).join("");
}

function reportCard(r) {
    const path = escHtml(reportUrl(r));
    return `
    <div class="card" onclick="window.open('${path}','_blank')" style="cursor:pointer">
      <div class="card-top">
        <div class="card-meta">
          <span class="category-badge">${escHtml(r.category)}</span>
          <span>${escHtml(formatSubmittedTime(r))}</span>
          ${r.author ? `<span>&middot; ${escHtml(r.author)}</span>` : ""}
          ${isAuthenticated ? `<span>&middot; ID: ${escHtml(r.reportId || r.id)}</span>` : ""}
        </div>
        ${r.authenticated ? '<span class="lock-badge"><svg viewBox="0 0 16 16"><path d="M4 6V4a4 4 0 1 1 8 0v2h1a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h1zm2-2a2 2 0 1 1 4 0v2H6V4z"/></svg>SSO</span>' : ''}
        <span class="status-badge status-${escHtml(r.status)}">${escHtml(r.status)}</span>
      </div>
      <div class="card-title">${escHtml(r.title)}</div>
      ${r.description ? `<div class="card-desc">${escHtml(r.description)}</div>` : ""}
      <div class="card-bottom">
        ${r.tags.map(t => `<span class="card-tag">${escHtml(t)}</span>`).join("")}
        <span class="card-size">${escHtml(r.size)}</span>
        ${r.versionCount > 1 ? `<button onclick="event.stopPropagation();showVersionHistory('${escHtml(r.reportId || r.id)}','${r.authenticated ? 'authenticated' : 'public'}','${escHtml(r.title)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer">Versions (${r.versionCount})</button>` : ""}
        ${currentGithubHandle && r.author && r.author.toLowerCase() === currentGithubHandle.toLowerCase() ? `<button onclick="event.stopPropagation();updateReport('${escHtml(r.id)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer">Update</button>${r.status !== 'archived' ? `<button onclick="event.stopPropagation();archiveReport('${escHtml(r.id)}','${r.authenticated ? 'authenticated' : 'public'}','${escHtml(r.title)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer">Archive</button>` : ''}<button onclick="event.stopPropagation();deleteReport('${escHtml(r.id)}','${r.authenticated ? 'authenticated' : 'public'}','${escHtml(r.title)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid #c00;border-radius:4px;font-size:0.7rem;cursor:pointer;color:#c00">Delete</button>` : ""}
      </div>
    </div>`;
}

function reportUrl(report) {
  if (report.externalUrl) return report.externalUrl;
  try { return `${window.location.origin}${new URL(report.path).pathname}`; }
  catch (e) { return report.path; }
}

function renderWorkstreamTags() {
  const container = document.getElementById("workstream-tags");
  const configured = WORKSTREAMS.filter(workstream => (workstream.top_tags || []).length);
  if (!configured.length) { container.innerHTML = ""; return; }
  container.innerHTML = configured.map(workstream => `<div class="workstream-tags"><strong style="font-size:.78rem;min-width:80px">${escHtml(workstream.name)}</strong>${workstream.top_tags.map(tag => `<button class="pill" data-tag="${escHtml(tag)}">${escHtml(tag)}</button>`).join("")}</div>`).join("");
  container.querySelectorAll("button[data-tag]").forEach(button => button.addEventListener("click", () => { activeTags.clear(); activeTags.add(button.dataset.tag); if (window.renderActiveTags) window.renderActiveTags(); render(); }));
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

async function showVersionHistory(reportId, access, title) {
  const response = await fetch(`${reportsApiUrl(access)}&history=1&reportId=${encodeURIComponent(reportId)}`, { credentials: "include" });
  const data = await response.json();
  if (!response.ok) return alert(data.error || "Could not load version history");
  document.getElementById("version-history-title").textContent = `Version history — ${title}`;
  document.getElementById("version-history-list").innerHTML = data.reports.sort((a,b) => Number(b.version) - Number(a.version)).map(report => `<div style="padding:.7rem 0;border-top:1px solid #d2d2d2"><strong>Version ${escHtml(report.version)}</strong>${report.isLatest !== false ? " · Current" : ""}<br><span style="font-size:.85rem;color:#6a6e73">${escHtml(formatSubmittedTime(report))} · ${escHtml(report.author || "")}</span><br><a href="${escHtml(reportUrl(report))}" target="_blank" rel="noopener" style="color:#c00">Open this version</a></div>`).join("");
  document.getElementById("version-history").showModal();
}

function updateReport(id) {
  resumingUpload = null;
  const report = REPORTS.find(item => item.id === id); if (!report) return;
  updatingReport = report;
  document.getElementById("report-title").value = report.title;
  document.getElementById("report-category").value = report.category;
  document.getElementById("report-access").value = report.authenticated ? "authenticated" : "public";
  window.setReportTags(report.tags || []);
  document.getElementById("report-description").value = report.description || "";
  document.getElementById("report-source").value = report.externalUrl ? "external" : "upload";
  document.getElementById("report-external-url").value = report.externalUrl || "";
  document.getElementById("report-files").value = "";
  document.getElementById("report-update-metadata").checked = true;
  document.getElementById("report-update-replacement").checked = false;
  syncReportUpdateMode();
  document.getElementById("report-upload-form").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteReport(id, access, title) {
  if (!confirm(`Permanently delete “${title}” and all its files?`)) return;
  try {
    const response = await fetch(`${TOKEN_API}/reports?access=${encodeURIComponent(access)}&id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "include" });
    const data = await response.json();
    if (!response.ok) return alert(data.error || "Deletion failed. Some files may already be deleted. Retry Delete; refresh the listing first if the outcome is uncertain.");
  } catch (error) {
    return alert("Deletion could not be confirmed. Some files may already be deleted. Refresh the listing and retry Delete if the report remains.");
  }
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

let incompleteUploads = [];
let incompleteCursor = null;
let incompleteLoading = false;

async function loadIncompleteUploads(more = false) {
  if (incompleteLoading || !currentGithubHandle) return;
  incompleteLoading = true;
  const status = document.getElementById("upload-list-status");
  status.textContent = "Loading uploads…";
  try {
    const suffix = more && incompleteCursor ? `?cursor=${encodeURIComponent(incompleteCursor)}` : "";
    const response = await fetch(`${TOKEN_API}/uploads${suffix}`, { credentials: "include" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not load uploads");
    incompleteUploads = more ? [...incompleteUploads, ...data.uploads] : data.uploads;
    incompleteCursor = data.cursor;
    renderIncompleteUploads();
    document.getElementById("upload-list-more").hidden = !incompleteCursor;
    status.textContent = data.enabled === false ? "The new upload lifecycle is not enabled yet." :
      `${incompleteUploads.length} uploads loaded.${incompleteCursor ? " More pages are available, including when this page has no matches." : ""}`;
  } catch (error) { status.textContent = `${error.message}. Your previous results are retained; refresh to retry.`; }
  finally { incompleteLoading = false; }
}

function renderIncompleteUploads() {
  const list = document.getElementById("upload-list");
  list.textContent = "";
  const selected = document.getElementById("upload-state-filter").value;
  for (const upload of incompleteUploads) {
    if (selected && upload.state !== selected) continue;
    const card = document.createElement("article");
    card.style.cssText = "border:1px solid var(--border);padding:1rem;margin:0.75rem 0";
    const title = document.createElement("h3"); title.textContent = upload.title; card.appendChild(title);
    const info = document.createElement("p");
    const deadline = new Date(upload.retainUntil);
    const left = Math.max(0, Math.ceil((upload.retainUntil - Date.now()) / 3600000));
    info.textContent = `${upload.id} · ${upload.access} · ${upload.category} · ${upload.state}. Entry: ${upload.entryFile || "external link"}. Created: ${new Date(upload.createdAt).toLocaleString()}. Edit and publish by ${new Date(upload.resumeUntil).toLocaleString()}. Retained until ${deadline.toLocaleString()} (${left} hours remaining). Upload links expire no later than ${new Date(upload.uploadUrlsExpireAt).toLocaleString()}.`;
    card.appendChild(info);
    const progress = document.createElement("p");
    progress.textContent = `Expected: ${upload.expectedFiles} files / ${upload.expectedBytes} bytes. Observed: ${upload.observedFiles === null ? "Unknown — inspect to refresh" : `${upload.observedFiles} files / ${upload.observedBytes} bytes`}.`;
    card.appendChild(progress);
    const detail = document.createElement("p");
    detail.textContent = `Failure: ${upload.failure || "none recorded"}. ${upload.cleanup ? `Cleanup failures: ${upload.cleanup.failures}; next check ${new Date(upload.cleanup.nextRetryAt).toLocaleString()}; last verified ${upload.cleanup.verifiedAt ? new Date(upload.cleanup.verifiedAt).toLocaleString() : "not yet"}.` : "Cleanup has not yet been verified."} Missing: ${upload.missing === null ? "Unknown" : upload.missing.join(", ") || "none"}. Mismatched: ${upload.mismatched === null ? "Unknown" : upload.mismatched.join(", ") || "none"}.`;
    card.appendChild(detail);
    const inspect = document.createElement("button"); inspect.type = "button"; inspect.textContent = "Inspect file progress";
    inspect.addEventListener("click", async () => {
      inspect.disabled = true;
      try {
        const response = await fetch(`${TOKEN_API}/uploads?id=${encodeURIComponent(upload.id)}`, { credentials: "include" });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Could not inspect upload");
        const found = data.uploads.find(item => item.id === upload.id);
        if (found) Object.assign(upload, found);
        else incompleteUploads = incompleteUploads.filter(item => item.id !== upload.id);
        renderIncompleteUploads();
      } catch (error) { detail.textContent = `Progress unavailable: ${error.message}. Retry inspection.`; inspect.disabled = false; }
    });
    card.appendChild(inspect);
    if (upload.previousPath && upload.previousPath.startsWith("https://")) {
      const previous = document.createElement("a"); previous.href = upload.previousPath; previous.textContent = " Previous committed revision"; card.appendChild(previous);
    }
    if (upload.canResume && Date.now() < upload.resumeUntil && upload.expectedFiles === 1) {
      const resume = document.createElement("button"); resume.type = "button"; resume.textContent = "Edit and continue";
      resume.addEventListener("click", () => resumeUpload(upload)); card.appendChild(resume);
    }
    const help = document.createElement("p");
    help.textContent = upload.canResume ? "Edit and continue lets you correct report details and reselect the HTML file. For multi-file bundles, rerun the CLI with --resume " + upload.id + ". Retrying does not extend the six-hour deadline." : "Recovery is unavailable while publishing, after the six-hour deadline, or after a newer revision is published. Refresh to check the current state.";
    card.appendChild(help);
    list.appendChild(card);
  }
}

function resumeUpload(upload) {
  resetReportForm();
  resumingUpload = upload;
  const details = upload.submission;
  document.getElementById("report-title").value = details.title;
  document.getElementById("report-description").value = details.description || "";
  document.getElementById("report-category").value = details.category;
  document.getElementById("report-access").value = details.access;
  document.getElementById("report-source").value = "upload";
  document.getElementById("report-files").value = "";
  window.setReportTags(details.tags || []);
  syncReportUpdateMode();
  document.getElementById("report-upload-status").textContent = `Reselect the HTML file, correct the report details, and publish by ${new Date(upload.resumeUntil).toLocaleString()}.`;
  document.getElementById("report-upload-form").scrollIntoView({ behavior: "smooth" });
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
    const resp = await fetch(`${TOKEN_API}/session`, { credentials: "include" });
    if (!resp.ok) return;
    const data = await resp.json();
    isAuthenticated = true;
    if (data.viewOnly) {
      document.getElementById("auth-status").textContent = `Signed in as ${data.email} (view only)`;
      document.getElementById("signin-link").hidden = true;
      document.getElementById("signout-link").hidden = false;
      document.getElementById("submit-link").hidden = true;
      document.getElementById("submit-signin").hidden = true;
      render();
      await loadPrivateEntries();
      return;
    }
    panel.hidden = false;
    document.getElementById("submit-signin").hidden = true;
    const submitter = document.getElementById("report-author");
    currentGithubHandle = data.githubHandle || "";
    document.getElementById("auth-status").textContent = data.githubHandle ? `Signed in as ${data.githubHandle}` : "Signed in with access token";
    document.getElementById("submit-link").href = "#admin-panel";
    document.getElementById("signin-link").hidden = true;
    document.getElementById("signout-link").hidden = false;
    submitter.value = data.githubHandle || "";
    submitter.placeholder = data.githubHandle ? "" : "GitHub sign-in required to submit";
    document.getElementById("report-upload-form").hidden = !data.githubHandle;
    document.getElementById("incomplete-uploads").hidden = !data.githubHandle;
    document.getElementById("report-oauth-required").hidden = !!data.githubHandle;
    const tokenResp = await fetch(`${TOKEN_API}/tokens`, { credentials: "include" });
    if (tokenResp.ok) renderTokenTable((await tokenResp.json()).tokens);
    render();
    loadPrivateEntries();
    initReportTagPicker();
    initReportUpload();
    if (new URLSearchParams(window.location.search).has("submit")) {
      requestAnimationFrame(() => panel.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
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

function initReportTagPicker() {
  const input = document.getElementById("report-tags");
  const suggestions = document.getElementById("report-tag-suggestions");
  if (!input || input.dataset.bound) return;
  input.dataset.bound = "true";

  const workstreamPicker = document.getElementById("report-workstreams");
  WORKSTREAMS.forEach(workstream => {
    const group = document.createElement("div");
    const label = document.createElement("strong");
    label.textContent = `${workstream.name}: `;
    group.appendChild(label);
    (workstream.match_tags || []).forEach(tag => {
      const button = document.createElement("button");
      button.type = "button"; button.className = "pill";
      button.textContent = tag; button.dataset.workstreamTag = tag.toLowerCase();
      button.addEventListener("click", () => {
        const matches = [...selectedReportTags].filter(value => value.toLowerCase() === tag.toLowerCase());
        if (matches.length) matches.forEach(value => selectedReportTags.delete(value));
        else addTag(tag);
        renderSelected();
      });
      group.appendChild(button);
    });
    workstreamPicker.appendChild(group);
  });
  function normalise(tag) { return tag.trim().replace(/\s+/g, " ").slice(0, 40); }
  function renderSelected() {
    const lowerTags = new Set([...selectedReportTags].map(tag => tag.toLowerCase()));
    let assigned = false;
    workstreamPicker.querySelectorAll("button").forEach(button => {
      const selected = lowerTags.has(button.dataset.workstreamTag);
      button.classList.toggle("active", selected);
      button.setAttribute("aria-pressed", String(selected));
      assigned = assigned || selected;
    });
    document.getElementById("report-workstream-reminder").hidden = assigned;
    const container = document.getElementById("report-selected-tags");
    container.innerHTML = "";
    selectedReportTags.forEach(tag => {
      const chip = document.createElement("button");
      chip.type = "button"; chip.className = "active-tag"; chip.title = `Remove ${tag}`;
      chip.textContent = `${tag} ×`;
      chip.addEventListener("click", () => { selectedReportTags.delete(tag); renderSelected(); showSuggestions(input.value); });
      container.appendChild(chip);
    });
  }
  function addTag(tag) {
    const clean = normalise(tag);
    if (!clean) return;
    const existing = [...selectedReportTags].find(item => item.toLowerCase() === clean.toLowerCase());
    if (!existing) selectedReportTags.add(clean);
    input.value = ""; suggestions.style.display = "none"; renderSelected();
  }
  function showSuggestions(query) {
    const q = query.trim().toLowerCase();
    const tags = getAllTags().filter(tag => ![...selectedReportTags].some(item => item.toLowerCase() === tag.toLowerCase()) && (!q || tag.toLowerCase().includes(q))).slice(0, 12);
    if (!tags.length) { suggestions.style.display = "none"; return; }
    suggestions.innerHTML = "";
    tags.forEach(tag => {
      const option = document.createElement("button");
      option.type = "button"; option.className = "tag-suggestion"; option.style.cssText = "display:block;width:100%;border:0;text-align:left;background:none";
      option.textContent = tag;
      option.addEventListener("click", () => addTag(tag));
      suggestions.appendChild(option);
    });
    suggestions.style.display = "block";
  }
  input.addEventListener("input", () => showSuggestions(input.value));
  input.addEventListener("focus", () => showSuggestions(input.value));
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" || event.key === ",") { event.preventDefault(); addTag(input.value); }
    else if (event.key === "Backspace" && !input.value && selectedReportTags.size) { selectedReportTags.delete([...selectedReportTags].pop()); renderSelected(); }
    else if (event.key === "Escape") suggestions.style.display = "none";
  });
  document.addEventListener("click", event => { if (!event.target.closest("#report-tag-picker")) suggestions.style.display = "none"; });
  window.setReportTags = tags => { selectedReportTags.clear(); (tags || []).forEach(addTag); renderSelected(); };
  renderSelected();
}

let resumingUpload = null;

function syncReportUpdateMode() {
  const metadataOnly = !!updatingReport && document.getElementById("report-update-metadata").checked;
  const external = document.getElementById("report-source").value === "external";
  document.getElementById("report-update-mode-label").hidden = !updatingReport;
  document.getElementById("report-cancel-update").hidden = !updatingReport && !resumingUpload;
  document.getElementById("report-source").disabled = metadataOnly || !!resumingUpload;
  // Visibility changes need a storage migration, not a metadata edit or revision.
  document.getElementById("report-access").disabled = !!updatingReport || !!resumingUpload?.previousPath;
  document.getElementById("report-file-label").hidden = metadataOnly || external;
  document.getElementById("report-external-url").hidden = metadataOnly || !external;
  document.getElementById("report-files").disabled = metadataOnly || external;
  document.getElementById("report-external-url").disabled = metadataOnly || !external;
  document.getElementById("report-upload-btn").textContent = resumingUpload ? "Continue submission" : metadataOnly ? "Save report info" : updatingReport ? `Publish revision ${Number(updatingReport.version || 1) + 1}` : "Upload report";
}

function resetReportForm() {
  const author = document.getElementById("report-author").value;
  document.getElementById("report-upload-form").reset();
  document.getElementById("report-author").value = author;
  window.setReportTags([]);
  updatingReport = null;
  resumingUpload = null;
  syncReportUpdateMode();
}

function initReportUpload() {
  const form = document.getElementById("report-upload-form");
  if (!form || form.dataset.bound) return;
  form.dataset.bound = "true";
  const source = document.getElementById("report-source");
  source.addEventListener("change", syncReportUpdateMode);
  document.getElementById("report-update-metadata").addEventListener("change", syncReportUpdateMode);
  document.getElementById("report-update-replacement").addEventListener("change", syncReportUpdateMode);
  document.getElementById("report-cancel-update").addEventListener("click", resetReportForm);
  syncReportUpdateMode();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = document.getElementById("report-upload-btn");
    const status = document.getElementById("report-upload-status");
    const uploadOrigin = `https://${CF_DOMAIN}`;
    const metadataOnly = !!updatingReport && document.getElementById("report-update-metadata").checked;
    if (!metadataOnly && source.value !== "external" && CF_DOMAIN && window.location.origin !== uploadOrigin) {
      const link = document.createElement("a");
      link.href = `${uploadOrigin}/admin/index.html?submit=1`;
      link.textContent = uploadOrigin;
      status.replaceChildren("Uploads are available only from ", link, ". Open that site and sign in to submit your report.");
      return;
    }
    const externalUrl = document.getElementById("report-source").value === "external" ? document.getElementById("report-external-url").value.trim() : "";
    const files = externalUrl ? [] : [...document.getElementById("report-files").files].map(file => ({ file, name: file.name, size: file.size, contentType: file.type || "text/html" }));
    const payload = {
      title: document.getElementById("report-title").value,
      category: document.getElementById("report-category").value,
      access: document.getElementById("report-access").value,
      tags: [...selectedReportTags],
      description: document.getElementById("report-description").value,
      entryFile: files[0] && files[0].name,
      externalUrl,
      parentId: updatingReport ? updatingReport.id : undefined,
      resumeId: resumingUpload ? resumingUpload.id : undefined,
      files: files.map(({ name, size, contentType }) => ({ name, size, contentType })),
    };
    button.disabled = true;
    try {
      if (metadataOnly) {
        status.textContent = "Saving report info…";
        const access = updatingReport.authenticated ? "authenticated" : "public";
        const result = await fetch(`${TOKEN_API}/reports?access=${access}&id=${encodeURIComponent(updatingReport.id)}`, {
          method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "metadata", title: payload.title, category: payload.category, tags: payload.tags, description: payload.description }),
        });
        const data = await result.json();
        if (!result.ok) throw new Error(data.error || "Could not save report info");
        status.textContent = "Report info saved. Existing report files unchanged.";
        resetReportForm();
        await loadPublicEntries(); await loadPrivateEntries();
        return;
      }
      status.textContent = "Preparing secure upload…";
      const planResponse = await fetch(`${TOKEN_API}/reports`, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const plan = await planResponse.json();
      if (!planResponse.ok) throw new Error(plan.error || "Could not prepare upload");
      if (plan.external) { status.textContent = "Published."; resetReportForm(); await loadPublicEntries(); await loadPrivateEntries(); return; }
      if (plan.resumeUntil) {
        resumingUpload = { id: plan.id, resumeUntil: Date.parse(plan.resumeUntil), previousPath: updatingReport ? "replacement" : resumingUpload?.previousPath };
        updatingReport = null;
        syncReportUpdateMode();
      }
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
      resetReportForm();
      await loadPublicEntries(); await loadPrivateEntries();
      await loadIncompleteUploads();
    } catch (error) {
      status.textContent = (error.message || "Upload failed.") + (resumingUpload ? ` You can correct the details or file and retry this submission until ${new Date(resumingUpload.resumeUntil).toLocaleString()}.` : "");
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
    <td style="padding:0.4rem"><span style="color:${t.active ? 'var(--badge-final)' : 'var(--badge-archived)'}">${t.active ? 'Active' : (t.expires && Date.parse(t.expires) <= Date.now() ? 'Expired' : 'Revoked')}</span></td>
    <td style="padding:0.4rem">${t.active ? `<button onclick="revokeToken('${escHtml(t.revokePrefix || t.id)}')" style="padding:0.2rem 0.5rem;background:none;border:1px solid var(--border);border-radius:4px;font-size:0.7rem;cursor:pointer;color:var(--text-secondary)">Revoke</button>` : ''}</td>
  </tr>`).join("");
}

async function revokeToken(prefix) {
  if (!confirm(`Revoke token ${prefix}?`)) return;
  try {
    const result = await fetch(`${TOKEN_API}/tokens`, {
      method: "DELETE", credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prefix }),
    });
    if (!result.ok) {
      const error = await result.json().catch(() => ({}));
      throw new Error(error.error || `Token revocation failed (${result.status}).`);
    }
    try {
      const resp = await fetch(`${TOKEN_API}/tokens`, { credentials: "include" });
      if (!resp.ok) throw new Error("Refresh failed");
      const data = await resp.json();
      renderTokenTable(data.tokens);
    } catch (_) {
      document.getElementById("token-tbody").innerHTML = '<tr><td colspan="7">Token revoked. Refresh the hub to reload the token list.</td></tr>';
      alert("Token revoked, but the list could not be refreshed. Refresh the hub.");
    }
  } catch (error) {
    alert(error.message || "Token revocation could not be confirmed. Refresh the hub and retry.");
  }
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
