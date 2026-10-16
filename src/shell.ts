import { baseName, globBase, looksLikeFile, resolvePath, type PathEnv } from './paths.ts';
import type { TouchKind } from './model.ts';
import { scriptTouches } from './script.ts';

export type Dialect = 'bash' | 'pwsh';

/** A path a shell command touched, inferred from the command's text. */
export interface Found {
  path: string;
  kind: TouchKind;
  tool: string;
}

/**
 * Infers the files a shell command reads, changes or searches. It understands the commands agents
 * use most, follows `cd` and simple variables within the command, and ignores what it can't
 * resolve, such as paths built at runtime.
 */
export function shellTouches(command: string, dialect: Dialect, cwd: string | undefined, env: PathEnv): Found[] {
  const st: State = { cwd, stack: [], vars: new Map(), env, dialect, out: [], depth: 0 };
  run(command, st);
  return st.out;
}

// Expansions in words are kept as placeholders until the interpreter knows the variables.
const OPEN = '\u0001';
const CLOSE = '\u0002';
const UNRESOLVED = OPEN + CLOSE;
const PLACEHOLDER = /\u0001([^\u0002]*)\u0002/g;

interface Word {
  text: string;
  quoted: boolean;
  /** Has an unquoted `*` or `?`. */
  glob: boolean;
}

interface Cmd {
  words: Word[];
  redirects: { op: 'in' | 'out'; target: Word }[];
  heredocs: string[];
  /** Its output is piped into the next command. */
  pipe: boolean;
}

interface State {
  cwd: string | undefined;
  stack: (string | undefined)[];
  vars: Map<string, string>;
  env: PathEnv;
  dialect: Dialect;
  out: Found[];
  depth: number;
}

function run(src: string, st: State): void {
  if (st.depth > 4) return;
  const { cmds, subs } = tokenize(src, st.dialect);
  for (const sub of subs) run(sub, { ...st, depth: st.depth + 1 });
  runCommands(cmds, st);
  if (st.dialect === 'pwsh' && st.depth === 0) {
    // .NET file APIs, such as [IO.File]::WriteAllText, read like script calls.
    for (const f of scriptTouches(src, (raw) => resolvePath(raw, st.cwd, st.env), 'PowerShell')) st.out.push(f);
  }
}

/** Runs commands in order, repeating the body of a bash `for x in a b c; do …; done` per value. */
function runCommands(cmds: Cmd[], st: State): void {
  for (let i = 0; i < cmds.length; i++) {
    const loop = st.dialect === 'bash' ? forLoop(cmds[i]!, st) : null;
    if (!loop) {
      interpret(cmds[i]!, cmds[i - 1]?.pipe ? cmds[i - 1] : undefined, st);
      continue;
    }
    const end = loopEnd(cmds, i + 1);
    for (const value of loop.values) {
      st.vars.set(loop.name, value);
      runCommands(cmds.slice(i + 1, end), st);
    }
    st.vars.delete(loop.name);
    i = end;
  }
}

function forLoop(cmd: Cmd, st: State): { name: string; values: string[] } | null {
  const [kw, name, inWord, ...rest] = cmd.words;
  if (kw?.text !== 'for' || !name || inWord?.text !== 'in') return null;
  const values = rest.filter((w) => !w.glob).map((w) => expand(w, st)).filter((v): v is string => v !== null);
  return { name: name.text, values: values.slice(0, 100) };
}

/** The index of the `done` that closes a loop body starting at `start`. */
function loopEnd(cmds: Cmd[], start: number): number {
  let depth = 0;
  for (let j = start; j < cmds.length; j++) {
    const first = cmds[j]!.words[0]?.text;
    const second = cmds[j]!.words[1]?.text;
    if (first === 'for' || first === 'while' || first === 'until' || (first === 'do' && (second === 'for' || second === 'while'))) depth++;
    if (first === 'done' && depth-- === 0) return j;
  }
  return cmds.length;
}

// ---------------------------------------------------------------------------------------------
// Tokenizer

function tokenize(src: string, dialect: Dialect): { cmds: Cmd[]; subs: string[] } {
  const pwsh = dialect === 'pwsh';
  const cmds: Cmd[] = [];
  const subs: string[] = [];
  const n = src.length;
  let cur = newCmd();
  let word: Word | null = null;
  let redirect: 'in' | 'out' | 'skip' | null = null;
  let heredocs: { delim: string; strip: boolean; cmd: Cmd }[] = [];
  let i = 0;

  const w = (): Word => (word ??= { text: '', quoted: false, glob: false });
  const endWord = (): void => {
    if (!word) return;
    if (redirect) {
      if (redirect !== 'skip') cur.redirects.push({ op: redirect, target: word });
      redirect = null;
    } else {
      cur.words.push(word);
    }
    word = null;
  };
  const endCmd = (pipe: boolean): void => {
    endWord();
    redirect = null;
    if (cur.words.length || cur.redirects.length || heredocs.some((h) => h.cmd === cur)) {
      cur.pipe = pipe;
      cmds.push(cur);
    }
    cur = newCmd();
  };

  const dollar = (x: Word): void => {
    const next = src[i + 1];
    if (next === '(') {
      const end = matchParen(src, i + 1);
      if (!(!pwsh && src[i + 2] === '(')) subs.push(src.slice(i + 2, end));
      x.text += UNRESOLVED;
      i = end + 1;
      return;
    }
    if (next === '{') {
      const end = src.indexOf('}', i + 2);
      if (end < 0) {
        x.text += '$';
        i++;
        return;
      }
      const name = src.slice(i + 2, end);
      x.text += /^(env:)?[A-Za-z_]\w*$/i.test(name) ? OPEN + varName(name, pwsh) + CLOSE : UNRESOLVED;
      i = end + 1;
      return;
    }
    const rest = src.slice(i + 1, i + 200);
    if (pwsh) {
      const m = /^(?:(env|global|script|local|private|using):)?([A-Za-z_]\w*)/i.exec(rest);
      if (!m) {
        x.text += '$';
        i++;
        return;
      }
      i += 1 + m[0].length;
      // Property access, indexing and automatic variables make the value unknown.
      if ((src[i] === '.' && /[A-Za-z_]/.test(src[i + 1] ?? '')) || src[i] === '[' || /^(_|true|false|null|psitem)$/i.test(m[2]!)) {
        while (i < n && /[\w.]/.test(src[i]!)) i++;
        x.text += UNRESOLVED;
        return;
      }
      x.text += OPEN + varName(m[1]?.toLowerCase() === 'env' ? `env:${m[2]}` : m[2]!, true) + CLOSE;
      return;
    }
    const m = /^[A-Za-z_]\w*/.exec(rest);
    if (m) {
      x.text += OPEN + m[0] + CLOSE;
      i += 1 + m[0].length;
    } else if (next && /[0-9@*#?$!-]/.test(next)) {
      x.text += UNRESOLVED;
      i += 2;
    } else if (next === "'") {
      let j = i + 2;
      let s = '';
      while (j < n && src[j] !== "'") {
        if (src[j] === '\\' && j + 1 < n) {
          s += src[j + 1];
          j += 2;
        } else {
          s += src[j++];
        }
      }
      x.text += s;
      x.quoted = true;
      i = j + 1;
    } else {
      x.text += '$';
      i++;
    }
  };

  const backtickSub = (x: Word): void => {
    let j = i + 1;
    while (j < n && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
    subs.push(src.slice(i + 1, j));
    x.text += UNRESOLVED;
    i = j + 1;
  };

  const readHeredocs = (start: number): number => {
    let pos = start;
    for (const h of heredocs) {
      const lines: string[] = [];
      while (pos < n) {
        let end = src.indexOf('\n', pos);
        if (end < 0) end = n;
        let line = src.slice(pos, end).replace(/\r$/, '');
        pos = end + 1;
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.delim) break;
        lines.push(line);
      }
      h.cmd.heredocs.push(lines.join('\n'));
    }
    heredocs = [];
    return pos;
  };

  while (i < n) {
    const c = src[i]!;
    const next = src[i + 1];

    if (c === '\n') {
      endCmd(false);
      i = heredocs.length ? readHeredocs(i + 1) : i + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }
    if (c === '#' && !word) {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (pwsh && c === '<' && next === '#') {
      endWord();
      const end = src.indexOf('#>', i);
      i = end < 0 ? n : end + 2;
      continue;
    }

    // Quotes and escapes
    if (c === "'") {
      const x = w();
      x.quoted = true;
      let j = i + 1;
      if (pwsh) {
        while (j < n) {
          if (src[j] === "'") {
            if (src[j + 1] !== "'") break;
            x.text += "'";
            j += 2;
          } else {
            x.text += src[j++];
          }
        }
      } else {
        const end = src.indexOf("'", j);
        x.text += src.slice(j, end < 0 ? n : end);
        j = end < 0 ? n : end;
      }
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const x = w();
      x.quoted = true;
      i++;
      while (i < n) {
        const d = src[i]!;
        if (d === '"') {
          if (pwsh && src[i + 1] === '"') {
            x.text += '"';
            i += 2;
            continue;
          }
          break;
        }
        if (!pwsh && d === '\\' && i + 1 < n && '$`"\\\n'.includes(src[i + 1]!)) {
          if (src[i + 1] !== '\n') x.text += src[i + 1];
          i += 2;
        } else if (pwsh && d === '`' && i + 1 < n) {
          x.text += psEscape(src[i + 1]!);
          i += 2;
        } else if (d === '$') {
          dollar(x);
        } else if (!pwsh && d === '`') {
          backtickSub(x);
        } else {
          x.text += d;
          i++;
        }
      }
      i++;
      continue;
    }
    if (pwsh && c === '@' && (next === "'" || next === '"') && /^\r?\n/.test(src.slice(i + 2, i + 4))) {
      const close = `\n${next}@`;
      const bodyStart = src.indexOf('\n', i) + 1;
      const end = src.indexOf(close, bodyStart - 1);
      const x = w();
      x.quoted = true;
      x.text += src.slice(bodyStart, end < 0 ? n : end).replace(/\r$/, '');
      i = end < 0 ? n : end + close.length;
      continue;
    }
    if (pwsh && c === '@' && (next === '(' || next === '{')) {
      i++;
      continue;
    }
    if (!pwsh && c === '\\') {
      if (next === '\n') i += 2;
      else if (next === '\r' && src[i + 2] === '\n') i += 3;
      else {
        w().text += next ?? '';
        i += 2;
      }
      continue;
    }
    if (pwsh && c === '`') {
      if (next === '\n' || next === '\r') {
        i += next === '\r' ? 3 : 2;
      } else {
        w().text += psEscape(next ?? '');
        i += 2;
      }
      continue;
    }
    if (c === '$') {
      dollar(w());
      continue;
    }
    if (!pwsh && c === '`') {
      backtickSub(w());
      continue;
    }

    // Redirections
    if (c === '>' || c === '<' || (c === '&' && next === '>' && !pwsh)) {
      if ((c === '<' || c === '>') && next === '(' && !pwsh) {
        const end = matchParen(src, i + 1);
        subs.push(src.slice(i + 2, end));
        w().text += UNRESOLVED;
        i = end + 1;
        continue;
      }
      // A file descriptor before the operator, such as the 2 in 2>err.log. (TypeScript can't see
      // that the closures above assign `word`, hence the cast.)
      const fd = word as Word | null;
      if (fd && !fd.quoted && (/^\d+$/.test(fd.text) || (pwsh && fd.text === '*'))) word = null;
      endWord();
      if (c === '&') i++;
      if (c === '<' && next === '<' && !pwsh) {
        if (src[i + 2] === '<') {
          redirect = 'skip';
          i += 3;
          continue;
        }
        i += 2;
        const strip = src[i] === '-';
        if (strip) i++;
        while (src[i] === ' ' || src[i] === '\t') i++;
        let delim = '';
        while (i < n && !/[\s;|&<>()]/.test(src[i]!)) {
          if (src[i] === "'" || src[i] === '"') {
            const q = src[i]!;
            const end = src.indexOf(q, i + 1);
            delim += src.slice(i + 1, end < 0 ? n : end);
            i = end < 0 ? n : end + 1;
          } else if (src[i] === '\\') {
            delim += src[i + 1] ?? '';
            i += 2;
          } else {
            delim += src[i++];
          }
        }
        heredocs.push({ delim, strip, cmd: cur });
        continue;
      }
      i++;
      if (src[i] === '>' || src[i] === '|') i++;
      if (src[i] === '&') {
        // A file-descriptor duplicate such as 2>&1.
        i++;
        while (i < n && /[\d-]/.test(src[i]!)) i++;
        continue;
      }
      redirect = c === '<' ? 'in' : 'out';
      continue;
    }

    // Separators
    if ((c === '&' && next === '&') || (c === '|' && next === '|')) {
      endCmd(false);
      i += 2;
      continue;
    }
    if (c === '|') {
      endCmd(true);
      i += next === '&' ? 2 : 1;
      continue;
    }
    if (c === ';' || c === '(' || c === ')') {
      endCmd(false);
      i++;
      continue;
    }
    if (c === '&') {
      if (pwsh) endWord();
      else endCmd(false);
      i++;
      continue;
    }
    if ((c === '{' || c === '}') && (pwsh || (!word && /[\s;]/.test(next ?? ' ')))) {
      endCmd(false);
      i++;
      continue;
    }
    if (pwsh && c === ',') {
      endWord();
      i++;
      continue;
    }

    const x = w();
    if (c === '*' || c === '?' || (c === '{' && !pwsh)) x.glob = true;
    x.text += c;
    i++;
  }
  endCmd(false);
  return { cmds, subs };
}

function newCmd(): Cmd {
  return { words: [], redirects: [], heredocs: [], pipe: false };
}

function varName(name: string, pwsh: boolean): string {
  return pwsh ? name.toLowerCase() : name;
}

function psEscape(c: string): string {
  return ({ n: '\n', t: '\t', r: '\r', '0': '\0' } as Record<string, string>)[c] ?? c;
}

/** The index of the parenthesis that closes the one at `open`, skipping quoted text. */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let j = open; j < src.length; j++) {
    const c = src[j];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
    else if (c === "'" || c === '"') {
      const end = src.indexOf(c, j + 1);
      if (end < 0) break;
      j = end;
    }
  }
  return src.length - 1;
}

// ---------------------------------------------------------------------------------------------
// Interpreter

interface Arg {
  text: string | null;
  glob: boolean;
  quoted: boolean;
  word?: Word;
}

interface Ctx {
  name: string;
  tool: string;
  args: Arg[];
  st: State;
  cmd: Cmd;
  prev: Cmd | undefined;
}

function expand(word: Word, st: State, loose = false): string | null {
  let unresolved = false;
  const text = word.text.replace(PLACEHOLDER, (_, name: string) => {
    const value = name ? (st.vars.get(name) ?? envVar(name, st)) : undefined;
    if (value !== undefined) return value;
    unresolved = true;
    return UNRESOLVED;
  });
  return unresolved && !loose ? null : text;
}

function envVar(name: string, st: State): string | undefined {
  const key = name.replace(/^env:/i, '').toUpperCase();
  const { home, temp } = st.env;
  switch (key) {
    case 'HOME':
    case 'USERPROFILE':
      return home;
    case 'TEMP':
    case 'TMP':
    case 'TMPDIR':
      return temp;
    case 'LOCALAPPDATA':
      return `${home}/AppData/Local`;
    case 'APPDATA':
      return `${home}/AppData/Roaming`;
    case 'PWD':
      return st.cwd;
    default:
      return undefined;
  }
}

const BASH_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', 'time', 'esac']);
const PS_KEYWORDS = new Set(['if', 'elseif', 'else', 'try', 'catch', 'finally', 'do', 'while', 'until', 'return', 'throw', 'begin', 'process', 'end']);

function interpret(cmd: Cmd, prev: Cmd | undefined, st: State): void {
  const pwsh = st.dialect === 'pwsh';
  for (const r of cmd.redirects) {
    emit(st, r.op === 'out' ? 'change' : 'read', { text: expand(r.target, st), glob: r.target.glob, quoted: true }, r.op === 'out' ? '>' : '<');
  }

  let words = cmd.words;
  if (pwsh) {
    // $x = 'value' stores a string; $x = Some-Command runs the command.
    const first = words[0]?.text ?? '';
    const glued = /^\u0001([^\u0002]+)\u0002=(.*)$/s.exec(first);
    const spaced = /^\u0001([^\u0002]+)\u0002$/.exec(first) && words[1]?.text === '=';
    if (glued || spaced) {
      const name = (glued ?? /^\u0001([^\u0002]+)\u0002$/.exec(first))![1]!;
      const rest: Word[] = glued ? (glued[2] ? [{ ...words[0]!, text: glued[2] }, ...words.slice(1)] : words.slice(1)) : words.slice(2);
      const value = rest.length === 1 && rest[0]!.quoted ? expand(rest[0]!, st) : null;
      if (value !== null) st.vars.set(name, value);
      else st.vars.delete(name);
      if (value !== null || !rest.length) return;
      words = rest;
    }
  } else {
    let k = 0;
    while (k < words.length && /^[A-Za-z_]\w*=/.test(words[k]!.text)) k++;
    if (k === words.length) {
      for (const word of words) {
        const eq = word.text.indexOf('=');
        const value = expand({ ...word, text: word.text.slice(eq + 1) }, st);
        if (value === null) st.vars.delete(word.text.slice(0, eq));
        else st.vars.set(word.text.slice(0, eq), value);
      }
      return;
    }
    words = words.slice(k);
  }

  let args: Arg[] = words.map((w) => ({ text: expand(w, st), glob: w.glob, quoted: w.quoted, word: w }));
  const keywords = pwsh ? PS_KEYWORDS : BASH_KEYWORDS;
  while (args.length && args[0]!.text !== null && (keywords.has(args[0]!.text.toLowerCase()) || args[0]!.text === '&' || args[0]!.text === '.')) args = args.slice(1);
  if (!args.length || args[0]!.text === null) return;

  const typed = args[0]!.text;
  const name = commandName(typed);
  const handler = (pwsh ? PS_HANDLERS[name] : undefined) ?? HANDLERS[name];
  if (handler) handler({ name, tool: baseName(typed.replace(/\\/g, '/')).replace(/\.(exe|cmd|bat)$/i, ''), args: args.slice(1), st, cmd, prev });
}

function commandName(typed: string): string {
  return (typed.replace(/\\/g, '/').split('/').pop() ?? '')
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '')
    .replace(/^python[\d.]+$/, 'python');
}

/** Whether an argument can be a path: not a number, `-`, `--`, a git pathspec such as :!x, or a negated glob such as !dist. */
function plausible(t: string): boolean {
  return t !== '' && t.length < 1024 && !t.includes('\n') && !/^[+-]?\d+$/.test(t) && !/^(--?$|[!:])/.test(t) && !t.includes(OPEN);
}

function emit(st: State, kind: TouchKind, arg: Arg | undefined, tool: string): void {
  const raw = arg?.text;
  if (raw == null || !plausible(raw)) return;
  let k = kind;
  let target = raw;
  // A quoted * is still a wildcard to the command (and no file is named *).
  if (arg!.glob || /[*?]/.test(raw)) {
    target = globBase(raw);
    k = 'search';
  }
  const path = resolvePath(target, st.cwd, st.env);
  if (path) st.out.push({ path, kind: k, tool });
}

/** Reads a path that names a file, and searches one that names a folder. */
function readOrSearch(st: State, arg: Arg | undefined, tool: string): void {
  if (arg?.text == null) return;
  emit(st, looksLikeFile(arg.text) && !arg.glob ? 'read' : 'search', arg, tool);
}

function cwdArg(st: State): Arg {
  return { text: st.cwd ?? null, glob: false, quoted: false };
}

// ---------------------------------------------------------------------------------------------
// Option parsing

interface Parsed {
  flags: Map<string, string | true>;
  pos: Arg[];
  /** How many positionals came before `--`, or -1 without one. */
  dashdash: number;
}

/** Parses POSIX options; `values` lists the short letters and long names that take a value. */
function opts(args: Arg[], values = ''): Parsed {
  const valueSet = new Set(values.split(' ').filter(Boolean));
  const flags = new Map<string, string | true>();
  const pos: Arg[] = [];
  let dashdash = -1;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const t = a.text;
    if (t === null || dashdash >= 0 || t === '-' || !t.startsWith('-')) {
      pos.push(a);
    } else if (t === '--') {
      dashdash = pos.length;
    } else if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      if (eq > 0) flags.set(t.slice(0, eq), t.slice(eq + 1));
      else flags.set(t, valueSet.has(t) ? (args[++i]?.text ?? '') : true);
    } else {
      for (let j = 1; j < t.length; j++) {
        const f = `-${t[j]}`;
        if (valueSet.has(f)) {
          flags.set(f, t.slice(j + 1) || (args[++i]?.text ?? ''));
          break;
        }
        flags.set(f, true);
      }
    }
  }
  return { flags, pos, dashdash };
}

const PS_VALUE_PARAMS = new Set(
  ('path literalpath lp pspath filepath destination destinationpath pattern encoding totalcount head first tail ' +
    'last skip readcount delimiter filter include exclude depth context value itemtype type name newname ' +
    'inputobject property erroraction ea warningaction wa errorvariable ev outvariable ov stream width ' +
    'attributes culture algorithm target credential').split(' '),
);

interface PsParsed {
  named: Map<string, Arg | null>;
  pos: Arg[];
}

function psOpts(args: Arg[]): PsParsed {
  const named = new Map<string, Arg | null>();
  const pos: Arg[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const m = a.text !== null && !a.quoted ? /^-([A-Za-z][\w-]*)(:?)(.*)$/s.exec(a.text) : null;
    if (!m) {
      pos.push(a);
      continue;
    }
    const name = m[1]!.toLowerCase();
    if (m[2]) named.set(name, { text: m[3]!, glob: a.glob, quoted: a.quoted });
    else if (PS_VALUE_PARAMS.has(name)) named.set(name, args[++i] ?? null);
    else named.set(name, null);
  }
  return { named, pos };
}

function psPaths(p: PsParsed, ...names: string[]): Arg[] {
  const named = names.map((n) => p.named.get(n)).filter((a): a is Arg => !!a);
  if (named.length) return named;
  return names.includes('path') || names.includes('filepath') ? p.pos : [];
}

// ---------------------------------------------------------------------------------------------
// Commands

type Handler = (c: Ctx) => void;

/** A command whose positionals are files it reads, with the options that take a value. */
function reader(values = ''): Handler {
  return (c) => {
    const { flags, pos } = opts(c.args, values);
    if (flags.has('-o') && c.name === 'sort') emit(c.st, 'change', { text: flags.get('-o') as string, glob: false, quoted: true }, c.tool);
    for (const a of pos) emit(c.st, 'read', a, c.tool);
  };
}

function changer(values = ''): Handler {
  return (c) => {
    for (const a of opts(c.args, values).pos) emit(c.st, 'change', a, c.tool);
  };
}

function lister(values = ''): Handler {
  return (c) => {
    const { pos } = opts(c.args, values);
    if (!pos.length) emit(c.st, 'search', cwdArg(c.st), c.tool);
    for (const a of pos) emit(c.st, 'search', a, c.tool);
  };
}

/** A command whose first positional is a program or pattern, unless one of `programFlags` gives it. */
function withProgram(values: string, programFlags: string[], kind: (p: Parsed) => TouchKind = () => 'read'): Handler {
  return (c) => {
    const p = opts(c.args, values);
    let pos = p.pos;
    if (!programFlags.some((f) => p.flags.has(f))) pos = pos.slice(1);
    for (const a of pos) if (!(a.text && /^\w+=/.test(a.text))) emit(c.st, kind(p), a, c.tool);
  };
}

const grep: Handler = (c) => {
  const p = opts(c.args, '-e -f -m -A -B -C -d -D --regexp --file --max-count --context --after-context --before-context');
  const pos = p.flags.has('-e') || p.flags.has('-f') || p.flags.has('--regexp') || p.flags.has('--file') ? p.pos : p.pos.slice(1);
  const recursive = ['-r', '-R', '--recursive', '--dereference-recursive'].some((f) => p.flags.has(f)) || c.name === 'rgrep';
  if (!pos.length && recursive) emit(c.st, 'search', cwdArg(c.st), c.tool);
  for (const a of pos) readOrSearch(c.st, a, c.tool);
};

const RG_VALUES =
  '-e -f -g -t -T -m -A -B -C -M -j -r -d -E --regexp --file --glob --iglob --type --type-not --max-count ' +
  '--after-context --before-context --context --max-columns --threads --replace --max-depth --encoding --sort ' +
  '--sortr --type-add --color --colors --max-filesize --pre --pre-glob --context-separator --path-separator ' +
  '--field-match-separator --engine --ignore-file';

const rg: Handler = (c) => {
  const p = opts(c.args, RG_VALUES);
  const filesMode = p.flags.has('--files');
  const pos = filesMode || p.flags.has('-e') || p.flags.has('-f') || p.flags.has('--regexp') || p.flags.has('--file') ? p.pos : p.pos.slice(1);
  if (!pos.length) emit(c.st, 'search', cwdArg(c.st), c.tool);
  for (const a of pos) (filesMode ? emit(c.st, 'search', a, c.tool) : readOrSearch(c.st, a, c.tool));
};

const sed: Handler = (c) => {
  const p = opts(c.args, '-e -f -l --expression --file');
  const inPlace = p.flags.has('-i') || p.flags.has('--in-place') || [...p.flags.keys()].some((k) => k.startsWith('--in-place'));
  let pos = p.pos;
  if (inPlace && pos[0]?.text === '') pos = pos.slice(1);
  if (!(p.flags.has('-e') || p.flags.has('-f') || p.flags.has('--expression') || p.flags.has('--file'))) pos = pos.slice(1);
  for (const a of pos) emit(c.st, inPlace ? 'change' : 'read', a, c.tool);
};

const perl: Handler = (c) => {
  const p = opts(c.args, '-e -E -I -M -m');
  if (p.flags.has('-e') || p.flags.has('-E')) {
    const kind = p.flags.has('-i') ? 'change' : 'read';
    if (p.flags.has('-n') || p.flags.has('-p')) for (const a of p.pos) emit(c.st, kind, a, c.tool);
    inlineScript(c, String(p.flags.get('-e') ?? p.flags.get('-E')));
  }
};

/** cp and mv: sources, then a destination file or folder. */
function copyMove(sourceKind: TouchKind): Handler {
  return (c) => {
    const p = opts(c.args, '-t -S --target-directory --suffix');
    const targetDir = (p.flags.get('-t') ?? p.flags.get('--target-directory')) as string | undefined;
    const sources = targetDir ? p.pos : p.pos.slice(0, -1);
    const dest = targetDir ?? p.pos[p.pos.length - 1]?.text;
    if (!sources.length || dest == null) return;
    for (const s of sources) emit(c.st, sourceKind, s, c.tool);
    destination(c, sources, dest, !!targetDir || sources.length > 1 || /[\\/]$/.test(dest));
  };
}

function destination(c: Ctx, sources: Arg[], dest: string, isDir: boolean): void {
  const intoDir = isDir || (!looksLikeFile(dest) && sources.every((s) => s.text && looksLikeFile(s.text)));
  if (!intoDir) {
    emit(c.st, 'change', { text: dest, glob: false, quoted: true }, c.tool);
    return;
  }
  for (const s of sources) {
    if (s.text == null || s.glob) continue;
    emit(c.st, 'change', { text: `${dest.replace(/[\\/]+$/, '')}/${baseName(s.text.replace(/\\/g, '/').replace(/\/+$/, ''))}`, glob: false, quoted: true }, c.tool);
  }
}

const find: Handler = (c) => {
  const roots: Arg[] = [];
  for (const a of c.args) {
    if (a.text !== null && /^[-(!)]/.test(a.text)) break;
    roots.push(a);
  }
  if (!roots.length) emit(c.st, 'search', cwdArg(c.st), c.tool);
  for (const a of roots) emit(c.st, 'search', a, c.tool);
};

const fd: Handler = (c) => {
  const p = opts(c.args, '-e -t -E -d -x -X -j -c -S --extension --type --exclude --max-depth --exec --exec-batch --threads --color --size --changed-within --changed-before --base-directory --search-path');
  const pos = p.pos.slice(1);
  if (!pos.length) emit(c.st, 'search', cwdArg(c.st), c.tool);
  for (const a of pos) emit(c.st, 'search', a, c.tool);
};

const jq: Handler = (c) => {
  const files: Arg[] = [];
  let haveFilter = false;
  for (let i = 0; i < c.args.length; i++) {
    const t = c.args[i]!.text;
    if (t === '--arg' || t === '--argjson') i += 2;
    else if (t === '--slurpfile' || t === '--rawfile') {
      emit(c.st, 'read', c.args[i + 2], c.tool);
      i += 2;
    } else if (t === '-f' || t === '--from-file') {
      emit(c.st, 'read', c.args[++i], c.tool);
      haveFilter = true;
    } else if (t === '--indent' || t === '--tab-width') i++;
    else if (t !== null && t.startsWith('-') && t !== '-') continue;
    else if (!haveFilter) haveFilter = true;
    else files.push(c.args[i]!);
  }
  for (const a of files) emit(c.st, 'read', a, c.tool);
};

function cd(c: Ctx, target: Arg | undefined): void {
  if (!target) {
    c.st.cwd = c.st.env.home;
    return;
  }
  if (target.text === null) {
    c.st.cwd = undefined;
    return;
  }
  if (target.text === '-') return;
  c.st.cwd = resolvePath(target.text, c.st.cwd, c.st.env) ?? undefined;
}

const pushd: Handler = (c) => {
  c.st.stack.push(c.st.cwd);
  cd(c, c.args.find((a) => !a.text?.startsWith('-')));
};

const popd: Handler = (c) => {
  if (c.st.stack.length) c.st.cwd = c.st.stack.pop();
};

/** Runs a nested shell command, such as `bash -c '...'` or `pwsh -Command '...'`. */
function nested(dialect: Dialect, flags: RegExp): Handler {
  return (c) => {
    const i = c.args.findIndex((a) => a.text !== null && flags.test(a.text));
    if (i < 0) return;
    const rest = c.args.slice(i + 1);
    const text = dialect === 'pwsh' ? rest.map((a) => a.text ?? '').join(' ') : rest[0]?.text;
    if (text) run(text, { ...c.st, dialect, depth: c.st.depth + 1 });
  };
}

/** A program run under another, such as `timeout 10 cat x` or `uv run python -c '...'`. */
function wrapper(skip: (args: Arg[]) => number): Handler {
  return (c) => {
    const rest = c.args.slice(skip(c.args));
    if (!rest.length) return;
    interpret({ ...c.cmd, words: rest.map((a) => ({ text: a.text ?? UNRESOLVED, quoted: a.quoted, glob: a.glob })), redirects: [] }, c.prev, c.st);
  };
}

function skipOptions(valueFlags: string[], leading = 0): (args: Arg[]) => number {
  return (args) => {
    let i = leading;
    while (i < args.length && args[i]!.text?.startsWith('-')) i += valueFlags.includes(args[i]!.text!) ? 2 : 1;
    return i;
  };
}

/** python, node and similar: inline code from -c/-e, a heredoc, or text piped in. */
const interpreter: Handler = (c) => {
  const codeFlags = c.name === 'python' || c.name === 'py' || c.name === 'pythonw' ? ['-c'] : ['-e', '--eval', '-p', '--print'];
  const i = c.args.findIndex((a) => a.text !== null && codeFlags.includes(a.text));
  const runsFile = c.args.some((a) => a.text && /\.(py|[cm]?[jt]s|rb)$/i.test(a.text));
  let code: string | null | undefined;
  if (i >= 0) code = known(c.args[i + 1], c.st);
  else if (c.name === 'deno' && c.args[0]?.text === 'eval') code = known(c.args[1], c.st);
  else if (runsFile) return;
  else if (c.cmd.heredocs.length) code = c.cmd.heredocs[0];
  else if (c.prev?.heredocs.length) code = c.prev.heredocs[0];
  else if (c.prev) {
    // Code piped in, such as a PowerShell here-string or `echo '...' | python -`.
    const [first, second, ...more] = c.prev.words;
    if (first && !second && first.quoted) code = expand(first, c.st, true);
    else if (first && second && !more.length && /^(echo|printf|write-output)$/i.test(first.text)) code = expand(second, c.st, true);
  }
  if (code) inlineScript(c, code);
};

/** An argument's text with what's known of its unresolved expansions. */
function known(a: Arg | undefined, st: State): string | null {
  if (!a) return null;
  return a.text ?? (a.word ? expand(a.word, st, true) : null);
}

function inlineScript(c: Ctx, code: string): void {
  for (const f of scriptTouches(code, (raw) => resolvePath(raw, c.st.cwd, c.st.env), c.tool)) c.st.out.push(f);
}

const git: Handler = (c) => {
  let i = 0;
  let cwd = c.st.cwd;
  while (i < c.args.length && c.args[i]!.text?.startsWith('-')) {
    const t = c.args[i]!.text!;
    if (t === '-C') cwd = resolvePath(c.args[i + 1]?.text ?? '', cwd, c.st.env) ?? undefined;
    i += t === '-C' || t === '-c' ? 2 : 1;
  }
  const sub = c.args[i]?.text;
  const rest = c.args.slice(i + 1);
  const st: State = { ...c.st, cwd };
  const tool = `git ${sub}`;
  const afterDashDash = (p: Parsed): Arg[] => (p.dashdash >= 0 ? p.pos.slice(p.dashdash) : []);
  switch (sub) {
    case 'diff':
    case 'difftool': {
      const p = opts(rest, '-O -S -G');
      const paths = p.dashdash >= 0 ? afterDashDash(p) : p.pos.filter((a) => a.text && looksLikeFile(a.text) && !a.text.includes('..'));
      for (const a of paths) readOrSearch(st, a, tool);
      break;
    }
    case 'show': {
      const p = opts(rest, '--format --pretty -U');
      for (const a of p.pos) {
        const m = a.text && !/^[A-Za-z]:[\\/]/.test(a.text) ? /^[^:\s]*:(.+)$/.exec(a.text) : null;
        if (m) emit(st, 'read', { ...a, text: m[1]! }, tool);
      }
      for (const a of afterDashDash(p)) readOrSearch(st, a, tool);
      break;
    }
    case 'blame':
    case 'annotate': {
      const p = opts(rest, '-L -S -C -M --contents --since');
      const file = p.dashdash >= 0 ? afterDashDash(p)[0] : p.pos[p.pos.length - 1];
      emit(st, 'read', file, tool);
      break;
    }
    case 'restore': {
      const p = opts(rest, '-s --source --pathspec-from-file');
      const staged = p.flags.has('-S') || p.flags.has('--staged');
      if (staged && !(p.flags.has('-W') || p.flags.has('--worktree'))) break;
      for (const a of p.pos) emit(st, 'change', a, tool);
      break;
    }
    case 'checkout': {
      for (const a of afterDashDash(opts(rest, '-b -B --orphan'))) emit(st, 'change', a, tool);
      break;
    }
    case 'rm': {
      const p = opts(rest, '--pathspec-from-file');
      if (!p.flags.has('--cached')) for (const a of p.pos) emit(st, 'change', a, tool);
      break;
    }
    case 'mv': {
      const p = opts(rest);
      const sources = p.pos.slice(0, -1);
      const dest = p.pos[p.pos.length - 1]?.text;
      if (!sources.length || dest == null) break;
      for (const s of sources) emit(st, 'change', s, tool);
      destination({ ...c, st, tool }, sources, dest, sources.length > 1);
      break;
    }
    case 'grep':
    case 'ls-files':
    case 'ls-tree': {
      const p = opts(rest, '-e -f');
      const paths = afterDashDash(p);
      if (!paths.length) emit(st, 'search', cwdArg(st), tool);
      for (const a of paths) emit(st, 'search', a, tool);
      break;
    }
  }
};

const HANDLERS: Record<string, Handler> = {
  cat: reader(),
  tac: reader(),
  head: reader('-n -c --lines --bytes'),
  tail: reader('-n -c -s --lines --bytes --pid --sleep-interval'),
  less: reader('-x -b -h -y -j -p -P -t -T -z'),
  more: reader('-n'),
  nl: reader('-b -d -f -h -i -l -n -s -v -w'),
  wc: reader('--files0-from'),
  sort: reader('-k -t -o -S -T --key --field-separator --output --buffer-size --temporary-directory'),
  uniq: reader('-f -s -w'),
  cut: reader('-d -f -c -b --delimiter --fields --characters --bytes'),
  bat: reader('-l -H -r --language --highlight-line --line-range --style --theme --tabs --wrap --color --paging'),
  batcat: reader('-l -H -r --language --highlight-line --line-range --style --theme'),
  xxd: reader('-l -s -c -g -o'),
  od: reader('-A -t -N -j -w'),
  hexdump: reader('-n -s -e -f'),
  strings: reader('-n -t'),
  file: reader('-m -f'),
  md5sum: reader(),
  sha1sum: reader(),
  sha256sum: reader(),
  sha512sum: reader(),
  base64: reader('-w'),
  column: reader('-s -c -o -t'),
  fold: reader('-w'),
  fmt: reader('-w'),
  paste: reader('-d'),
  comm: reader(),
  diff: reader('-U -C -L -x -X -I -F --label --unified --context --exclude --ignore-matching-lines'),
  cmp: reader('-i -n'),
  iconv: reader('-f -t -o'),
  awk: withProgram('-F -v', ['-f']),
  gawk: withProgram('-F -v', ['-f']),
  sed,
  perl,
  grep,
  egrep: grep,
  fgrep: grep,
  zgrep: grep,
  rgrep: grep,
  rg,
  ag: rg,
  ack: rg,
  jq,
  ls: lister('-I -w -T --ignore --hide --sort --color --format --time-style --width --block-size'),
  ll: lister(),
  dir: lister(),
  tree: lister('-L -I -P -o --filelimit'),
  eza: lister('-L -I --level --ignore-glob --sort --color'),
  exa: lister('-L -I --level --ignore-glob --sort --color'),
  du: lister('-d --max-depth --exclude -B --block-size'),
  stat: lister('-c -f --format --printf'),
  find,
  fd,
  fdfind: fd,
  touch: changer('-d -r -t --date --reference'),
  rm: changer(),
  rmdir: changer(),
  unlink: changer(),
  shred: changer('-n -s'),
  truncate: changer('-s -r --size --reference'),
  dos2unix: changer(),
  unix2dos: changer(),
  tee: changer(),
  cp: copyMove('read'),
  install: copyMove('read'),
  mv: copyMove('change'),
  cd: (c) => cd(c, c.args.find((a) => !a.text?.startsWith('-') || a.text === '-')),
  chdir: (c) => cd(c, c.args[0]),
  pushd,
  popd,
  git,
  python: interpreter,
  python3: interpreter,
  py: interpreter,
  pythonw: interpreter,
  node: interpreter,
  deno: interpreter,
  bun: interpreter,
  ruby: interpreter,
  bash: nested('bash', /^-\w*c$/),
  sh: nested('bash', /^-\w*c$/),
  zsh: nested('bash', /^-\w*c$/),
  pwsh: nested('pwsh', /^-(c|command)$/i),
  powershell: nested('pwsh', /^-(c|command)$/i),
  cmd: nested('pwsh', /^\/[ck]$/i),
  sudo: wrapper(skipOptions(['-u', '-g'])),
  env: wrapper((args) => {
    let i = 0;
    while (i < args.length && (args[i]!.text?.startsWith('-') || /^\w+=/.test(args[i]!.text ?? ''))) i++;
    return i;
  }),
  command: wrapper(skipOptions([])),
  builtin: wrapper(skipOptions([])),
  exec: wrapper(skipOptions([])),
  nice: wrapper(skipOptions(['-n'])),
  nohup: wrapper(skipOptions([])),
  time: wrapper(skipOptions([])),
  timeout: wrapper((args) => skipOptions(['-s', '-k', '--signal', '--kill-after'])(args) + 1),
  uv: wrapper((args) => (args[0]?.text === 'run' ? skipOptions(['--with', '--python', '-p', '--project', '--directory', '--env-file', '--extra', '--group', '--package'], 1)(args) : args.length)),
  poetry: wrapper((args) => (args[0]?.text === 'run' ? 1 : args.length)),
  pipenv: wrapper((args) => (args[0]?.text === 'run' ? 1 : args.length)),
};

// PowerShell cmdlets, and the aliases that mean something else there than in bash.

function psHandler(fn: (c: Ctx, p: PsParsed) => void): Handler {
  return (c) => fn(c, psOpts(c.args));
}

const psRead = psHandler((c, p) => {
  for (const a of psPaths(p, 'path', 'literalpath', 'lp', 'pspath')) emit(c.st, 'read', a, c.tool);
});

const psList = psHandler((c, p) => {
  const paths = psPaths(p, 'path', 'literalpath', 'lp', 'pspath').slice(0, 1);
  if (!paths.length) emit(c.st, 'search', cwdArg(c.st), c.tool);
  for (const a of paths) emit(c.st, 'search', a, c.tool);
});

const psCheck = psHandler((c, p) => {
  for (const a of psPaths(p, 'path', 'literalpath', 'lp', 'pspath')) emit(c.st, 'search', a, c.tool);
});

const psWrite = psHandler((c, p) => {
  const paths = psPaths(p, 'path', 'literalpath', 'lp', 'pspath', 'filepath');
  // Positionally, the second argument is the content, not a path.
  for (const a of paths === p.pos ? paths.slice(0, 1) : paths) emit(c.st, 'change', a, c.tool);
});

const psRemove = psHandler((c, p) => {
  for (const a of psPaths(p, 'path', 'literalpath', 'lp', 'pspath')) emit(c.st, 'change', a, c.tool);
});

const psSelectString = psHandler((c, p) => {
  const named = psPaths(p, 'path', 'literalpath', 'lp');
  const paths = p.named.has('path') || p.named.has('literalpath') || p.named.has('lp') ? named : p.named.has('pattern') ? p.pos : p.pos.slice(1);
  for (const a of paths) readOrSearch(c.st, a, c.tool);
});

const psNewItem = psHandler((c, p) => {
  if (/^(directory|dir|d)$/i.test(p.named.get('itemtype')?.text ?? p.named.get('type')?.text ?? '')) return;
  const base = (p.named.get('path') ?? p.pos[0])?.text;
  const name = p.named.get('name')?.text;
  if (name != null) emit(c.st, 'change', { text: base != null ? `${base}/${name}` : name, glob: false, quoted: true }, c.tool);
  else if (base != null) emit(c.st, 'change', { text: base, glob: false, quoted: true }, c.tool);
});

function psCopyMove(sourceKind: TouchKind): Handler {
  return psHandler((c, p) => {
    const sources = p.named.get('path') ?? p.named.get('literalpath') ?? p.pos[0];
    const dest = (p.named.get('destination') ?? (p.named.has('path') || p.named.has('literalpath') ? p.pos[0] : p.pos[1]))?.text;
    if (!sources) return;
    emit(c.st, sourceKind, sources, c.tool);
    if (dest != null) destination(c, [sources], dest, /[\\/]$/.test(dest));
  });
}

const psRename = psHandler((c, p) => {
  const source = p.named.get('path') ?? p.named.get('literalpath') ?? p.pos[0];
  const newName = (p.named.get('newname') ?? (p.named.has('path') || p.named.has('literalpath') ? p.pos[0] : p.pos[1]))?.text;
  if (!source?.text) return;
  emit(c.st, 'change', source, c.tool);
  const dir = /[\\/]/.test(source.text) ? source.text.replace(/[\\/][^\\/]*$/, '/') : '';
  if (newName) emit(c.st, 'change', { text: dir + newName, glob: false, quoted: true }, c.tool);
});

const psArchive = (sourceKind: TouchKind) =>
  psHandler((c, p) => {
    for (const a of psPaths(p, 'path', 'literalpath').slice(0, 1)) emit(c.st, sourceKind, a, c.tool);
    emit(c.st, 'change', p.named.get('destinationpath') ?? undefined, c.tool);
  });

const psCd = psHandler((c, p) => cd(c, p.named.get('path') ?? p.named.get('literalpath') ?? p.pos[0]));

const PS_HANDLERS: Record<string, Handler> = {
  'get-content': psRead,
  gc: psRead,
  cat: psRead,
  type: psRead,
  'import-csv': psRead,
  ipcsv: psRead,
  'import-clixml': psRead,
  'import-powershelldatafile': psRead,
  'get-filehash': psRead,
  'format-hex': psRead,
  fhx: psRead,
  'select-string': psSelectString,
  sls: psSelectString,
  'get-childitem': psList,
  gci: psList,
  ls: psList,
  dir: psList,
  'test-path': psCheck,
  'get-item': psCheck,
  gi: psCheck,
  'resolve-path': psCheck,
  rvpa: psCheck,
  'get-itemproperty': psCheck,
  'set-content': psWrite,
  sc: psWrite,
  'add-content': psWrite,
  ac: psWrite,
  'out-file': psWrite,
  'clear-content': psWrite,
  clc: psWrite,
  'tee-object': psWrite,
  tee: psWrite,
  'export-csv': psWrite,
  epcsv: psWrite,
  'export-clixml': psWrite,
  'new-item': psNewItem,
  ni: psNewItem,
  'remove-item': psRemove,
  ri: psRemove,
  rm: psRemove,
  del: psRemove,
  erase: psRemove,
  rd: psRemove,
  rmdir: psRemove,
  'copy-item': psCopyMove('read'),
  cpi: psCopyMove('read'),
  cp: psCopyMove('read'),
  copy: psCopyMove('read'),
  'move-item': psCopyMove('change'),
  mi: psCopyMove('change'),
  mv: psCopyMove('change'),
  move: psCopyMove('change'),
  'rename-item': psRename,
  rni: psRename,
  ren: psRename,
  'expand-archive': psArchive('read'),
  'compress-archive': psArchive('read'),
  'set-location': psCd,
  sl: psCd,
  cd: psCd,
  chdir: psCd,
  'push-location': (c) => {
    c.st.stack.push(c.st.cwd);
    psCd(c);
  },
  pushd: (c) => {
    c.st.stack.push(c.st.cwd);
    psCd(c);
  },
  'pop-location': popd,
  popd,
  sort: () => {},
  diff: () => {},
  echo: () => {},
};
