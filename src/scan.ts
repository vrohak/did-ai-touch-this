import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { claudeTranscript, parseClaude } from './claude.ts';
import { parseCodex } from './codex.ts';
import { TouchSet, type Agent, type Session, type SessionPart } from './model.ts';
import type { PathEnv } from './paths.ts';

export interface Sources {
  /** ~/.claude/projects, or the projects folder under CLAUDE_CONFIG_DIR. */
  claudeProjects: string;
  /** ~/.codex, or CODEX_HOME. */
  codexHome: string;
}

export function defaultSources(): Sources {
  return {
    claudeProjects: path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects'),
    codexHome: process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  };
}

export function defaultCacheFile(): string {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'did-ai-touch-this', 'index.json');
}

export interface Progress {
  done: number;
  total: number;
}

interface CacheEntry {
  size: number;
  mtimeMs: number;
  part: SessionPart | null;
}

interface Cache {
  version: string;
  entries: Record<string, CacheEntry>;
}

/**
 * Reads every Claude Code and Codex transcript into sessions. Parsed transcripts are cached by
 * size and modification time, so a rescan only parses new and growing transcripts; changing the
 * parsing code invalidates the cache.
 */
export async function scan(sources: Sources, cacheFile: string, env: PathEnv, onProgress: (p: Progress) => void = () => {}): Promise<Session[]> {
  const files: { agent: Agent; file: string }[] = [
    ...walk(sources.claudeProjects).filter((f) => f.endsWith('.jsonl')).map((file) => ({ agent: 'claude' as const, file })),
    ...[path.join(sources.codexHome, 'sessions'), path.join(sources.codexHome, 'archived_sessions')]
      .flatMap((dir) => walk(dir))
      .filter((f) => /[\\/]rollout-[^\\/]*\.jsonl(\.zst)?$/.test(f))
      .map((file) => ({ agent: 'codex' as const, file })),
  ];
  const version = parserVersion();
  const old = readCache(cacheFile, version);
  const entries: Record<string, CacheEntry> = {};
  let lastYield = Date.now();
  for (const [i, { agent, file }] of files.entries()) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const hit = old[file];
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) {
      entries[file] = hit;
    } else {
      entries[file] = { size: stat.size, mtimeMs: stat.mtimeMs, part: parseFile(agent, file, sources, env) };
    }
    if (Date.now() - lastYield > 100) {
      onProgress({ done: i + 1, total: files.length });
      await new Promise((resolve) => setImmediate(resolve));
      lastYield = Date.now();
    }
  }
  onProgress({ done: files.length, total: files.length });
  writeCache(cacheFile, { version, entries });
  const parts = Object.values(entries).flatMap((e) => (e.part ? [e.part] : []));
  return mergeParts(parts, codexThreadNames(sources.codexHome), env);
}

function parseFile(agent: Agent, file: string, sources: Sources, env: PathEnv): SessionPart | null {
  try {
    if (agent === 'claude') {
      const transcript = claudeTranscript(file, sources.claudeProjects);
      return transcript ? parseClaude(fs.readFileSync(file, 'utf8'), transcript, env) : null;
    }
    const buf = fs.readFileSync(file);
    const text = file.endsWith('.zst') ? zlib.zstdDecompressSync(buf).toString('utf8') : buf.toString('utf8');
    return parseCodex(text, file, env);
  } catch (err) {
    console.warn(`Skipped ${file}: ${(err as Error).message}`);
    return null;
  }
}

/** Joins the parts of each session, such as its subagents' transcripts. */
export function mergeParts(parts: SessionPart[], threadNames: Map<string, string>, env: PathEnv): Session[] {
  const merged = new Map<string, { s: Session; touches: TouchSet; titleRank: number; cwdRank: number }>();
  for (const part of parts) {
    const key = `${part.agent}:${part.id}`;
    let m = merged.get(key);
    if (!m) {
      m = { s: { agent: part.agent, id: part.id, title: '', touches: [] }, touches: new TouchSet(env), titleRank: -1, cwdRank: -1 };
      merged.set(key, m);
    }
    if (part.title && part.title.rank > m.titleRank) {
      m.s.title = part.title.text;
      m.titleRank = part.title.rank;
    }
    if (part.cwd && part.cwd.rank > m.cwdRank) {
      m.s.cwd = part.cwd.path;
      m.cwdRank = part.cwd.rank;
    }
    if (part.start && (!m.s.start || part.start < m.s.start)) m.s.start = part.start;
    if (part.end && (!m.s.end || part.end > m.s.end)) m.s.end = part.end;
    for (const t of part.touches) m.touches.add(t.path, t.kind, t.exact, t.tools, t.first, t.last);
  }
  const sessions: Session[] = [];
  for (const m of merged.values()) {
    m.s.touches = m.touches.list();
    if (m.s.agent === 'codex') m.s.title = threadNames.get(m.s.id) ?? m.s.title;
    if (!m.s.title) m.s.title = '(untitled session)';
    if (m.s.touches.length) sessions.push(m.s);
  }
  return sessions.sort((a, b) => (b.end ?? '').localeCompare(a.end ?? ''));
}

/** The names Codex gave its threads, from session_index.jsonl. */
function codexThreadNames(codexHome: string): Map<string, string> {
  const names = new Map<string, string>();
  let text = '';
  try {
    text = fs.readFileSync(path.join(codexHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    try {
      const { id, thread_name } = JSON.parse(line) as { id?: string; thread_name?: string };
      if (id && thread_name) names.set(id, thread_name);
    } catch {
      // Skip a partly written line.
    }
  }
  return names;
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.isFile()) out.push(p);
  }
  return out;
}

/** A hash of the parsing code, so changing how transcripts are read re-reads them. */
function parserVersion(): string {
  const hash = crypto.createHash('sha1');
  for (const name of ['paths.ts', 'model.ts', 'shell.ts', 'script.ts', 'patch.ts', 'jsargs.ts', 'claude.ts', 'codex.ts']) {
    hash.update(fs.readFileSync(path.join(import.meta.dirname, name)));
  }
  return hash.digest('hex');
}

function readCache(file: string, version: string): Record<string, CacheEntry> {
  try {
    const cache = JSON.parse(fs.readFileSync(file, 'utf8')) as Cache;
    return cache.version === version ? cache.entries : {};
  } catch {
    return {};
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`Couldn't write the index cache: ${(err as Error).message}`);
  }
}
