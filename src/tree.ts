import type { Session, TouchKind } from './model.ts';
import { joinPath, pathKey, splitPath, type PathEnv } from './paths.ts';

export const KINDS: readonly TouchKind[] = ['read', 'change', 'search'];

/** 0: untouched, 1: only inferred from shell commands, 2: recorded by a file tool. */
export type Level = 0 | 1 | 2;

/** Paths at or under a node with each kind of touch, in all and only from file tools. */
export interface Counts {
  read: number;
  readExact: number;
  change: number;
  changeExact: number;
  search: number;
  searchExact: number;
}

interface Hit {
  session: number;
  kind: TouchKind;
  exact: boolean;
  tools: string[];
  first: string;
  last: string;
}

export interface TreeNode {
  name: string;
  path: string;
  children: Map<string, TreeNode>;
  own: Record<TouchKind, Level>;
  hits: Hit[];
  counts: Counts;
}

/** What one session did at or under a path. */
export interface SessionActivity {
  session: Session;
  /** How the session touched the path itself, or anything under it. */
  levels: Record<TouchKind, Level>;
  tools: Record<TouchKind, string[]>;
  /** Paths under it with each kind of touch, in all and only from file tools. */
  counts: Record<TouchKind, number>;
  exactCounts: Record<TouchKind, number>;
  first: string;
  last: string;
}

/** Every path the sessions touched, as a tree with per-folder counts. */
export class TouchTree {
  readonly root: TreeNode = newNode('', '');
  readonly sessions: Session[];
  private readonly env: PathEnv;

  constructor(sessions: Session[], env: PathEnv) {
    this.sessions = sessions;
    this.env = env;
    sessions.forEach((s, i) => {
      for (const t of s.touches) {
        const node = this.ensure(t.path);
        node.hits.push({ session: i, kind: t.kind, exact: t.exact, tools: t.tools, first: t.first, last: t.last });
        node.own[t.kind] = Math.max(node.own[t.kind], t.exact ? 2 : 1) as Level;
      }
    });
    settle(this.root);
  }

  find(path: string): TreeNode | undefined {
    if (path === '') return this.root;
    let node: TreeNode | undefined = this.root;
    for (const part of splitPath(path)) {
      node = node.children.get(pathKey(part, this.env));
      if (!node) return undefined;
    }
    return node;
  }

  *nodesUnder(node: TreeNode): Generator<TreeNode> {
    const stack = [node];
    while (stack.length) {
      const n = stack.pop()!;
      yield n;
      for (const c of n.children.values()) stack.push(c);
    }
  }

  /** Where the tree opens: the deepest folder holding nearly all read and changed paths. */
  start(): string {
    let node = this.root;
    for (;;) {
      const total = node.counts.read + node.counts.change;
      const next = [...node.children.values()].find((c) => c.counts.read + c.counts.change >= total * 0.9);
      if (!next || total === 0) break;
      node = next;
    }
    return node.path;
  }

  /** The sessions that touched a path or anything under it, most recent first. */
  activity(node: TreeNode): SessionActivity[] {
    const bySession = new Map<number, SessionActivity>();
    for (const n of this.nodesUnder(node)) {
      for (const h of n.hits) {
        let a = bySession.get(h.session);
        if (!a) {
          a = {
            session: this.sessions[h.session]!,
            levels: { read: 0, change: 0, search: 0 },
            tools: { read: [], change: [], search: [] },
            counts: { read: 0, change: 0, search: 0 },
            exactCounts: { read: 0, change: 0, search: 0 },
            first: h.first,
            last: h.last,
          };
          bySession.set(h.session, a);
        }
        a.levels[h.kind] = Math.max(a.levels[h.kind], h.exact ? 2 : 1) as Level;
        a.counts[h.kind]++;
        if (h.exact) a.exactCounts[h.kind]++;
        for (const tool of h.tools) if (!a.tools[h.kind].includes(tool)) a.tools[h.kind].push(tool);
        if (h.first && h.first < a.first) a.first = h.first;
        if (h.last > a.last) a.last = h.last;
      }
    }
    return [...bySession.values()].sort((a, b) => b.last.localeCompare(a.last));
  }

  private ensure(path: string): TreeNode {
    let node = this.root;
    for (const part of splitPath(path)) {
      const key = pathKey(part, this.env);
      let child = node.children.get(key);
      if (!child) {
        child = newNode(part, joinPath(node.path, part));
        node.children.set(key, child);
      }
      node = child;
    }
    return node;
  }
}

function newNode(name: string, path: string): TreeNode {
  return {
    name,
    path,
    children: new Map(),
    own: { read: 0, change: 0, search: 0 },
    hits: [],
    counts: { read: 0, readExact: 0, change: 0, changeExact: 0, search: 0, searchExact: 0 },
  };
}

/** Counts each node's subtree; a folder can't be read, so a "read" of one is a search. */
function settle(node: TreeNode): void {
  for (const child of node.children.values()) settle(child);
  if (node.children.size && node.own.read) {
    node.own.search = Math.max(node.own.search, node.own.read) as Level;
    node.own.read = 0;
    for (const h of node.hits) if (h.kind === 'read') h.kind = 'search';
  }
  const c = node.counts;
  for (const kind of KINDS) {
    if (node.own[kind]) c[kind]++;
    if (node.own[kind] === 2) c[`${kind}Exact`]++;
  }
  for (const child of node.children.values()) {
    for (const key of Object.keys(c) as (keyof Counts)[]) c[key] += child.counts[key];
  }
}
