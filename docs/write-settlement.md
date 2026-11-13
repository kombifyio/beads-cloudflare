# Write settlement

`profile.write_settlement_v1` is additive to `/v0`. Existing clients keep their
current routes, scope checks, transactional writes and seven-day idempotency cache.

A client that wants a durable answer to "did this operation change anything?"
binds its writes to one operation: it supplies `X-Beads-Operation: <UUID>` and an
`Idempotency-Key` of the form `<label>-<UUID>-<request>` on every write of that
operation, for example `app-<UUID>-1`. The label is the client's choice: 1 to 16
lowercase letters and digits, starting with a letter, without a hyphen, so the UUID
always sits right after the first hyphen and a key names exactly one operation. The
store refuses a bound write whose key does not name the header's UUID in that place
before it changes anything. Give each logical request of the operation a stable ordinal in its key
and keep that key across transport retries. The durable operation ledger binds
receipts to verified principal, tracker, UUID, request key and canonical request
hash. Business effect and receipt commit in the same synchronous transaction.
Changed payloads under the same key are refused. Permanent receipts and settlement
fences outlive the ordinary expiring request cache.

- GET `/t/<tracker>/v0/beads/write-operations/<UUID>` reads whether the operation
  is tracked/settled and its receipt summaries (key, hash, HTTP status, returned ID).
- POST `/t/<tracker>/v0/beads/write-operations/<UUID>:settle` permanently seals it
  in the same transactional order as writes. The result is `applied` when at least
  one request committed successfully, otherwise `not_applied`. Receipt summaries
  identify partial batches. A request arriving after the seal cannot apply; an
  identical already recorded request returns its stored receipt without applying.

Both routes require the existing read/write scopes and tracker authorization.
A dedicated merge-close credential may inspect/seal only receipts belonging to its
own verified principal and authorized tracker; ordinary close proof checks remain.
No other principal or tracker can inspect or seal this operation. Sealing only
records the receipts as final and never resends the business mutation. A network
partition that prevents reading the fence leaves the operation explicitly
unsettled until the client can read it again.

## Using it from a client

Seal the operation when the client finishes with it, including after a transport
failure, and read the result back: after the seal no late request of that
operation can still apply, so `not_applied` is a proof that nothing changed. An
inspection alone (GET) never changes the operation. Requests sent without the
header cannot be proven absent by an empty ledger, so an operation is only
settled reliably when every one of its writes carried the header.

A client can wrap the unchanged native `bd` this way: a process-scoped loopback
proxy forwards `bd`'s exact requests to the store and rewrites each write's
`Idempotency-Key` to the operation's key, keeping one key per native request
across `bd`'s own retries. Bind such a proxy to `127.0.0.1` only, give the child
process a fresh bearer of its own and require it on every loopback request, permit
only the tracker path of the operation, forward no redirects and stop the proxy
with its child. The Worker transaction serializes writes; the existing claim and
revision rules apply to bound and unbound writes alike.

## Mixed versions

A client should check the store's context for `profile.write_settlement_v1`
before it sends the header; against a store without it, it keeps its previous
write path and can only inspect, not settle. A store with the capability serves
every existing route and the key-only idempotency cache unchanged, so a client
that never sends the header needs no change. `TeamStore`, its binding and
migration `v1` do not change; the receipt tables are created additively on
activation.
