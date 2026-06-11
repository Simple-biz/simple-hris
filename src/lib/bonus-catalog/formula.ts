// Excel-style formula engine for the Bonus Catalog.
//
// Accountants author bonus rules using a familiar spreadsheet syntax
// (IF(...), MIN/MAX, ROUND, tiers via nested IFs, arithmetic on named metric
// variables). This module turns that text into:
//   - an AST                      (parse)
//   - a numeric result            (evaluate, given variable values)
//   - the list of variables used  (extractVariables)
//   - a validation verdict        (validateFormula)
//   - a faithful TypeScript port  (compileToTypeScript)
//
// Semantics are numeric-everywhere (Excel-like coercion): comparisons yield
// 1/0, any nonzero value is "true", division by zero yields 0 (payroll-safe,
// never Infinity/NaN). There is NO use of eval()/Function() anywhere -- the
// evaluator walks the AST directly, and the generated TypeScript is a
// self-contained, runnable port that produces the identical result.

const MAX_INPUT_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type Token =
  | { type: 'num'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'comma' };

const TWO_CHAR_OPS = new Set(['>=', '<=', '<>']);
const ONE_CHAR_OPS = new Set(['+', '-', '*', '/', '^', '=', '>', '<']);

function tokenize(input: string): Token[] {
  if (input.length > MAX_INPUT_LENGTH) {
    throw new FormulaError('Formula is too long.');
  }
  const tokens: Token[] = [];
  let i = 0;
  const n = input.length;

  while (i < n) {
    const ch = input[i];

    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i += 1;
      continue;
    }

    // Number (integer or decimal). Leading dot supported (.5).
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && input[i + 1] >= '0' && input[i + 1] <= '9')) {
      let j = i;
      let seenDot = false;
      while (j < n) {
        const c = input[j];
        if (c >= '0' && c <= '9') {
          j += 1;
        } else if (c === '.' && !seenDot) {
          seenDot = true;
          j += 1;
        } else {
          break;
        }
      }
      const slice = input.slice(i, j);
      const value = Number(slice);
      if (!Number.isFinite(value)) throw new FormulaError(`Invalid number "${slice}".`);
      tokens.push({ type: 'num', value });
      i = j;
      continue;
    }

    // Identifier: letter or underscore, then word chars.
    if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_') {
      let j = i;
      while (j < n) {
        const c = input[j];
        if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_') {
          j += 1;
        } else {
          break;
        }
      }
      tokens.push({ type: 'ident', value: input.slice(i, j) });
      i = j;
      continue;
    }

    if (ch === '(') { tokens.push({ type: 'lparen' }); i += 1; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i += 1; continue; }
    if (ch === ',') { tokens.push({ type: 'comma' }); i += 1; continue; }

    const two = input.slice(i, i + 2);
    if (TWO_CHAR_OPS.has(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
    if (ONE_CHAR_OPS.has(ch)) { tokens.push({ type: 'op', value: ch }); i += 1; continue; }

    throw new FormulaError(`Unexpected character "${ch}".`);
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

export type Ast =
  | { kind: 'num'; value: number }
  | { kind: 'var'; name: string }
  | { kind: 'unary'; op: '-'; arg: Ast }
  | { kind: 'binary'; op: string; left: Ast; right: Ast }
  | { kind: 'call'; name: string; args: Ast[] };

export class FormulaError extends Error {}

/** Built-in functions: name -> [minArgs, maxArgs] (maxArgs = Infinity for variadic). */
const FUNCTIONS: Record<string, [number, number]> = {
  IF: [3, 3],
  MIN: [1, Infinity],
  MAX: [1, Infinity],
  SUM: [1, Infinity],
  ROUND: [1, 2],
  ROUNDUP: [1, 2],
  ROUNDDOWN: [1, 2],
  FLOOR: [1, 2],
  CEILING: [1, 2],
  ABS: [1, 1],
  MOD: [2, 2],
  AND: [1, Infinity],
  OR: [1, Infinity],
  NOT: [1, 1],
};

/** Reserved identifiers that are NOT user variables. */
const CONSTANTS: Record<string, number> = { TRUE: 1, FALSE: 0 };

export function isReservedName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper in FUNCTIONS || upper in CONSTANTS;
}

export const BUILTIN_FUNCTION_NAMES = Object.keys(FUNCTIONS);

// ---------------------------------------------------------------------------
// Parser (recursive descent with precedence)
//   expr        := comparison
//   comparison  := additive ( (= <> >= <= > <) additive )*
//   additive    := multiplicative ( (+ -) multiplicative )*
//   multiplicative := power ( (* /) power )*
//   power       := unary ( ^ power )?          (right associative)
//   unary       := (-)? primary
//   primary     := number | ident | ident '(' args ')' | '(' expr ')'
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Ast {
    if (this.tokens.length === 0) throw new FormulaError('Formula is empty.');
    const node = this.parseComparison();
    if (this.pos < this.tokens.length) {
      throw new FormulaError('Unexpected trailing input.');
    }
    return node;
  }

  private peek(): Token | undefined { return this.tokens[this.pos]; }
  private next(): Token | undefined { return this.tokens[this.pos++]; }

  private parseComparison(): Ast {
    let left = this.parseAdditive();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'op' && ['=', '<>', '>=', '<=', '>', '<'].includes(t.value)) {
        this.next();
        const right = this.parseAdditive();
        left = { kind: 'binary', op: t.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseAdditive(): Ast {
    let left = this.parseMultiplicative();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '+' || t.value === '-')) {
        this.next();
        const right = this.parseMultiplicative();
        left = { kind: 'binary', op: t.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parseMultiplicative(): Ast {
    let left = this.parsePower();
    while (true) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.value === '*' || t.value === '/')) {
        this.next();
        const right = this.parsePower();
        left = { kind: 'binary', op: t.value, left, right };
      } else {
        break;
      }
    }
    return left;
  }

  private parsePower(): Ast {
    const left = this.parseUnary();
    const t = this.peek();
    if (t && t.type === 'op' && t.value === '^') {
      this.next();
      const right = this.parsePower(); // right associative
      return { kind: 'binary', op: '^', left, right };
    }
    return left;
  }

  private parseUnary(): Ast {
    const t = this.peek();
    if (t && t.type === 'op' && t.value === '-') {
      this.next();
      return { kind: 'unary', op: '-', arg: this.parseUnary() };
    }
    if (t && t.type === 'op' && t.value === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    const t = this.next();
    if (!t) throw new FormulaError('Unexpected end of formula.');

    if (t.type === 'num') return { kind: 'num', value: t.value };

    if (t.type === 'lparen') {
      const inner = this.parseComparison();
      const close = this.next();
      if (!close || close.type !== 'rparen') throw new FormulaError('Missing closing parenthesis ")".');
      return inner;
    }

    if (t.type === 'ident') {
      const after = this.peek();
      if (after && after.type === 'lparen') {
        // Function call
        const fnName = t.value.toUpperCase();
        if (!(fnName in FUNCTIONS)) throw new FormulaError(`Unknown function "${t.value}".`);
        this.next(); // consume '('
        const args: Ast[] = [];
        if (this.peek() && this.peek()!.type !== 'rparen') {
          args.push(this.parseComparison());
          while (this.peek() && this.peek()!.type === 'comma') {
            this.next();
            args.push(this.parseComparison());
          }
        }
        const close = this.next();
        if (!close || close.type !== 'rparen') throw new FormulaError(`Missing ")" after ${fnName}(...).`);
        const [minA, maxA] = FUNCTIONS[fnName];
        if (args.length < minA || args.length > maxA) {
          const range = maxA === Infinity ? `${minA}+` : minA === maxA ? `${minA}` : `${minA}-${maxA}`;
          throw new FormulaError(`${fnName} expects ${range} argument(s), got ${args.length}.`);
        }
        return { kind: 'call', name: fnName, args };
      }
      // Constant or variable
      const upper = t.value.toUpperCase();
      if (upper in CONSTANTS) return { kind: 'num', value: CONSTANTS[upper] };
      return { kind: 'var', name: t.value };
    }

    throw new FormulaError('Unexpected token.');
  }
}

export function parseFormula(input: string): Ast {
  // Excel formulas begin with "="; accept it (optional) so pasted formulas
  // like "=A+B" work. Here A/B are NOT cell references (there is no grid) --
  // they are named variables (the metric inputs).
  let src = (input ?? '').trim();
  if (src.startsWith('=')) src = src.slice(1).trim();
  return new Parser(tokenize(src)).parse();
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

function num(v: number): number { return Number.isFinite(v) ? v : 0; }
function bool(v: number): boolean { return num(v) !== 0; }

function evalNode(node: Ast, vars: Record<string, number>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'var': {
      const v = vars[node.name];
      return typeof v === 'number' && Number.isFinite(v) ? v : 0;
    }
    case 'unary':
      return -evalNode(node.arg, vars);
    case 'binary': {
      const a = evalNode(node.left, vars);
      const b = evalNode(node.right, vars);
      switch (node.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b === 0 ? 0 : a / b;
        case '^': return num(Math.pow(a, b));
        case '=': return a === b ? 1 : 0;
        case '<>': return a !== b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        default: throw new FormulaError(`Unknown operator "${node.op}".`);
      }
    }
    case 'call': {
      const args = node.args.map((a) => evalNode(a, vars));
      switch (node.name) {
        case 'IF': return bool(args[0]) ? args[1] : args[2];
        case 'MIN': return Math.min(...args);
        case 'MAX': return Math.max(...args);
        case 'SUM': return args.reduce((s, x) => s + x, 0);
        case 'ABS': return Math.abs(args[0]);
        case 'MOD': return args[1] === 0 ? 0 : args[0] % args[1];
        case 'ROUND': return roundTo(args[0], args[1] ?? 0, 'round');
        case 'ROUNDUP': return roundTo(args[0], args[1] ?? 0, 'up');
        case 'ROUNDDOWN': return roundTo(args[0], args[1] ?? 0, 'down');
        case 'FLOOR': return stepRound(args[0], args[1] ?? 1, 'floor');
        case 'CEILING': return stepRound(args[0], args[1] ?? 1, 'ceil');
        case 'AND': return args.every(bool) ? 1 : 0;
        case 'OR': return args.some(bool) ? 1 : 0;
        case 'NOT': return bool(args[0]) ? 0 : 1;
        default: throw new FormulaError(`Unknown function "${node.name}".`);
      }
    }
    default:
      throw new FormulaError('Unknown node.');
  }
}

function roundTo(x: number, digits: number, mode: 'round' | 'up' | 'down'): number {
  const f = Math.pow(10, Math.trunc(digits));
  const scaled = x * f;
  const r = mode === 'up' ? Math.ceil(scaled) : mode === 'down' ? Math.floor(scaled) : Math.round(scaled);
  return num(r / f);
}

function stepRound(x: number, step: number, mode: 'floor' | 'ceil'): number {
  if (step === 0) return 0;
  return num((mode === 'floor' ? Math.floor(x / step) : Math.ceil(x / step)) * step);
}

/** Evaluate a formula string against a variable map. Returns a finite number. */
export function evaluateFormula(input: string, vars: Record<string, number>): number {
  return num(evalNode(parseFormula(input), vars));
}

/** Evaluate an already-parsed AST (avoids re-parsing in hot loops). */
export function evaluateAst(ast: Ast, vars: Record<string, number>): number {
  return num(evalNode(ast, vars));
}

// ---------------------------------------------------------------------------
// Variable extraction + validation
// ---------------------------------------------------------------------------

function collectVars(node: Ast, out: Set<string>): void {
  switch (node.kind) {
    case 'var': out.add(node.name); break;
    case 'unary': collectVars(node.arg, out); break;
    case 'binary': collectVars(node.left, out); collectVars(node.right, out); break;
    case 'call': node.args.forEach((a) => collectVars(a, out)); break;
    default: break;
  }
}

/** Distinct variable names referenced by the formula (in first-seen order). */
export function extractVariables(input: string): string[] {
  const out = new Set<string>();
  collectVars(parseFormula(input), out);
  return [...out];
}

export type ValidationResult =
  | { ok: true; variables: string[]; ast: Ast }
  | { ok: false; error: string };

/** Parse + validate without throwing. */
export function validateFormula(input: string): ValidationResult {
  const trimmed = (input ?? '').trim();
  if (!trimmed) return { ok: false, error: 'Formula is empty.' };
  try {
    const ast = parseFormula(trimmed);
    const out = new Set<string>();
    collectVars(ast, out);
    return { ok: true, variables: [...out], ast };
  } catch (e) {
    return { ok: false, error: e instanceof FormulaError ? e.message : 'Invalid formula.' };
  }
}

// ---------------------------------------------------------------------------
// TypeScript code generation
// ---------------------------------------------------------------------------

function compileNode(node: Ast): string {
  switch (node.kind) {
    case 'num':
      return String(node.value);
    case 'var':
      return safeIdent(node.name);
    case 'unary':
      return `-(${compileNode(node.arg)})`;
    case 'binary': {
      const a = compileNode(node.left);
      const b = compileNode(node.right);
      switch (node.op) {
        case '+': return `(${a} + ${b})`;
        case '-': return `(${a} - ${b})`;
        case '*': return `(${a} * ${b})`;
        // Payroll-safe divide: 0 instead of Infinity/NaN.
        case '/': return `((${b}) === 0 ? 0 : (${a}) / (${b}))`;
        case '^': return `Math.pow(${a}, ${b})`;
        case '=': return `((${a}) === (${b}) ? 1 : 0)`;
        case '<>': return `((${a}) !== (${b}) ? 1 : 0)`;
        case '>=': return `((${a}) >= (${b}) ? 1 : 0)`;
        case '<=': return `((${a}) <= (${b}) ? 1 : 0)`;
        case '>': return `((${a}) > (${b}) ? 1 : 0)`;
        case '<': return `((${a}) < (${b}) ? 1 : 0)`;
        default: return '0';
      }
    }
    case 'call': {
      const a = node.args.map(compileNode);
      switch (node.name) {
        case 'IF': return `((${a[0]}) !== 0 ? (${a[1]}) : (${a[2]}))`;
        case 'MIN': return `Math.min(${a.join(', ')})`;
        case 'MAX': return `Math.max(${a.join(', ')})`;
        case 'SUM': return `(${a.join(' + ')})`;
        case 'ABS': return `Math.abs(${a[0]})`;
        case 'MOD': return `((${a[1]}) === 0 ? 0 : (${a[0]}) % (${a[1]}))`;
        case 'NOT': return `((${a[0]}) !== 0 ? 0 : 1)`;
        case 'AND': return `(${a.map((x) => `(${x}) !== 0`).join(' && ')} ? 1 : 0)`;
        case 'OR': return `(${a.map((x) => `(${x}) !== 0`).join(' || ')} ? 1 : 0)`;
        case 'ROUND': return roundExpr(a[0], a[1] ?? '0', 'round');
        case 'ROUNDUP': return roundExpr(a[0], a[1] ?? '0', 'ceil');
        case 'ROUNDDOWN': return roundExpr(a[0], a[1] ?? '0', 'floor');
        case 'FLOOR': return stepExpr(a[0], a[1] ?? '1', 'floor');
        case 'CEILING': return stepExpr(a[0], a[1] ?? '1', 'ceil');
        default: return '0';
      }
    }
    default:
      return '0';
  }
}

function roundExpr(x: string, digits: string, mode: 'round' | 'ceil' | 'floor'): string {
  return `(Math.${mode}((${x}) * Math.pow(10, ${digits})) / Math.pow(10, ${digits}))`;
}

function stepExpr(x: string, step: string, mode: 'floor' | 'ceil'): string {
  return `((${step}) === 0 ? 0 : Math.${mode}((${x}) / (${step})) * (${step}))`;
}

/** JS identifiers are a superset of our identifier grammar, so names pass through. */
function safeIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `vars[${JSON.stringify(name)}]`;
}

/**
 * Emit a self-contained, runnable TypeScript function equivalent to the formula.
 * This is the "translate to code" view shown next to the editor.
 */
export function compileToTypeScript(input: string, fnName = 'computeBonus'): string {
  const result = validateFormula(input);
  if (!result.ok) return `// Cannot compile: ${result.error}`;

  const vars = result.variables;
  const header = `/** Generated from formula: ${input.trim().replace(/\*\//g, '* /')} */`;
  const destructure =
    vars.length > 0
      ? `  const { ${vars.map(safeIdent).join(', ')} } = { ${vars
          .map((v) => `${safeIdent(v)}: vars[${JSON.stringify(v)}] ?? 0`)
          .join(', ')} };\n`
      : '';
  const body = compileNode(result.ast);
  return (
    `${header}\n` +
    `export function ${fnName}(vars: Record<string, number>): number {\n` +
    destructure +
    `  return ${body};\n` +
    `}`
  );
}
