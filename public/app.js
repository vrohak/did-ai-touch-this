import {
  agentLabel,
  ancestors,
  classifyBoxInput,
  dateGroup,
  durationLabel,
  formatUrl,
  idOf,
  matchRanges,
  matcher,
  momentLabel,
  openingSelection,
  placeLabel,
  shortId,
  spanLabel,
  timeLabel,
} from './sessions.js';

const $ = (selector) => document.querySelector(selector);

const els = {
  tree: $('#tree'),
  treePane: $('.tree-pane'),
  covHead: $('.cov-head'),
  detail: $('#detail'),
  status: $('#status-text'),
  rescan: $('#rescan'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  loadingBar: $('#loading-bar'),
  goto: $('#goto'),
  gotoInput: $('#goto-input'),
  options: { inferred: $('#opt-inferred'), searched: $('#opt-searched'), untouched: $('#opt-untouched') },
  scope: $('#scope'),
  notice: $('#notice'),
  announce: $('#announce'),
  tablist: $('.tabs'),
  tabs: { sessions: $('#tab-sessions'), detail: $('#tab-detail') },
  panels: { sessions: $('#sessions-panel'), detail: $('#detail') },
  tabCount: $('#tab-count'),
  tabName: $('#tab-name'),
  search: $('#session-search'),
  summary: $('#list-summary'),
  listScroll: $('#list-scroll'),
  list: $('#session-list'),
  listState: $('#list-state'),
  sentinel: $('#list-sentinel'),
};

const TITLE = document.title;
const KINDS = ['read', 'change', 'search'];
const LABELS = { read: 'Read', change: 'Changed', search: 'Searched' };
/** Only files are read; a change or search can be of a folder too. */
const NOUNS = { read: 'file', change: 'path', search: 'path' };
const ICONS = {
  chevron: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h3.1l1.4 1.5h5.5c.7 0 1.25.55 1.25 1.25v6.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  file: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.2l3.05 3.05v8.2c0 .7-.55 1.25-1.25 1.25H4c-.7 0-1.25-.55-1.25-1.25V3c0-.7.55-1.25 1.25-1.25z M9 1.9V5h3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};
/** List rows added to the page at a time: all 10,000 at once would make typing lag. */
const CHUNK = 100;
/** Session cards the details show at a time: a project's root can have over a thousand. */
const CARDS = 20;

const options = loadOptions();
/** Folder listings by path key. */
const listings = new Map();
/** Expanded folders by path key. */
const expanded = new Set();
/** Coverage by folder path key: 'pending' while it's counted. */
const coverage = new Map();
let status = null;
/** The index generation the tree shows. */
let generation = 0;
let rows = [];
let selected = null;
/** A path the user went to, shown even when it's untouched and untouched paths are hidden. */
let pinned = null;
let detail = null;
let detailRequest = 0;
/** The one session the app shows, as /api/session describes it, or null for all sessions. */
let scope = null;
/** The session the tree's listings are for. It runs ahead of `scope` while a new tree loads. */
let treeScope = null;
/** Bumped by each loadTree, so listings and coverage asked for an earlier tree are dropped. */
let loadToken = 0;
/** Whether loadTree is still loading; the old tree stays on screen untouched until it's done. */
let treeLoading = false;

// --- Helpers ---------------------------------------------------------------------------------

/** Thrown by a load that a newer tree has replaced. */
const STALE = new Error('Superseded by a newer view');
const rethrowStale = (err) => {
  if (err === STALE) throw err;
};

const key = (p) => (status?.windows ? p.toLowerCase() : p);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const display = (p) => (status?.windows ? p.replace(/\//g, '\\') : p);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
const countText = (kind, n) => `${plural(n, NOUNS[kind])} ${LABELS[kind].toLowerCase()}`;
/** A click that follows a link in place, rather than into a new tab or window. */
const plainClick = (ev) => ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { method: path === '/api/rescan' ? 'POST' : 'GET' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status });
  return body;
}

function loadOptions() {
  const defaults = { inferred: true, searched: false, untouched: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem('options') ?? '{}') };
  } catch {
    return defaults;
  }
}

function saveOptions() {
  try {
    localStorage.setItem('options', JSON.stringify(options));
  } catch {
    // Options just won't persist.
  }
}

function relative(iso) {
  if (!iso) return '';
  const seconds = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const steps = [
    [60, 'second'],
    [60, 'minute'],
    [24, 'hour'],
    [30, 'day'],
    [12, 'month'],
    [Infinity, 'year'],
  ];
  let value = seconds;
  for (const [size, unit] of steps) {
    if (Math.abs(value) < size) return rtf.format(Math.round(value), unit);
    value /= size;
  }
  return '';
}

const absolute = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

/** Counts and levels as the options show them: without inferred touches when those are hidden. */
function shown(counts) {
  return {
    read: options.inferred ? counts.read : counts.readExact,
    change: options.inferred ? counts.change : counts.changeExact,
    search: options.searched ? (options.inferred ? counts.search : counts.searchExact) : 0,
  };
}

const levelShown = (level, kind) => (level === 2 || (level === 1 && options.inferred)) && (kind !== 'search' || options.searched);

function isTouched(entry) {
  const c = shown(entry.counts);
  return c.read + c.change + c.search > 0;
}

/** Why counts that aren't zero show none under the options: 'inferred' or 'searched', else null. */
function hiddenReason(counts) {
  const c = shown(counts);
  if (c.read + c.change + c.search) return null;
  if (counts.read + counts.change || (options.searched && counts.search)) return 'inferred';
  return counts.search ? 'searched' : null;
}

const hiddenNote = (counts) => (hiddenReason(counts) === 'searched' ? 'only searched' : 'only inferred touches');

/** A count's tooltip, such as "12 files read (3 only inferred)". */
function countTitle(counts, kind) {
  const inferred = options.inferred ? counts[kind] - counts[`${kind}Exact`] : 0;
  return `${countText(kind, shown(counts)[kind])}${inferred > 0 ? ` (${inferred.toLocaleString()} only inferred)` : ''}`;
}

/** A chip for each kind of count the options show. */
const countChips = (counts) => {
  const c = shown(counts);
  return KINDS.filter((k) => c[k]).map((k) => `<li class="chip ${k}">${countText(k, c[k])}</li>`);
};

/** A folder's coverage as the options show it: without inferred touches when those are hidden. */
const coverageShown = (cov) => ({ read: options.inferred ? cov.read : cov.readExact, change: options.inferred ? cov.change : cov.changeExact });

/** A path's name as the tree shows it. */
const nameOf = (p) => findEntry(p)?.name ?? p.split('/').filter(Boolean).pop() ?? p;

const agentBadge = (agent) => `<span class="agent ${esc(agent)}">${esc(agentLabel(agent))}</span>`;

/** Text with the search words in it marked. */
function marked(text, words) {
  let out = '';
  let at = 0;
  for (const [start, end] of matchRanges(text, words)) {
    out += `${esc(text.slice(at, start))}<mark>${esc(text.slice(start, end))}</mark>`;
    at = end;
  }
  return out + esc(text.slice(at));
}

/** Where a session ran: its project, then its worktree. */
function placeHtml(project, worktree, words = []) {
  const place = placeLabel(project, worktree);
  if (!place) return 'no folder';
  return marked(place.name, words) + (place.worktree ? ` › ${marked(place.worktree, words)}` : '');
}

let announceTimer = 0;

/** Says something through the page's one live region. */
function announce(text) {
  clearTimeout(announceTimer);
  els.announce.textContent = '';
  // Filled a beat after emptying, so the same words twice in a row still count as news.
  announceTimer = setTimeout(() => (els.announce.textContent = text), 50);
}

// --- Loading -----------------------------------------------------------------------------------

async function loadChildren(dir, { ensure, all } = {}) {
  const token = loadToken;
  const data = await api('/api/children', { path: dir, ensure, all: all ? '1' : undefined, session: treeScope?.key });
  if (token !== loadToken) throw STALE;
  data.all = !!all;
  listings.set(key(dir), data);
  if (dir !== '') queueCoverage(data.entries.filter(hasCoverage).map((e) => e.path));
  return data;
}

/** Coverage only says something about folders on disk where files were read or changed; a whole drive is too big to count. */
function hasCoverage(entry) {
  return entry.dir && entry.onDisk && !entry.path.endsWith('/') && entry.counts.read + entry.counts.change > 0;
}

const coverageQueue = [];
let coverageActive = 0;

function queueCoverage(paths) {
  for (const p of paths) {
    if (coverage.has(key(p))) continue;
    coverage.set(key(p), 'pending');
    coverageQueue.push(p);
  }
  pumpCoverage();
}

function pumpCoverage() {
  while (coverageActive < 4 && coverageQueue.length) {
    const p = coverageQueue.shift();
    const token = loadToken;
    coverageActive++;
    api('/api/coverage', { path: p, session: treeScope?.key })
      .then((cov) => token === loadToken && coverage.set(key(p), cov))
      .catch(() => token === loadToken && coverage.set(key(p), null))
      .finally(() => {
        coverageActive--;
        // While a tree loads, the page still shows the one before; it shows this when it switches.
        if (token === loadToken && !treeLoading) {
          updateRow(p);
          if (selected && key(selected) === key(p)) renderDetail();
        }
        pumpCoverage();
      });
  }
}

/** Expands the folders down to a path, so it's in the tree. */
async function reveal(p, { expandSelf = false } = {}) {
  const chain = ['', ...ancestors(p)];
  for (const [i, dir] of chain.entries()) {
    if (dir) expanded.add(key(dir));
    const next = chain[i + 1] ?? p;
    const listing = listings.get(key(dir));
    if (!listing?.entries.some((e) => key(e.path) === key(next))) await loadChildren(dir, { ensure: next });
  }
  const self = findEntry(p);
  if (expandSelf && self?.dir) {
    expanded.add(key(p));
    if (!listings.has(key(p))) await loadChildren(p).catch(rethrowStale);
  }
  pinned = p;
}

function findEntry(p) {
  for (const listing of listings.values()) {
    const e = listing.entries.find((x) => key(x.path) === key(p));
    if (e) return e;
  }
  return null;
}

// --- Tree ------------------------------------------------------------------------------------

function visible(entry) {
  // Drives and the filesystem root (paths ending in /) always show.
  if (options.untouched || isTouched(entry) || entry.path.endsWith('/')) return true;
  return pinned !== null && (key(pinned) === key(entry.path) || key(pinned).startsWith(`${key(entry.path)}/`));
}

function renderTree() {
  // The listings already belong to the tree that's loading; the old tree stays on screen as it was until that's done.
  if (treeLoading) return;
  rows = [];
  const walk = (dir, level) => {
    const listing = listings.get(key(dir));
    if (!listing) return;
    for (const entry of listing.entries) {
      if (!visible(entry)) continue;
      rows.push({ entry, level });
      if (entry.dir && expanded.has(key(entry.path))) {
        if (listings.has(key(entry.path))) walk(entry.path, level + 1);
        else rows.push({ note: 'Loading…', level: level + 1 });
      }
    }
    if (listing.hidden && !listing.all && options.untouched) rows.push({ more: dir, hidden: listing.hidden, level });
    if (!listing.entries.length && dir !== '') rows.push({ note: listing.onDisk ? 'Empty folder' : 'Not on disk anymore', level });
  };
  walk('', 0);
  const frag = document.createDocumentFragment();
  rows.forEach((row, i) => frag.append(rowElement(row, i)));
  els.tree.replaceChildren(frag);
  markActive();
}

function rowElement(row, i) {
  const div = document.createElement('div');
  div.id = `tr-${i}`;
  div.style.setProperty('--level', row.level);
  if (row.note || row.more) {
    div.className = 'row cols more-row';
    div.innerHTML = row.more
      ? `<span class="name">${plural(row.hidden, 'more untouched entry')} · <button type="button" data-more="${esc(row.more)}">show all</button></span>`
      : `<span class="name">${esc(row.note)}</span>`;
    return div;
  }
  const e = row.entry;
  const isOpen = expanded.has(key(e.path));
  div.className = `row cols ${e.dir ? 'dir' : 'file'}${e.onDisk ? '' : ' ghost'}${isTouched(e) ? '' : ' untouched'}`;
  div.setAttribute('role', 'treeitem');
  div.setAttribute('aria-level', String(row.level + 1));
  div.setAttribute('aria-selected', String(selected !== null && key(selected) === key(e.path)));
  if (e.dir) div.setAttribute('aria-expanded', String(isOpen));
  div.dataset.path = e.path;
  const name = row.level === 0 && status?.windows ? `${e.name}\\` : e.name;
  div.setAttribute('aria-label', spokenEntry(e, name));
  // Not a button: a click on it focuses the tree, as on the rest of the row, and the keys open folders.
  const twisty = `<span class="twisty" aria-hidden="true">${e.dir ? ICONS.chevron : ''}</span>`;
  div.innerHTML =
    `<span class="name" title="${esc(display(e.path))}">${twisty}${e.dir ? ICONS.folder : ICONS.file}<span class="label">${esc(name)}</span>` +
    `${e.onDisk ? '' : '<span class="tag">not on disk</span>'}</span>${cells(e)}`;
  return div;
}

/** A tree row's name for screen readers, which can't hear what its columns, dots and bars mean. */
function spokenEntry(e, name) {
  const parts = [name];
  if (!e.onDisk) parts.push('not on disk');
  if (e.dir) {
    const c = shown(e.counts);
    parts.push(...KINDS.filter((k) => c[k]).map((k) => countText(k, c[k])));
    const cov = hasCoverage(e) ? coverage.get(key(e.path)) : null;
    if (cov && cov !== 'pending' && cov.total) {
      const s = coverageShown(cov);
      parts.push(`coverage: read ${percent(s.read, cov.total)}, changed ${percent(s.change, cov.total)}`);
    }
  } else {
    parts.push(...KINDS.filter((k) => levelShown(e.own[k], k)).map((k) => `${LABELS[k].toLowerCase()}${e.own[k] === 1 ? ', inferred' : ''}`));
  }
  return parts.join(', ');
}

function cells(e) {
  if (!e.dir) {
    return KINDS.map((k) => `<span class="num${k === 'search' ? ' col-search' : ''}">${mark(k, e.own[k])}</span>`).join('') + '<span></span>';
  }
  const c = shown(e.counts);
  const count = (k) =>
    `<span class="num count ${k}-count${c[k] ? '' : ' zero'}${k === 'search' ? ' col-search' : ''}" title="${esc(countTitle(e.counts, k))}">${c[k].toLocaleString()}</span>`;
  return count('read') + count('change') + count('search') + coverageCell(e);
}

function mark(kind, level) {
  if (!levelShown(level, kind)) return '';
  const how = level === 2 ? 'recorded by a file tool' : 'inferred from a shell command';
  return `<span class="mark ${kind}${level === 1 ? ' inferred' : ''}" title="${LABELS[kind]}, ${how}"></span>`;
}

function coverageCell(e) {
  if (!hasCoverage(e)) return '<span></span>';
  const cov = coverage.get(key(e.path));
  if (cov === undefined || cov === 'pending') return '<span class="cov pending" title="Counting files…">…</span>';
  if (!cov || cov.total === null) return '<span class="cov unknown" title="Too many files to count">—</span>';
  if (cov.total === 0) return '<span class="cov unknown" title="No files that count for coverage">—</span>';
  const { read, change } = coverageShown(cov);
  const what = `${read.toLocaleString()} and changed ${change.toLocaleString()} of the ${plural(cov.total, 'file')} on disk`;
  return `<span class="cov" title="${scope ? `This session read ${what}` : `Read ${what}`}">${bar('read', read, cov.total)}${bar('change', change, cov.total)}</span>`;
}

function bar(kind, n, total) {
  const pct = (n / total) * 100;
  return `<span class="cov-line"><span class="bar-track"><span class="bar-fill ${kind}" style="width:${n ? Math.max(pct, 2) : 0}%"></span></span><span class="pct">${percent(n, total)}</span></span>`;
}

function percent(n, total) {
  const pct = (n / total) * 100;
  if (n === 0) return '0%';
  if (pct < 1) return '<1%';
  return `${Math.round(pct)}%`;
}

function updateRow(p) {
  const i = rows.findIndex((r) => r.entry && key(r.entry.path) === key(p));
  const el = els.tree.querySelector(`[data-path="${CSS.escape(p)}"]`);
  if (i >= 0 && el) el.replaceWith(rowElement(rows[i], i));
}

async function toggle(p) {
  const entry = findEntry(p);
  if (!entry?.dir) return;
  if (expanded.has(key(p))) {
    expanded.delete(key(p));
    renderTree();
    writeUrl();
    return;
  }
  expanded.add(key(p));
  renderTree();
  writeUrl();
  if (!listings.has(key(p))) {
    try {
      await loadChildren(p);
    } catch (err) {
      if (err === STALE) return;
      expanded.delete(key(p));
      showError(err);
    }
    renderTree();
  }
}

/** Selects a path. `scroll` is where its row goes in the pane: 'center' or 'start', else only into view. */
function select(p, { scroll = null } = {}) {
  if (!selected || key(selected) !== key(p)) cardLimit = CARDS;
  selected = p;
  for (const el of els.tree.querySelectorAll('[aria-selected="true"]')) el.setAttribute('aria-selected', 'false');
  const el = els.tree.querySelector(`[data-path="${CSS.escape(p)}"]`);
  if (el) {
    el.setAttribute('aria-selected', 'true');
    el.scrollIntoView({ block: scroll ?? 'nearest' });
  }
  markActive();
  renderTabName();
  writeUrl();
  loadDetail(p);
}

/** Points the tree's aria-activedescendant at the selected row: it's how screen readers follow the selection. */
function markActive() {
  const el = selected && els.tree.querySelector(`[data-path="${CSS.escape(selected)}"]`);
  if (el) els.tree.setAttribute('aria-activedescendant', el.id);
  else els.tree.removeAttribute('aria-activedescendant');
}

function onTreeKey(ev) {
  const items = rows.filter((r) => r.entry);
  let i = items.findIndex((r) => selected && key(r.entry.path) === key(selected));
  const current = items[i];
  const go = (j) => {
    const target = items[Math.max(0, Math.min(items.length - 1, j))];
    if (target) select(target.entry.path);
  };
  switch (ev.key) {
    case 'ArrowDown':
      go(i + 1);
      break;
    case 'ArrowUp':
      go(i < 0 ? 0 : i - 1);
      break;
    case 'Home':
      go(0);
      break;
    case 'End':
      go(items.length - 1);
      break;
    case 'ArrowRight':
      if (current?.entry.dir && !expanded.has(key(current.entry.path))) toggle(current.entry.path);
      else if (current?.entry.dir) go(i + 1);
      break;
    case 'ArrowLeft':
      if (current?.entry.dir && expanded.has(key(current.entry.path))) toggle(current.entry.path);
      else if (current) {
        while (--i >= 0 && items[i].level >= current.level);
        if (i >= 0) go(i);
      }
      break;
    case 'Enter':
    case ' ':
      if (current) toggle(current.entry.path);
      break;
    default:
      return;
  }
  ev.preventDefault();
  activateTab('detail');
}

// --- Detail ------------------------------------------------------------------------------------

/** How many session cards the details show; "Show 20 more" raises it. */
let cardLimit = CARDS;
/** The cards the details can show, kept for "Show 20 more". */
let cards = { sessions: [], isDir: false };

const relevant = (s) => KINDS.some((k) => levelShown(s.levels[k], k));

async function loadDetail(p) {
  const request = ++detailRequest;
  try {
    const data = await api('/api/touches', { path: p });
    if (request !== detailRequest) return;
    detail = data;
    renderDetail();
  } catch (err) {
    if (request === detailRequest) els.detail.innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

function renderDetail() {
  // Until the selection's own details arrive, the ones on show stay.
  if (!detail || !selected || key(detail.path) !== key(selected)) return;
  const entry = findEntry(selected);
  const isDir = entry ? entry.dir : !!detail.counts && detail.counts.read + detail.counts.change > 1;
  const mine = scope ? detail.sessions.find((s) => s.key === scope.key) : null;
  const others = scope ? detail.sessions.filter((s) => s !== mine) : detail.sessions;
  const sessions = others.filter(relevant);
  const hiddenCount = others.length - sessions.length;
  cards = { sessions, isDir };
  const facts = [];
  if (!detail.onDisk) facts.push('<li class="chip">Not on disk now</li>');
  // These count every session; in a scope, the This session block says what matters.
  if (!scope) facts.push(...touchFacts(isDir));
  const more = moreLabel();

  els.detail.innerHTML = `
    <h2>${esc(nameOf(selected))}</h2>
    <div class="path-line"><code>${esc(display(selected))}</code><button type="button" class="copy" data-copy="${esc(display(selected))}" data-copied="Copied the path.">Copy</button></div>
    ${facts.length ? `<ul class="facts">${facts.join('')}</ul>` : ''}
    ${scope ? thisSession(mine, entry, isDir) : entry && hasCoverage(entry) ? coverageBox(selected) : ''}
    ${sessionsHeading(sessions.length, isDir)}
    ${sessions.length ? `<ol class="sessions">${sessions.slice(0, cardLimit).map((s) => sessionCard(s, isDir)).join('')}</ol>` : ''}
    ${more ? `<button type="button" class="more">${more}</button>` : ''}
    ${hiddenCount ? `<p class="list-note">The options above hide ${plural(hiddenCount, 'more session')}.</p>` : ''}
    <div class="legend">
      <span><span class="mark read"></span>Recorded by a file tool</span>
      <span><span class="mark read inferred"></span>Inferred from a shell command or script</span>
    </div>`;
}

/** What all sessions together did here, from the merged tree. */
function touchFacts(isDir) {
  if (detail.counts && isDir) return countChips(detail.counts);
  if (!detail.own) return [];
  return KINDS.filter((k) => levelShown(detail.own[k], k)).map((k) => `<li class="chip ${k}${detail.own[k] === 1 ? ' inferred' : ''}">${LABELS[k]}</li>`);
}

function sessionsHeading(n, isDir) {
  if (!scope) {
    if (n) return `<h3>${plural(n, 'session')} ${isDir ? 'touched files here' : 'touched this'}</h3>`;
    return `<p class="empty">No agent ${options.searched ? 'read, changed or searched' : 'read or changed'} ${isDir ? 'anything here' : 'this'}.</p>`;
  }
  if (!n) return '<p class="empty">No other session touched this.</p>';
  return `<h3>${isDir ? `Also touched files here · ${plural(n, 'other session')}` : `Also touched by ${plural(n, 'other session')}`}</h3>`;
}

/** What the session in scope did here, from its card in the all-sessions details. */
function thisSession(mine, entry, isDir) {
  let body;
  if (!mine || !relevant(mine)) {
    body = `<p class="none">This session didn't ${options.searched ? 'read, change or search' : 'read or change'} this.</p>`;
  } else if (isDir) {
    body = `<ul class="facts">${countChips(mine.counts).join('')}</ul>${entry && hasCoverage(entry) ? coverageBox(selected) : ''}`;
  } else {
    const first = momentLabel(mine.first || mine.last, scope.start);
    const last = momentLabel(mine.last, scope.start);
    const when = first === last ? `At ${esc(last)}` : `First at ${esc(first)} · last at ${esc(last)}`;
    body = `<div class="did">${didChips(mine, false)}</div>${last ? `<p class="when">${when}</p>` : ''}`;
  }
  return `<section class="this-session" aria-labelledby="this-session-title"><h3 id="this-session-title" class="eyebrow">This session</h3>${body}</section>`;
}

function coverageBox(p) {
  const cov = coverage.get(key(p));
  if (!coverage.has(key(p))) queueCoverage([p]);
  if (cov === undefined || cov === 'pending') return '<div class="coverage-box"><p class="note">Counting files on disk…</p></div>';
  if (!cov || cov.total === null) return '<div class="coverage-box"><p class="note">Too many files here to work out coverage.</p></div>';
  if (cov.total === 0) return '';
  const { read: r, change: ch } = coverageShown(cov);
  const line = (kind, n, verb) =>
    `<div class="cov-line"><span>${verb} <b>${n.toLocaleString()}</b> of ${plural(cov.total, 'file')}</span><span>${percent(n, cov.total)}</span>` +
    `<span class="bar-track"><span class="bar-fill ${kind}" style="width:${n ? Math.max((n / cov.total) * 100, 1) : 0}%"></span></span></div>`;
  const [read, changed] = scope ? ['This session read', 'It changed'] : ['Read', 'Changed'];
  return `<div class="coverage-box">${line('read', r, read)}${line('change', ch, changed)}<p class="note">Out of the files on disk now. Git-ignored files and dependency folders don't count.</p></div>`;
}

function sessionCard(s, isDir) {
  const place = s.project ? ` · in <span title="${esc(display(s.cwd ?? s.project))}">${placeHtml(s.project, s.worktree)}</span>` : '';
  return `<li class="session">
    <div class="session-title">${agentBadge(s.agent)}<span>${esc(s.title)}</span></div>
    <div class="session-meta">
      <span>Touched <time datetime="${esc(s.last)}" title="${esc(absolute(s.last))}">${esc(relative(s.last))}</time>${place}</span>
      <a class="scope-link" href="${esc(formatUrl({ session: s.key, path: selected }))}" data-session="${esc(s.key)}" aria-label="Show only this session: ${esc(s.title)}">Show only this session</a>
    </div>
    <div class="did">${didChips(s, isDir)}</div>
    <div class="resume"><code title="${esc(s.resume)}">${esc(s.resume)}</code><button type="button" class="copy" data-copy="${esc(s.resume)}" data-copied="Copied the resume command.">Copy</button></div>
  </li>`;
}

/** How a session touched a path: a chip per kind, with the tools that did it. */
function didChips(s, isDir) {
  return KINDS.filter((k) => levelShown(s.levels[k], k))
    .map((k) => {
      const what = isDir ? `${LABELS[k]} ${shown(s.counts)[k].toLocaleString()}` : LABELS[k];
      const tools = s.tools[k].slice(0, 4).map(toolName).join(', ');
      const how = s.levels[k] === 2 ? 'recorded by a file tool' : 'inferred from a shell command or script';
      return `<span class="chip ${k}${s.levels[k] === 1 ? ' inferred' : ''}" title="${esc(how)}">${what}${tools ? ` <span class="via">via ${esc(tools)}</span>` : ''}</span>`;
    })
    .join('');
}

function moreLabel() {
  const left = cards.sessions.length - cardLimit;
  return left > 0 ? `Show ${Math.min(CARDS, left)} more` : '';
}

/** Adds the next cards in place, so focus and scroll stay where they are. */
function showMoreCards(button) {
  const list = els.detail.querySelector('.sessions');
  const from = cardLimit;
  cardLimit += CARDS;
  list.insertAdjacentHTML('beforeend', cards.sessions.slice(from, cardLimit).map((s) => sessionCard(s, cards.isDir)).join(''));
  const more = moreLabel();
  if (more) {
    button.textContent = more;
    return;
  }
  list.children[from]?.querySelector('a')?.focus();
  button.remove();
}

function toolName(tool) {
  return { '>': 'output redirect', '<': 'input redirect' }[tool] ?? tool;
}

// --- Side panel tabs ---------------------------------------------------------------------------

/** Shows a side panel tab. The Sessions panel is hidden, not redrawn, so its search, scroll and highlight stay. */
function activateTab(name, { focus = false } = {}) {
  for (const [n, tab] of Object.entries(els.tabs)) {
    const on = n === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    els.panels[n].hidden = !on;
  }
  if (focus) els.tabs[name].focus();
}

function onTabKey(ev) {
  const names = Object.keys(els.tabs);
  const i = names.findIndex((n) => els.tabs[n] === ev.target);
  const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: names.length - 1 }[ev.key];
  if (i < 0 || next === undefined) return;
  ev.preventDefault();
  activateTab(names[(next + names.length) % names.length], { focus: true });
}

function renderTabName() {
  els.tabName.textContent = selected ? nameOf(selected) : 'Details';
  els.tabs.detail.title = selected ? display(selected) : '';
}

function renderTabCount() {
  const n = list.rows?.length ?? (status?.generation ? status.sessions : null);
  els.tabCount.textContent = n === null ? '' : n.toLocaleString();
}

// --- Sessions list -----------------------------------------------------------------------------

const list = {
  /** /api/sessions rows, newest first, or null until they load. */
  rows: null,
  generation: 0,
  request: 0,
  loading: false,
  error: null,
  /** Each row's date group, worked out on `day` since groups roll over at midnight. */
  groups: [],
  day: '',
  /** The search's words to mark, and in id mode the session id it names. */
  words: [],
  id: null,
  /** Indexes into rows of the sessions the search matches, and how many fall in each group. */
  matches: [],
  groupSizes: new Map(),
  /** How many matches are in the page. */
  rendered: 0,
  /** The keyboard highlight, as an index into matches, and the key that finds it again after a refresh. */
  active: -1,
  activeKey: null,
  /** A session id that a rescan is looking for. */
  lookingFor: null,
};

const optId = (s) => `opt-${s.agent}-${s.id}`;

/** Adds rows as the end of the list nears the screen. */
const sentinelObserver = new IntersectionObserver(
  (entries) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    renderChunk();
    watchSentinel();
  },
  { root: els.listScroll, rootMargin: '600px' },
);

/** Observing afresh reports the sentinel at once, so a chunk that leaves it in view brings the next. */
function watchSentinel() {
  sentinelObserver.unobserve(els.sentinel);
  if (list.rendered < list.matches.length) sentinelObserver.observe(els.sentinel);
}

/** Fetches the session list, once per index generation. */
async function loadSessions() {
  if (list.rows && list.generation === status.generation) return;
  const request = ++list.request;
  list.error = null;
  const slow = setTimeout(() => {
    list.loading = true;
    renderListState();
  }, 150);
  try {
    const data = await api('/api/sessions');
    if (request !== list.request) return;
    list.rows = data.sessions;
    list.generation = data.generation;
    list.day = '';
  } catch (err) {
    if (request !== list.request) return;
    list.error = err.message;
    if (list.rows) showError(err);
  } finally {
    clearTimeout(slow);
    if (request === list.request) list.loading = false;
  }
  if (request === list.request) applyFilter({ keep: true });
}

/**
 * Filters the list by the search. `keep` holds on to the highlight, scroll and rows in the page, as a
 * refresh or an options change should; otherwise the list starts again at its top match.
 */
function applyFilter({ keep = false } = {}) {
  if (!list.rows) {
    renderListState();
    return;
  }
  const today = new Date().toDateString();
  if (list.day !== today) {
    const now = new Date();
    list.groups = list.rows.map((r) => dateGroup(r.end, now));
    list.day = today;
  }
  const m = matcher(els.search.value);
  list.words = m.words;
  list.id = m.id;
  list.matches = [];
  list.groupSizes = new Map();
  list.rows.forEach((row, i) => {
    if (!m.test(row)) return;
    list.matches.push(i);
    const g = list.groups[i].key;
    list.groupSizes.set(g, (list.groupSizes.get(g) ?? 0) + 1);
  });
  // A highlight on the top row stays on the top row, so a session that just ended is still the one / then Enter opens.
  const found = keep && list.activeKey && list.active > 0 ? list.matches.findIndex((i) => list.rows[i].key === list.activeKey) : -1;
  const scrollTop = els.listScroll.scrollTop;
  const rendered = keep ? list.rendered : 0;
  els.list.replaceChildren();
  list.rendered = 0;
  renderChunk(Math.max(rendered, found + 1));
  setActive(Math.max(found, 0), { scroll: false });
  els.listScroll.scrollTop = keep ? scrollTop : 0;
  if (list.id && !list.matches.length && list.lookingFor !== list.id && !rescannedFor.has(list.id)) lookFor(list.id);
  renderListState();
  watchSentinel();
}

/** Adds the next chunk of matches to the page, or matches up to `upTo`, under their date groups. */
function renderChunk(upTo = 0) {
  const end = Math.min(list.matches.length, Math.max(upTo, list.rendered + CHUNK));
  const now = new Date();
  let group = els.list.lastElementChild;
  let html = '';
  for (let i = list.rendered; i < end; i++) {
    const r = list.matches[i];
    const g = list.groups[r];
    if (group?.dataset.group !== g.key) {
      if (html) group.insertAdjacentHTML('beforeend', html);
      html = '';
      els.list.insertAdjacentHTML('beforeend', groupHtml(g));
      group = els.list.lastElementChild;
    }
    html += sessionRow(list.rows[r], i, g, now);
  }
  if (html) group.insertAdjacentHTML('beforeend', html);
  list.rendered = Math.max(list.rendered, end);
}

function groupHtml(g) {
  const size = (list.groupSizes.get(g.key) ?? 0).toLocaleString();
  return (
    `<div class="sgroup" role="group" data-group="${esc(g.key)}" aria-labelledby="group-${esc(g.key)}">` +
    `<div class="group-head" role="presentation"><span id="group-${esc(g.key)}">${esc(g.label)}</span><span class="group-count">${size}</span></div></div>`
  );
}

function sessionRow(row, i, group, now) {
  const place = placeLabel(row.project, row.worktree);
  const time = timeLabel(row.end, group.key);
  const tip = [row.title, `${agentLabel(row.agent)} · ${row.id}`, `${spanLabel(row.start, row.end, now)} (${durationLabel(row.start, row.end)})`, row.project && display(row.project)];
  const when = group.key === 'today' || group.key === 'yesterday' ? `${group.label.toLowerCase()} ${time}` : time;
  const spoken = [agentLabel(row.agent), row.title, place?.name ?? 'no folder', place?.worktree && `worktree ${place.worktree}`, when, totalsText(row.counts)];
  // The tooltip sits on the hidden part: on the option, it would be read out as its description at every arrow key.
  return (
    `<a class="srow" role="option" id="${esc(optId(row))}" href="${esc(formatUrl({ session: row.key }))}" tabindex="-1" aria-selected="${scope?.key === row.key}" ` +
    `aria-setsize="${list.matches.length}" aria-posinset="${i + 1}">` +
    `<span class="visually-hidden">${esc(spoken.filter(Boolean).join(', '))}</span>` +
    `<span class="s-body" aria-hidden="true" title="${esc(tip.filter(Boolean).join('\n'))}">` +
    `<span class="s-title${row.untitled ? ' untitled' : ''}">${marked(row.title, list.words)}</span>` +
    `<span class="s-time">${esc(time)}</span>` +
    `<span class="s-where">${agentBadge(row.agent)}<span class="place">${placeHtml(row.project, row.worktree, list.words)}</span></span>` +
    `<span class="s-totals">${totalsHtml(row.counts)}</span></span></a>`
  );
}

/** A session's totals as the options show them, or why they show none. */
function totalsText(counts) {
  const c = shown(counts);
  const parts = KINDS.filter((k) => c[k]).map((k) => countText(k, c[k]));
  return parts.length ? parts.join(', ') : hiddenNote(counts);
}

function totalsHtml(counts) {
  const c = shown(counts);
  const parts = KINDS.filter((k) => c[k]).map((k) => `<span class="${k}-count">${c[k].toLocaleString()}</span> ${LABELS[k].toLowerCase()}`);
  return parts.length ? parts.join(' · ') : hiddenNote(counts);
}

/** Moves the keyboard highlight, stopping at the ends, and brings rows down to it into the page. */
function setActive(i, { scroll = true } = {}) {
  els.list.querySelector('.srow.active')?.classList.remove('active');
  if (!list.matches.length) {
    list.active = -1;
    list.activeKey = null;
    els.search.removeAttribute('aria-activedescendant');
    return;
  }
  list.active = Math.max(0, Math.min(list.matches.length - 1, i));
  if (list.active >= list.rendered) {
    renderChunk(list.active + 1);
    watchSentinel();
  }
  const row = list.rows[list.matches[list.active]];
  const el = document.getElementById(optId(row));
  list.activeKey = row.key;
  el.classList.add('active');
  els.search.setAttribute('aria-activedescendant', el.id);
  if (scroll) el.scrollIntoView({ block: 'nearest' });
}

const activeRow = () => list.rows?.[list.matches[list.active]] ?? null;

/** The summary line, the tab's count and, when there are no rows to show, why. */
function renderListState() {
  renderTabCount();
  const total = list.rows?.length ?? 0;
  const query = els.search.value.trim();
  let summary = '';
  let state = '';
  if (!list.rows) {
    if (list.error) state = `<p class="error">Couldn't load sessions: ${esc(list.error)}</p><button type="button" data-action="retry">Try again</button>`;
    else if (!status?.generation) state = "<p>Reading transcripts… Sessions show up here when that's done.</p>";
    else if (list.loading) state = '<p>Loading sessions…</p>';
  } else if (!total) {
    state =
      '<h3>No sessions yet</h3><p>Claude Code keeps transcripts in ~/.claude/projects and Codex in ~/.codex/sessions. Run one in a project, then Rescan.</p>' +
      '<button type="button" data-action="rescan">Rescan</button>';
  } else {
    if (list.id) summary = `Session with id ${shortId(list.id)}`;
    else if (query) summary = `${list.matches.length.toLocaleString()} of ${plural(total, 'session')}`;
    else summary = `${plural(total, 'session')}, newest first. Pick one to see only what it touched.`;
    if (list.matches.length) state = '';
    else if (list.id && list.lookingFor === list.id) state = `<p>Looking for session ${esc(shortId(list.id))} in new transcripts…</p>`;
    else if (list.id) state = `<p>No session with id ${esc(shortId(list.id))} on this machine.</p><button type="button" data-action="clear">Clear search</button>`;
    else {
      state =
        `<p>No sessions match "${esc(query)}". Search looks at titles, projects, worktrees, agents and session ids. ` +
        'To find who touched a file, paste its full path in the box at the top.</p><button type="button" data-action="clear">Clear search</button>';
    }
  }
  els.summary.textContent = summary;
  els.listState.innerHTML = state;
  els.listState.hidden = !state;
}

/** Looks for a session the list lacks, with findSession's one rescan; the list then shows it or says it's not here. */
async function lookFor(id) {
  list.lookingFor = id;
  let found = false;
  try {
    // The list says it's looking, so the notice above both panes would only repeat it.
    await findSession(id, { notice: false });
    found = true;
    // Found in an index newer than this tab's list, as when another tab rescanned.
    if (!list.rows?.some((r) => r.id === id)) {
      await waitForIndex();
      await loadSessions();
    }
  } catch {
    // The list says it isn't here.
  }
  if (list.lookingFor === id) list.lookingFor = null;
  renderListState();
  if (!found && list.id === id) announce(`No session with id ${shortId(id)} on this machine.`);
  if (status.generation !== generation) await refreshView().catch(showError);
}

let filterFrame = 0;
let countTimer = 0;

/** Filters once per frame however fast keys come, and says how many match once typing stops. */
function filterSoon() {
  filterFrame ||= requestAnimationFrame(() => {
    filterFrame = 0;
    applyFilter();
  });
  clearTimeout(countTimer);
  countTimer = setTimeout(() => {
    const n = list.matches.length;
    // An id that matches nothing is looked for, and that says how it went.
    if (list.rows && !(list.id && !n)) announce(`${plural(n, 'session')} ${n === 1 ? 'matches' : 'match'}`);
  }, 500);
}

const STEPS = { ArrowDown: 1, ArrowUp: -1, PageDown: 10, PageUp: -10 };

function onSearchKey(ev) {
  if (ev.isComposing) return;
  // Keys act on what's typed, even within the frame before it filters.
  if (filterFrame) {
    cancelAnimationFrame(filterFrame);
    filterFrame = 0;
    applyFilter();
  }
  const step = STEPS[ev.key];
  if (step) {
    ev.preventDefault();
    if (list.active >= 0) setActive(list.active + step);
  } else if (ev.key === 'Enter') {
    ev.preventDefault();
    const row = activeRow();
    if (row && row.key === scope?.key && !navigating) els.tree.focus();
    else if (row) navigate({ session: row.key }, { push: true });
  } else if (ev.key === 'Escape') {
    ev.preventDefault();
    // Clears first; with nothing left to clear, it does what Esc does everywhere else.
    if (els.search.value) {
      els.search.value = '';
      filterSoon();
    } else {
      leaveScope();
    }
  }
}

/** Shows the Sessions tab with its search focused and selected, ready to type over. */
function focusSearch() {
  activateTab('sessions');
  els.search.focus();
  els.search.select();
}

// --- Scope -------------------------------------------------------------------------------------

/** Shows the scope everywhere it shows: the banner and tint, the page title and labels, and the list's selected row. */
function renderScope() {
  if (scope) document.body.dataset.agent = scope.agent;
  else delete document.body.dataset.agent;
  els.scope.hidden = !scope;
  if (scope) renderBanner();
  else els.scope.replaceChildren();
  document.title = scope ? `${scope.title} · ${TITLE}` : TITLE;
  const label = scope ? `Folders and files, showing only ${scope.title}` : 'Folders and files';
  els.treePane.setAttribute('aria-label', label);
  els.tree.setAttribute('aria-label', label);
  for (const el of [els.options.untouched.closest('label'), els.covHead]) {
    el.dataset.title ??= el.title;
    el.title = scope ? el.dataset.scopedTitle : el.dataset.title;
  }
  els.list.querySelector('.srow[aria-selected="true"]')?.setAttribute('aria-selected', 'false');
  if (scope) document.getElementById(optId(scope))?.setAttribute('aria-selected', 'true');
}

function renderBanner() {
  const s = scope;
  const place = `<span class="place"${s.cwd ? ` title="${esc(display(s.cwd))}"` : ''}>${placeHtml(s.project, s.worktree)}</span>`;
  els.scope.innerHTML = `
    <h2 id="scope-title" tabindex="-1"><span class="eyebrow">Showing only</span> ${agentBadge(s.agent)} <span class="scope-name${s.untitled ? ' untitled' : ''}" title="${esc(s.title)}">${esc(s.title)}</span></h2>
    <div class="scope-actions">
      <button type="button" class="copy" data-copy="${esc(s.resume)}" data-copied="Copied the resume command." title="${esc(s.resume)}" aria-label="Copy resume command">Copy resume<span class="long"> command</span></button>
      <button type="button" class="scope-close" aria-label="All sessions" aria-keyshortcuts="Escape"><span aria-hidden="true">✕</span> All<span class="long"> sessions</span></button>
    </div>
    <p class="scope-meta">
      <span>${esc(spanLabel(s.start, s.end, new Date()))}</span> ·
      <span title="From its first transcript entry to its last, idle time included.">${esc(durationLabel(s.start, s.end))}</span> ·
      ${place} · ${scopeTotals(s.counts)}
    </p>`;
}

function scopeTotals(counts) {
  const c = shown(counts);
  const chips = KINDS.filter((k) => c[k]).map((k) => `<span class="chip ${k}" title="${esc(countTitle(counts, k))}">${c[k].toLocaleString()} ${LABELS[k].toLowerCase()}</span>`);
  if (chips.length) return `<span class="chips">${chips.join('')}</span>`;
  return hiddenReason(counts) === 'searched'
    ? `<span>Only searched. Tick Searched to see its ${plural(counts.search, 'path')}.</span>`
    : '<span>Only inferred touches. Tick Inferred to see them.</span>';
}

function scopeAnnouncement() {
  if (!scope) return 'Showing all sessions.';
  return `Showing only ${scope.title}, ${agentLabel(scope.agent)}: ${totalsText(scope.counts)}.`;
}

/** A notice in the banner's place, for a session that can't be shown. */
function showNotice(text, { dismiss = true } = {}) {
  els.notice.innerHTML = `<p>${esc(text)}</p>${dismiss ? '<button type="button" class="dismiss">Dismiss</button>' : ''}`;
  els.notice.hidden = false;
  announce(text);
}

function hideNotice() {
  els.notice.hidden = true;
  els.notice.replaceChildren();
}

// --- Navigation and URL ------------------------------------------------------------------------

/** Bumped by each navigation, so the latest one wins. */
let navToken = 0;
/** Whether a navigation is under way; the URL waits for it to finish. */
let navigating = false;
/** A rescan that finished during a navigation, which shows it once the navigation is done. */
let refreshPending = false;
let urlTimer = 0;
/** Session ids already looked for with a rescan: each gets one per page. */
const rescannedFor = new Set();

/** Where a view opens when nothing says otherwise: a session's own folder, or the start folder for all. */
const homeOf = (info) => (info ? info.opensAt : (status?.start ?? null));

/** The only reader of the URL: `session` as written, a key or a bare id, and `path`. */
function readUrl() {
  const q = new URLSearchParams(location.search);
  return { session: q.get('session') || null, path: q.get('path') || null };
}

/**
 * The only writer of the URL. A push adds a history entry, as scope changes do; otherwise the current
 * entry is replaced, at most every 250 ms. Each entry keeps its open folders and scroll for Back.
 */
function writeUrl({ push = false, now = push } = {}) {
  clearTimeout(urlTimer);
  if (!now) {
    if (!navigating) urlTimer = setTimeout(() => writeUrl({ now: true }), 250);
    return;
  }
  const home = homeOf(scope);
  const path = selected && !(home && key(selected) === key(home)) ? selected : null;
  const url = location.pathname + formatUrl({ session: scope?.key, path });
  const state = { expanded: [...expanded], scrollTop: els.tree.scrollTop };
  if (push) history.pushState(state, '', url);
  else history.replaceState(state, '', url);
}

/**
 * Shows a scope and a selection. Every scope change comes through here, and the latest call wins.
 * Without a path, it keeps the selection when the session touched it, or opens at the session's folder;
 * from the URL (`url`), no path means the view's default folder. `restore` is a history entry's open folders.
 */
async function navigate(route, { push = false, url = false, focus = null, restore = null, scrollTop = null, quiet = false } = {}) {
  const token = ++navToken;
  if (push && !navigating) writeUrl({ now: true });
  clearTimeout(urlTimer);
  // A count of search matches still to come would talk over what this shows.
  clearTimeout(countTimer);
  navigating = true;
  const focused = document.activeElement;
  const before = scope?.key ?? null;
  if (!quiet) hideNotice();
  try {
    let info = route.session && treeScope && isScope(route.session, treeScope) ? treeScope : null;
    if (route.session && !info) {
      try {
        info = await findSession(route.session);
      } catch (err) {
        if (token !== navToken) return;
        if (err.status !== 400 && err.status !== 404) throw err;
        showNotice(`No session with id ${shortId(idOf(route.session))} on this machine. Its transcript is gone, or it never read or changed a file.`);
        // A link drops the session it names; the box at the top leaves the view, and focus, as they were.
        info = url ? null : scope;
        push = false;
        focus = null;
      }
      if (token !== navToken) return;
    }
    let target = route.path && url ? await resolvePath(route.path) : route.path;
    if (token !== navToken) return;
    // Against the tree, which runs ahead of the banner while it loads, so that a click on another row meanwhile counts.
    const entering = !!info && info.key !== treeScope?.key;
    const leaving = !info && !!treeScope;
    const reload = entering || leaving || restore || generation !== status.generation || (!treeLoading && treeScope !== scope);
    // The tree is already loading this view, as when its row was clicked twice: carry on from where that lands.
    if (!reload && treeLoading && (!(await treeLoad) || token !== navToken)) return;
    if (!target) {
      if (url) target = homeOf(info);
      else if (entering) target = openingSelection({ selected, touched: touchedSelection(info.key), opensAt: info.opensAt, windows: !!status.windows });
      else target = selected ?? homeOf(info);
    }
    if (reload) {
      if (restore) {
        expanded.clear();
        for (const k of restore) expanded.add(k);
      } else if (entering) {
        expanded.clear();
      }
      // Leaving keeps the open folders; entering, or a first load, opens where the view starts.
      const reveals = !restore && (entering || !expanded.size) ? openingFolders(info) : [];
      if (!(await loadTree({ info, target, reveals, scrollTop }))) return;
    } else if (target && (!selected || key(selected) !== key(target))) {
      await reveal(target);
      if (token !== navToken) return;
      renderTree();
      select(target, { scroll: 'center' });
    }
    if (token !== navToken) return;
    const changed = (scope?.key ?? null) !== before;
    // Focus moves from where it was, or from where it was lost, but never from where the user has put it since.
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || !!active.closest('[hidden]');
    const free = lost || active === focused;
    if (focus === 'title' && changed && free) $('#scope-title')?.focus();
    else if (focus === 'tree' && free) els.tree.focus();
    else if (!focus && focused !== document.body && lost) els.tree.focus();
    if (changed && !quiet) announce(scopeAnnouncement());
    // Only a change of session adds an entry, judged by the address bar, which Back, Forward and links change too.
    const shown = readUrl().session;
    writeUrl({ push: push && !(scope ? !!shown && isScope(shown, scope) : !shown), now: true });
  } catch (err) {
    if (err !== STALE && token === navToken) showError(err);
  } finally {
    if (token === navToken) {
      navigating = false;
      // A rescan that landed meanwhile left the view a generation behind.
      if (refreshPending || generation !== status.generation) {
        refreshPending = false;
        refreshView().catch(showError);
      }
    }
  }
}

/** Shows what the URL says, as on load, Back and Forward. */
function applyUrl() {
  const state = history.state;
  return navigate(readUrl(), { url: true, restore: state?.expanded ?? null, scrollTop: state?.scrollTop ?? null });
}

function leaveScope({ focus = null } = {}) {
  if (treeScope) navigate({ session: null, path: selected }, { push: true, focus });
}

/** Whether a key or bare id names a session. */
const isScope = (ref, s) => ref === s.key || ref === s.id;

/** Whether the selection's details list a session, meaning it touched the path or something under it. */
function touchedSelection(sessionKey) {
  return !!selected && !!detail && key(detail.path) === key(selected) && detail.sessions.some((s) => s.key === sessionKey);
}

/** The folders a view opens with: its own, and in a scope those holding the files it changed, newest first. */
function openingFolders(info) {
  return [homeOf(info), ...(info ? info.changedFolders[options.inferred ? 'all' : 'exact'] : [])].filter(Boolean);
}

/** A path from a link, spelled the way this machine does, or null when it isn't a path here. */
async function resolvePath(p) {
  try {
    return (await api('/api/resolve', { path: p })).path;
  } catch {
    return null;
  }
}

/**
 * Looks a session up by key or bare id. One the index doesn't know gets a single rescan, since a session
 * that just ended may not be indexed yet. `notice` says so above both panes; otherwise it's only spoken.
 */
async function findSession(ref, { notice = true } = {}) {
  const id = idOf(ref);
  try {
    return await api('/api/session', { session: ref });
  } catch (err) {
    if (err.status !== 404 || rescannedFor.has(id)) throw err;
  }
  rescannedFor.add(id);
  const looking = `Looking for session ${shortId(id)} in new transcripts`;
  if (notice) showNotice(looking, { dismiss: false });
  else announce(looking);
  try {
    await rescan({ refresh: false });
  } finally {
    if (notice) hideNotice();
  }
  return api('/api/session', { session: ref });
}

// --- Status and startup ----------------------------------------------------------------------

function renderStatus() {
  if (!status) return;
  const { done, total } = status.progress;
  setRescanBusy(status.scanning);
  if (status.scanning) {
    els.status.textContent = total ? `Indexing ${done.toLocaleString()} of ${plural(total, 'transcript')}…` : 'Finding transcripts…';
  } else if (status.error) {
    els.status.textContent = `Indexing failed: ${status.error}`;
  } else {
    els.status.textContent = `Indexed ${relative(status.scannedAt)}`;
  }
  els.loading.hidden = status.generation > 0;
  els.loadingText.textContent = total ? `Reading ${done.toLocaleString()} of ${plural(total, 'transcript')}… The first run takes a while; later ones are quick.` : 'Finding transcripts…';
  els.loadingBar.style.width = total ? `${(done / total) * 100}%` : '0';
  renderTabCount();
}

async function waitForIndex() {
  for (;;) {
    status = await api('/api/status');
    renderStatus();
    if (!status.scanning && (status.generation > 0 || status.error)) return;
    await sleep(400);
  }
}

/** The tree load under way, or the last one: true once its tree shows, false when a newer load replaced it. */
let treeLoad = Promise.resolve(true);

/**
 * Reloads the tree for a session, or for all of them when `info` is null, and selects `target`. Folders
 * open now stay open, and `reveals` opens more first. Nothing changes on screen until all of it has
 * loaded: then the banner, the details and the tree switch to the new scope together.
 */
function loadTree(view) {
  treeLoad = buildTree(view);
  return treeLoad;
}

async function buildTree({ info, target, reveals = [], scrollTop = null }) {
  const token = ++loadToken;
  treeLoading = true;
  treeScope = info;
  generation = status.generation;
  listings.clear();
  coverage.clear();
  coverageQueue.length = 0;
  try {
    await loadChildren('');
    for (const p of reveals) await reveal(p, { expandSelf: true });
    if (target) await reveal(target);
    // Folders open before stay open, each after the folder it's in.
    const depth = (k) => k.split('/').filter(Boolean).length;
    for (const k of [...expanded].sort((a, b) => depth(a) - depth(b))) {
      const entry = findEntry(k);
      if (!entry) expanded.delete(k);
      else if (!listings.has(k)) {
        await loadChildren(entry.path).catch((err) => {
          rethrowStale(err);
          expanded.delete(k);
        });
      }
    }
  } catch (err) {
    if (err === STALE) return false;
    throw err;
  } finally {
    if (token === loadToken) treeLoading = false;
  }
  scope = info;
  renderScope();
  renderTree();
  // An open folder goes to the top, so the files under it fill the pane.
  if (target) select(target, { scroll: scrollTop !== null ? null : expanded.has(key(target)) ? 'start' : 'center' });
  if (scrollTop !== null) els.tree.scrollTop = scrollTop;
  renderDetail();
  return true;
}

let rescanning = null;

/** Shows the Rescan button as busy, without disabling it, which would drop the keyboard focus on it. */
function setRescanBusy(busy) {
  els.rescan.setAttribute('aria-disabled', String(busy));
}

/**
 * Reads new transcripts and reloads the list. Unless `refresh` is false, as when a navigation will load
 * the tree next anyway, it then shows the new index in place.
 */
async function rescan({ refresh = true } = {}) {
  rescanning ??= (async () => {
    setRescanBusy(true);
    try {
      status = await api('/api/rescan');
      while (status.scanning) {
        renderStatus();
        await sleep(400);
        status = await api('/api/status');
      }
      renderStatus();
      await loadSessions();
    } finally {
      setRescanBusy(false);
      rescanning = null;
    }
  })();
  await rescanning;
  if (refresh && status.generation !== generation) await refreshView();
}

/** A rescan the user asked for, which says when it's done, since the status line isn't read out. */
async function rescanAsked() {
  if (rescanning) return;
  try {
    await rescan();
    if (els.notice.hidden) announce(`Rescan done. ${plural(list.rows?.length ?? status.sessions, 'session')}.`);
  } catch (err) {
    showError(err);
  }
}

/** Shows a new index generation in place: the same scope, selection and open folders, with fresh counts. */
async function refreshView() {
  // A navigation under way must not be overtaken; it shows the new index when it's done.
  if (navigating) {
    refreshPending = true;
    return;
  }
  const token = navToken;
  let info = null;
  if (scope) {
    try {
      // A running session grows, and its title may arrive.
      info = await api('/api/session', { session: scope.key });
    } catch (err) {
      if (token !== navToken) return;
      if (err.status !== 404) throw err;
      showNotice("That session isn't in the index anymore. Showing all sessions.");
      await navigate({ session: null, path: selected }, { quiet: true });
      return;
    }
    if (token !== navToken) return;
  }
  await loadTree({ info, target: selected ?? homeOf(info), reveals: expanded.size ? [] : openingFolders(info) });
}

function showError(err) {
  els.status.textContent = err.message;
  announce(err.message);
}

function setOptionsClass() {
  document.body.classList.toggle('show-searched', options.searched);
}

/** Fields keys type into, which single-key shortcuts leave alone; checkboxes and buttons aren't. */
const TEXT_FIELD = 'textarea, select, input:not([type=checkbox], [type=radio], [type=button], [type=submit])';

function onKey(ev) {
  if (ev.defaultPrevented || ev.ctrlKey || ev.metaKey || ev.altKey || ev.isComposing) return;
  if (ev.target.matches?.(TEXT_FIELD)) return;
  if (ev.key === '/') {
    ev.preventDefault();
    focusSearch();
  } else if (ev.key === 'Escape' && treeScope) {
    ev.preventDefault();
    leaveScope();
  }
}

function bindUi() {
  for (const [name, input] of Object.entries(els.options)) {
    input.checked = options[name];
    input.addEventListener('change', () => {
      options[name] = input.checked;
      saveOptions();
      setOptionsClass();
      renderTree();
      renderDetail();
      if (scope) renderBanner();
      applyFilter({ keep: true });
    });
  }
  setOptionsClass();

  els.tree.addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-more]');
    if (more) {
      loadChildren(more.dataset.more, { all: true }).then(renderTree, (err) => err !== STALE && showError(err));
      return;
    }
    const row = ev.target.closest('.row[data-path]');
    if (!row) return;
    if (ev.target.closest('.twisty')) toggle(row.dataset.path);
    select(row.dataset.path);
    activateTab('detail');
  });
  els.tree.addEventListener('dblclick', (ev) => {
    const row = ev.target.closest('.row[data-path]');
    if (row && !ev.target.closest('.twisty')) toggle(row.dataset.path);
  });
  els.tree.addEventListener('keydown', onTreeKey);

  els.goto.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const raw = els.gotoInput.value.trim();
    if (!raw) return;
    const { kind, value } = classifyBoxInput(raw);
    if (kind === 'session') {
      navigate({ session: value }, { push: true, focus: 'tree' });
      return;
    }
    if (kind === 'words') {
      els.search.value = value;
      // Shown first: a hidden list can't scroll back to its top match.
      focusSearch();
      applyFilter();
      return;
    }
    try {
      const { path } = await api('/api/resolve', { path: value });
      activateTab('detail');
      await reveal(path, { expandSelf: true });
      renderTree();
      select(path, { scroll: 'center' });
      els.tree.focus();
    } catch (err) {
      if (err !== STALE) showError(err);
    }
  });

  document.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-copy]');
    if (!button) return;
    button.dataset.label ??= button.innerHTML;
    // At least as wide as it was, so a shorter label doesn't slide it out from under the pointer.
    button.style.minWidth = `${button.offsetWidth}px`;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
      if (button.dataset.copied) announce(button.dataset.copied);
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => {
      button.innerHTML = button.dataset.label;
      button.style.minWidth = '';
    }, 1200);
  });

  els.rescan.addEventListener('click', rescanAsked);

  for (const [name, tab] of Object.entries(els.tabs)) tab.addEventListener('click', () => activateTab(name));
  els.tablist.addEventListener('keydown', onTabKey);

  els.search.addEventListener('input', filterSoon);
  els.search.addEventListener('keydown', onSearchKey);
  els.list.addEventListener('mousedown', (ev) => {
    // Picking a row leaves focus where it was, such as in the search, so the arrow keys carry on from it.
    if (plainClick(ev) && ev.target.closest('.srow')) ev.preventDefault();
  });
  els.list.addEventListener('click', (ev) => {
    const el = ev.target.closest('.srow');
    if (!el || !plainClick(ev)) return;
    ev.preventDefault();
    setActive(Number(el.getAttribute('aria-posinset')) - 1, { scroll: false });
    // Even onto the session in scope: it overtakes a switch to another one still under way.
    const row = activeRow();
    if (row) navigate({ session: row.key }, { push: true });
  });
  els.listState.addEventListener('click', (ev) => {
    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (action === 'clear') {
      els.search.value = '';
      applyFilter();
      els.search.focus();
    } else if (action === 'rescan') {
      rescanAsked();
    } else if (action === 'retry') {
      // Before the first index there is no list to load, only a scan to try again.
      if (status?.generation) loadSessions();
      else rescan({ refresh: false }).then(applyUrl, showError);
    }
  });

  els.scope.addEventListener('click', (ev) => {
    if (ev.target.closest('.scope-close')) leaveScope({ focus: 'tree' });
  });
  els.notice.addEventListener('click', (ev) => {
    if (!ev.target.closest('.dismiss')) return;
    hideNotice();
    els.tree.focus();
  });
  els.detail.addEventListener('click', (ev) => {
    const link = ev.target.closest('.scope-link');
    if (link && plainClick(ev)) {
      ev.preventDefault();
      // The card is drawn away, so focus goes to the banner that names the session now shown.
      navigate({ session: link.dataset.session, path: selected }, { push: true, focus: 'title' });
      return;
    }
    const more = ev.target.closest('button.more');
    if (more) showMoreCards(more);
  });

  document.addEventListener('keydown', onKey);
  window.addEventListener('popstate', applyUrl);
}

async function main() {
  bindUi();
  activateTab(readUrl().path ? 'detail' : 'sessions');
  renderListState();
  try {
    await waitForIndex();
    if (!status.generation) {
      list.error = status.error;
      renderListState();
      return;
    }
    loadSessions();
    await applyUrl();
  } catch (err) {
    showError(err);
  }
}

main();
