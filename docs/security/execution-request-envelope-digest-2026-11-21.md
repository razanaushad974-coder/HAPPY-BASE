# Immutable execution request envelope digest

Status: design and application-code contract only. The SQL candidate is not applied to any hosted Supabase project.

## Two distinct digests

- `input_digest` is SHA-256 over the canonical PostgreSQL JSONB representation of the request input. Existing FILE-mutation approval bindings continue to use this payload digest.
- `envelope_digest` is SHA-256 over a PostgreSQL `jsonb_build_object(...)` containing the proposed/persisted request ID, task and mission IDs, requester and executor IDs, organization and workspace IDs, capability, action, input, target reference, fixed HIGH risk, required founder approval, and idempotency key.

The database computes both digests. The API does not accept either digest from the caller. The durable request lookup requires both to be 64-character lowercase hexadecimal values.

## Idempotency

The unique key is scoped to requester + organization + workspace + idempotency key. On retry, the database recomputes the envelope digest using the original persisted request ID, not the newly proposed ID. It then compares every immutable field and both digests using null-safe comparisons. A key reused for a different envelope fails closed.

## Limits

A matching digest is an integrity check, not an authorization decision. Tenant membership, task/mission binding, founder approval, request lifecycle, and any future worker claim must still be independently checked. Do not treat the digest as a capability token.

## Migration gate

The SQL candidate adds a non-null requirement for complete envelopes through its table check constraint. Existing partially populated or previously created envelope rows need explicit inventory and a reviewed backfill plan before applying the candidate. Do not infer or fabricate historical digests. The candidate remains unapplied until explicit approval and a controlled migration review.

No worker claim, execution dispatch, adapter activation, or production deployment is enabled by this change.
