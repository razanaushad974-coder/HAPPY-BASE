import { redirect } from "next/navigation";

import { getVerifiedIdentity } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export default async function WorkspacePage() {
  const identity = await getVerifiedIdentity();

  if (!identity) {
    redirect("/login");
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080b12] px-5 py-12 text-white">
      <section className="w-full max-w-2xl rounded-3xl border border-white/10 bg-white/[0.04] p-8">
        <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300">
          HAPPY AI
        </p>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight">
          Your session is verified
        </h1>
        <p className="mt-3 max-w-xl text-sm leading-7 text-slate-300">
          Supabase authentication is connected for this Preview environment.
          This is the secure workspace entry point; the full HAPPY workspace
          modules and organization access will be connected after tenant
          membership and row-level security are implemented and verified.
        </p>
        <p className="mt-6 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-4 text-sm text-emerald-200">
          Identity verification: successful
        </p>
      </section>
    </main>
  );
}
