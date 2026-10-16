import type { TouchKind } from './model.ts';
import type { Found } from './shell.ts';

type Role = 'read' | 'change' | 'open';

/** Calls whose arguments are paths, with the role of each positional argument. */
const CALLS: { re: RegExp; roles: Role[] }[] = [
  { re: /\bopen\(/g, roles: ['open'] },
  {
    re: /\b(?:readFileSync|readFile|createReadStream|ReadAllText|ReadAllLines|ReadAllBytes|ReadLines|read_csv|read_excel|read_json|read_parquet|read_table|load_workbook|Document)\(/g,
    roles: ['read'],
  },
  {
    re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|unlinkSync|rmSync|WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines|File\]::Delete|to_csv|to_excel|to_json|to_parquet|savefig|os\.remove|os\.unlink|shutil\.rmtree|\.save)\(/g,
    roles: ['change'],
  },
  { re: /\b(?:copyFileSync|copyFile|cpSync|shutil\.copy2?|shutil\.copyfile|File\]::Copy)\(/g, roles: ['read', 'change'] },
  { re: /\b(?:renameSync|shutil\.move|os\.rename|os\.replace|File\]::Move)\(/g, roles: ['change', 'change'] },
];

/** A receiver followed by a dot: Path('...'). or a variable. */
const RECEIVER = /(?<![\w.])(?:((?:pathlib\.)?Path\()|(\$?[A-Za-z_]\w*)\.)/g;
/** pathlib methods, called on a Path or a variable holding a path. */
const METHOD_ROLES: Record<string, Role> = {
  read_text: 'read',
  read_bytes: 'read',
  open: 'open',
  write_text: 'change',
  write_bytes: 'change',
  unlink: 'change',
  touch: 'change',
  rename: 'change',
};

/** The value a variable holds at a position in the code, or null when unknown. */
type Lookup = (name: string, pos: number) => string | null;

interface Arg {
  text: string;
  start: number;
}

/**
 * Infers the files inline code reads and changes, such as a Python heredoc that rewrites a file.
 * It follows string literals, variables assigned one, and simple joins, through the common file
 * APIs of Python, Node and .NET.
 */
export function scriptTouches(code: string, resolve: (raw: string) => string | null, tool: string): Found[] {
  const lookup = assignments(code);
  const out: Found[] = [];
  const add = (kind: TouchKind, raw: string | null | undefined): void => {
    const path = raw ? resolve(raw) : null;
    if (path) out.push({ path, kind, tool });
  };
  const value = (arg: Arg | undefined): string | null => (arg ? (pathExpr(code, arg.start, lookup)?.value ?? null) : null);

  for (const { re, roles } of CALLS) {
    re.lastIndex = 0;
    for (let m = re.exec(code); m; m = re.exec(code)) {
      const args = callArgs(code, m.index + m[0].length - 1);
      roles.forEach((role, i) => {
        const arg = args[i];
        if (!arg || /^\s*\w+\s*=[^=]/.test(arg.text)) return;
        // Path.open('w') is a method call, handled with the other methods below.
        if (role === 'open' && /^\s*['"][rwxabt+U]{1,4}['"]\s*$/.test(arg.text)) return;
        add(role === 'open' ? openKind(args.slice(1)) : role, value(arg));
      });
    }
  }

  RECEIVER.lastIndex = 0;
  for (let m = RECEIVER.exec(code); m; m = RECEIVER.exec(code)) {
    let receiver: string | null;
    let dot: number;
    if (m[1]) {
      const e = pathExpr(code, m.index, lookup);
      if (!e || code[e.end] !== '.') continue;
      receiver = e.value;
      dot = e.end;
    } else {
      receiver = lookup(varName(m[2]!), m.index);
      dot = m.index + m[0].length - 1;
    }
    const method = /^\.(\w+)\(/.exec(code.slice(dot, dot + 20));
    const role = method ? METHOD_ROLES[method[1]!] : undefined;
    if (!method || !role || receiver === null) continue;
    const args = callArgs(code, dot + method[0].length - 1);
    add(role === 'open' ? openKind(args) : role, receiver);
    if (method[1] === 'rename') add('change', value(args[0]));
  }
  return out;
}

/** open() writes when its mode has w, a, x or +. */
function openKind(rest: Arg[]): TouchKind {
  for (const arg of rest) {
    const m = /^\s*(?:mode\s*=\s*)?['"]([rwxabt+U]{1,4})['"]\s*$/.exec(arg.text);
    if (m) return /[wax+]/.test(m[1]!) ? 'change' : 'read';
  }
  return 'read';
}

function varName(raw: string): string {
  return raw.replace(/^\$/, '').toLowerCase();
}

/** Tracks assignments in order, so a variable resolves to what it held where it's used. */
function assignments(code: string): Lookup {
  const list: { name: string; pos: number; value: string | null }[] = [];
  const lookup: Lookup = (name, pos) => {
    for (let i = list.length - 1; i >= 0; i--) if (list[i]!.name === name && list[i]!.pos < pos) return list[i]!.value;
    return null;
  };
  const re = /(?<![\w.$])(\$?[A-Za-z_]\w*)\s*(?::\s*[A-Za-z_][\w[\], .|]*)?=(?![=>])/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const e = pathExpr(code, m.index + m[0].length, lookup);
    let value: string | null = null;
    if (e && e.value !== null) {
      const after = code.slice(skipSpaces(code, e.end), skipSpaces(code, e.end) + 2);
      if (after === '' || /^([\n\r;,)}#]|\/\/)/.test(after)) value = e.value;
    }
    list.push({ name: varName(m[1]!), pos: m.index, value });
  }
  return lookup;
}

interface Expr {
  /** The path, or null when it depends on something unknown. */
  value: string | null;
  end: number;
}

/** A string, Path('...'), path.join(...), known variable, or a `/` join of those, at `start`. */
function pathExpr(code: string, start: number, lookup: Lookup): Expr | null {
  let i = skipSpaces(code, start);
  let base: Expr | null;
  let joinable = false;
  const head = code.slice(i, i + 40);
  const call = /^(?:pathlib\.)?Path\(/.exec(head) ?? /^(?:os\.)?path\.(?:join|resolve)\(/.exec(head);
  if (call) {
    const open = i + call[0].length - 1;
    const parts = callArgs(code, open).map((a) => pathExpr(code, a.start, lookup)?.value ?? null);
    base = { value: parts.length && parts.every((p) => p !== null) ? parts.join('/') : null, end: callEnd(code, open) };
    joinable = call[0].includes('Path(');
  } else {
    base = stringAt(code, i);
    if (!base) {
      const id = /^\$?[A-Za-z_]\w*/.exec(code.slice(i, i + 80));
      if (!id || /^(true|false|null|None|True|False)$/.test(id[0])) return null;
      base = { value: lookup(varName(id[0]), i), end: i + id[0].length };
      joinable = code[base.end] !== '.' && code[base.end] !== '(';
    }
  }
  // pathlib joins: Path('a') / 'b' / name
  while (joinable) {
    i = skipSpaces(code, base.end);
    if (code[i] !== '/' || code[i + 1] === '/' || code[i + 1] === '=') break;
    const next = pathExpr(code, i + 1, lookup);
    if (!next) return { value: null, end: base.end };
    base = { value: base.value !== null && next.value !== null ? `${base.value}/${next.value}` : null, end: next.end };
  }
  return base;
}

/** A single-line string literal at `i`, or null. Interpolated strings have no value. */
function stringAt(code: string, i: number): Expr | null {
  let j = i;
  let raw = false;
  let interpolated = false;
  while (j - i < 2 && /[rRuUbBfF]/.test(code[j] ?? '')) {
    if (/[rR]/.test(code[j]!)) raw = true;
    if (/[fF]/.test(code[j]!)) interpolated = true;
    j++;
  }
  const q = code[j];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  if (code.startsWith(q.repeat(3), j)) return null;
  let s = '';
  let k = j + 1;
  for (; k < code.length && code[k] !== q; k++) {
    if (code[k] === '\n') return null;
    if (code[k] === '\\' && !raw) {
      const nx = code[k + 1] ?? '';
      s += nx === '\\' || nx === '"' || nx === "'" || nx === '`' ? nx : `\\${nx}`;
      k++;
    } else {
      s += code[k];
    }
  }
  if (k >= code.length) return null;
  // f-strings, JS templates, and the $var and %VAR% of shell code.
  if (interpolated || (q === '`' && s.includes('${')) || /\$[\w{(]|%\w+%/.test(s)) return { value: null, end: k + 1 };
  return { value: s, end: k + 1 };
}

/** The top-level arguments of the call whose `(` is at `open`. */
function callArgs(code: string, open: number): Arg[] {
  const args: Arg[] = [];
  let depth = 0;
  let start = open + 1;
  const push = (end: number): void => {
    const text = code.slice(start, end);
    if (text.trim()) args.push({ text, start });
  };
  for (let k = open; k < code.length; k++) {
    const c = code[k]!;
    if (c === '"' || c === "'" || c === '`') {
      const end = code.indexOf(c, k + 1);
      if (end < 0) break;
      k = end;
    } else if (c === '(' || c === '[' || c === '{') {
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      if (--depth === 0) {
        push(k);
        return args;
      }
    } else if (c === ',' && depth === 1) {
      push(k);
      start = k + 1;
    }
  }
  return args;
}

function callEnd(code: string, open: number): number {
  let depth = 0;
  for (let k = open; k < code.length; k++) {
    const c = code[k];
    if (c === '"' || c === "'") {
      const end = code.indexOf(c, k + 1);
      if (end < 0) break;
      k = end;
    } else if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return k + 1;
  }
  return code.length;
}

function skipSpaces(code: string, i: number): number {
  while (i < code.length && (code[i] === ' ' || code[i] === '\t')) i++;
  return i;
}
