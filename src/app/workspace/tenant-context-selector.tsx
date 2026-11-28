"use client";

import { useState, type FormEvent } from "react";

type VerifiedTenant = {
  organizationId: string;
  workspaceId: string;
  organizationRole: string;
  workspaceRole: string;
};

type ApiResponse = {
  status?: string;
  tenant?: VerifiedTenant;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default function TenantContextSelector() {
  const [organizationId, setOrganizationId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Membership has not been checked for this workspace.");
  const [verified, setVerified] = useState<VerifiedTenant | null>(null);
  const [error, setError] = useState(false);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setVerified(null);
    setError(false);

    const organization = organizationId.trim();
    const workspace = workspaceId.trim();
    if (!UUID_PATTERN.test(organization) || !UUID_PATTERN.test(workspace)) {
      setError(true);
      setMessage("Enter valid Organization ID and Workspace ID values (UUID format).");
      return;
    }

    setLoading(true);
    setMessage("Checking your active membership with Supabase…");
    try {
      const response = await fetch("/api/workspace/tenant-context", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId: organization, workspaceId: workspace }),
      });
      const payload = await response.json() as ApiResponse;
      if (!response.ok || payload.status !== "TENANT_CONTEXT_VERIFIED" || !payload.tenant) {
        setError(true);
        if (response.status === 401) {
          setMessage("Your sign-in session is no longer valid. Sign in again to continue.");
        } else if (response.status === 403) {
          setMessage("Access denied. This account does not have active membership in that organization and workspace.");
        } else if (response.status === 503) {
          setMessage("Tenant verification is not available yet. The authenticated membership RPC must be deployed and verified in the connected database.");
        } else {
          setMessage("The tenant selection could not be verified. Check both IDs and try again.");
        }
        return;
      }

      setVerified(payload.tenant);
      setMessage("Active organization and workspace membership verified. This verification is not persisted across page reloads.");
    } catch {
      setError(true);
      setMessage("Could not reach the tenant verification service. No workspace access was granted.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="tenant-context-heading" className="mt-6 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold tracking-[0.2em] text-cyan-200">SECURE WORKSPACE ACCESS</p>
          <h2 id="tenant-context-heading" className="mt-2 text-lg font-semibold">Verify organization & workspace</h2>
        </div>
        <span className="rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] text-amber-200">MEMBERSHIP CHECK REQUIRED</span>
      </div>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-400">
        Enter the IDs supplied by your organization or workspace administrator. HAPPY treats them only as selectors; Supabase verifies your signed-in identity and both active memberships before returning a tenant context. This screen does not create tenants or save the selection.
      </p>
      <form onSubmit={verify} className="mt-5 grid gap-3 md:grid-cols-2">
        <label className="block text-xs font-medium text-slate-300">
          Organization ID
          <input
            required
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            value={organizationId}
            onChange={(event) => { setOrganizationId(event.target.value); setVerified(null); }}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-mono text-xs text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/50"
          />
        </label>
        <label className="block text-xs font-medium text-slate-300">
          Workspace ID
          <input
            required
            autoComplete="off"
            spellCheck={false}
            inputMode="text"
            value={workspaceId}
            onChange={(event) => { setWorkspaceId(event.target.value); setVerified(null); }}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="mt-2 h-11 w-full rounded-xl border border-white/10 bg-black/20 px-3 font-mono text-xs text-white outline-none transition placeholder:text-slate-600 focus:border-cyan-300/50"
          />
        </label>
        <div className="md:col-span-2 flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="h-11 rounded-xl border border-cyan-200/20 bg-cyan-300/10 px-5 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-300/15 disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Verifying…" : "Verify membership"}
          </button>
          <p role="status" aria-live="polite" className={`text-xs leading-5 ${error ? "text-amber-200" : "text-slate-400"}`}>
            {message}
          </p>
        </div>
      </form>
      {verified ? (
        <div className="mt-4 grid gap-3 rounded-xl border border-emerald-300/20 bg-emerald-300/[0.06] p-4 sm:grid-cols-2">
          <div><p className="text-[10px] font-bold tracking-[0.14em] text-emerald-200">ORGANIZATION ROLE</p><p className="mt-1 text-sm font-semibold text-white">{verified.organizationRole}</p></div>
          <div><p className="text-[10px] font-bold tracking-[0.14em] text-emerald-200">WORKSPACE ROLE</p><p className="mt-1 text-sm font-semibold text-white">{verified.workspaceRole}</p></div>
          <p className="sm:col-span-2 break-all font-mono text-[10px] leading-5 text-slate-400">Organization: {verified.organizationId}<br />Workspace: {verified.workspaceId}</p>
        </div>
      ) : null}
    </section>
  );
}
