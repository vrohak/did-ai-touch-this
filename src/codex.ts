import { TouchSet, type SessionPart, type TouchKind } from './model.ts';
import { toolCalls, UNKNOWN, type JsValue } from './jsargs.ts';
import { patchedFiles, type PatchedFile } from './patch.ts';
import { resolvePath, type PathEnv } from './paths.ts';
import { shellTouches, type Dialect } from './shell.ts';

const ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i;

/** The thread id in a rollout's file name, such as `rollout-2026-10-01T10-00-00-<id>.jsonl.zst`. */
export function codexThreadId(file: string): string | null {
  return ID.exec(file)?.[1] ?? null;
}

interface Payload {
  type?: string;
  id?: string;
  cwd?: string;
  parent_thread_id?: string;
  role?: string;
  name?: string;
  call_id?: string;
  arguments?: string;
  input?: string;
  output?: unknown;
  content?: { type?: string; text?: string }[];
  message?: string;
  action?: { command?: unknown; working_directory?: string };
  item?: {
    type?: string;
    status?: string;
    command?: unknown;
    cwd?: string;
    changes?: Record<string, { move_path?: string | null }>;
    content?: { text?: string }[];
  };
}

/**
 * Parses a Codex rollout. Codex's format has changed often: file changes come from FileChange
 * events or apply_patch calls, and commands from shell function calls, `exec` cells that call
 * tools from JavaScript, or CommandExecution events, depending on the version.
 */
export function parseCodex(text: string, file: string, env: PathEnv): SessionPart | null {
  const ownId = codexThreadId(file);
  if (!ownId) return null;
  const touches = new TouchSet(env);
  const patches = new Map<string, { files: PatchedFile[]; cwd: string | undefined; at: string }>();
  const part: SessionPart = { agent: 'codex', id: ownId, touches: [] };
  let subagent = false;
  let metaSeen = false;
  let cwd: string | undefined;
  let at = '';

  const exact = (kind: TouchKind, raw: string | undefined | null, tool: string, base = cwd): void => {
    const p = raw ? resolvePath(raw, base, env) : null;
    if (p) touches.add(p, kind, true, tool, at);
  };
  const shell = (command: unknown, workdir: unknown, shellName?: unknown): void => {
    const parsed = commandText(command, typeof shellName === 'string' ? shellName : undefined, env);
    if (!parsed) return;
    const dir = typeof workdir === 'string' && workdir ? (resolvePath(workdir, cwd, env) ?? cwd) : cwd;
    for (const f of shellTouches(parsed.text, parsed.dialect, dir, env)) touches.add(f.path, f.kind, false, f.tool, at);
  };
  const applyPatches = (files: PatchedFile[], base: string | undefined, when: string): void => {
    const saved = at;
    at = when;
    for (const f of files) {
      exact('change', f.path, 'apply_patch', base);
      if (f.moveTo) exact('change', f.moveTo, 'apply_patch', base);
    }
    at = saved;
  };
  const title = (text: string | undefined, rank: number): void => {
    const t = text?.trim();
    if (subagent || !t || (part.title && part.title.rank >= rank)) return;
    if (t.startsWith('<') || t.includes('# AGENTS.md instructions')) return;
    part.title = { text: t.replace(/\s+/g, ' ').slice(0, 200), rank };
  };

  for (const raw of text.split('\n')) {
    if (!raw || raw.includes('"type":"token_count"') || raw.includes('"type":"reasoning"')) continue;
    if (raw.includes('_output"')) {
      const callId = /"call_id":"([^"]+)"/.exec(raw)?.[1];
      if (!callId || !patches.has(callId)) continue;
    }
    let line: { type?: string; timestamp?: string; payload?: Payload };
    try {
      line = JSON.parse(raw);
    } catch {
      continue;
    }
    const p = line.payload ?? {};
    at = line.timestamp ?? at;
    if (at) {
      if (!part.start || at < part.start) part.start = at;
      if (!part.end || at > part.end) part.end = at;
    }

    if (line.type === 'session_meta') {
      if (metaSeen) continue;
      metaSeen = true;
      cwd = p.cwd;
      if (p.parent_thread_id) {
        part.id = p.parent_thread_id;
        subagent = true;
      }
      if (p.cwd) part.cwd = { path: p.cwd, rank: subagent ? 1 : 2 };
    } else if (line.type === 'turn_context') {
      if (p.cwd) cwd = p.cwd;
    } else if (line.type === 'response_item') {
      if (p.type === 'message' && p.role === 'user') {
        title(p.content?.find((c) => c.type === 'input_text')?.text, 0.5);
      } else if (p.type === 'function_call') {
        const args = jsonObject(p.arguments);
        if (p.name === 'apply_patch') {
          const patch = typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
          if (p.call_id) patches.set(p.call_id, { files: patchedFiles(patch), cwd, at });
        } else if (p.name === 'view_image') {
          exact('read', typeof args.path === 'string' ? args.path : undefined, 'view_image');
        } else if (p.name && /^(shell|shell_command|exec_command|container\.exec|local_shell)$/.test(p.name)) {
          shell(args.command ?? args.cmd, args.workdir ?? args.working_directory, args.shell);
        }
      } else if (p.type === 'custom_tool_call') {
        if (p.name === 'apply_patch' && p.call_id) {
          patches.set(p.call_id, { files: patchedFiles(p.input ?? ''), cwd, at });
        } else if (p.name === 'exec' && p.input) {
          for (const call of toolCalls(p.input)) {
            const arg = call.arg;
            if (!isObject(arg)) continue;
            if (call.tool === 'shell_command' || call.tool === 'exec_command') shell(known(arg.command ?? arg.cmd), known(arg.workdir), known(arg.shell));
            else if (call.tool === 'view_image') exact('read', stringOr(arg.path), 'view_image');
            // apply_patch from exec shows up as FileChange events, which say whether it applied.
          }
        }
      } else if (p.type === 'local_shell_call') {
        shell(p.action?.command, p.action?.working_directory);
      } else if (p.call_id && patches.has(p.call_id)) {
        const pending = patches.get(p.call_id)!;
        patches.delete(p.call_id);
        if (patchSucceeded(p.output)) applyPatches(pending.files, pending.cwd, pending.at);
      }
    } else if (line.type === 'event_msg') {
      const item = p.item;
      if (p.type === 'user_message') title(p.message, 1);
      if (p.type !== 'item_completed' || !item) continue;
      if (item.type === 'FileChange' && item.status !== 'failed') {
        for (const [changed, change] of Object.entries(item.changes ?? {})) {
          exact('change', changed, 'apply_patch');
          if (change?.move_path) exact('change', change.move_path, 'apply_patch');
        }
      } else if (item.type === 'CommandExecution') {
        shell(item.command, item.cwd);
      } else if (item.type === 'UserMessage') {
        title(item.content?.map((c) => c.text ?? '').join('\n'), 1);
      }
    }
  }
  // A patch whose result never arrived, such as at the end of an interrupted session, most likely applied.
  for (const pending of patches.values()) applyPatches(pending.files, pending.cwd, pending.at);
  part.touches = touches.list();
  return part;
}

/** The script a shell call runs, in the shell that runs it. */
function commandText(command: unknown, shellName: string | undefined, env: PathEnv): { text: string; dialect: Dialect } | null {
  let dialect: Dialect = shellName ? (/pwsh|powershell/i.test(shellName) ? 'pwsh' : 'bash') : env.windows ? 'pwsh' : 'bash';
  if (typeof command === 'string') return { text: command, dialect };
  if (!Array.isArray(command) || !command.every((a) => typeof a === 'string')) return null;
  const argv = command as string[];
  const exe = (argv[0] ?? '').replace(/\\/g, '/').split('/').pop()!.toLowerCase();
  if (/^(bash|sh|zsh|dash)(\.exe)?$/.test(exe)) dialect = 'bash';
  else if (/^(pwsh|powershell|cmd)(\.exe)?$/.test(exe)) dialect = 'pwsh';
  else return { text: argv.map((a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a)).join(' '), dialect: 'bash' };
  const flag = argv.findIndex((a, i) => i > 0 && /^(-\w*c|-command|\/c)$/i.test(a));
  return flag < 0 ? null : { text: argv.slice(flag + 1).join(' '), dialect };
}

function patchSucceeded(output: unknown): boolean {
  let text = typeof output === 'string' ? output : JSON.stringify(output ?? '');
  try {
    const parsed = JSON.parse(text) as { output?: string; metadata?: { exit_code?: number } };
    if (typeof parsed?.metadata?.exit_code === 'number') return parsed.metadata.exit_code === 0;
    if (typeof parsed?.output === 'string') text = parsed.output;
  } catch {
    // Plain text output.
  }
  return /^\s*Success/.test(text) || /^\s*Done!/.test(text);
}

function jsonObject(text: string | undefined): Record<string, unknown> {
  try {
    const v = JSON.parse(text ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isObject(v: JsValue): v is { [key: string]: JsValue } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function known(v: JsValue | undefined): unknown {
  return v === UNKNOWN ? undefined : v;
}

function stringOr(v: JsValue | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
