"use client";

import { FormEvent, useState } from "react";

import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setSent(false);
    setError("");

    try {
      const supabase = createClient();
      const emailRedirectTo = new URL(
        "/auth/callback?next=%2Fworkspace",
        window.location.origin,
      ).toString();

      const { error: authError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo,
          shouldCreateUser: true,
        },
      });

      if (authError) {
        setError("Sign-in link could not be sent. Please check the email and try again.");
      } else {
        setSent(true);
      }
    } catch {
      setError("Supabase Auth is not configured for this environment yet.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-[#080b12] px-5 py-12 text-white">
      <section className="w-full max-w-md rounded-3xl border border-white/10 bg-white/[0.04] p-8 shadow-2xl shadow-black/30">
        <div className="mb-8">
          <p className="text-xs font-semibold uppercase tracking-[0.32em] text-cyan-300">
            HAPPY AI
          </p>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">
            Welcome back
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-300">
            Enter your email and we’ll send you a secure sign-in link. No password required.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <label className="block text-sm font-medium text-slate-200" htmlFor="email">
            Email address
          </label>
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={254}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="h-12 w-full rounded-xl border border-white/15 bg-black/20 px-4 text-base text-white outline-none transition placeholder:text-slate-500 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20"
          />
          <button
            type="submit"
            disabled={pending || !email.trim()}
            className="h-12 w-full rounded-xl bg-cyan-300 px-4 font-semibold text-slate-950 transition hover:bg-cyan-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {pending ? "Sending link…" : "Continue with email"}
          </button>
        </form>

        {sent && (
          <p role="status" className="mt-5 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3 text-sm leading-6 text-emerald-200">
            If this address can sign in, a secure link is on its way. Open it in this browser to continue.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-5 rounded-xl border border-rose-400/20 bg-rose-400/10 p-3 text-sm leading-6 text-rose-200">
            {error}
          </p>
        )}

        <p className="mt-8 text-center text-xs leading-5 text-slate-500">
          Secure authentication powered by Supabase. Your account session is verified on the server.
        </p>
      </section>
    </main>
  );
}
