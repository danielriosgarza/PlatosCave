/**
 * The expression language of interactive exercise steps (§9): arithmetic on numbers, a step's
 * parameters, and the names a shape binds (`x` on a function graph, `t` on a curve, the name of
 * a repeated shape's counter). It is parsed into a tree and evaluated without `eval`, so an
 * author's text never runs as code. The browser draws with it and the server judges with it,
 * which is why it lives here: both read an expression the same way.
 *
 * Grammar, loosest first: `c ? a : b`, `||`, `&&`, `== !=`, `< <= > >=`, `+ -`, `* / %`,
 * unary `- + !`, `^` (right-associative, so `-2^2` is -4), then numbers, names, calls and
 * parentheses. A comparison or logical operator gives 1 or 0; a condition holds when its value
 * is a number other than 0. A point parameter `P` is read as `P.x` and `P.y`.
 */

export type Expr =
  | { t: 'num'; v: number }
  | { t: 'name'; name: string }
  | { t: 'unary'; op: '-' | '+' | '!'; a: Expr }
  | { t: 'binary'; op: BinaryOp; a: Expr; b: Expr }
  | { t: 'if'; c: Expr; a: Expr; b: Expr }
  | { t: 'call'; f: string; args: Expr[] };

type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '^'
  | '<'
  | '<='
  | '>'
  | '>='
  | '=='
  | '!='
  | '&&'
  | '||';

/** Longest accepted source; a step's expressions stay short enough to read. */
export const MAX_EXPRESSION_LENGTH = 300;
const MAX_DEPTH = 40;

export const CONSTANTS: Readonly<Record<string, number>> = {
  pi: Math.PI,
  tau: 2 * Math.PI,
  e: Math.E,
};

const truth = (v: number) => (v !== 0 && !Number.isNaN(v) ? 1 : 0);
/** A table's own entry: `constructor` or `toString` must not reach Object.prototype. */
const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;
const rad = (d: number) => (d * Math.PI) / 180;

/** Functions by name: the implementation and the counts of arguments it takes. */
const FUNCTIONS: Readonly<
  Record<string, { min: number; max: number; f: (...a: number[]) => number }>
> = {
  sin: { min: 1, max: 1, f: Math.sin },
  cos: { min: 1, max: 1, f: Math.cos },
  tan: { min: 1, max: 1, f: Math.tan },
  asin: { min: 1, max: 1, f: Math.asin },
  acos: { min: 1, max: 1, f: Math.acos },
  atan: { min: 1, max: 1, f: Math.atan },
  atan2: { min: 2, max: 2, f: Math.atan2 },
  sinh: { min: 1, max: 1, f: Math.sinh },
  cosh: { min: 1, max: 1, f: Math.cosh },
  tanh: { min: 1, max: 1, f: Math.tanh },
  sqrt: { min: 1, max: 1, f: Math.sqrt },
  cbrt: { min: 1, max: 1, f: Math.cbrt },
  abs: { min: 1, max: 1, f: Math.abs },
  exp: { min: 1, max: 1, f: Math.exp },
  ln: { min: 1, max: 1, f: Math.log },
  log10: { min: 1, max: 1, f: Math.log10 },
  log2: { min: 1, max: 1, f: Math.log2 },
  /** `log(x, base)`: the base is required, because `log(x)` means ln to some and log10 to others. */
  log: { min: 2, max: 2, f: (x, b) => Math.log(x) / Math.log(b) },
  pow: { min: 2, max: 2, f: Math.pow },
  floor: { min: 1, max: 1, f: Math.floor },
  ceil: { min: 1, max: 1, f: Math.ceil },
  trunc: { min: 1, max: 1, f: Math.trunc },
  /** `round(x)` to a whole number, `round(x, n)` to n decimals. */
  round: {
    min: 1,
    max: 2,
    f: (x, n = 0) => {
      const k = 10 ** Math.round(n);
      return Math.round(x * k) / k;
    },
  },
  sign: { min: 1, max: 1, f: Math.sign },
  min: { min: 1, max: 20, f: Math.min },
  max: { min: 1, max: 20, f: Math.max },
  hypot: { min: 1, max: 20, f: Math.hypot },
  clamp: { min: 3, max: 3, f: (x, lo, hi) => Math.min(hi, Math.max(lo, x)) },
  /** Degrees to radians and back. */
  rad: { min: 1, max: 1, f: rad },
  deg: { min: 1, max: 1, f: (r) => (r * 180) / Math.PI },
  /** 1 when |a − b| ≤ tol: the way to compare measured values. */
  near: { min: 3, max: 3, f: (a, b, tol) => truth(Number(Math.abs(a - b) <= tol)) },
  between: { min: 3, max: 3, f: (x, lo, hi) => truth(Number(x >= lo && x <= hi)) },
};

/** Names an author cannot give a parameter or a counter: constants, functions and bound names. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  ...Object.keys(CONSTANTS),
  ...Object.keys(FUNCTIONS),
  'x',
  't',
]);

type Token =
  | { k: 'num'; v: number; at: number }
  | { k: 'name'; v: string; at: number }
  | { k: 'op'; v: string; at: number }
  | { k: 'end'; at: number };

const OPERATORS = [
  '&&',
  '||',
  '<=',
  '>=',
  '==',
  '!=',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '<',
  '>',
  '!',
  '(',
  ')',
  ',',
  '?',
  ':',
];

class ParseError extends Error {}

const isOp = (t: Token, op: string) => t.k === 'op' && t.v === op;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const number = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(source.slice(i));
    if (number) {
      const after = source[i + number[0].length];
      if (after !== undefined && /[A-Za-z_]/.test(after)) {
        throw new ParseError(`write * between ${number[0]} and what follows it`);
      }
      tokens.push({ k: 'num', v: Number(number[0]), at: i });
      i += number[0].length;
      continue;
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*(\.[xy](?![A-Za-z0-9_]))?/.exec(source.slice(i));
    if (name) {
      tokens.push({ k: 'name', v: name[0], at: i });
      i += name[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => source.startsWith(o, i));
    if (!op) throw new ParseError(`unexpected “${ch}”`);
    tokens.push({ k: 'op', v: op, at: i });
    i += op.length;
  }
  tokens.push({ k: 'end', at: source.length });
  return tokens;
}

/** Binding power of each infix operator: [left, right]. Right-associative ones bind less on the right. */
const INFIX: Record<string, [number, number]> = {
  '||': [3, 4],
  '&&': [5, 6],
  '==': [7, 8],
  '!=': [7, 8],
  '<': [9, 10],
  '<=': [9, 10],
  '>': [9, 10],
  '>=': [9, 10],
  '+': [11, 12],
  '-': [11, 12],
  '*': [13, 14],
  '/': [13, 14],
  '%': [13, 14],
  '^': [18, 17],
};
const TERNARY = 2;
const PREFIX = 15;

function parseTokens(tokens: Token[]): Expr {
  let pos = 0;
  const peek = () => tokens[pos] as Token;
  const next = () => tokens[pos++] as Token;
  const expect = (op: string) => {
    const t = next();
    if (t.k !== 'op' || t.v !== op) {
      throw new ParseError(t.k === 'end' ? `missing “${op}” at the end` : `expected “${op}”`);
    }
  };

  const expression = (minPower: number, depth: number): Expr => {
    if (depth > MAX_DEPTH) throw new ParseError('the expression is nested too deeply');
    let left = primary(depth);
    for (;;) {
      const t = peek();
      if (t.k !== 'op') {
        if (t.k === 'end') break;
        throw new ParseError(`expected an operator before “${t.v}”`);
      }
      if (t.v === '?') {
        if (TERNARY < minPower) break;
        next();
        const a = expression(0, depth + 1);
        expect(':');
        const b = expression(TERNARY, depth + 1);
        left = { t: 'if', c: left, a, b };
        continue;
      }
      const power = INFIX[t.v];
      if (!power || power[0] < minPower) break;
      next();
      const right = expression(power[1], depth + 1);
      left = { t: 'binary', op: t.v as BinaryOp, a: left, b: right };
    }
    return left;
  };

  const primary = (depth: number): Expr => {
    const t = next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'name') {
      if (isOp(peek(), '(')) {
        next();
        const args: Expr[] = [];
        if (!isOp(peek(), ')')) {
          args.push(expression(0, depth + 1));
          while (isOp(peek(), ',')) {
            next();
            args.push(expression(0, depth + 1));
          }
        }
        expect(')');
        const fn = own(FUNCTIONS, t.v);
        if (!fn) throw new ParseError(`there is no function ${t.v}`);
        if (args.length < fn.min || args.length > fn.max) {
          const n = fn.min === fn.max ? `${fn.min}` : `${fn.min} to ${fn.max}`;
          throw new ParseError(`${t.v} takes ${n} argument${fn.max === 1 ? '' : 's'}`);
        }
        return { t: 'call', f: t.v, args };
      }
      if (own(FUNCTIONS, t.v)) {
        throw new ParseError(`${t.v} is a function: write ${t.v}(…)`);
      }
      return { t: 'name', name: t.v };
    }
    if (t.k === 'op' && t.v === '(') {
      const inner = expression(0, depth + 1);
      expect(')');
      return inner;
    }
    if (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === '!')) {
      return { t: 'unary', op: t.v, a: expression(PREFIX, depth + 1) };
    }
    throw new ParseError(t.k === 'end' ? 'the expression ends too early' : `unexpected “${t.v}”`);
  };

  const tree = expression(0, 0);
  const rest = peek();
  if (rest.k !== 'end')
    throw new ParseError(`unexpected “${rest.k === 'op' || rest.k === 'name' ? rest.v : rest.k}”`);
  return tree;
}

export type ParsedExpression = { ok: true; expr: Expr } | { ok: false; message: string };

/** Parses `source`; the message says what is wrong in an author's words. */
export function parseExpression(source: string): ParsedExpression {
  if (source.trim() === '') return { ok: false, message: 'the expression is empty' };
  if (source.length > MAX_EXPRESSION_LENGTH) {
    return {
      ok: false,
      message: `the expression is longer than ${MAX_EXPRESSION_LENGTH} characters`,
    };
  }
  try {
    return { ok: true, expr: parseTokens(tokenize(source)) };
  } catch (error) {
    if (error instanceof ParseError) return { ok: false, message: error.message };
    throw error;
  }
}

/** The names an expression reads, other than the constants. */
export function freeNames(expr: Expr, out = new Set<string>()): Set<string> {
  switch (expr.t) {
    case 'name':
      if (own(CONSTANTS, expr.name) === undefined) out.add(expr.name);
      break;
    case 'unary':
      freeNames(expr.a, out);
      break;
    case 'binary':
      freeNames(expr.a, out);
      freeNames(expr.b, out);
      break;
    case 'if':
      freeNames(expr.c, out);
      freeNames(expr.a, out);
      freeNames(expr.b, out);
      break;
    case 'call':
      for (const a of expr.args) freeNames(a, out);
      break;
    case 'num':
      break;
  }
  return out;
}

/**
 * What is wrong with `source` as an expression over `names`, or undefined when it is valid.
 * Every name it reads must be one of `names` or a constant.
 */
export function expressionProblem(source: string, names: Iterable<string>): string | undefined {
  const parsed = parseExpression(source);
  if (!parsed.ok) return `“${source}”: ${parsed.message}`;
  const known = new Set(names);
  const unknown = [...freeNames(parsed.expr)].filter((n) => !known.has(n));
  if (unknown.length === 0) return undefined;
  const offered = [...known].sort();
  return `“${source}” uses ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not defined here${
    offered.length ? ` (defined: ${offered.join(', ')})` : ''
  }`;
}

/** A value for each free name; a missing name reads as NaN, which no condition accepts. */
export type ExpressionScope = Readonly<Record<string, number>>;

export function evaluate(expr: Expr, scope: ExpressionScope): number {
  switch (expr.t) {
    case 'num':
      return expr.v;
    case 'name': {
      const value = own(CONSTANTS, expr.name) ?? own(scope, expr.name);
      return typeof value === 'number' ? value : Number.NaN;
    }
    case 'unary': {
      const a = evaluate(expr.a, scope);
      return expr.op === '-' ? -a : expr.op === '+' ? a : 1 - truth(a);
    }
    case 'if':
      return truth(evaluate(expr.c, scope)) ? evaluate(expr.a, scope) : evaluate(expr.b, scope);
    case 'call': {
      const fn = own(FUNCTIONS, expr.f);
      return fn ? fn.f(...expr.args.map((a) => evaluate(a, scope))) : Number.NaN;
    }
    case 'binary': {
      if (expr.op === '&&')
        return truth(evaluate(expr.a, scope)) ? truth(evaluate(expr.b, scope)) : 0;
      if (expr.op === '||')
        return truth(evaluate(expr.a, scope)) ? 1 : truth(evaluate(expr.b, scope));
      const a = evaluate(expr.a, scope);
      const b = evaluate(expr.b, scope);
      switch (expr.op) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          return a / b;
        case '%':
          return a % b;
        case '^':
          return a ** b;
        case '<':
          return Number(a < b);
        case '<=':
          return Number(a <= b);
        case '>':
          return Number(a > b);
        case '>=':
          return Number(a >= b);
        case '==':
          return Number(a === b);
        case '!=':
          return Number(a !== b);
      }
    }
  }
}

const cache = new Map<string, ParsedExpression>();

/** `parseExpression` remembered per source text; a scene redrawn every frame parses once. */
export function compileExpression(source: string): ParsedExpression {
  let parsed = cache.get(source);
  if (!parsed) {
    if (cache.size > 2000) cache.clear();
    parsed = parseExpression(source);
    cache.set(source, parsed);
  }
  return parsed;
}

/** A number, or the value of an expression in `scope`; NaN when the expression does not parse. */
export function quantityValue(value: number | string, scope: ExpressionScope): number {
  if (typeof value === 'number') return value;
  const parsed = compileExpression(value);
  return parsed.ok ? evaluate(parsed.expr, scope) : Number.NaN;
}

/** Whether a condition holds in `scope`: its value is a number other than 0. */
export function holds(source: string, scope: ExpressionScope): boolean {
  return truth(quantityValue(source, scope)) === 1;
}

/**
 * `{expr}` and `{expr:n}` placeholders in a label: each expression with its position in the
 * text, so a checker can validate them and a renderer can fill them in.
 */
export function placeholders(text: string): { source: string; digits?: number }[] {
  return [...text.matchAll(/\{([^{}:]+)(?::(\d))?\}/g)].map((m) => ({
    source: (m[1] as string).trim(),
    ...(m[2] !== undefined && { digits: Number(m[2]) }),
  }));
}

/** A number as a label shows it: `digits` decimals when given, else at most three, trimmed. */
export function formatNumber(value: number, digits?: number): string {
  if (!Number.isFinite(value)) return '–';
  if (digits !== undefined) return value.toFixed(digits);
  const rounded = Number(value.toFixed(3));
  return String(Object.is(rounded, -0) ? 0 : rounded);
}

/** A label with its `{expr}` placeholders filled in from `scope`. */
export function interpolate(text: string, scope: ExpressionScope): string {
  return text.replace(/\{([^{}:]+)(?::(\d))?\}/g, (_, source: string, digits?: string) =>
    formatNumber(
      quantityValue(source.trim(), scope),
      digits === undefined ? undefined : Number(digits),
    ),
  );
}
