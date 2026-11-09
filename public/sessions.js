// @ts-check
/**
 * The rules of browsing by session, free of the DOM so tests can run them: what a search matches,
 * how sessions group by date and how their times read, where a session opens, and how a session is
 * written in a URL.
 */

/** @typedef {import('../src/server.ts').SessionRow} SessionRow */

/** @type {Record<string, string>} */
const AGENTS = { claude: 'Claude Code', codex: 'Codex' };

const UUID = /(?<![0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z])/gi;

/** @param {string} agent */
export const agentLabel = (agent) => AGENTS[agent] ?? agent;

/** @param {string} id */
export const shortId = (id) => `${id.slice(0, 8)}…`;

// --- Reading what was pasted ---------------------------------------------------------------------

/**
 * The session id in pasted text: its last UUID, so a resume command's `cd` folder, a transcript file's
 * date or a link's host doesn't win over the id itself.
 * @param {string} text
 * @returns {string | null}
 */
export function sessionIdIn(text) {
  const ids = decoded(text).match(UUID);
  return ids ? ids[ids.length - 1].toLowerCase() : null;
}

/**
 * Text with any percent-encoding undone, as in a link built with encodeURIComponent, whose `%3A` would
 * otherwise run into the id after it.
 * @param {string} text
 */
function decoded(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/**
 * What the box at the top was given: a path to go to, a session to show, or words to search sessions for.
 * @param {string} text
 * @returns {{ kind: 'path' | 'session' | 'words', value: string }}
 */
export function classifyBoxInput(text) {
  const trimmed = text.trim();
  // A copied path is often quoted; /api/resolve takes the quotes off, as it does for a link's path.
  if (/^["']?(?:[a-z]:|[/\\~]|file:\/\/)/i.test(trimmed)) return { kind: 'path', value: trimmed };
  const id = sessionIdIn(trimmed);
  return id ? { kind: 'session', value: id } : { kind: 'words', value: trimmed };
}

// --- Search --------------------------------------------------------------------------------------

/**
 * Text as search compares it: lowercase, without accents.
 * @param {string} s
 */
function normalize(s) {
  return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * What search looks in. Not the full folder path, which every session shares a start of, and not the
 * files a session touched, which the box at the top finds.
 * @param {SessionRow} row
 */
function haystack(row) {
  const place = placeLabel(row.project, row.worktree);
  return normalize([row.title, place?.name, place?.worktree, agentLabel(row.agent)].filter(Boolean).join('\n'));
}

/** @type {WeakMap<SessionRow, string>} */
const haystacks = new WeakMap();

/**
 * What a search matches. A query holding a session id matches that session alone. Otherwise every word
 * must be in the row's haystack, or, as 6 or more id characters, start its id.
 * @param {string} query
 * @returns {{ id: string | null, words: string[], test: (row: SessionRow) => boolean }}
 */
export function matcher(query) {
  const id = sessionIdIn(query);
  if (id) return { id, words: [], test: (row) => row.id.toLowerCase() === id };
  const words = normalize(query).split(/\s+/).filter(Boolean);
  const test = (/** @type {SessionRow} */ row) => {
    let hay = haystacks.get(row);
    if (hay === undefined) haystacks.set(row, (hay = haystack(row)));
    const h = hay;
    return words.every((w) => h.includes(w) || (w.length >= 6 && /^[0-9a-f-]+$/.test(w) && row.id.toLowerCase().startsWith(w)));
  };
  return { id: null, words, test };
}

/**
 * Where search words occur in text, as sorted, merged [start, end) offsets into it.
 * @param {string} text
 * @param {string[]} words normalized, as `matcher` returns them
 * @returns {[number, number][]}
 */
export function matchRanges(text, words) {
  if (!words.length) return [];
  // Normalized a character at a time, so each offset in the normalized text maps back to the original.
  let folded = '';
  /** @type {number[]} */
  const at = [];
  let offset = 0;
  for (const ch of text) {
    const f = normalize(ch);
    for (let i = 0; i < f.length; i++) at.push(offset);
    folded += f;
    offset += ch.length;
  }
  at.push(text.length);
  /** @type {[number, number][]} */
  const hits = [];
  for (const w of words) {
    for (let i = folded.indexOf(w); i >= 0; i = folded.indexOf(w, i + 1)) {
      // A match ends where the next original character starts, taking in marks that normalize away.
      let end = i + w.length;
      while (end < folded.length && at[end] === at[end - 1]) end++;
      hits.push([at[i], at[end]]);
    }
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  /** @type {[number, number][]} */
  const merged = [];
  for (const [start, end] of hits) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

// --- Places --------------------------------------------------------------------------------------

/**
 * Where a session ran: its project folder's name, and its worktree's when it ran in one. Null when it
 * recorded no folder.
 * @param {string | null} project
 * @param {string | null} worktree
 * @returns {{ name: string, worktree: string | null } | null}
 */
export function placeLabel(project, worktree) {
  if (!project) return null;
  return { name: project.split('/').filter(Boolean).pop() ?? project, worktree: worktree || null };
}

/**
 * The folders above a path, from the root down: C:/Users/me/x → C:/, C:/Users, C:/Users/me.
 * @param {string} p
 * @returns {string[]}
 */
export function ancestors(p) {
  const posix = p.startsWith('/');
  const parts = p.split('/').filter(Boolean);
  if (!parts.length) return [];
  const out = [];
  let cur = posix ? '/' : `${parts.shift()}/`;
  for (const part of parts) {
    out.push(cur);
    cur = cur.endsWith('/') ? cur + part : `${cur}/${part}`;
  }
  return out;
}

/**
 * What a session picked without a path opens at: the selection, when the session touched it and it
 * isn't a folder above the session's own, where what the session did would be lost among everything
 * else; otherwise the session's own folder.
 * @param {{ selected: string | null, touched: boolean, opensAt: string, windows: boolean }} view
 */
export function openingSelection({ selected, touched, opensAt, windows }) {
  if (!selected || !touched) return opensAt;
  const key = (/** @type {string} */ p) => (windows ? p.toLowerCase() : p);
  return ancestors(opensAt).some((a) => key(a) === key(selected)) ? opensAt : selected;
}

// --- Dates ---------------------------------------------------------------------------------------

const DAY = 86_400_000;

/**
 * A date format in the browser's locale that writes a missing or malformed time as '', where Intl
 * would throw and take the whole list down with it.
 * @param {Intl.DateTimeFormatOptions} options
 */
function dateFormat(options) {
  const f = new Intl.DateTimeFormat(undefined, options);
  return { format: (/** @type {Date} */ d) => (Number.isNaN(d.getTime()) ? '' : f.format(d)) };
}

const TIME = dateFormat({ hour: 'numeric', minute: '2-digit' });
const WEEKDAY_TIME = dateFormat({ weekday: 'short', hour: 'numeric', minute: '2-digit' });
const DAY_MONTH = dateFormat({ day: 'numeric', month: 'short' });
const MONTH = dateFormat({ month: 'long', year: 'numeric' });
const WEEKDAY_DATE = dateFormat({ weekday: 'short', day: 'numeric', month: 'short' });
const WEEKDAY_DATE_YEAR = dateFormat({ weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const DATE_TIME = dateFormat({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const DATE_TIME_YEAR = dateFormat({ day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * Local calendar days from `then` to `now`: 0 on the same day, 1 the day after.
 * @param {Date} then
 * @param {Date} now
 */
function daysBetween(then, now) {
  const a = new Date(then.getFullYear(), then.getMonth(), then.getDate());
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Rounded, because a day with a daylight saving change is 23 or 25 hours long.
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

/**
 * The list's date group for a session that ended at `iso`: rolling windows back from today, then months.
 * @param {string} iso
 * @param {Date} now
 * @returns {{ key: string, label: string }}
 */
export function dateGroup(iso, now) {
  const d = new Date(iso);
  const days = daysBetween(d, now);
  if (Number.isNaN(days)) return { key: 'undated', label: 'Undated' };
  if (days <= 0) return { key: 'today', label: 'Today' };
  if (days === 1) return { key: 'yesterday', label: 'Yesterday' };
  if (days <= 7) return { key: 'week', label: 'Previous 7 days' };
  if (days <= 30) return { key: 'month', label: 'Previous 30 days' };
  return { key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTH.format(d) };
}

/**
 * A list row's time, as much of the date as its group doesn't already say.
 * @param {string} iso
 * @param {string} groupKey
 */
export function timeLabel(iso, groupKey) {
  const d = new Date(iso);
  if (groupKey === 'today' || groupKey === 'yesterday') return TIME.format(d);
  if (groupKey === 'week') return WEEKDAY_TIME.format(d);
  return DAY_MONTH.format(d);
}

/**
 * When a session ran: one day and two times when it stayed within a day, else two dates with times.
 * @param {string} start
 * @param {string} end
 * @param {Date} now
 */
export function spanLabel(start, end, now) {
  const a = new Date(start);
  const b = new Date(end);
  if (daysBetween(a, b) !== 0) return `${dateTime(a, now)} – ${dateTime(b, now)}`;
  const from = TIME.format(a);
  const to = TIME.format(b);
  return `${dayName(a, now)}, ${from === to ? from : `${from} – ${to}`}`;
}

/**
 * A moment in a session: just its time on the day the session started, else its date too.
 * @param {string} iso
 * @param {string} sessionStart
 */
export function momentLabel(iso, sessionStart) {
  const d = new Date(iso);
  const start = new Date(sessionStart);
  return daysBetween(start, d) === 0 ? TIME.format(d) : dateTime(d, start);
}

/**
 * How long a session ran, from its first transcript entry to its last.
 * @param {string} start
 * @param {string} end
 */
export function durationLabel(start, end) {
  const minutes = Math.floor((Date.parse(end) - Date.parse(start)) / 60_000);
  if (!(minutes >= 1)) return '<1 min';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}${hours % 24 ? ` ${hours % 24} h` : ''}`;
}

/**
 * @param {Date} d
 * @param {Date} now
 */
function dayName(d, now) {
  const days = daysBetween(d, now);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return (d.getFullYear() === now.getFullYear() ? WEEKDAY_DATE : WEEKDAY_DATE_YEAR).format(d);
}

/**
 * @param {Date} d
 * @param {Date} now
 */
function dateTime(d, now) {
  return (d.getFullYear() === now.getFullYear() ? DATE_TIME : DATE_TIME_YEAR).format(d);
}

// --- URLs ----------------------------------------------------------------------------------------

/**
 * The id in a `session` value, which is a key (`claude:<id>`) or a bare id.
 * @param {string} ref
 */
export const idOf = (ref) => ref.replace(/^(claude|codex):/, '');

/**
 * The query string for a view, or '' for all sessions at their default folder.
 * @param {{ session?: string | null, path?: string | null }} view
 */
export function formatUrl({ session = null, path = null }) {
  const parts = [];
  if (session) parts.push(`session=${encode(session)}`);
  if (path) parts.push(`path=${encode(path)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * Encoded, but with slashes and colons left as they are, which a query value allows, so URLs stay readable.
 * @param {string} s
 */
function encode(s) {
  return encodeURIComponent(s).replace(/%2F/g, '/').replace(/%3A/g, ':');
}
