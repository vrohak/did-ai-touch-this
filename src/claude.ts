import path from 'node:path';
import { TouchSet, type SessionPart, type TouchKind } from './model.ts';
import { globBase, looksLikeFile, resolvePath, type PathEnv } from './paths.ts';
import { shellTouches } from './shell.ts';

export interface ClaudeTranscript {
  sessionId: string;
  /** A subagent's transcript, which lives in a folder named after its parent session. */
  subagent: boolean;
}

/** Which session a transcript under ~/.claude/projects belongs to: `<project>/<session>.jsonl`, or a subagent's under `<project>/<session>/`. */
export function claudeTranscript(file: string, projectsDir: string): ClaudeTranscript | null {
  const rel = path.relative(projectsDir, file).split(/[\\/]/);
  if (rel.length < 2 || !rel[rel.length - 1]!.endsWith('.jsonl')) return null;
  if (rel.length === 2) return { sessionId: rel[1]!.replace(/\.jsonl$/, ''), subagent: false };
  return { sessionId: rel[1]!, subagent: true };
}

interface Line {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isMeta?: boolean;
  customTitle?: string;
  aiTitle?: string;
  summary?: string;
  message?: { content?: unknown };
}

interface Block {
  type?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
  tool_use_id?: string;
  is_error?: boolean;
}

const TITLE_RANKS: Record<string, number> = { 'custom-title': 4, 'ai-title': 3, summary: 2 };

export function parseClaude(text: string, transcript: ClaudeTranscript, env: PathEnv): SessionPart {
  const touches = new TouchSet(env);
  // File-tool touches wait for the tool's result: a failed edit changed nothing.
  const pending: { toolUseId: string; path: string; kind: TouchKind; tool: string; at: string }[] = [];
  const failed = new Set<string>();
  const part: SessionPart = { agent: 'claude', id: transcript.sessionId, touches: [] };

  for (const raw of text.split('\n')) {
    const wanted =
      raw.includes('"tool_use"') ||
      raw.includes('"is_error":true') ||
      raw.includes('"custom-title"') ||
      raw.includes('"ai-title"') ||
      raw.includes('"type":"summary"') ||
      (!part.cwd && raw.includes('"cwd"')) ||
      (!part.title && !transcript.subagent && raw.includes('"type":"user"'));
    if (!wanted) continue;
    let line: Line;
    try {
      line = JSON.parse(raw) as Line;
    } catch {
      continue;
    }
    const at = line.timestamp ?? '';
    if (at) {
      if (!part.start || at < part.start) part.start = at;
      if (!part.end || at > part.end) part.end = at;
    }
    if (line.cwd && !part.cwd) part.cwd = { path: line.cwd, rank: transcript.subagent ? 1 : 2 };

    const titleRank = TITLE_RANKS[line.type ?? ''];
    const titleText = line.customTitle ?? line.aiTitle ?? line.summary;
    if (titleRank && titleText && titleRank >= (part.title?.rank ?? 0)) part.title = { text: titleText, rank: titleRank };

    const content = line.message?.content;
    if (line.type === 'user' && !part.title && !transcript.subagent && !line.isMeta) {
      const prompt = promptText(content);
      if (prompt) part.title = { text: prompt, rank: 1 };
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Block[]) {
      if (block.type === 'tool_result' && block.is_error && block.tool_use_id) failed.add(block.tool_use_id);
      if (block.type !== 'tool_use' || !block.name || !block.input) continue;
      const input = block.input;
      const str = (key: string): string | undefined => (typeof input[key] === 'string' ? (input[key] as string) : undefined);
      const exact = (kind: TouchKind, raw: string | undefined, base = line.cwd): void => {
        const p = raw === undefined ? null : resolvePath(raw, base, env);
        if (p) pending.push({ toolUseId: block.id ?? '', path: p, kind, tool: block.name!, at });
      };
      switch (block.name) {
        case 'Read':
        case 'NotebookRead':
          exact('read', str('file_path') ?? str('notebook_path'));
          break;
        case 'Edit':
        case 'MultiEdit':
        case 'Write':
        case 'NotebookEdit':
          exact('change', str('file_path') ?? str('notebook_path'));
          break;
        case 'Grep': {
          const target = str('path');
          if (target && looksLikeFile(target) && !str('glob')) exact('read', target);
          else exact('search', target ?? line.cwd);
          break;
        }
        case 'Glob':
          exact('search', globBase(str('pattern') ?? ''), str('path') ? (resolvePath(str('path')!, line.cwd, env) ?? undefined) : line.cwd);
          break;
        case 'LS':
          exact('search', str('path'));
          break;
        case 'Bash':
        case 'PowerShell': {
          const command = str('command');
          if (!command) break;
          for (const f of shellTouches(command, block.name === 'Bash' ? 'bash' : 'pwsh', line.cwd, env)) touches.add(f.path, f.kind, false, f.tool, at);
          break;
        }
      }
    }
  }

  for (const t of pending) if (!failed.has(t.toolUseId)) touches.add(t.path, t.kind, true, t.tool, t.at);
  part.touches = touches.list();
  return part;
}

/** The text a person typed, or undefined for tool results and the messages Claude Code injects. */
function promptText(content: unknown): string | undefined {
  let text: string | undefined;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = (content as Block[]).find((b) => b.type === 'text' && typeof b.text === 'string')?.text;
  text = text?.trim();
  if (!text || text.startsWith('<') || text.startsWith('Caveat:') || text.startsWith('[Request interrupted')) return undefined;
  return text.replace(/\s+/g, ' ').slice(0, 200);
}
