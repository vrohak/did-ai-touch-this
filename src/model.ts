import { pathKey, type PathEnv } from './paths.ts';

export type Agent = 'claude' | 'codex';

/** read: the file's content was read. change: it was created, edited, moved or deleted. search: a folder was listed or searched, or a file's existence checked. */
export type TouchKind = 'read' | 'change' | 'search';

/** What one session did to one path, in one way. */
export interface Touch {
  path: string;
  kind: TouchKind;
  /** Recorded by a file tool, rather than inferred from a shell command or script. */
  exact: boolean;
  tools: string[];
  first: string;
  last: string;
}

/** What one transcript file says about a session; a session can span several, such as its subagents'. */
export interface SessionPart {
  agent: Agent;
  /** The id that resumes the session. */
  id: string;
  /** Higher ranks win when parts disagree: a name the user gave beats a generated one beats the first prompt. */
  title?: { text: string; rank: number };
  /** The directory the session started in; the main transcript's beats a subagent's. */
  cwd?: { path: string; rank: number };
  start?: string;
  end?: string;
  touches: Touch[];
}

export interface Session {
  agent: Agent;
  id: string;
  title: string;
  cwd?: string;
  start?: string;
  end?: string;
  touches: Touch[];
}

/** Collects touches, merging repeats of the same path and kind. */
export class TouchSet {
  private readonly byKey = new Map<string, Touch>();
  private readonly env: PathEnv;

  constructor(env: PathEnv) {
    this.env = env;
  }

  add(path: string, kind: TouchKind, exact: boolean, tools: string | string[], first: string, last = first): void {
    const key = `${kind}\0${pathKey(path, this.env)}`;
    const toolList = typeof tools === 'string' ? [tools] : tools;
    const t = this.byKey.get(key);
    if (!t) {
      this.byKey.set(key, { path, kind, exact, tools: [...new Set(toolList)], first, last });
      return;
    }
    t.exact ||= exact;
    for (const tool of toolList) if (!t.tools.includes(tool)) t.tools.push(tool);
    if (first && (!t.first || first < t.first)) t.first = first;
    if (last && last > t.last) t.last = last;
  }

  list(): Touch[] {
    return [...this.byKey.values()];
  }
}
