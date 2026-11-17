# Release blockers for HAPPY working-source candidate — 2026-11-17

## Dependency security blocker
The candidate's `package.json` and lockfile resolve Next.js and `eslint-config-next` to 16.3.5. This version is below the patched 16.x release line.

A separate read-only check of GitHub `main` also found both `next` and `eslint-config-next` pinned to 16.3.5 (main `package.json` blob: `aa6ee60b3a2974a162f1587910e184d19095e27c`). Therefore this is not isolated to the candidate archive; the repository baseline has the same dependency remediation gap. This finding does not authorize a direct change to `main`.

The Next.js 16.3.8 release notes (2026-09-30) document security fixes for SSRF in image optimization, cache poisoning, and information disclosure. The November 2026 security release fixed additional issues in 16.4.5; 16.4.6 is a later bug-fix release. References:
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


## Uploaded security-reviewed candidate re-validation

- Archive SHA-256: `ab39f72492295b34a6ab663d540d9d48ae9233269000bdac2a96fc45618ef00d` (362 entries; ZIP integrity PASS).
- Candidate `package.json` and `package-lock.json` both resolve `next` and `eslint-config-next` to `16.3.5`; the lockfile root matches the manifest, but the versions remain below the patched line.
- Current public release evidence: Next.js 16.3.8 fixed the September 30 security advisories; the November 3 release fixed seven additional advisories in 16.4.5, and 16.4.6 is the later 16.x release. Next.js 16.3.5 is therefore behind the documented security fixes. See [Next.js release notes](https://nextjs-changelog.vercel.app/) and [Netlify's November 3 advisory summary](https://www.netlify.com/changelog/2026-11-03-nextjs-security-vulnerabilities/).
- TypeScript/TSX syntax transpilation: 329 files, zero syntax diagnostics.
- Focused approval policy/mutation harness: 8 assertions passed.
- High-confidence secret-pattern scan: zero matches; this does not guarantee absence of all secrets.
- `npm ci` timed out again. The local dependency tree is incomplete; `tsc --noEmit` reports missing type packages. No lockfile was manually edited because a correct lockfile regeneration requires a successful package-resolution/install step.
- Full lint, Vitest, npm audit, and production build remain NOT RUN.

**Release remains blocked.** Do not treat the candidate as production-ready, and do not merge or deploy until the dependency upgrade and full validation succeed.
