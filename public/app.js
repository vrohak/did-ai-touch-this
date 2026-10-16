const $ = (selector) => document.querySelector(selector);

const els = {
  tree: $('#tree'),
  detail: $('#detail'),
  status: $('#status-text'),
  rescan: $('#rescan'),
  loading: $('#loading'),
  loadingText: $('#loading-text'),
  loadingBar: $('#loading-bar'),
  goto: $('#goto'),
  gotoInput: $('#goto-input'),
  options: { inferred: $('#opt-inferred'), searched: $('#opt-searched'), untouched: $('#opt-untouched') },
};

const KINDS = ['read', 'change', 'search'];
const LABELS = { read: 'Read', change: 'Changed', search: 'Searched' };
const ICONS = {
  chevron: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.25c0-.7.55-1.25 1.25-1.25h3.1l1.4 1.5h5.5c.7 0 1.25.55 1.25 1.25v6.5c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
  file: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1.75h5.2l3.05 3.05v8.2c0 .7-.55 1.25-1.25 1.25H4c-.7 0-1.25-.55-1.25-1.25V3c0-.7.55-1.25 1.25-1.25z M9 1.9V5h3.1" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>',
};

const options = loadOptions();
/** Folder listings by path key. */
const listings = new Map();
/** Expanded folders by path key. */
const expanded = new Set();
/** Coverage by folder path key: 'pending' while it's counted. */
const coverage = new Map();
let status = null;
let generation = 0;
let rows = [];
let selected = null;
/** A path the user went to, shown even when it's untouched and untouched paths are hidden. */
let pinned = null;
let detail = null;
let detailRequest = 0;

// --- Helpers ---------------------------------------------------------------------------------

const key = (p) => (status?.windows ? p.toLowerCase() : p);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const display = (p) => (status?.windows ? p.replace(/\//g, '\\') : p);
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

async function api(path, params = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { method: path === '/api/rescan' ? 'POST' : 'GET' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? res.statusText);
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

/** The folders above a path, from the root down: C:/Users/me/x → C:/, C:/Users, C:/Users/me. */
function ancestors(p) {
  const posix = p.startsWith('/');
  const parts = p.split('/').filter(Boolean);
  const out = [];
  let cur = posix ? '/' : `${parts.shift()}/`;
  if (posix && !parts.length) return [];
  for (const part of parts) {
    out.push(cur);
    cur = cur.endsWith('/') ? cur + part : `${cur}/${part}`;
  }
  return out;
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

// --- Loading -----------------------------------------------------------------------------------

async function loadChildren(dir, { ensure, all } = {}) {
  const data = await api('/api/children', { path: dir, ensure, all: all ? '1' : undefined });
  data.all = !!all;
  listings.set(key(dir), data);
  if (dir !== '') queueCoverage(data.entries.filter(hasCoverage).map((e) => e.path));
  return data;
}

/** Coverage only says something about folders on disk where files were read or changed. */
function hasCoverage(entry) {
  return entry.dir && entry.onDisk && entry.counts.read + entry.counts.change > 0;
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
    const gen = generation;
    coverageActive++;
    api('/api/coverage', { path: p })
      .then((cov) => gen === generation && coverage.set(key(p), cov))
      .catch(() => gen === generation && coverage.set(key(p), null))
      .finally(() => {
        coverageActive--;
        if (gen === generation) {
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
    if (!listings.has(key(p))) await loadChildren(p).catch(() => {});
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
  for (const row of rows) frag.append(rowElement(row));
  els.tree.replaceChildren(frag);
}

function rowElement(row) {
  const div = document.createElement('div');
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
  const twisty = e.dir ? `<button type="button" class="twisty" tabindex="-1" aria-hidden="true">${ICONS.chevron}</button>` : '<span class="twisty"></span>';
  div.innerHTML =
    `<span class="name" title="${esc(display(e.path))}">${twisty}${e.dir ? ICONS.folder : ICONS.file}<span class="label">${esc(name)}</span>` +
    `${e.onDisk ? '' : '<span class="tag">not on disk</span>'}</span>${cells(e)}`;
  return div;
}

function cells(e) {
  if (!e.dir) {
    return KINDS.map((k) => `<span class="num${k === 'search' ? ' col-search' : ''}">${mark(k, e.own[k])}</span>`).join('') + '<span></span>';
  }
  const c = shown(e.counts);
  const inferredOnly = (k) => (options.inferred && e.counts[k] > e.counts[`${k}Exact`] ? `, ${e.counts[k] - e.counts[`${k}Exact`]} only inferred` : '');
  const count = (k, noun) =>
    `<span class="num count ${k}-count${c[k] ? '' : ' zero'}${k === 'search' ? ' col-search' : ''}" title="${plural(c[k], noun)}${inferredOnly(k)}">${c[k].toLocaleString()}</span>`;
  return count('read', 'file read') + count('change', 'path changed') + count('search', 'path searched') + coverageCell(e);
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
  const r = options.inferred ? cov.read : cov.readExact;
  const ch = options.inferred ? cov.change : cov.changeExact;
  return `<span class="cov" title="Read ${r.toLocaleString()} and changed ${ch.toLocaleString()} of the ${plural(cov.total, 'file')} on disk">${bar('read', r, cov.total)}${bar('change', ch, cov.total)}</span>`;
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
  if (i >= 0 && el) el.replaceWith(rowElement(rows[i]));
}

async function toggle(p) {
  const entry = findEntry(p);
  if (!entry?.dir) return;
  if (expanded.has(key(p))) {
    expanded.delete(key(p));
    renderTree();
    return;
  }
  expanded.add(key(p));
  renderTree();
  if (!listings.has(key(p))) {
    try {
      await loadChildren(p);
    } catch (err) {
      expanded.delete(key(p));
      showError(err);
    }
    renderTree();
  }
}

function select(p, { scroll = false } = {}) {
  selected = p;
  for (const el of els.tree.querySelectorAll('[aria-selected="true"]')) el.setAttribute('aria-selected', 'false');
  const el = els.tree.querySelector(`[data-path="${CSS.escape(p)}"]`);
  if (el) {
    el.setAttribute('aria-selected', 'true');
    if (scroll) el.scrollIntoView({ block: 'center' });
    else el.scrollIntoView({ block: 'nearest' });
  }
  loadDetail(p);
}

// --- Detail ------------------------------------------------------------------------------------

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
  if (!detail || !selected) return;
  const entry = findEntry(selected);
  const isDir = entry ? entry.dir : !!detail.counts && detail.counts.read + detail.counts.change > 1;
  const name = entry?.name ?? selected.split('/').filter(Boolean).pop() ?? selected;
  const facts = [];
  if (!detail.onDisk) facts.push('<li class="chip">Not on disk now</li>');
  if (detail.counts && isDir) {
    const c = shown(detail.counts);
    if (c.read) facts.push(`<li class="chip read">${plural(c.read, 'file')} read</li>`);
    if (c.change) facts.push(`<li class="chip change">${plural(c.change, 'path')} changed</li>`);
    if (c.search) facts.push(`<li class="chip search">${plural(c.search, 'path')} searched</li>`);
  } else if (detail.own) {
    for (const k of KINDS) if (levelShown(detail.own[k], k)) facts.push(`<li class="chip ${k}${detail.own[k] === 1 ? ' inferred' : ''}">${LABELS[k]}</li>`);
  }

  const relevant = (s) => KINDS.some((k) => levelShown(s.levels[k], k));
  const sessions = detail.sessions.filter(relevant);
  const hiddenCount = detail.sessions.length - sessions.length;

  els.detail.innerHTML = `
    <h2>${esc(name)}</h2>
    <div class="path-line"><code>${esc(display(selected))}</code><button type="button" class="copy" data-copy="${esc(display(selected))}">Copy</button></div>
    ${facts.length ? `<ul class="facts">${facts.join('')}</ul>` : ''}
    ${entry && hasCoverage(entry) ? coverageBox(selected) : ''}
    ${
      sessions.length
        ? `<h3>${plural(sessions.length, 'session')} ${isDir ? 'touched files here' : 'touched this'}</h3><ol class="sessions">${sessions.map((s) => sessionCard(s, isDir)).join('')}</ol>`
        : `<p class="empty">No agent ${options.searched ? 'read, changed or searched' : 'read or changed'} ${isDir ? 'anything here' : 'this'}.</p>`
    }
    ${hiddenCount ? `<p class="list-note">The options above hide ${plural(hiddenCount, 'more session')}.</p>` : ''}
    <div class="legend">
      <span><span class="mark read"></span>Recorded by a file tool</span>
      <span><span class="mark read inferred"></span>Inferred from a shell command or script</span>
    </div>`;
}

function coverageBox(p) {
  const cov = coverage.get(key(p));
  if (!coverage.has(key(p))) queueCoverage([p]);
  if (cov === undefined || cov === 'pending') return '<div class="coverage-box"><p class="note">Counting files on disk…</p></div>';
  if (!cov || cov.total === null) return '<div class="coverage-box"><p class="note">Too many files here to work out coverage.</p></div>';
  if (cov.total === 0) return '';
  const r = options.inferred ? cov.read : cov.readExact;
  const ch = options.inferred ? cov.change : cov.changeExact;
  const line = (kind, n, verb) =>
    `<div class="cov-line"><span>${verb} <b>${n.toLocaleString()}</b> of ${plural(cov.total, 'file')}</span><span>${percent(n, cov.total)}</span>` +
    `<span class="bar-track"><span class="bar-fill ${kind}" style="width:${n ? Math.max((n / cov.total) * 100, 1) : 0}%"></span></span></div>`;
  return `<div class="coverage-box">${line('read', r, 'Read')}${line('change', ch, 'Changed')}<p class="note">Out of the files on disk now. Git-ignored files and dependency folders don't count.</p></div>`;
}

function sessionCard(s, isDir) {
  const agent = s.agent === 'claude' ? 'Claude Code' : 'Codex';
  const did = KINDS.filter((k) => levelShown(s.levels[k], k))
    .map((k) => {
      const what = isDir ? `${LABELS[k]} ${(options.inferred ? s.counts : s.exactCounts)[k].toLocaleString()}` : LABELS[k];
      const tools = s.tools[k].slice(0, 4).map(toolName).join(', ');
      const how = s.levels[k] === 2 ? 'recorded by a file tool' : 'inferred from a shell command or script';
      return `<span class="chip ${k}${s.levels[k] === 1 ? ' inferred' : ''}" title="${esc(how)}">${what}${tools ? ` <span class="via">via ${esc(tools)}</span>` : ''}</span>`;
    })
    .join('');
  return `<li class="session">
    <div class="session-title"><span class="agent ${s.agent}">${agent}</span><span>${esc(s.title)}</span></div>
    <div class="session-meta">Touched <time datetime="${esc(s.last)}" title="${esc(absolute(s.last))}">${esc(relative(s.last))}</time>${s.cwd ? ` · in <span title="${esc(s.cwd)}">${esc(s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd)}</span>` : ''}</div>
    <div class="did">${did}</div>
    <div class="resume"><code title="${esc(s.resume)}">${esc(s.resume)}</code><button type="button" class="copy" data-copy="${esc(s.resume)}">Copy</button></div>
  </li>`;
}

function toolName(tool) {
  return { '>': 'output redirect', '<': 'input redirect' }[tool] ?? tool;
}

// --- Status and startup ----------------------------------------------------------------------

function renderStatus() {
  if (!status) return;
  const { done, total } = status.progress;
  els.rescan.disabled = status.scanning;
  if (status.scanning) {
    els.status.textContent = total ? `Indexing ${done.toLocaleString()} of ${plural(total, 'transcript')}…` : 'Finding transcripts…';
  } else if (status.error) {
    els.status.textContent = `Indexing failed: ${status.error}`;
  } else {
    els.status.textContent = `${plural(status.sessions.claude, 'Claude Code session')} · ${plural(status.sessions.codex, 'Codex session')} · indexed ${relative(status.scannedAt)}`;
  }
  els.loading.hidden = status.generation > 0;
  els.loadingText.textContent = total ? `Reading ${done.toLocaleString()} of ${plural(total, 'transcript')}… The first run takes a while; later ones are quick.` : 'Finding transcripts…';
  els.loadingBar.style.width = total ? `${(done / total) * 100}%` : '0';
}

async function waitForIndex() {
  for (;;) {
    status = await api('/api/status');
    renderStatus();
    if (!status.scanning && (status.generation > 0 || status.error)) return;
    await sleep(400);
  }
}

async function loadTree({ keep = false } = {}) {
  generation = status.generation;
  listings.clear();
  coverage.clear();
  coverageQueue.length = 0;
  if (!keep) expanded.clear();
  const target = keep && selected ? selected : status.start;
  await loadChildren('');
  if (target) await reveal(target, { expandSelf: !keep });
  // Folders open before a rescan stay open, parents first.
  for (const k of [...expanded]) {
    const entry = findEntry(k);
    if (!entry) expanded.delete(k);
    else if (!listings.has(k)) await loadChildren(entry.path).catch(() => expanded.delete(k));
  }
  renderTree();
  if (target) select(target, { scroll: true });
}

async function rescan() {
  els.rescan.disabled = true;
  try {
    status = await api('/api/rescan');
    const before = generation;
    while (status.scanning) {
      renderStatus();
      await sleep(400);
      status = await api('/api/status');
    }
    renderStatus();
    if (status.generation !== before) await loadTree({ keep: true });
  } catch (err) {
    showError(err);
  } finally {
    els.rescan.disabled = false;
  }
}

function showError(err) {
  els.status.textContent = err.message;
}

function setOptionsClass() {
  document.body.classList.toggle('show-searched', options.searched);
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
    });
  }
  setOptionsClass();

  els.tree.addEventListener('click', (ev) => {
    const more = ev.target.closest('[data-more]');
    if (more) {
      loadChildren(more.dataset.more, { all: true }).then(renderTree, showError);
      return;
    }
    const row = ev.target.closest('.row[data-path]');
    if (!row) return;
    if (ev.target.closest('.twisty')) toggle(row.dataset.path);
    select(row.dataset.path);
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
    try {
      const { path } = await api('/api/resolve', { path: raw });
      await reveal(path, { expandSelf: true });
      renderTree();
      select(path, { scroll: true });
      els.tree.focus();
    } catch (err) {
      showError(err);
    }
  });

  document.addEventListener('click', async (ev) => {
    const button = ev.target.closest('[data-copy]');
    if (!button) return;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
    setTimeout(() => (button.textContent = 'Copy'), 1200);
  });

  els.rescan.addEventListener('click', rescan);
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
}

async function main() {
  bindUi();
  try {
    await waitForIndex();
    if (status.generation > 0) await loadTree();
  } catch (err) {
    showError(err);
  }
}

main();
