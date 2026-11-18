// queryIssues: the `bd query` expression language over HTTP.
//
// The grammar and the evaluator are ported from upstream internal/query/{lexer,parser,evaluator}.go and
// the plan from internal/workapi/query.go. Every expression is evaluated as a predicate over the
// candidate rows (upstream's predicate mode), so no expression is refused for being "filter-incompatible";
// docs/semantics.md lists the places where upstream's filter mode and predicate mode differ and which one this follows.
import { METADATA_KEY } from "./body";
import { all, issuesWithCounts, type IssueRow } from "./model";
import { invalid } from "./problem";
import type { Out } from "./problem";
import { blockedAmong, Params } from "./ready";
import { isStatus, loadVocab, statusNames } from "./vocab";
import { safeObject } from "./util";

// ---------------------------------------------------------------------------------------------
// lexer (lexer.go)

type TokenType = "EOF" | "IDENT" | "STRING" | "NUMBER" | "DURATION" | "=" | "!=" | "<" | "<=" | ">" | ">=" | "AND" | "OR" | "NOT" | "(" | ")" | ",";
interface Token {
  type: TokenType;
  value: string;
  pos: number;
}

const isLetter = (c: string) => /\p{L}/u.test(c);
const isDigit = (c: string) => /\p{Nd}/u.test(c);
const isIdentStart = (c: string) => isLetter(c) || c === "_";
const isIdentChar = (c: string) => isLetter(c) || isDigit(c) || "_-.:/".includes(c);
const isDurationSuffix = (c: string) => "hdwmyHDWMY".includes(c);

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  const peek = () => (pos < input.length ? input[pos]! : "");
  const readIdent = (start: number): Token => {
    let value = "";
    while (pos < input.length && isIdentChar(input[pos]!)) value += input[pos++];
    const upper = value.toUpperCase();
    const type = upper === "AND" || upper === "OR" || upper === "NOT" ? upper : "IDENT";
    return { type, value, pos: start };
  };
  for (;;) {
    while (pos < input.length && /\s/u.test(input[pos]!)) pos++;
    const start = pos;
    if (pos >= input.length) {
      tokens.push({ type: "EOF", value: "", pos: start });
      return tokens;
    }
    const r = input[pos++]!;
    if (r === "(" || r === ")" || r === "," || r === "=") {
      tokens.push({ type: r, value: r, pos: start });
    } else if (r === "!") {
      if (peek() !== "=") throw new Error(`unexpected character '!' at position ${start} (did you mean '!=' or 'NOT'?)`);
      pos++;
      tokens.push({ type: "!=", value: "!=", pos: start });
    } else if (r === "<" || r === ">") {
      if (peek() === "=") {
        pos++;
        tokens.push({ type: `${r}=` as TokenType, value: `${r}=`, pos: start });
      } else tokens.push({ type: r, value: r, pos: start });
    } else if (r === '"' || r === "'") {
      let value = "";
      for (;;) {
        if (pos >= input.length) throw new Error(`unterminated string starting at position ${start}`);
        const c = input[pos++]!;
        if (c === r) break;
        if (c === "\\") {
          if (pos >= input.length) throw new Error(`unterminated escape sequence at position ${pos - 1}`);
          const e = input[pos++]!;
          value += e === "n" ? "\n" : e === "t" ? "\t" : e;
        } else value += c;
      }
      tokens.push({ type: "STRING", value, pos: start });
    } else if (isDigit(r) || r === "-" || r === "+") {
      pos = start;
      tokens.push(readNumberOrDuration());
    } else if (isIdentStart(r)) {
      pos = start;
      tokens.push(readIdent(start));
    } else {
      throw new Error(`unexpected character "${r}" at position ${start}`);
    }
  }

  function readNumberOrDuration(): Token {
    const startPos = pos;
    let value = "";
    let c = pos < input.length ? input[pos++]! : "";
    const hadSign = c === "-" || c === "+";
    if (hadSign) {
      value += c;
      c = pos < input.length ? input[pos++]! : "";
    }
    if (c === "" || !isDigit(c)) throw new Error(`expected digit at position ${pos - 1}`);
    value += c;
    for (;;) {
      c = pos < input.length ? input[pos++]! : "";
      if (c === "" || !isDigit(c)) break;
      value += c;
    }
    const after = pos < input.length ? input[pos]! : "";
    if (c !== "" && isDurationSuffix(c) && !(after !== "" && isIdentChar(after))) {
      return { type: "DURATION", value: value + c, pos: startPos };
    }
    if (!hadSign && c !== "" && isIdentChar(c)) {
      pos = startPos;
      return readIdent(startPos);
    }
    if (c !== "") pos--;
    return { type: "NUMBER", value, pos: startPos };
  }
}

// ---------------------------------------------------------------------------------------------
// parser (parser.go)

type Op = "=" | "!=" | "<" | "<=" | ">" | ">=";
type Node =
  | { kind: "cmp"; field: string; op: Op; value: string; valueType: TokenType }
  | { kind: "and"; left: Node; right: Node }
  | { kind: "or"; left: Node; right: Node }
  | { kind: "not"; operand: Node };

export const KNOWN_FIELDS = new Set([
  "id", "title", "description", "desc", "status", "priority", "type", "assignee", "owner", "created", "updated", "closed",
  "created_at", "updated_at", "closed_at", "started", "started_at", "label", "labels", "pinned", "ephemeral", "template",
  "spec", "spec_id", "parent", "mol_type", "notes", "has_metadata_key",
]);

function parse(input: string): Node {
  const tokens = tokenize(input);
  let i = 0;
  const cur = () => tokens[i]!;
  const advance = () => {
    if (i < tokens.length - 1) i++;
  };
  if (cur().type === "EOF") throw new Error("empty query");

  const orExpr = (): Node => {
    let left = andExpr();
    while (cur().type === "OR") {
      advance();
      left = { kind: "or", left, right: andExpr() };
    }
    return left;
  };
  const andExpr = (): Node => {
    let left = notExpr();
    while (cur().type === "AND") {
      advance();
      left = { kind: "and", left, right: notExpr() };
    }
    return left;
  };
  const notExpr = (): Node => {
    if (cur().type === "NOT") {
      advance();
      return { kind: "not", operand: notExpr() };
    }
    return primary();
  };
  const primary = (): Node => {
    if (cur().type === "(") {
      advance();
      const node = orExpr();
      if (cur().type !== ")") throw new Error(`expected ')' at position ${cur().pos}, got ${cur().type}`);
      advance();
      return node;
    }
    return comparison();
  };
  const comparison = (): Node => {
    if (cur().type !== "IDENT") throw new Error(`expected field name at position ${cur().pos}, got ${cur().type}`);
    let field = cur().value.toLowerCase();
    if (field.startsWith("metadata.") && field.length > "metadata.".length) field = `metadata.${cur().value.slice("metadata.".length)}`;
    advance();
    const op = cur().type;
    if (!["=", "!=", "<", "<=", ">", ">="].includes(op)) throw new Error(`expected comparison operator at position ${cur().pos}, got ${op}`);
    advance();
    const t = cur();
    if (!["IDENT", "STRING", "NUMBER", "DURATION"].includes(t.type)) throw new Error(`expected value at position ${t.pos}, got ${t.type}`);
    advance();
    return { kind: "cmp", field, op: op as Op, value: t.value, valueType: t.type };
  };

  const node = orExpr();
  if (cur().type !== "EOF") throw new Error(`unexpected token "${cur().value}" at position ${cur().pos} (expected end of query)`);
  return node;
}

const mentionsStatus = (n: Node): boolean =>
  n.kind === "cmp" ? n.field === "status" : n.kind === "not" ? mentionsStatus(n.operand) : mentionsStatus(n.left) || mentionsStatus(n.right);

// ---------------------------------------------------------------------------------------------
// time values (internal/timeparsing/parser.go)

const COMPACT = /^([+-]?)(\d+)([hdwmy])$/;

function addCompact(base: Date, amount: number, unit: string): Date {
  const d = new Date(base);
  if (unit === "h") d.setUTCHours(d.getUTCHours() + amount);
  else if (unit === "d") d.setUTCDate(d.getUTCDate() + amount);
  else if (unit === "w") d.setUTCDate(d.getUTCDate() + amount * 7);
  else if (unit === "m") d.setUTCMonth(d.getUTCMonth() + amount);
  else d.setUTCFullYear(d.getUTCFullYear() + amount);
  return d;
}

function parseTime(value: string, valueType: TokenType, now: Date): Date {
  // A bare duration token means "that long ago" (evaluator.go parseDurationAgo).
  if (valueType === "DURATION") {
    const m = COMPACT.exec(`-${value.replace(/^\+/, "")}`);
    if (!m) throw new Error(`cannot parse time expression: ${JSON.stringify(value)}`);
    return addCompact(now, -Number(m[2]), m[3]!);
  }
  const m = COMPACT.exec(value);
  if (m) return addCompact(now, (m[1] === "-" ? -1 : 1) * Number(m[2]), m[3]!);
  const day = new Date(now);
  day.setUTCHours(0, 0, 0, 0);
  const named: Record<string, Date> = {
    now,
    today: day,
    yesterday: addCompact(day, -1, "d"),
    tomorrow: addCompact(day, 1, "d"),
  };
  const lower = value.toLowerCase();
  if (named[lower]) return named[lower]!;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value) || /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?$/.test(value)) {
    const t = Date.parse(value.includes(" ") ? value.replace(" ", "T") + (/[Zz+]|-\d{2}:\d{2}$/.test(value) ? "" : "Z") : value.length === 10 ? `${value}T00:00:00Z` : /[Zz]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
    if (!Number.isNaN(t)) return new Date(t);
  }
  throw new Error(`cannot parse time expression: ${JSON.stringify(value)} (examples: +6h, tomorrow, 2025-01-15)`);
}

// ---------------------------------------------------------------------------------------------
// evaluation

interface Candidate {
  row: IssueRow;
  labels: string[];
  metadata: Record<string, unknown>;
  extra: Record<string, unknown>;
  parents: Set<string>;
}
type Predicate = (c: Candidate) => boolean;

const NONE = (v: string) => v === "" || v.toLowerCase() === "none" || v.toLowerCase() === "null";
const sameDay = (a: Date, b: Date) => a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();

function compareTime(op: Op, actual: Date, target: Date): boolean {
  switch (op) {
    case "=": return sameDay(actual, target);
    case "!=": return !sameDay(actual, target);
    case "<": return actual < target;
    case "<=": return actual <= target;
    case ">": return actual > target;
    default: return actual >= target;
  }
}

function boolValue(value: string, field: string): boolean {
  const v = value.toLowerCase();
  if (["true", "yes", "1"].includes(v)) return true;
  if (["false", "no", "0"].includes(v)) return false;
  throw new Error(`invalid boolean value for ${field}: ${value}`);
}

function compile(node: Node, now: Date, statuses: (s: string) => boolean): Predicate {
  if (node.kind === "and") {
    const [l, r] = [compile(node.left, now, statuses), compile(node.right, now, statuses)];
    return (c) => l(c) && r(c);
  }
  if (node.kind === "or") {
    const [l, r] = [compile(node.left, now, statuses), compile(node.right, now, statuses)];
    return (c) => l(c) || r(c);
  }
  if (node.kind === "not") {
    const o = compile(node.operand, now, statuses);
    return (c) => !o(c);
  }
  const { field, op, value, valueType } = node;
  const only = (...allowed: Op[]) => {
    if (!allowed.includes(op)) throw new Error(`${field} does not support ${op} operator`);
  };
  const text = (get: (c: Candidate) => string): Predicate => {
    only("=", "!=");
    const v = value.toLowerCase();
    return (c) => (get(c).toLowerCase().includes(v) ? op === "=" : op === "!=");
  };
  const instant = (get: (c: Candidate) => string | null, label: string): Predicate => {
    let target: Date;
    try {
      target = parseTime(value, valueType, now);
    } catch (e) {
      throw new Error(`invalid ${label} time: ${(e as Error).message}`);
    }
    return (c) => {
      const raw = get(c);
      return raw === null ? false : compareTime(op, new Date(raw), target);
    };
  };

  switch (field) {
    case "status": {
      only("=", "!=");
      const status = value.toLowerCase();
      if (!statuses(status)) throw new Error(`invalid status: ${value}`);
      return (c) => (c.row.status === status) === (op === "=");
    }
    case "priority": {
      if (!/^[+-]?\d+$/.test(value)) throw new Error(`invalid priority value: ${value}`);
      const n = Number(value);
      return (c) => {
        const p = c.row.priority;
        return op === "=" ? p === n : op === "!=" ? p !== n : op === "<" ? p < n : op === "<=" ? p <= n : op === ">" ? p > n : p >= n;
      };
    }
    case "type": {
      only("=", "!=");
      const type = value.toLowerCase();
      return (c) => (c.row.issue_type === type) === (op === "=");
    }
    case "assignee": {
      only("=", "!=");
      return (c) => {
        const same = NONE(value) ? c.row.assignee === "" : c.row.assignee.toLowerCase() === value.toLowerCase();
        return same === (op === "=");
      };
    }
    case "owner": {
      only("=", "!=");
      return (c) => {
        const same = NONE(value) ? c.row.owner === "" : c.row.owner.toLowerCase() === value.toLowerCase();
        return same === (op === "=");
      };
    }
    case "label":
    case "labels": {
      only("=", "!=");
      return (c) => {
        const has = NONE(value) ? c.labels.length > 0 : c.labels.some((l) => l.toLowerCase() === value.toLowerCase());
        return NONE(value) ? (op === "=" ? !has : has) : has === (op === "=");
      };
    }
    case "title": return text((c) => c.row.title);
    case "notes": return text((c) => c.row.notes);
    case "description":
    case "desc": {
      only("=", "!=");
      return (c) => {
        const has = NONE(value) ? c.row.description !== "" : c.row.description.toLowerCase().includes(value.toLowerCase());
        return NONE(value) ? (op === "=" ? !has : has) : has === (op === "=");
      };
    }
    case "created":
    case "created_at": return instant((c) => c.row.created_at, "created");
    case "updated":
    case "updated_at": return instant((c) => c.row.updated_at, "updated");
    case "closed":
    case "closed_at": return instant((c) => c.row.closed_at, "closed");
    case "started":
    case "started_at": return instant((c) => c.row.started_at, "started");
    case "id": {
      only("=", "!=");
      const wild = value.endsWith("*");
      const prefix = value.slice(0, -1);
      return (c) => (wild ? c.row.id.startsWith(prefix) : c.row.id === value) === (op === "=");
    }
    case "spec":
    case "spec_id": {
      only("=", "!=");
      const wild = value.endsWith("*");
      const prefix = value.slice(0, -1);
      const spec = (c: Candidate) => String(c.extra.spec_id ?? "");
      return (c) => (wild ? spec(c).startsWith(prefix) : spec(c) === value) === (op === "=");
    }
    case "parent": {
      only("=", "!=");
      return (c) => c.parents.has(value) === (op === "=");
    }
    case "mol_type": {
      only("=", "!=");
      return (c) => (String(c.extra.mol_type ?? "") === value.toLowerCase()) === (op === "=");
    }
    case "pinned":
    case "ephemeral":
    case "template": {
      only("=", "!=");
      const want = boolValue(value, field);
      const get = (c: Candidate) => (field === "pinned" ? c.row.pinned === 1 : field === "ephemeral" ? c.row.ephemeral === 1 : c.extra.is_template === true);
      return (c) => (get(c) === want) === (op === "=");
    }
    case "has_metadata_key": {
      only("=");
      if (!METADATA_KEY.test(value)) throw new Error(`invalid metadata key "${value}"`);
      return (c) => Object.prototype.hasOwnProperty.call(c.metadata, value);
    }
    default: {
      if (!field.startsWith("metadata.")) throw new Error(`unknown field: ${field}`);
      only("=");
      const key = field.slice("metadata.".length);
      if (!METADATA_KEY.test(key)) throw new Error(`invalid metadata key "${key}"`);
      return (c) => {
        if (!Object.prototype.hasOwnProperty.call(c.metadata, key)) return false;
        const v = c.metadata[key];
        return typeof v === "string" ? v === value : JSON.stringify(v).replace(/^"|"$/g, "") === value;
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the operation

export const QUERY_SORTS = ["priority", "created", "updated", "closed", "status", "id", "title", "type", "assignee"] as const;
export const DEFAULT_QUERY_LIMIT = 50;

export interface QueryParams {
  q: string;
  all: boolean;
  sort?: (typeof QUERY_SORTS)[number];
  reverse: boolean;
  limit?: number;
}

const cmp = <T>(a: T, b: T) => (a < b ? -1 : a > b ? 1 : 0);

/** sort.go CompareIssuesBy: the display orders (created, updated and closed are newest first). */
function compareBy(a: IssueRow, b: IssueRow, sort: string): number {
  switch (sort) {
    case "priority": return cmp(a.priority, b.priority);
    case "created": return cmp(b.created_at, a.created_at);
    case "updated": return cmp(b.updated_at, a.updated_at);
    case "closed":
      if (a.closed_at === null && b.closed_at === null) return 0;
      if (a.closed_at === null) return 1;
      if (b.closed_at === null) return -1;
      return cmp(b.closed_at, a.closed_at);
    case "status": return cmp(a.status, b.status);
    case "id": return a.id.localeCompare(b.id, "en", { numeric: true });
    case "title": return cmp(a.title.toLowerCase(), b.title.toLowerCase());
    case "type": return cmp(a.issue_type, b.issue_type);
    case "assignee": return cmp(a.assignee, b.assignee);
    default: return 0;
  }
}

// ---------------------------------------------------------------------------------------------
// planning: what can be decided in SQL, and which heavy columns the rest needs

/** The columns every candidate carries: small, so a whole tracker of them fits in memory. */
const LIGHT_COLUMNS =
  "tracker, id, title, status, priority, issue_type, assignee, owner, created_at, created_by, updated_at, started_at, closed_at, pinned, ephemeral, no_history, version";

interface Needs {
  description: boolean;
  notes: boolean;
  metadata: boolean;
  extra: boolean;
  labels: boolean;
  parents: boolean;
}

function needsOf(node: Node, needs: Needs = { description: false, notes: false, metadata: false, extra: false, labels: false, parents: false }): Needs {
  if (node.kind === "not") return needsOf(node.operand, needs);
  if (node.kind === "and" || node.kind === "or") {
    needsOf(node.left, needs);
    return needsOf(node.right, needs);
  }
  const f = node.field;
  if (f === "description" || f === "desc") needs.description = true;
  else if (f === "notes") needs.notes = true;
  else if (f === "has_metadata_key" || f.startsWith("metadata.")) needs.metadata = true;
  else if (f === "spec" || f === "spec_id" || f === "mol_type" || f === "template") needs.extra = true;
  else if (f === "label" || f === "labels") needs.labels = true;
  else if (f === "parent") needs.parents = true;
  return needs;
}

const ASCII = /^[\x20-\x7e]*$/;
// SQLite refuses LIKE and GLOB patterns over 50 characters, so the canonical spelling
// (YYYY-MM-DDTHH:MM:SS.mmmZ, 24 characters) is told by its length and its first and last characters.
const CANONICAL = "[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T*Z";
const NON_ASCII = "*[^ -~]*";

const conjuncts = (node: Node): Node[] => (node.kind === "and" ? [...conjuncts(node.left), ...conjuncts(node.right)] : [node]);

/**
 * The SQL implied by one top-level conjunct, or undefined. Each condition admits AT LEAST every row the
 * predicate accepts (it only narrows the candidates; the predicate still decides): case-insensitive
 * matches are ASCII-folded in SQL, so rows holding non-ASCII text are always passed through, and time
 * bounds are inclusive and pass rows whose stored time is not in the canonical spelling.
 */
function pushdown(node: Node, p: Params, now: Date): string | undefined {
  if (node.kind !== "cmp") return undefined;
  const { field, op, value, valueType } = node;
  const fold = (column: string) => (ASCII.test(value) ? `(${column} = ${p.add(value)} COLLATE NOCASE OR ${column} GLOB '${NON_ASCII}')` : undefined);
  switch (field) {
    case "id":
      if (op !== "=") return undefined;
      return value.endsWith("*") ? `substr(i.id, 1, ${[...value].length - 1}) = ${p.add(value.slice(0, -1))}` : `i.id = ${p.add(value)}`;
    case "status":
      return op === "=" ? `i.status = ${p.add(value.toLowerCase())}` : op === "!=" ? `i.status != ${p.add(value.toLowerCase())}` : undefined;
    case "type":
      return op === "=" ? `i.issue_type = ${p.add(value.toLowerCase())}` : op === "!=" ? `i.issue_type != ${p.add(value.toLowerCase())}` : undefined;
    case "priority":
      return /^[+-]?\d+$/.test(value) ? `i.priority ${op} ${p.add(Number(value))}` : undefined;
    case "assignee":
    case "owner": {
      const column = `i.${field}`;
      if (NONE(value)) return op === "=" ? `${column} = ''` : op === "!=" ? `${column} != ''` : undefined;
      return op === "=" ? fold(column) : undefined;
    }
    case "label":
    case "labels": {
      if (op !== "=") return undefined;
      const any = "SELECT 1 FROM labels l WHERE l.tracker = ?1 AND l.issue_id = i.id";
      if (NONE(value)) return `NOT EXISTS (${any})`;
      const match = fold("l.label");
      return match ? `EXISTS (${any} AND ${match})` : undefined;
    }
    case "parent": {
      if (op !== "=") return undefined;
      const edge = "SELECT 1 FROM dependencies d WHERE d.tracker = ?1 AND d.issue_id = i.id AND d.type = 'parent-child'";
      return `(EXISTS (${edge} AND d.depends_on_id = ${p.add(value)}) OR (NOT EXISTS (${edge}) AND substr(i.id, 1, ${[...value].length + 1}) = ${p.add(`${value}.`)}))`;
    }
    case "created":
    case "created_at":
    case "updated":
    case "updated_at":
    case "closed":
    case "closed_at":
    case "started":
    case "started_at": {
      if (op === "!=") return undefined;
      const column = `i.${field.replace(/^(created|updated|closed|started)$/, "$1_at")}`;
      const t = parseTime(value, valueType, now);
      if (Number.isNaN(t.getTime())) return undefined;
      const odd = `(length(${column}) != 24 OR ${column} NOT GLOB '${CANONICAL}')`;
      if (op === "=") {
        const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
        const end = new Date(day.getTime() + 24 * 3600_000);
        return `((${column} >= ${p.add(day.toISOString())} AND ${column} <= ${p.add(end.toISOString())}) OR ${odd})`;
      }
      return `(${column} ${op === ">" || op === ">=" ? ">=" : "<="} ${p.add(t.toISOString())} OR ${odd})`;
    }
    default:
      return undefined;
  }
}

const CHUNK = 50;
const placeholders = (n: number, from: number) => Array.from({ length: n }, (_, i) => `?${from + i}`).join(",");

export function queryIssues(sql: SqlStorage, tracker: string, q: QueryParams, now: Date): Out {
  const expression = q.q.trim();
  const refuse = (detail: string) => invalid("q", `invalid query expression: ${detail}`);
  if (expression === "") throw refuse("an expression is required");
  const limit = q.limit ?? DEFAULT_QUERY_LIMIT;

  let node: Node;
  let predicate: Predicate;
  const vocab = loadVocab(sql, tracker);
  try {
    node = parse(expression);
    predicate = compile(node, now, (s) => isStatus(vocab, s));
  } catch (e) {
    const detail = (e as Error).message;
    throw refuse(detail.startsWith("invalid status") ? `${detail} (valid: ${statusNames(vocab).join(", ")})` : detail);
  }

  // Candidates: light columns only, narrowed in SQL by whatever the top-level conjuncts allow.
  const p = new Params(sql, tracker);
  const where = ["i.tracker = ?1"];
  if (!q.all && !mentionsStatus(node)) where.push("i.status != 'closed'");
  for (const c of conjuncts(node)) {
    const condition = pushdown(c, p, now);
    if (condition) where.push(condition);
  }
  const candidates = all<IssueRow>(
    sql,
    `SELECT ${LIGHT_COLUMNS} FROM issues i WHERE ${where.join(" AND ")} ORDER BY i.priority ASC, i.created_at DESC, i.id ASC`,
    ...p.values,
  );

  // Evaluate in bounded chunks, fetching the heavy columns (and labels, parents) of one chunk at a time.
  // Without a display order the first limit+1 matches end the scan; with one, every match is needed.
  const needs = needsOf(node);
  const heavy = [needs.description && "description", needs.notes && "notes", needs.metadata && "metadata", needs.extra && "extra"].filter(Boolean) as string[];
  const stopAt = !q.sort && limit > 0 ? limit + 1 : Infinity;
  const matched: IssueRow[] = [];
  for (let at = 0; at < candidates.length && matched.length < stopAt; at += CHUNK) {
    const chunk = candidates.slice(at, at + CHUNK);
    const ids = chunk.map((r) => r.id);
    const marks = placeholders(ids.length, 2);
    const columns = new Map<string, Record<string, string>>();
    if (heavy.length > 0) {
      for (const r of all<Record<string, SqlStorageValue>>(sql, `SELECT id, ${heavy.join(", ")} FROM issues WHERE tracker = ?1 AND id IN (${marks})`, tracker, ...ids)) {
        columns.set(r.id as string, r as Record<string, string>);
      }
    }
    const labels = new Map<string, string[]>();
    if (needs.labels) {
      for (const l of all<{ issue_id: string; label: string }>(sql, `SELECT issue_id, label FROM labels WHERE tracker = ?1 AND issue_id IN (${marks})`, tracker, ...ids)) {
        (labels.get(l.issue_id) ?? labels.set(l.issue_id, []).get(l.issue_id)!).push(l.label);
      }
    }
    // A `parent` comparison names direct children (edge or dotted id), like the `parent` filter of listIssues.
    const parentsOf = new Map<string, Set<string>>();
    if (needs.parents) {
      for (const d of all<{ issue_id: string; depends_on_id: string }>(
        sql, `SELECT issue_id, depends_on_id FROM dependencies WHERE tracker = ?1 AND type = 'parent-child' AND issue_id IN (${marks})`, tracker, ...ids)) {
        (parentsOf.get(d.issue_id) ?? parentsOf.set(d.issue_id, new Set()).get(d.issue_id)!).add(d.depends_on_id);
      }
    }
    for (const light of chunk) {
      const extra = columns.get(light.id);
      const row = {
        ...light,
        description: extra?.description ?? "",
        notes: extra?.notes ?? "",
        design: "",
        acceptance_criteria: "",
        metadata: extra?.metadata ?? "{}",
        extra: extra?.extra ?? "{}",
      } as IssueRow;
      const hit = predicate({
        row,
        labels: labels.get(row.id) ?? [],
        metadata: safeObject(row.metadata),
        extra: safeObject(row.extra),
        parents: parentsOf.get(row.id) ?? new Set(row.id.includes(".") ? [row.id.slice(0, row.id.lastIndexOf("."))] : []),
      });
      if (hit) matched.push(light);
      if (matched.length >= stopAt) break;
    }
  }

  let ordered = matched;
  if (q.sort) {
    const sign = q.reverse ? -1 : 1;
    ordered = matched
      .map((row, index) => ({ row, index }))
      .sort((a, b) => sign * compareBy(a.row, b.row, q.sort!) || a.index - b.index)
      .map((x) => x.row);
  }
  const hasMore = limit > 0 && ordered.length > limit;
  const page = hasMore ? ordered.slice(0, limit) : ordered;

  // Only the rows of the answer are read in full.
  const full = new Map<string, IssueRow>();
  const pageIds = page.map((r) => r.id);
  for (let at = 0; at < pageIds.length; at += 90) {
    const part = pageIds.slice(at, at + 90);
    for (const r of all<IssueRow>(sql, `SELECT * FROM issues WHERE tracker = ?1 AND id IN (${placeholders(part.length, 2)})`, tracker, ...part)) full.set(r.id, r);
  }
  const rows = pageIds.map((id) => full.get(id)!);
  return { status: 200, body: { items: issuesWithCounts(sql, tracker, rows, { blocked: blockedAmong(sql, tracker, rows.map((r) => r.id)) }), has_more: hasMore } };
}
