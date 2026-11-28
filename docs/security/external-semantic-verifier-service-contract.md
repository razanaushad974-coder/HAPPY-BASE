# External semantic verifier service contract

Status: implementation contract only. This document does not mean an external verifier has been provisioned, deployed, or independently assessed.

## 1. Trust boundary

HAPPY is the caller and final attestation verifier. The external verifier is a separate server-side service operated by an explicitly trusted party.

The service MUST:
- Authenticate HAPPY using the operator-provisioned bearer credential; reject missing, expired, revoked, or wrong-audience credentials.
- Authorize the caller for this verifier endpoint and enforce request-size/rate limits.
- Evaluate only the supplied registered verification request and its exact evidence snapshot. It MUST NOT choose a different tenant, request, mission, task, execution request, or evidence set.
- Sign the response with an RSA private key of at least 2048 bits held in a KMS/HSM or equivalent protected signing service. The private key MUST NOT be returned to HAPPY or stored in the HAPPY repository.
- Use a configured `verifierId` and `keyId` that correspond to the public-key allowlist configured in HAPPY's trusted server composition.
- Return a signed decision only after the evaluation has actually completed. It MUST NOT infer success from evidence presence, HTTP success, task state, or caller-provided outcome fields.
- Keep an auditable record of the evaluation identity, request ID, evidence IDs/checksums, criterion-level decisions, signing key ID, and timestamp. Logs MUST NOT contain bearer credentials or unnecessary raw evidence content.

HAPPY verifies the signature and all tenant/request/evidence/criteria bindings. A valid signature proves that the configured key signed the payload; it does not independently prove that the verifier's reasoning was correct. The verifier's implementation, data access, operator, and KMS/HSM controls require separate security review.

## 2. Request

HAPPY sends one HTTPS `POST` to the operator-configured fixed endpoint with:
- `Authorization: Bearer <server-side token>`
- `Content-Type: application/json`
- `Accept: application/json`
- `Idempotency-Key: <verification request ID>`

Redirects are rejected. The client does not forward browser credentials or cookies, and does not cache the response.

The JSON body has this shape:

```json
{
  "schemaVersion": 1,
  "scope": {
    "organizationId": "tenant-organization-id",
    "workspaceId": "tenant-workspace-id",
    "userId": "authenticated-user-id"
  },
  "request": {
    "id": "verification-request-id",
    "missionId": "mission-id",
    "taskId": "task-id",
    "executionRequestId": "execution-request-id-or-null",
    "description": "What must be verified",
    "criteria": [
      {
        "id": "criterion-id",
        "description": "Criterion to evaluate",
        "expected": "Expected observable result",
        "required": true
      }
    ],
    "preferredMethods": ["method identifiers"],
    "requiresEvidence": true
  },
  "evidence": [
    {
      "id": "evidence-id",
      "type": "evidence type",
      "source": "capture source",
      "title": "evidence title",
      "content": "bounded evidence content",
      "checksum": "checksum-or-null",
      "capturedAt": "timestamp"
    }
  ]
}
```

The example values are illustrative, not valid production identifiers. The client sends only the fields shown for evidence. Evidence URIs and arbitrary metadata are deliberately excluded because they may contain credentials or unrelated sensitive data.

The verifier MUST treat all request content as untrusted input. It MUST bind its decision to the exact scope, request, mission, task, execution request, and evidence IDs received. If it needs additional data, it must use an independently authorized tenant-scoped retrieval path; it must not ask the caller to widen scope or accept a client-supplied replacement evidence set.

The current client defaults to at most 50 evidence items, 16,384 characters per evidence content field, a 512 KiB serialized request, a 256 KiB streamed response, and a 10-second request timeout. Configurable limits are bounded in code. Oversized requests are rejected before network I/O; oversized response streams are cancelled before buffering.

## 3. Response envelope

Return HTTP 200 with `Content-Type: application/json` and exactly this envelope shape (no additional top-level fields):

```json
{
  "payload": {
    "schemaVersion": 1,
    "verifierId": "configured-verifier-id",
    "keyId": "active-public-key-id",
    "organizationId": "tenant-organization-id",
    "workspaceId": "tenant-workspace-id",
    "userId": "authenticated-user-id",
    "requestId": "verification-request-id",
    "missionId": "mission-id",
    "taskId": "task-id",
    "executionRequestId": "execution-request-id-or-null",
    "evidenceIds": ["evidence-id"],
    "passedCriteria": ["criterion-id"],
    "failedCriteria": [],
    "partialCriteria": [],
    "outcome": "PASSED",
    "confidence": "HIGH",
    "summary": "Concise explanation of the decision",
    "verifiedAt": "2026-11-27T10:00:00.000Z"
  },
  "signature": "base64-encoded-RSA-signature"
}
```

All payload keys are required and no additional keys are permitted. Use exact string identifiers from the request. Each reported criterion ID must occur exactly once across the three criterion arrays and must exist in the registered request. Every required criterion must be reported.

The outcome is derived from required criteria:
- `FAILED` if any required criterion is failed.
- `PASSED` only if every required criterion is passed.
- `PARTIAL` otherwise, including any required criterion reported partial.

The verifier MUST NOT return `PASSED` if a required criterion is failed or partial. Optional criteria may be reported, but do not override the required-criterion outcome.

## 4. Signature construction

HAPPY verifies RSA-SHA256 signatures using the configured trusted public key. The signature is standard Base64 of the raw RSA signature bytes (not Base64URL).

The signed message is UTF-8 JSON produced with the following exact property order:
1. `schemaVersion`
2. `verifierId`
3. `keyId`
4. `organizationId`
5. `workspaceId`
6. `userId`
7. `requestId`
8. `missionId`
9. `taskId`
10. `executionRequestId`
11. `evidenceIds` (sorted lexicographically)
12. `passedCriteria` (sorted lexicographically)
13. `failedCriteria` (sorted lexicographically)
14. `partialCriteria` (sorted lexicographically)
15. `outcome`
16. `confidence`
17. `summary`
18. `verifiedAt`

Serialize this ordered object using compact JSON (equivalent to JavaScript `JSON.stringify` with no added whitespace), encode as UTF-8, then sign with RSA-SHA256 using the RSA PKCS#1 v1.5 signature scheme. The signature covers the payload only, not the envelope.

HAPPY rejects unknown/missing payload or envelope fields, non-canonical Base64, a signature whose byte length does not match the trusted RSA modulus, malformed or oversized payloads, unknown keys, invalid signatures, scope/request/evidence/criteria mismatches, future timestamps, and attestations older than five minutes. The service should therefore emit a UTC ISO-8601 timestamp and keep its clock synchronized.

## 5. Idempotency, retries, and errors

The request ID is the idempotency key. For repeated delivery of the same request ID and same immutable input snapshot, the verifier SHOULD return the same signed decision or a deterministic terminal result. It MUST NOT silently evaluate a different evidence snapshot under the same idempotency key.

The HAPPY client currently performs no automatic retries. The verifier should return bounded JSON error responses for authentication, authorization, validation, rate-limit, and internal failures. Non-2xx responses are treated as errors; HAPPY does not accept unsigned error bodies as verification results. A timeout or lost response is an ambiguous transport result, not evidence of success.

## 6. Deployment and operational controls

Before enabling this integration:
1. Provision and independently review the verifier service and its tenant-scoped data access.
2. Provision the RSA signing key in KMS/HSM; export only its public key.
3. Configure the verifier identity/key ID and public key in HAPPY's server-side `HAPPY_SEMANTIC_VERIFIER_KEYS` allowlist.
4. Configure the HTTPS endpoint and bearer-token supplier in server-only runtime composition. Never put credentials in browser code, user input, task records, or repository files.
5. Enforce outbound network egress allowlisting at the worker/network layer. A fixed HTTPS URL in application code is not an SSRF or network-egress boundary by itself. Block loopback, link-local, cloud metadata, private/internal destinations, and unapproved hosts.
6. Define data minimization, retention, deletion, incident response, key rotation, token rotation, audit access, and verifier availability objectives.
7. Run positive and negative integration tests against the actual service and KMS/HSM-backed signing path in an isolated staging environment.
8. Keep verification-required tasks fail-closed until all of the above are independently validated.

Public-key configuration alone does not create or deploy the verifier. No verifier endpoint, bearer token, KMS/HSM signer, hosted staging connection, database grant, or production deployment is provisioned by this contract document.
