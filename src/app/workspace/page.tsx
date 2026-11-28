import Link from "next/link";
import { redirect } from "next/navigation";
import { getVerifiedIdentity } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

const areas = [
  { id: "missions", number: "01", title: "Missions & tasks", description: "Plan work, track task dependencies, and review execution outcomes.", state: "RUNTIME NOT CONNECTED" },
  { id: "projects", number: "02", title: "Projects & files", description: "Keep project context, files, and workspace activity in one place.", state: "TENANT STORAGE NOT CONNECTED" },
  { id: "memory", number: "03", title: "Memory & context", description: "Build continuity across conversations, projects, and decisions.", state: "DURABLE MEMORY NOT CONNECTED" },
  { id: "automations", number: "04", title: "Automations & integrations", description: "Connect approved tools and run repeatable workflows.", state: "CONNECTORS NOT CONFIGURED" },
  { id: "evidence", number: "05", title: "Evidence & verification", description: "Inspect what ran, what changed, and how an outcome was verified.", state: "LIVE EVIDENCE STORE NOT CONNECTED" },
] as const;

function StatusPill({ children }: { children: string }) {
  return <span className="inline-flex rounded-full border border-amber-300/20 bg-amber-300/[0.08] px-2.5 py-1 text-[10px] font-semibold tracking-[0.12em] text-amber-200">{children}</span>;
}

export default async function WorkspacePage() {
  let identity = null;
  try { identity = await getVerifiedIdentity(); } catch { redirect("/login?error=configuration"); }
  if (!identity) redirect("/login");

  return (
    <main className="min-h-screen bg-[#080b12] text-white">
      <header className="sticky top-0 z-20 border-b border-white/[0.08] bg-[#080b12]/90 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1440px] items-center justify-between px-5 py-4 sm:px-8">
          <Link href="/workspace" aria-label="HAPPY workspace home" className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-sm font-black text-cyan-200">H</span>
            <span><span className="block text-sm font-bold tracking-[0.2em]">HAPPY</span><span className="block text-[10px] tracking-[0.18em] text-slate-500">ONE INTELLIGENT SYSTEM</span></span>
          </Link>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-emerald-300/20 bg-emerald-300/[0.07] px-3 py-1.5 text-[11px] font-medium text-emerald-200 sm:inline-flex">Identity verified</span>
            <form action="/auth/signout" method="post"><button type="submit" className="rounded-xl border border-white/10 px-4 py-2 text-xs font-semibold text-slate-300 transition hover:border-white/25 hover:bg-white/[0.06]">Sign out</button></form>
          </div>
        </div>
      </header>
      <div className="mx-auto grid max-w-[1440px] gap-8 px-5 py-8 sm:px-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:py-10">
        <aside className="hidden lg:block">
          <p className="mb-4 px-3 text-[10px] font-bold tracking-[0.22em] text-slate-500">WORKSPACE</p>
          <nav aria-label="Workspace sections" className="space-y-1">
            <a href="#overview" className="block rounded-xl border border-cyan-300/15 bg-cyan-300/[0.08] px-3 py-2.5 text-sm font-medium text-cyan-100">Overview</a>
            {areas.map((area) => <a key={area.id} href={`#${area.id}`} className="block rounded-xl px-3 py-2.5 text-sm text-slate-400 transition hover:bg-white/[0.05] hover:text-white">{area.title}</a>)}
          </nav>
          <div className="mt-8 rounded-2xl border border-white/[0.08] bg-white/[0.025] p-4"><p className="text-xs font-semibold text-slate-200">One HAPPY identity</p><p className="mt-2 text-xs leading-5 text-slate-500">One connected system for understanding, planning, execution, verification, memory, and improvement.</p></div>
        </aside>
        <div className="min-w-0">
          <section id="overview" className="overflow-hidden rounded-3xl border border-white/[0.09] bg-[radial-gradient(ellipse_at_top_right,_rgba(34,211,238,0.12),_transparent_42%),linear-gradient(135deg,rgba(255,255,255,0.045),rgba(255,255,255,0.015))] p-6 sm:p-9">
            <div className="flex flex-wrap items-center gap-2"><span className="text-[10px] font-bold tracking-[0.24em] text-cyan-200">HAPPY WORKSPACE OS</span><StatusPill>FOUNDATION MODE</StatusPill></div>
            <h1 className="mt-5 max-w-3xl text-3xl font-semibold tracking-tight sm:text-4xl">One place to understand, plan, and move work forward.</h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300">Your sign-in identity is verified by Supabase. The workspace shell is ready, but tenant membership, durable workspace data, and the hosted execution runtime have not yet been connected. HAPPY will keep execution unavailable until those checks are complete.</p>
            <div className="mt-7 grid gap-3 sm:grid-cols-3">
              <div className="rounded-2xl border border-emerald-300/15 bg-emerald-300/[0.06] p-4"><p className="text-[10px] font-bold tracking-[0.16em] text-emerald-200">AUTHENTICATION</p><p className="mt-2 text-lg font-semibold">Verified</p><p className="mt-1 text-xs text-slate-400">Server-verified user session</p></div>
              <div className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-4"><p className="text-[10px] font-bold tracking-[0.16em] text-amber-200">TENANT CONTEXT</p><p className="mt-2 text-lg font-semibold">Not connected</p><p className="mt-1 text-xs text-slate-400">Active org/workspace membership</p></div>
              <div className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.05] p-4"><p className="text-[10px] font-bold tracking-[0.16em] text-amber-200">EXECUTION RUNTIME</p><p className="mt-2 text-lg font-semibold">Not connected</p><p className="mt-1 text-xs text-slate-400">No task dispatch from this screen</p></div>
            </div>
          </section>
          <section className="mt-8">
            <div className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[0.22em] text-cyan-200">SYSTEM AREAS</p><h2 className="mt-2 text-xl font-semibold tracking-tight">Your connected workspace</h2></div><p className="text-xs text-slate-500">Unavailable modules are clearly marked</p></div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {areas.map((area) => <article id={area.id} key={area.id} className="rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 transition hover:border-white/[0.16]"><div className="flex items-start justify-between gap-3"><span className="text-xs font-semibold tracking-[0.18em] text-slate-500">{area.number}</span><StatusPill>{area.state}</StatusPill></div><h3 className="mt-5 text-base font-semibold">{area.title}</h3><p className="mt-2 min-h-12 text-sm leading-6 text-slate-400">{area.description}</p></article>)}
            </div>
          </section>
          <section className="mt-8 rounded-2xl border border-white/[0.09] bg-white/[0.025] p-5 sm:p-6">
            <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="text-[10px] font-bold tracking-[0.2em] text-cyan-200">COMMAND CENTER</p><h2 className="mt-2 text-lg font-semibold">Talk to HAPPY</h2></div><StatusPill>EXECUTION LOCKED</StatusPill></div>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-400">The command interface will activate after HAPPY can resolve your verified organization and workspace, persist the request, and enforce the approval and worker lifecycle end to end.</p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row"><input aria-label="HAPPY command" disabled placeholder="Command input will be enabled after secure runtime connection…" className="h-12 min-w-0 flex-1 rounded-xl border border-white/10 bg-black/20 px-4 text-sm text-slate-400 placeholder:text-slate-600 disabled:cursor-not-allowed" /><button type="button" disabled className="h-12 rounded-xl bg-cyan-300/20 px-6 text-sm font-semibold text-cyan-100/50 disabled:cursor-not-allowed">Send command</button></div>
            <p className="mt-3 text-[11px] leading-5 text-slate-500">No command is accepted, queued, or executed by this placeholder interface.</p>
          </section>
          <footer className="mt-8 border-t border-white/[0.08] py-5 text-xs leading-5 text-slate-500">HAPPY AI · ONE_HAPPY · Understand → Plan → Execute → Verify → Remember → Improve</footer>
        </div>
      </div>
    </main>
  );
}
