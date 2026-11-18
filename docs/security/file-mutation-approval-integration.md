# File mutation approval boundary

`FileExecutionAdapter` now treats every non-`READ` operation as approval-required independently of the caller-controlled `requiresApproval` flag.

## Default behavior

- `CREATE`, `MODIFY`, `COPY`, `MOVE`, `RENAME`, and `DELETE` return `WAITING_APPROVAL` unless a server-owned `FileMutationAuthorizer` is injected.
- `approved: true` and `requiresApproval: false` are not authorization evidence.
- Authorizer exceptions fail closed.
- `READ` remains available without a mutation grant.

## Required production integration

The injected authorizer must independently load and validate a persisted approval using trusted server-side identity and tenant membership. It must bind the grant to the exact request, operation, source path, destination path, content/input digest, and target; reject expired, consumed, mismatched, or replayed grants; and enforce atomic one-time consumption where applicable.

Do not implement the authorizer by checking `ExecutionRequest.approved` or by accepting actor, role, tenant, or approval claims from request input. The current repository has no production file-mutation authorizer wired into `FileExecutionAdapter`. Therefore mutations intentionally remain blocked until that integration exists. The injected test authorizer is only a contract test double, not a production implementation.

This change is defense-in-depth for the direct-adapter bypass. It does not claim that all other execution adapters or every possible direct use of the low-level workspace executor are secured.
