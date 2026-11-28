# API and Browser outbound host policy boundary

Date: 2026-11-21

## Implemented boundary

- API and Browser adapters no longer read `allowedHosts` from execution request input.
- The allowlist is injected through the adapter constructor by trusted server-side composition.
- An adapter constructed without a non-empty server-owned allowlist reports `NOT_YET_CONNECTED`.
- Existing request-level `allowedHosts` values are ignored; regression tests attempt to widen the allowlist to `localhost` and expect the request to be blocked.
- HTTP redirects remain disabled/blocked by the adapters, and Browser subresource requests are checked against the same server-owned allowlist.

## Explicit limitations

This change closes caller-controlled host-allowlist widening. It is not, by itself, a complete SSRF or network-isolation boundary.

Before production activation, the server-side composition must provide an egress-controlled transport/worker that:
- blocks loopback, link-local, private, multicast, reserved, and cloud-metadata destinations for both IPv4 and IPv6;
- resolves DNS under policy and pins the validated destination to the actual connection to prevent DNS rebinding/TOCTOU;
- enforces the same controls for redirects, browser subresources, WebSockets, downloads, and any alternate protocol;
- prevents access to internal service networks, host sockets, and deployment control planes;
- applies response-size, duration, concurrency, and audit limits.

The current adapters still use the platform `fetch` and Playwright transport directly. Therefore, do not treat a configured hostname allowlist alone as production-grade egress isolation. Keep these capabilities disconnected until the trusted network boundary is wired and verified.

## Verification

The API and Browser adapter tests cover:
- default adapter status is `NOT_YET_CONNECTED` without server-owned allowlist configuration;
- normal requests work against an explicitly injected test allowlist;
- request-supplied allowlists cannot widen the server-owned allowlist;
- mutating actions still require approval;
- redirects remain blocked.

CI is the validation path for this branch. No hosted network policy, production deployment, or live tenant data was changed.
