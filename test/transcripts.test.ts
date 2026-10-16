import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claudeTranscript, parseClaude } from '../src/claude.ts';
import { parseCodex } from '../src/codex.ts';
import { toolCalls, UNKNOWN } from '../src/jsargs.ts';
import type { SessionPart } from '../src/model.ts';
import { patchedFiles } from '../src/patch.ts';
import { mergeParts } from '../src/scan.ts';
import { win } from './env.ts';

const jsonl = (lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n');

/** A part's touches as `kind exact|inferred path` lines. */
const summary = (part: SessionPart | null): string[] =>
  (part?.touches ?? []).map((t) => `${t.kind} ${t.exact ? 'exact' : 'inferred'} ${t.path}`).sort();

function assistant(cwd: string, ...uses: { id: string; name: string; input: Record<string, unknown> }[]) {
  return { type: 'assistant', cwd, timestamp: '2026-10-01T10:00:00.000Z', message: { content: uses.map((u) => ({ type: 'tool_use', ...u })) } };
}

test('a Claude transcript belongs to the session its file or folder is named after', () => {
  const projects = 'C:\\Users\\me\\.claude\\projects';
  assert.deepEqual(claudeTranscript(`${projects}\\C--repo\\abc.jsonl`, projects), { sessionId: 'abc', subagent: false });
  assert.deepEqual(claudeTranscript(`${projects}\\C--repo\\abc\\subagents\\agent-1.jsonl`, projects), { sessionId: 'abc', subagent: true });
});

test('Claude file tools are exact, failed calls are dropped, and shell commands are inferred', () => {
  const text = jsonl([
    { type: 'user', cwd: 'C:\\repo', timestamp: '2026-10-01T09:59:00.000Z', message: { content: 'Fix the login bug' } },
    assistant(
      'C:\\repo',
      { id: 't1', name: 'Read', input: { file_path: 'C:\\repo\\src\\login.ts' } },
      { id: 't2', name: 'Edit', input: { file_path: 'C:\\repo\\src\\login.ts', old_string: 'a', new_string: 'b' } },
      { id: 't3', name: 'Edit', input: { file_path: 'C:\\repo\\src\\other.ts', old_string: 'a', new_string: 'b' } },
      { id: 't4', name: 'Grep', input: { pattern: 'x', path: 'C:\\repo\\src' } },
      { id: 't5', name: 'Bash', input: { command: 'cat README.md' } },
      { id: 't6', name: 'Glob', input: { pattern: 'docs/**/*.md' } },
    ),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'String not found' }] } },
    { type: 'ai-title', aiTitle: 'Login bug fix' },
  ]);
  const part = parseClaude(text, { sessionId: 's1', subagent: false }, win);
  assert.deepEqual(summary(part), [
    'change exact C:/repo/src/login.ts',
    'read exact C:/repo/src/login.ts',
    'read inferred C:/repo/README.md',
    'search exact C:/repo/docs',
    'search exact C:/repo/src',
  ]);
  assert.equal(part.title?.text, 'Login bug fix');
  assert.equal(part.cwd?.path, 'C:\\repo');
});

test('a Claude session without a generated title is named by its first prompt', () => {
  const text = jsonl([
    { type: 'user', isMeta: true, message: { content: '<command-name>/init</command-name>' } },
    { type: 'user', cwd: 'C:\\repo', message: { content: [{ type: 'text', text: 'Add a dark   mode' }] } },
  ]);
  assert.equal(parseClaude(text, { sessionId: 's1', subagent: false }, win).title?.text, 'Add a dark mode');
});

const meta = (extra: Record<string, unknown> = {}) => ({ type: 'session_meta', timestamp: '2026-10-01T10:00:00.000Z', payload: { id: 'x', cwd: 'C:\\repo', ...extra } });
const FILE = 'C:\\Users\\me\\.codex\\sessions\\2026\\10\\01\\rollout-2026-10-01T10-00-00-01a0a0f7-032c-7583-9532-1f8c4295c96d.jsonl.zst';

test('Codex file changes come from FileChange events and apply_patch calls that succeeded', () => {
  const text = jsonl([
    meta(),
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'completed', changes: { 'C:\\repo\\a.ts': { type: 'update', move_path: 'C:\\repo\\b.ts' } } } } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'FileChange', status: 'failed', changes: { 'C:\\repo\\failed.ts': { type: 'add' } } } } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p1', input: '*** Begin Patch\n*** Add File: docs/new.md\n+hi\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p1', output: JSON.stringify({ output: 'Success.', metadata: { exit_code: 0 } }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p2', input: '*** Begin Patch\n*** Delete File: gone.md\n*** End Patch' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'p2', output: JSON.stringify({ output: 'error: no such file', metadata: { exit_code: 1 } }) } },
  ]);
  assert.deepEqual(summary(parseCodex(text, FILE, win)), ['change exact C:/repo/a.ts', 'change exact C:/repo/b.ts', 'change exact C:/repo/docs/new.md']);
});

test('Codex commands come from shell calls, exec cells and CommandExecution events', () => {
  const text = jsonl([
    meta(),
    { type: 'turn_context', payload: { cwd: 'C:\\repo' } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'Get-Content -Raw a.md', workdir: 'docs' }) } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'cat b.md'] }) } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'const r = await tools.exec_command({cmd: "rg -n foo src/c.ts", workdir: "C:\\\\repo"}); text(r);' } },
    { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', '-Command', 'Get-Content d.md'], cwd: 'file:///C:/repo' } } },
  ]);
  assert.deepEqual(summary(parseCodex(text, FILE, win)), [
    'read inferred C:/repo/b.md',
    'read inferred C:/repo/d.md',
    'read inferred C:/repo/docs/a.md',
    'read inferred C:/repo/src/c.ts',
  ]);
});

test("a Codex subagent's thread counts toward its parent session, which names it", () => {
  const child = parseCodex(jsonl([meta({ parent_thread_id: 'parent-1' }), { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'Review the diff' }] } } }]), FILE, win);
  assert.equal(child?.id, 'parent-1');
  assert.equal(child?.title, undefined);
  const parent = parseCodex(jsonl([meta(), { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'Ship the feature' }] } } }]), FILE, win);
  assert.equal(parent?.title?.text, 'Ship the feature');
});

test('session parts merge, and Codex thread names win over first prompts', () => {
  const parts: SessionPart[] = [
    { agent: 'codex', id: 'a', title: { text: 'first prompt', rank: 1 }, cwd: { path: 'C:\\repo', rank: 2 }, start: '2026-01-02', end: '2026-01-03', touches: [{ path: 'C:/repo/x', kind: 'read', exact: false, tools: ['cat'], first: '2026-01-02', last: '2026-01-02' }] },
    { agent: 'codex', id: 'a', cwd: { path: 'C:\\sub', rank: 1 }, start: '2026-01-01', touches: [{ path: 'C:/repo/X', kind: 'read', exact: true, tools: ['view_image'], first: '2026-01-01', last: '2026-01-01' }] },
  ];
  const [s] = mergeParts(parts, new Map([['a', 'Named thread']]), win);
  assert.equal(s!.title, 'Named thread');
  assert.equal(s!.cwd, 'C:\\repo');
  assert.equal(s!.start, '2026-01-01');
  assert.equal(s!.touches.length, 1);
  assert.deepEqual(s!.touches[0]!.tools, ['cat', 'view_image']);
  assert.equal(s!.touches[0]!.exact, true);
});

test('apply_patch patches name their files', () => {
  const patch = '*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n-x\n+y\n*** Delete File: c.ts\n*** End Patch';
  assert.deepEqual(patchedFiles(patch), [
    { path: 'a.ts', op: 'update', moveTo: 'b.ts' },
    { path: 'c.ts', op: 'delete' },
  ]);
});

test('exec cells are parsed, never run', () => {
  const calls = toolCalls('const r = await tools.shell_command({\n  command: "Get-Content \'a b.md\'", // read it\n  workdir: dir,\n  timeout_ms: 1000,\n});');
  assert.deepEqual(calls, [{ tool: 'shell_command', arg: { command: "Get-Content 'a b.md'", workdir: UNKNOWN, timeout_ms: 1000 } }]);
  assert.deepEqual(toolCalls('tools.apply_patch(`*** Begin Patch\\n${x}`)'), [{ tool: 'apply_patch', arg: UNKNOWN }]);
});
