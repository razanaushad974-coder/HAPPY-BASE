import { redirect } from "next/navigation";

import { getVerifiedIdentity } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  let identity = null;
  try {
    identity = await getVerifiedIdentity();
  } catch {
    redirect("/login?error=configuration");
  }

  if (!identity) redirect("/login");

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080b12] px-5 py-12 text-white">
      <section className="w-full max-w-2xl rounded-3xl border border-white/10 bg-white/[0.04] p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300">HAPPY AI</p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">Your session is verified</h1>
        <p className="mt-3 max-w-xl text-sm leading-7 text-slate-300">
          Authentication is verified by Supabase on the server. This is the secure workspace entry point.
          Organization membership, tenant-scoped data, missions and workspace capabilities remain unavailable
          until their production authorization and persistence adapters are connected.
        </p>
        <p className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-200">
          Identity verification: successful
        </p>
        <form action="/auth/signout" method="post" className="mt-8">
          <button type="submit" className="rounded-xl border border-white/15 px-5 py-3 text-sm font-medium text-slate-200 transition hover:bg-white/10">
            Sign out
          </button>
        </form>
      </section>
    </main>
  );
}
