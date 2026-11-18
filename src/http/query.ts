// Query-string decoding with the refusals upstream produces: first refusal wins, unknown parameters last.
import { invalid } from "../tracker/problem";
import { setOwn } from "../tracker/util";

const RFC3339 = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;
const TRUE = new Set(["1", "t", "T", "TRUE", "true", "True"]);
const FALSE = new Set(["0", "f", "F", "FALSE", "false", "False"]);

export class Query {
  private readonly read = new Set<string>();

  constructor(private readonly params: URLSearchParams) {}

  private values(name: string): string[] {
    this.read.add(name);
    return this.params.getAll(name);
  }

  /** Whether the request names the parameter at all, empty or not. */
  has(name: string): boolean {
    this.read.add(name);
    return this.params.has(name);
  }

  /** Every value as sent, empty ones included: for parameters where an empty value is itself a refusal. */
  raw(name: string): string[] {
    return this.values(name);
  }

  /** A single-valued parameter; an empty value counts as absent. */
  str(name: string): string | undefined {
    const values = this.values(name);
    if (values.length > 1) throw invalid(name, "this parameter takes a single value");
    return values[0] === "" ? undefined : values[0];
  }

  bool(name: string): boolean {
    const raw = this.str(name);
    if (raw === undefined) return false;
    if (TRUE.has(raw)) return true;
    if (FALSE.has(raw)) return false;
    throw invalid(name, `${JSON.stringify(raw)} is not a boolean`);
  }

  int(name: string): number | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!/^[+-]?\d+$/.test(raw)) throw invalid(name, `${JSON.stringify(raw)} is not an integer`);
    return Number(raw);
  }

  oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(raw)) {
      throw invalid(name, `${JSON.stringify(raw)} is not one of ${[...allowed].sort().join(", ")}`);
    }
    return raw as T;
  }

  time(name: string): string | undefined {
    const raw = this.str(name);
    if (raw === undefined) return undefined;
    if (!RFC3339.test(raw) || Number.isNaN(Date.parse(raw))) throw invalid(name, `${JSON.stringify(raw)} is not an RFC 3339 timestamp`);
    return new Date(raw).toISOString();
  }

  /** A repeatable parameter: trimmed, empties dropped, deduplicated. */
  list(name: string): string[] {
    return [...new Set(this.values(name).map((v) => v.trim()).filter((v) => v !== ""))];
  }

  /** Repeatable and comma-separated. */
  commaList(name: string): string[] {
    return this.list(name).flatMap((v) => v.split(",").map((p) => p.trim()).filter((p) => p !== ""));
  }

  metadataFields(name = "metadata_field"): Record<string, string> {
    const out: Record<string, string> = {};
    for (const entry of this.values(name)) {
      const at = entry.indexOf("=");
      if (at <= 0) throw invalid(name, `${JSON.stringify(entry)} is not key=value`);
      setOwn(out, entry.slice(0, at), entry.slice(at + 1));
    }
    return out;
  }

  /** Refuses any parameter the operation did not read. */
  finish(): void {
    const unknown = [...new Set(this.params.keys())].filter((k) => !this.read.has(k)).sort();
    if (unknown.length > 0) {
      throw invalid(
        unknown[0],
        this.read.size === 0 ? "this operation takes no query parameters" : "this server does not know that parameter for this operation",
        "unknown_parameter",
      );
    }
  }
}
