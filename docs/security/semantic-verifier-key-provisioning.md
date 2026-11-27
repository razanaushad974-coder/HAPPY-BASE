# HAPPY trusted semantic verifier key provisioning

## Purpose

The worker composition accepts an operator-provisioned public-key allowlist and uses it to independently verify semantic-verifier attestations. HAPPY does not generate semantic decisions or signatures in this module. The external verifier must evaluate the requested criteria and sign the exact attestation payload with its private key.

## Deployment configuration

Set `HAPPY_SEMANTIC_VERIFIER_KEYS` in the dedicated server/worker deployment environment. The host passes its value to `createVercelPostgresHappyWorker({ semanticVerifierKeysJson })`. Do not pass request-body, tenant-editable, browser, or user-supplied configuration to this parameter.

The value is a JSON array. Each entry must contain exactly these string fields:

```json
[
  {
    "verifierId": "happy-semantic-verifier",
    "keyId": "key-2026-01",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\\n...\\n-----END PUBLIC KEY-----"
  }
]
```

- Keys must be RSA SubjectPublicKeyInfo public keys with at least 2048-bit modulus.
- Key IDs must be unique within the configured verifier identity.
- Keep private signing keys exclusively in the external verifier's KMS/HSM or secret manager. Never put a private key in this variable, the HAPPY repository, browser bundles, logs, or task/evidence records.
- Multiple public keys may be configured during rotation. Add the new public key before the verifier starts signing with it. Retain the old public key for at least the maximum attestation age (five minutes) plus deployment/clock-skew allowance, then remove it.
- Attestations older than five minutes or with future timestamps are rejected.
- The HTTPS client caps the serialized request at 512 KiB by default (operator-adjustable up to 2 MiB) and the streamed response at 256 KiB by default (up to 1 MiB). Oversized requests are rejected before network I/O; oversized response streams are cancelled before buffering.
- Requests use `credentials: omit`, `cache: no-store`, and `redirect: error`; bearer tokens are read server-side and are never forwarded across redirects.
- An absent/empty value intentionally leaves semantic verification disconnected. Verification-required tasks remain unable to transition to COMPLETED.
- Malformed JSON, unknown fields, duplicate IDs, invalid PEM, non-RSA keys, and keys below 2048 bits fail worker composition.

## Operational boundary

This configuration only establishes which public keys HAPPY trusts. It does not authenticate the external verifier's runtime, prove how it evaluated criteria, provision signing keys, rotate keys automatically, or deploy the worker. The verifier service must authenticate its caller, fetch the registered request and exact evidence through authorized tenant-scoped interfaces, evaluate every required criterion, and sign the canonical payload. Its endpoint, identity, authorization, audit trail, and KMS/HSM-backed signing integration remain separate deployment work. The worker host must also enforce outbound network egress restrictions to the operator-approved verifier service and block cloud metadata, loopback, link-local, and other unintended internal destinations; a fixed HTTPS URL alone is not a network egress policy.

No staging/production database change or production deployment is performed by this configuration change.
