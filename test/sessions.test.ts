import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
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
  sessionIdIn,
  spanLabel,
  timeLabel,
  type SessionRow,
} from '../public/sessions.js';

const ID = '3f2a91c0-5b7e-4c1d-9a63-0e2f4b8d71aa';
const OTHER = '0193b1f4-77aa-7c3e-8d21-5be0f6a9c412';

const zero = { read: 0, readExact: 0, change: 0, changeExact: 0, search: 0, searchExact: 0 };
const row = (fields: Partial<SessionRow>): SessionRow => ({
  key: `claude:${ID}`,
  agent: 'claude',
  id: ID,
  title: 'Add discount codes at checkout',
  untitled: false,
  project: 'C:/Users/me/code/acme-shop',
  worktree: null,
  start: '2026-11-03T13:02:00.000Z',
  end: '2026-11-03T14:10:00.000Z',
  counts: zero,
  ...fields,
});

/** A local time, as the server's ISO strings are read in the browser's time zone. */
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026): string => new Date(year, month - 1, day, hour, minute).toISOString();
const now = new Date(2026, 10, 9, 10, 0);
const format = (options: Intl.DateTimeFormatOptions, iso: string): string => new Intl.DateTimeFormat(undefined, options).format(new Date(iso));
const time = (iso: string): string => format({ hour: 'numeric', minute: '2-digit' }, iso);

test('the session id is found in what both CLIs print, transcript names and links', () => {
  for (const text of [
    ID,
    ` ${ID.toUpperCase()} `,
    `claude --resume ${ID}`,
    `cd "C:\\Users\\me\\code\\acme-shop"; claude --resume ${ID}`,
    `cd "/home/me/.claude/worktrees/${OTHER}"; claude --resume ${ID}`,
    `codex resume ${ID}`,
    `${ID}.jsonl`,
    `rollout-2026-11-03T14-02-11-${ID}.jsonl`,
    `http://localhost:4477/?session=codex:${ID}&path=C:/Users/me`,
    `http://localhost:4477/?session=claude%3A${ID}&path=C%3A%2FUsers%2Fme`,
  ]) {
    assert.equal(sessionIdIn(text), ID, text);
  }
  assert.equal(sessionIdIn('checkout discount'), null);
  assert.equal(sessionIdIn(`x${ID}`), null);
  assert.equal(sessionIdIn(`cd "C:\\100%"; claude --resume ${ID}`), ID, 'text that is not percent-encoded is read as it is');
});

test('the top box tells paths from sessions from words', () => {
  for (const [text, value] of [
    ['C:\\Users\\me\\x.ts', 'C:\\Users\\me\\x.ts'],
    ['c:/Users/me', 'c:/Users/me'],
    ['/home/me/x.ts', '/home/me/x.ts'],
    ['\\\\server\\share', '\\\\server\\share'],
    ['~/code/acme-shop', '~/code/acme-shop'],
    ['  "C:\\Program Files\\x"  ', '"C:\\Program Files\\x"'],
    ["'/home/me/my repo'", "'/home/me/my repo'"],
    ['"C:\\Users\\me\\x.ts', '"C:\\Users\\me\\x.ts'],
    ['file:///C:/Users/me/x.ts', 'file:///C:/Users/me/x.ts'],
    [`C:/Users/me/.claude/projects/acme/${ID}.jsonl`, `C:/Users/me/.claude/projects/acme/${ID}.jsonl`],
  ]) {
    assert.deepEqual(classifyBoxInput(text!), { kind: 'path', value }, text);
  }
  assert.deepEqual(classifyBoxInput(`cd "C:\\Users\\me\\acme"; claude --resume ${ID}`), { kind: 'session', value: ID });
  assert.deepEqual(classifyBoxInput(`codex resume ${ID}`), { kind: 'session', value: ID });
  assert.deepEqual(classifyBoxInput(`${ID}.jsonl`), { kind: 'session', value: ID });
  assert.deepEqual(classifyBoxInput('  checkout acme '), { kind: 'words', value: 'checkout acme' });
});

test('every word must match the title, project, worktree or agent, ignoring case and accents', () => {
  const r = row({ title: 'Café menu: crème brûlée', worktree: 'Discount-Codes' });
  const matches = (q: string): boolean => matcher(q).test(r);
  assert.ok(matches('acme discount'));
  assert.ok(matches('CAFE creme'));
  assert.ok(matches('brûlée'));
  assert.ok(matches('claude code'));
  assert.ok(!matches('codex'));
  assert.ok(!matches('acme mailer'));
  // The rest of the folder path would match nearly every session.
  assert.ok(!matches('users'));
  assert.ok(matches(''));
  assert.deepEqual(matcher('  Café   ACME ').words, ['cafe', 'acme']);
});

test('id prefixes match from 6 characters, and a full id matches that session alone', () => {
  const r = row({ title: 'Untitled' });
  assert.ok(matcher('3f2a91').test(r));
  assert.ok(matcher('3F2A91C0-5B').test(r));
  assert.ok(!matcher('3f2a9').test(r));
  assert.ok(!matcher('91c0-5b').test(r));
  const exact = matcher(`claude --resume ${ID}`);
  assert.equal(exact.id, ID);
  assert.deepEqual(exact.words, []);
  assert.ok(exact.test(r));
  assert.ok(!exact.test(row({ id: OTHER })));
});

test('matches are marked where they are in the original text', () => {
  assert.deepEqual(matchRanges('Café crème', ['cafe']), [[0, 4]]);
  assert.deepEqual(matchRanges('Cafe\u0301 au lait', ['cafe']), [[0, 5]]);
  assert.deepEqual(matchRanges('plan-37 plan', ['plan', 'an-3']), [[0, 6], [8, 12]]);
  assert.deepEqual(matchRanges('acme', []), []);
});

test('dates group by rolling windows back from today, then by month', () => {
  const group = (iso: string): string => dateGroup(iso, now).key;
  assert.equal(group(at(11, 9, 0, 0)), 'today');
  assert.equal(group(at(11, 10, 9, 0)), 'today');
  assert.equal(group(at(11, 8, 23, 59)), 'yesterday');
  assert.equal(group(at(11, 8, 0, 0)), 'yesterday');
  assert.equal(group(at(11, 7, 23, 59)), 'week');
  assert.equal(group(at(11, 2, 0, 0)), 'week');
  assert.equal(group(at(11, 1, 23, 59)), 'month');
  assert.equal(group(at(10, 10, 0, 0)), 'month');
  assert.equal(group(at(10, 9, 23, 59)), '2026-10');
  assert.equal(group(at(12, 31, 12, 0, 2025)), '2025-12');
  assert.equal(dateGroup(at(10, 9), now).label, format({ month: 'long', year: 'numeric' }, at(10, 9)));
  assert.deepEqual(dateGroup(at(11, 9), now), { key: 'today', label: 'Today' });
});

test('a missing time reads as blank rather than breaking the list', () => {
  assert.equal(dateGroup('', now).key, 'undated');
  assert.equal(timeLabel('', 'today'), '');
  assert.equal(momentLabel('', at(11, 3)), '');
});

test('a row shows as much of its date as its group leaves out', () => {
  assert.equal(timeLabel(at(11, 9, 15, 10), 'today'), time(at(11, 9, 15, 10)));
  assert.equal(timeLabel(at(11, 3, 15, 10), 'week'), format({ weekday: 'short', hour: 'numeric', minute: '2-digit' }, at(11, 3, 15, 10)));
  assert.equal(timeLabel(at(9, 3, 15, 10), '2026-09'), format({ day: 'numeric', month: 'short' }, at(9, 3, 15, 10)));
});

test('a session span reads as one day and two times, or two dates', () => {
  assert.equal(spanLabel(at(11, 9, 14, 2), at(11, 9, 15, 10), now), `Today, ${time(at(11, 9, 14, 2))} – ${time(at(11, 9, 15, 10))}`);
  assert.equal(spanLabel(at(11, 8, 14, 2), at(11, 8, 14, 2), now), `Yesterday, ${time(at(11, 8, 14, 2))}`);
  const day = format({ weekday: 'short', day: 'numeric', month: 'short' }, at(11, 3));
  assert.equal(spanLabel(at(11, 3, 14, 2), at(11, 3, 15, 10), now), `${day}, ${time(at(11, 3, 14, 2))} – ${time(at(11, 3, 15, 10))}`);
  const dateTime = (iso: string): string => format({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, iso);
  assert.equal(spanLabel(at(11, 3, 14, 2), at(11, 5, 9, 10), now), `${dateTime(at(11, 3, 14, 2))} – ${dateTime(at(11, 5, 9, 10))}`);
  assert.match(spanLabel(at(12, 30, 14, 2, 2025), at(12, 30, 15, 0, 2025), now), /2025/);
  assert.doesNotMatch(spanLabel(at(11, 3, 14, 2), at(11, 5, 9, 10), now), /2026/);
});

test('a moment in a session shows its date only off the day the session started', () => {
  assert.equal(momentLabel(at(11, 3, 14, 5), at(11, 3, 14, 2)), time(at(11, 3, 14, 5)));
  assert.equal(momentLabel(at(11, 4, 9, 0), at(11, 3, 14, 2)), format({ day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }, at(11, 4, 9, 0)));
});

test('durations round down to minutes, hours and days', () => {
  const after = (ms: number): string => durationLabel('2026-11-03T14:00:00.000Z', new Date(Date.parse('2026-11-03T14:00:00.000Z') + ms).toISOString());
  const minute = 60_000;
  assert.equal(after(0), '<1 min');
  assert.equal(after(59_000), '<1 min');
  assert.equal(after(8 * minute), '8 min');
  assert.equal(after(68 * minute + 30_000), '1 h 8 min');
  assert.equal(after(120 * minute), '2 h');
  assert.equal(after((24 + 3) * 60 * minute), '1 day 3 h');
  assert.equal(after(2 * 24 * 60 * minute), '2 days');
  assert.equal(after(-minute), '<1 min');
});

test('a view round-trips through its URL, which stays readable', () => {
  const path = 'C:/Users/me/My Repo/a&b#c%d+e?.ts';
  const url = formatUrl({ session: `claude:${ID}`, path });
  assert.ok(url.startsWith(`?session=claude:${ID}&path=C:/Users/me/My%20Repo/`), url);
  const q = new URLSearchParams(url);
  assert.equal(q.get('path'), path);
  assert.equal(q.get('session'), `claude:${ID}`);
  assert.equal(new URLSearchParams(formatUrl({ path: '/home/me/x' })).get('path'), '/home/me/x');
  assert.equal(formatUrl({}), '');
  assert.equal(idOf(`codex:${ID}`), ID);
  assert.equal(idOf(ID), ID);
});

test('the folders above a path run from its root down', () => {
  assert.deepEqual(ancestors('C:/Users/me/x.ts'), ['C:/', 'C:/Users', 'C:/Users/me']);
  assert.deepEqual(ancestors('/home/me'), ['/', '/home']);
  assert.deepEqual(ancestors('C:/'), []);
  assert.deepEqual(ancestors('/'), []);
});

test('a session picked without a path keeps a selection it touched, unless that is a folder above its own', () => {
  const opensAt = 'C:/Users/me/code/acme-shop';
  const open = (selected: string | null, touched = true): string => openingSelection({ selected, touched, opensAt, windows: true });
  assert.equal(open('C:/Users/me/code/acme-shop/src/checkout.ts'), 'C:/Users/me/code/acme-shop/src/checkout.ts');
  assert.equal(open('C:/Users/me/.claude'), 'C:/Users/me/.claude', 'a folder it touched beside its own');
  assert.equal(open(opensAt), opensAt);
  assert.equal(open('C:/Users/me/code'), opensAt, 'the folder the app opens at, above every project');
  assert.equal(open('c:/users/ME'), opensAt);
  assert.equal(open('C:/'), opensAt);
  assert.equal(open('C:/Users/me/code/other/a.ts', false), opensAt, 'a path it did not touch');
  assert.equal(open(null), opensAt);
});
