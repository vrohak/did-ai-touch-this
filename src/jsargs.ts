/** A value the code computes at runtime, such as a variable or an expression. */
export const UNKNOWN: unique symbol = Symbol('unknown');

export type JsValue = string | number | boolean | null | typeof UNKNOWN | JsValue[] | { [key: string]: JsValue };

/**
 * The `tools.<name>(<arg>)` calls in the JavaScript of a Codex `exec` cell, with each literal
 * argument parsed. The code is read, never run.
 */
export function toolCalls(code: string): { tool: string; arg: JsValue }[] {
  const calls: { tool: string; arg: JsValue }[] = [];
  const re = /\btools\.([A-Za-z_]\w*)\(/g;
  for (let m = re.exec(code); m; m = re.exec(code)) {
    const parsed = parseValue(code, m.index + m[0].length);
    calls.push({ tool: m[1]!, arg: parsed ? parsed.value : UNKNOWN });
  }
  return calls;
}

interface Parsed {
  value: JsValue;
  end: number;
}

function parseValue(s: string, start: number): Parsed | null {
  const i = skip(s, start);
  const c = s[i];
  if (c === undefined) return null;
  if (c === '{') return parseObject(s, i);
  if (c === '[') return parseArray(s, i);
  if (c === '"' || c === "'" || c === '`') return parseString(s, i);
  const lit = /^(?:-?\d+(?:\.\d+)?|true|false|null)(?![\w$])/.exec(s.slice(i, i + 32));
  if (lit) return { value: JSON.parse(lit[0]) as JsValue, end: i + lit[0].length };
  return { value: UNKNOWN, end: skipExpression(s, i) };
}

function parseObject(s: string, open: number): Parsed {
  const obj: { [key: string]: JsValue } = {};
  let i = open + 1;
  for (;;) {
    i = skip(s, i);
    if (i >= s.length) return { value: obj, end: i };
    if (s[i] === '}') return { value: obj, end: i + 1 };
    if (s[i] === ',') {
      i++;
      continue;
    }
    let key: string;
    if (s[i] === '"' || s[i] === "'") {
      const k = parseString(s, i);
      key = typeof k.value === 'string' ? k.value : '';
      i = k.end;
    } else {
      const id = /^[\w$]+/.exec(s.slice(i, i + 100));
      if (!id) return { value: obj, end: skipExpression(s, i) };
      key = id[0];
      i += id[0].length;
    }
    i = skip(s, i);
    if (s[i] === ':') {
      const v = parseValue(s, i + 1);
      if (!v) return { value: obj, end: s.length };
      obj[key] = v.value;
      i = v.end;
    } else {
      obj[key] = UNKNOWN;
    }
  }
}

function parseArray(s: string, open: number): Parsed {
  const arr: JsValue[] = [];
  let i = open + 1;
  for (;;) {
    i = skip(s, i);
    if (i >= s.length) return { value: arr, end: i };
    if (s[i] === ']') return { value: arr, end: i + 1 };
    if (s[i] === ',') {
      i++;
      continue;
    }
    const v = parseValue(s, i);
    if (!v) return { value: arr, end: s.length };
    arr.push(v.value);
    i = v.end;
  }
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', '0': '\0' };

function parseString(s: string, open: number): Parsed {
  const q = s[open]!;
  let out = '';
  let i = open + 1;
  let interpolated = false;
  while (i < s.length && s[i] !== q) {
    const c = s[i]!;
    if (c === '\\') {
      const nx = s[i + 1] ?? '';
      if (nx === 'u') {
        const m = /^u\{([0-9a-fA-F]+)\}|^u([0-9a-fA-F]{4})/.exec(s.slice(i + 1, i + 12));
        if (m) {
          out += String.fromCodePoint(parseInt(m[1] ?? m[2]!, 16));
          i += 1 + m[0].length;
          continue;
        }
      } else if (nx === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
        out += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
        i += 4;
        continue;
      } else if (nx === '\n') {
        i += 2;
        continue;
      }
      out += ESCAPES[nx] ?? nx;
      i += 2;
      continue;
    }
    if (q === '`' && c === '$' && s[i + 1] === '{') interpolated = true;
    out += c;
    i++;
  }
  return { value: interpolated ? UNKNOWN : out, end: i + 1 };
}

/** Skips an expression up to the `,` or closing bracket that ends it. */
function skipExpression(s: string, start: number): number {
  let depth = 0;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (c === '"' || c === "'" || c === '`') i = parseString(s, i).end - 1;
    else if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (c === ',' && depth === 0) return i;
  }
  return s.length;
}

function skip(s: string, start: number): number {
  let i = start;
  for (;;) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (s.startsWith('//', i)) {
      const end = s.indexOf('\n', i);
      i = end < 0 ? s.length : end + 1;
    } else if (s.startsWith('/*', i)) {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      return i;
    }
  }
}
