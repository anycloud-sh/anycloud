/**
 * Evaluates the GitHub Actions expression subset our workflows use, so
 * workflow policy specs check what a job does for an event (where it runs,
 * whether it runs) instead of how its condition is spelled.
 *
 * Semantics follow GitHub's expression docs: `&&` and `||` return an operand,
 * `==` ignores case and coerces mismatched types to numbers, and property
 * access on a missing value yields null.
 */
export type Value =
  | string
  | number
  | boolean
  | null
  | Value[]
  | { [key: string]: Value };
export type Functions = Record<string, (...args: Value[]) => Value>;

/**
 * True for a pull request from a fork or Dependabot. Workflows route these to
 * GitHub-hosted runners with `(vars.CI_BACKEND == 'hosted' || <this>)`. That
 * is defense in depth: a fork's pull request runs the workflow files it
 * carries, so it can drop the route.
 */
export const UNTRUSTED_PULL_REQUEST =
  "github.event_name == 'pull_request' && " +
  '(github.event.pull_request.head.repo.full_name != github.repository || ' +
  "github.event.pull_request.user.login == 'dependabot[bot]')";

/** True for a workflow_run that follows a run such a pull request started. */
export const UNTRUSTED_WORKFLOW_RUN =
  "github.event_name == 'workflow_run' && " +
  '(github.event.workflow_run.head_repository.full_name != github.repository || ' +
  "github.event.workflow_run.actor.login == 'dependabot[bot]')";

/** `x.*` result: later property access maps over the elements. */
class Projection extends Array<Value> {}

const TOKEN =
  /\s*(?:(\d+(?:\.\d+)?)|'((?:[^']|'')*)'|([A-Za-z_][\w-]*)|(==|!=|<=|>=|&&|\|\||[!<>().,[\]*]))/y;

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < source.trimEnd().length) {
    const at = TOKEN.lastIndex;
    const match = TOKEN.exec(source);
    if (!match) throw new Error(`cannot parse ${source.slice(at)}`);
    tokens.push(match[0].trim());
  }
  return tokens;
}

export function truthy(value: Value): boolean {
  return !(
    value === false ||
    value === null ||
    value === '' ||
    value === 0 ||
    Number.isNaN(value)
  );
}

function toNumber(value: Value): number {
  if (value === null) return 0;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') return value.trim() === '' ? 0 : Number(value);
  return typeof value === 'number' ? value : NaN;
}

function equal(a: Value, b: Value): boolean {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }
  if (typeof a === typeof b) return a === b;
  return toNumber(a) === toNumber(b);
}

function property(target: Value, key: string): Value {
  if (target instanceof Projection) {
    return Projection.from(target, (item) => property(item, key));
  }
  if (target === null || typeof target !== 'object') return null;
  if (Array.isArray(target)) return target[Number(key)] ?? null;
  const name = Object.keys(target).find(
    (candidate) => candidate.toLowerCase() === key.toLowerCase(),
  );
  return name === undefined ? null : target[name];
}

const BUILTINS: Functions = {
  contains: (haystack, needle) =>
    Array.isArray(haystack)
      ? haystack.some((item) => equal(item, needle))
      : String(haystack ?? '')
          .toLowerCase()
          .includes(String(needle ?? '').toLowerCase()),
  startsWith: (text, prefix) =>
    String(text ?? '')
      .toLowerCase()
      .startsWith(String(prefix ?? '').toLowerCase()),
  endsWith: (text, suffix) =>
    String(text ?? '')
      .toLowerCase()
      .endsWith(String(suffix ?? '').toLowerCase()),
  fromJSON: (text) => JSON.parse(String(text)) as Value,
  format: (template, ...args) =>
    String(template).replace(/\{(\d+)\}/g, (_, i: string) =>
      String(args[Number(i)] ?? ''),
    ),
};

/** Evaluates one expression (no `${{ }}`) against `context`. */
export function evaluate(
  expression: string,
  context: Record<string, Value>,
  functions: Functions = {},
): Value {
  const tokens = tokenize(expression);
  let position = 0;
  const peek = () => tokens[position];
  const take = (expected?: string) => {
    const token = tokens[position++];
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected}, got ${token} in ${expression}`);
    }
    return token;
  };

  const or = (): Value => {
    let left = and();
    while (peek() === '||') {
      take();
      const right = and();
      left = truthy(left) ? left : right;
    }
    return left;
  };
  const and = (): Value => {
    let left = comparison();
    while (peek() === '&&') {
      take();
      const right = comparison();
      left = truthy(left) ? right : left;
    }
    return left;
  };
  const comparison = (): Value => {
    let left = unary();
    while (['==', '!=', '<', '>', '<=', '>='].includes(peek())) {
      const operator = take();
      const right = unary();
      if (operator === '==') left = equal(left, right);
      else if (operator === '!=') left = !equal(left, right);
      else {
        const [a, b] = [toNumber(left), toNumber(right)];
        left =
          operator === '<'
            ? a < b
            : operator === '>'
              ? a > b
              : operator === '<='
                ? a <= b
                : a >= b;
      }
    }
    return left;
  };
  const unary = (): Value => {
    if (peek() === '!') {
      take();
      return !truthy(unary());
    }
    return postfix(primary());
  };
  const primary = (): Value => {
    const token = take();
    if (token === '(') {
      const value = or();
      take(')');
      return value;
    }
    if (token.startsWith("'")) return token.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(token)) return Number(token);
    if (token === 'true' || token === 'false') return token === 'true';
    if (token === 'null') return null;
    if (peek() === '(') {
      take();
      const args: Value[] = [];
      while (peek() !== ')') {
        args.push(or());
        if (peek() === ',') take();
      }
      take(')');
      const fn = functions[token] ?? BUILTINS[token];
      if (!fn) throw new Error(`unknown function ${token}()`);
      return fn(...args);
    }
    return property(context, token);
  };
  const postfix = (target: Value): Value => {
    for (;;) {
      if (peek() === '.') {
        take();
        const key = take();
        target =
          key === '*'
            ? Projection.from(
                Array.isArray(target)
                  ? target
                  : Object.values((target ?? {}) as Record<string, Value>),
              )
            : property(target, key);
      } else if (peek() === '[') {
        take();
        const key = or();
        take(']');
        target = property(target, String(key));
      } else {
        return target;
      }
    }
  };

  const value = or();
  if (position !== tokens.length) {
    throw new Error(`unexpected ${peek()} in ${expression}`);
  }
  return value instanceof Projection ? [...value] : value;
}

/**
 * Evaluates a workflow field: a whole `${{ expr }}` yields the expression's
 * value, embedded ones interpolate into a string, and a plain value passes
 * through. `bare` treats a plain string as an expression, as `if:` does.
 */
export function evaluateField(
  field: unknown,
  context: Record<string, Value>,
  functions: Functions = {},
  bare = false,
): Value {
  if (typeof field !== 'string') return (field ?? null) as Value;
  const whole = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(field);
  if (whole && !whole[1].includes('${{')) {
    return evaluate(whole[1], context, functions);
  }
  if (field.includes('${{')) {
    return field.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expression: string) =>
      String(evaluate(expression, context, functions) ?? ''),
    );
  }
  return bare ? evaluate(field, context, functions) : field;
}
