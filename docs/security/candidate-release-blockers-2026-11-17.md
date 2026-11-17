# Release blockers for HAPPY working-source candidate — 2026-11-17

## Dependency security blocker
The candidate's `package.json` and lockfile resolve Next.js and `eslint-config-next` to 16.3.5. This version is below the patched 16.x release line.

The Next.js 16.3.8 release notes (2026-09-30) document security fixes for SSRF in image optimization, cache poisoning, and information disclosure. The November 2026 security release fixed additional issues in 16.4.5; the 16.4.6 release is a later bug-fix release. References:
- https://nextjs-changelog.vercel.app/ (16.3.8, 16.4.5, 16.4.6 release notes)
- https://www.netlify.com/changelog/2026-11-03-nextjs-security-vulnerabilities/ (November 3 security fixes; 16.4.5 / 15.5.29)
- https://www.netlify.com/changelog/2026-09-30-nextjs-react-security-vulnerabilities/ (September 30 security fixes; 16.3.8)

Required before release:
1. Upgrade both `next` and matching `eslint-config-next` to a patched 16.x version (use 16.4.6 as the reviewed target for this candidate).
2. Regenerate `package-lock.json` with npm against the updated manifest.
3. Run `npm ci`, `npm audit`, lint, typecheck, tests, and production build on the exact resulting tree.
4. Review hosting adapter/deployment implications separately; no deployment is authorized by this note.

## Validation status
- Corrected source archive integrity: PASS.
- Targeted TypeScript transpile/syntax checks on the seven approval-related changed TS files: PASS.
- Full `npm ci`: timed out; dependencies did not install completely.
- Full TypeScript typecheck: BLOCKED because type packages are incomplete after the timed-out install.
- Full lint, Vitest suite, npm audit, and production build: NOT RUN.
- No source import to GitHub `main`, no database writes/migrations, and no production deployment.

## Approval and tenant remediation
The candidate source includes the approval-expiry and canonical-tenant changes described in `approval-expiry-tenant-remediation.md`. These code changes are not a substitute for dependency remediation or full integration testing.
