import { useState } from "react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import { ArrowRight, Check, Eye, EyeOff, FileClock, FileSearch, GitCompareArrows, LockKeyhole, Mail, ShieldCheck, UserRound } from "lucide-react";
import { authClient } from "@/lib/auth/client";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/login")({ component: Login });

function Login() {
  const { user, isPending } = useCurrentUserState();
  const [mode, setMode] = useState<"login" | "signup">("signup");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  if (isPending) return <main className="grid min-h-dvh place-items-center bg-bg text-muted">Checking your session…</main>;
  if (user) return <Navigate to="/" />;

  return (
    <main className="grid h-dvh overflow-hidden bg-bg lg:grid-cols-[1.04fr_.96fr]">
      <section className="relative hidden overflow-hidden border-r border-border bg-surface p-10 lg:flex lg:flex-col lg:justify-between xl:p-14">
        <a href="/login" className="relative z-10 flex items-center gap-3"><img src="/aegis-logo.png" alt="Aegis advocate emblem" className="brand-mark size-12" /><span><span className="block font-display text-[27px] leading-none">Aegis</span><span className="mt-1 block text-[10px] uppercase tracking-[.14em] text-muted">Legal document analyser</span></span></a>
        <div className="relative z-10 max-w-xl pb-8">
          <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-accent">A clearer view of every agreement</p>
          <h1 className="mt-4 font-display text-[56px] leading-[.98] tracking-tight xl:text-[68px]">Make room for the details that matter.</h1>
          <p className="mt-5 max-w-md text-[15px] leading-7 text-muted">A considered workspace for reviewing, comparing, and organizing legal documents.</p>
          <div className="mt-9 space-y-3">
            {["Clause and risk analysis", "Private document history", "Image and scanned document support"].map((item) => <div key={item} className="flex items-center gap-3 text-sm text-fg"><span className="grid size-6 place-items-center rounded-full bg-accent/15 text-accent"><Check size={14} /></span>{item}</div>)}
          </div>
        </div>
        <div className="relative z-10 flex items-center gap-2 text-xs text-subtle"><ShieldCheck size={15} /> Account-protected legal workspace</div>
        <div className="legal-hero-art login-art" aria-hidden="true"><div className="legal-hero-orbit" /><div className="legal-hero-seal"><img src="/aegis-logo.png" alt="" /><span>AEGIS</span></div><div className="legal-float-card legal-float-one"><FileSearch size={17} /><span>Document review</span><small>Clause intelligence</small></div><div className="legal-float-card legal-float-two"><ShieldCheck size={17} /><span>Account protected</span></div><div className="legal-float-card legal-float-three"><GitCompareArrows size={16} /><span>Side-by-side review</span></div><div className="legal-float-card legal-float-four"><FileClock size={16} /><span>Saved legal history</span></div></div>
      </section>

      <section className="flex min-h-dvh items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[420px]">
          <div className="mb-9 flex items-center gap-3 lg:hidden"><img src="/aegis-logo.png" alt="Aegis advocate emblem" className="brand-mark size-11" /><span><span className="block font-display text-2xl leading-none">Aegis</span><span className="mt-1 block text-[9px] uppercase tracking-[.14em] text-muted">Legal document analyser</span></span></div>
          <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-accent">Your secure workspace</p>
          <h2 className="mt-2 font-display text-[40px] leading-tight">{mode === "signup" ? "Create your account" : "Welcome back"}</h2>
          <p className="mt-2 text-sm leading-6 text-muted">{mode === "signup" ? "Sign up to analyze and save your legal documents." : "Sign in to continue to your documents and conversations."}</p>

          <form className="mt-8 space-y-4" onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true); setError("");
            const form = new FormData(event.currentTarget);
            const name = String(form.get("name") ?? "").trim();
            const email = String(form.get("email") ?? "").trim();
            const password = String(form.get("password") ?? "");
            try {
              const response = mode === "signup"
                ? await authClient.signUp.email({ name, email, password })
                : await authClient.signIn.email({ email, password });
              if (response.error) throw new Error(response.error.message || "Please check your details and try again.");
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : "We could not complete sign-in. Please try again.");
            } finally { setBusy(false); }
          }}>
            {mode === "signup" && <label className="block"><span className="mb-2 block text-xs font-medium">Full name</span><span className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-3 focus-within:border-accent"><UserRound size={16} className="text-subtle" /><input name="name" required autoComplete="name" placeholder="Your name" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" /></span></label>}
            <label className="block"><span className="mb-2 block text-xs font-medium">Email address</span><span className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-3 focus-within:border-accent"><Mail size={16} className="text-subtle" /><input name="email" required type="email" autoComplete="email" placeholder="you@example.com" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" /></span></label>
            <label className="block"><span className="mb-2 block text-xs font-medium">Password</span><span className="flex min-h-12 items-center gap-3 rounded-xl border border-border bg-surface px-3 focus-within:border-accent"><LockKeyhole size={16} className="text-subtle" /><input name="password" required type={showPassword ? "text" : "password"} autoComplete={mode === "login" ? "current-password" : "new-password"} minLength={8} placeholder="At least 8 characters" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle" /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} className="rounded p-1 text-subtle hover:text-fg" onClick={() => setShowPassword((shown) => !shown)}>{showPassword ? <EyeOff size={16} /> : <Eye size={16} />}</button></span></label>
            <button disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg transition hover:-translate-y-0.5 disabled:opacity-60">{busy ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}<ArrowRight size={16} /></button>
          </form>

          {error && <p role="alert" className="mt-4 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm leading-5 text-danger">{error}</p>}
          <p className="mt-6 text-center text-sm text-muted">{mode === "signup" ? "Already have an account?" : "New to Aegis?"}{" "}<button onClick={() => { setMode(mode === "signup" ? "login" : "signup"); setError(""); }} className="font-semibold text-fg underline decoration-accent underline-offset-4">{mode === "signup" ? "Sign in" : "Create an account"}</button></p>
          <p className="mt-8 text-center text-[11px] leading-5 text-subtle">Your account uses protected password authentication. Documents and chat history are kept private to your account.</p>
        </div>
      </section>
    </main>
  );
}
