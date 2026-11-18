// Problem errors per the upstream `Problem` schema. A domain refusal is an `Out` with a 4xx status
// and a Problem body (without request_id, which the HTTP edge adds); it travels as a thrown
// `Refusal` inside the store so the surrounding transaction rolls back.
import type { components } from "../generated/openapi.v0";

export type Problem = components["schemas"]["Problem"];

/** The result of a domain operation: an HTTP status and JSON body, as the upstream server would answer. */
export interface Out {
  status: number;
  body: unknown;
  etag?: string;
  /** The response is a stored one, replayed for a repeated Idempotency-Key. */
  replayed?: boolean;
}

/** Only called after a refused write transaction rolled back, never for an uncertain transport error. */
export function rejectedWrite(out: Out): Out {
  if (out.status < 400 || out.status >= 500) return out;
  const body = out.body;
  if (body === null || typeof body !== "object" || Array.isArray(body)) return out;
  // The original request under this key committed; rollback of the conflicting
  // request says nothing about that operation's effects.
  if ("reason" in body && body.reason === "idempotency_key_reused") {
    return { ...out, body: { ...body, x_outcome: "unknown" } };
  }
  return { ...out, body: { ...body, x_outcome: "rejected", x_mutation_applied: false } };
}

const STATUS: Record<string, number> = {
  invalid_argument: 400,
  invalid_cursor: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  already_claimed: 409,
  not_claimable: 409,
  not_closable: 409,
  not_releasable: 409,
  dependency_cycle: 409,
  dependency_exists: 409,
  already_exists: 409,
  precondition_failed: 409,
  internal: 500,
};

const TITLE: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  500: "Internal Server Error",
};

export type ProblemExtras = Partial<Omit<Problem, "status" | "title" | "code" | "detail" | "request_id">> & {
  [extension: `x_${string}`]: unknown;
};

export function problemOut(code: string, detail: string, extras: ProblemExtras = {}): Out {
  const status = STATUS[code] ?? 500;
  return { status, body: { status, title: TITLE[status] ?? "Error", code, detail, ...extras } };
}

export class Refusal extends Error {
  constructor(readonly out: Out) {
    super(String((out.body as Problem).detail ?? "refused"));
  }

  /** Adds extension members to the Problem body. */
  withExtras(extras: ProblemExtras): this {
    Object.assign(this.out.body as object, extras);
    return this;
  }
}

export const refuse = (code: string, detail: string, extras: ProblemExtras = {}) =>
  new Refusal(problemOut(code, detail, extras));

export const invalid = (param: string | undefined, detail: string, reason = "invalid_value") =>
  refuse("invalid_argument", detail, param === undefined ? { reason } : { param, reason });

export const issueNotFound = () => refuse("not_found", "no issue or wisp with that id");

export const forbiddenTracker = (tracker: string) =>
  problemOut("forbidden", `this credential may not use tracker ${JSON.stringify(tracker)}`, { param: "tracker" });

export const NO_SUCH_ROUTE = problemOut("not_found", "no such route on this server");
