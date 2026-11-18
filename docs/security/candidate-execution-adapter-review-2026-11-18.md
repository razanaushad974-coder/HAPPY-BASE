# Candidate execution-adapter security review — 2026-11-18

## Scope and method

Static review of execution adapters and the orchestration/execution contracts in the uploaded candidate archive `HAPPY-AI-WORKING-UPDATED-security-reviewed-candidate.zip` (SHA-256 `ab39f72492295b34a6ab663d540d9d48ae9233269000bdac2a96fc45618ef00d`). Reviewed source includes the API, browser, file and database adapters, the generic execution engine, orchestration request types, and workspace file executor.

No live HTTP requests, internal-network probes, database writes, file mutations, or production tests were performed. Findings below are static-source conclusions, not demonstrated deployed exploits.

## HIGH — API host allowlist is caller-controlled, so it is not a security boundary

Evidence:
- `src/core/execution/api-execution-adapter.ts` parses `allowedHosts` directly from `request.input` (lines 103–110).
- The adapter then checks the destination hostname against that same input-supplied list (lines 227–255).
- It permits both HTTP and HTTPS URLs (lines 212–225) and calls `fetch()` without setting `redirect: "manual"` or revalidating redirect destinations (lines 266–283). The default fetch redirect behaviour therefore follows redirects after validating only the initial hostname.
- No fixed server-owned host policy or private-address/DNS resolution check is present in this adapter.

Impact:
A caller who can cause an API execution request can nominate the destination host in the same input that is treated as the allowlist. This makes the allowlist self-asserted rather than trusted. Requests can target arbitrary hosts, including internal/private network destinations if reachable from the server. A permitted public host can also redirect the request to a different destination because redirects are not revalidated. This is an SSRF risk; no internal service was contacted during this review.

Required remediation:
1. Remove `allowedHosts` from untrusted execution input. Resolve an allowlist from server-owned capability/tenant policy.
2. Reject loopback, link-local, private, multicast, unspecified and other non-public IP ranges after DNS resolution; defend against DNS rebinding by validating the address actually connected to.
3. Disable automatic redirects or validate every redirect hop, including scheme, hostname, resolved IP and redirect count.
4. Add tests for caller-supplied arbitrary hosts, IPv4/IPv6 private ranges, DNS rebinding, redirects to localhost/private IP, redirect loops and timeout handling.

## HIGH — Browser host allowlist is caller-controlled and navigation is not revalidated

Evidence:
- `src/core/execution/browser-execution-adapter.ts` parses `allowedHosts` from `request.input` (lines 109–116).
- `validateUrl()` compares the initial URL hostname only against that same input-supplied list (lines 137–193).
- `page.goto()` follows browser navigation/redirects from the initial URL (lines 315–323). The adapter does not inspect and reject a redirected final URL or enforce an outbound request policy for subresources.
- `CLICK` is executed against the loaded page (lines 344–373); a click may trigger a new navigation, but the resulting URL is not checked against a trusted host policy.

Impact:
The host list is not an effective security boundary when the request itself supplies it. Browser navigation and page actions can also initiate additional network requests beyond the initial validated URL. This creates an SSRF / unintended network-access risk from the server-side browser context. No internal network was probed.

Required remediation:
1. Use server-owned host policy; never accept the security allowlist from task/user input.
2. Enforce outbound request interception for every top-level navigation, redirect and subresource request, with DNS/IP range checks.
3. Revalidate after every navigation and click-triggered navigation; block non-approved destinations before the request is sent.
4. Add tests for redirect chains, JavaScript/meta refresh, click navigation, subresources, private IPv4/IPv6, localhost aliases and DNS rebinding.

## HIGH — approval booleans remain trusted by generic and adapter-level execution gates

Evidence:
- `src/core/execution/types.ts` exposes `requiresApproval: boolean` and `approved: boolean` directly on `ExecutionRequest` (lines 38–50).
- `src/core/execution/engine.ts` and the file, API and browser adapters gate execution using caller-provided `requiresApproval` and `approved` booleans. In the file adapter, the guard is conditional on `request.requiresApproval` (lines 161–180), so `requiresApproval: false` bypasses the adapter's approval check. Database writes use the same conditional pattern (database adapter lines 208–220).
- `src/core/orchestration/types.ts` retains optional `approved?: boolean` on `HappyPipelineRequest` (lines 54–77). The normal execute route currently initializes it to false, but the core contract itself does not make the value server-verifiable.
- The approval-resume path does validate that a persisted approval record exists, matches request/plan linkage, and has status APPROVED. However, the resumed execution request is constructed with `approved: true` after that check (orchestration engine lines 187–226 and 599–659). The execution adapters still receive only the boolean, not a validated one-time grant bound to the exact action and target.

Impact:
A direct or future caller that can construct an `ExecutionRequest` can set `approved: true`, or set `requiresApproval: false`, without presenting a server-verified approval grant. This is a core-contract bypass risk. The current route-level caller setting `approved: false` is a useful control but does not secure direct adapter/engine callers or future routes.

Required remediation:
1. Remove caller-controlled approval booleans from the public execution contract.
2. Inject a server-only approval authorizer into every side-effecting adapter and generic execution engine.
3. Bind approval to authenticated actor, tenant, request/plan, exact action, normalized target/path, input/content digest, expiry and one-time consumption.
4. Compute approval requirements server-side; callers must not be able to set `requiresApproval: false`.
5. Add direct-adapter tests for false/false, false/true, true/true, expired/replayed grants, tenant mismatch, target mismatch, changed input and concurrent consumption.

## MEDIUM — workspace path validation retains a time-of-check/time-of-use window

Evidence:
- `src/core/execution/workspace-code-executor.ts` performs lexical containment, realpath/symlink and hard-link checks before returning a path (lines 78–167).
- File operations occur later using ordinary path-based `mkdirSync`, `writeFileSync`, `copyFileSync`, `renameSync` and `rmSync` calls (for example lines 268–278, 320–324, 361–366, 416–419 and 444–446).
- The checks and mutations are not performed through directory file descriptors/openat-style operations with no-follow semantics, so a concurrent filesystem change may replace a checked path component between validation and use.

Impact:
The realpath and hard-link checks materially improve path safety, but they do not eliminate a race in a workspace writable by another concurrent process/user. Exploitability depends on workspace permissions and concurrent write access; no race was attempted.

Required remediation:
1. Use descriptor-relative filesystem operations and no-follow flags where supported.
2. Keep the workspace root and its parent directories non-writable by untrusted principals.
3. Recheck file identity immediately before mutation and avoid following symlinks at mutation time.
4. Add adversarial concurrent symlink-swap tests on supported operating systems.

## Positive controls observed

- API and browser adapters reject non-HTTP(S) schemes and require a non-empty host list; however, because that list is request-controlled, this is not sufficient protection.
- API and browser operations have bounded timeout values (up to 30 seconds).
- Workspace file executor performs lexical path containment, realpath-based symlink/junction containment and hard-link checks.
- The database adapter validates basic input shape and requires tenant scope fields. This does not replace tenant authorization or server-owned approval verification.

## Required order of work

1. Make API and browser outbound network policy server-owned and enforce it across redirects and all browser requests.
2. Replace boolean approval checks with server-owned, exact-action, one-time approval authorization.
3. Add production-mode local-development authentication rejection (separate HIGH finding in `candidate-api-surface-review-2026-11-18.md`).
4. Close workspace filesystem TOCTOU exposure.
5. Only after source remediation, run focused tests, complete dependency installation, audit, typecheck, lint, full test suite and production build on the exact candidate commit.

## Verification status

- Static source review only.
- No candidate source files changed as part of this review.
- No tests, typecheck, lint, dependency audit or production build run in this pass.
- No Supabase migrations, database writes, merges or deployments performed.
