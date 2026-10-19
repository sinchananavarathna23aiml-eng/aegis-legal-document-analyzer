import { useState } from "react";
import { Navigate, createFileRoute } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  FileClock,
  FileSearch,
  GitCompareArrows,
  LayoutDashboard,
  LogOut,
  PenLine,
  ShieldCheck,
} from "lucide-react";
import { AnalyzePanel } from "@/components/analyze-panel";
import { ComparePanel } from "@/components/compare-panel";
import { GeneratePanel } from "@/components/generate-panel";
import { LexaChat } from "@/components/lexa-chat";
import { DocumentHistoryPage } from "@/components/document-history-page";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { signOut } from "@/lib/auth/client";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/")({ component: Home });

type View = "overview" | "analyze" | "compare" | "draft" | "history" | "assistant";
const steps: { id: View; label: string; shortLabel: string; icon: typeof LayoutDashboard }[] = [
  { id: "overview", label: "Overview", shortLabel: "Home", icon: LayoutDashboard },
  { id: "analyze", label: "Document review", shortLabel: "Review", icon: FileSearch },
  { id: "compare", label: "Compare documents", shortLabel: "Compare", icon: GitCompareArrows },
  { id: "draft", label: "Draft a document", shortLabel: "Draft", icon: PenLine },
  { id: "history", label: "Document history", shortLabel: "History", icon: FileClock },
  { id: "assistant", label: "Lexa assistant", shortLabel: "Lexa", icon: Bot },
];

function Home() {
  const { user, isPending } = useCurrentUserState();
  const [view, setView] = useState<View>("overview");
  const [chatOpen, setChatOpen] = useState(false);
  const [docText, setDocText] = useState("");
  const [docName, setDocName] = useState("");
  const [docVersion, setDocVersion] = useState(0);
  const currentIndex = steps.findIndex((step) => step.id === view);

  if (isPending) return <main className="grid h-dvh place-items-center bg-bg text-muted">Loading your secure workspace…</main>;
  if (!user) return <Navigate to="/login" />;

  const setStep = (next: View) => {
    setView(next);
    setChatOpen(next === "assistant");
  };
  const title = steps[currentIndex]?.label ?? "Overview";

  return (
    <div className="flex h-dvh overflow-hidden bg-bg text-fg">
      <aside className="hidden w-[250px] shrink-0 flex-col border-r border-border bg-surface px-5 py-6 lg:flex">
        <a href="/" className="flex items-center gap-3 px-1">
          <img src="/aegis-logo.png" alt="Aegis advocate emblem" className="brand-mark size-12" />
          <span><span className="block font-display text-[25px] leading-none">Aegis</span><span className="mt-1 block text-[10px] uppercase tracking-[.14em] text-muted">Legal document analyser</span></span>
        </a>
        <p className="mb-3 mt-10 px-3 text-[10px] font-semibold uppercase tracking-[.18em] text-subtle">Workspace</p>
        <nav className="space-y-1" aria-label="Workspace pages">
          {steps.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setStep(id)} aria-current={view === id ? "page" : undefined} className={cn("flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition", view === id ? "bg-accent-soft font-semibold text-fg" : "text-muted hover:bg-elevated hover:text-fg")}>
              <Icon size={17} className={view === id ? "text-accent" : "text-subtle"} />{label}
            </button>
          ))}
        </nav>
        <div className="mt-auto rounded-2xl border border-border bg-bg p-4">
          <div className="flex size-9 items-center justify-center rounded-xl bg-accent-soft text-accent"><ShieldCheck size={18} /></div>
          <p className="mt-3 text-sm font-medium">Private by account</p>
          <p className="mt-1 text-xs leading-5 text-muted">Your documents and conversations are stored in your own workspace.</p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="z-20 flex min-h-[72px] shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-7">
          <div className="flex min-w-0 items-center gap-3">
            <img src="/aegis-logo.png" alt="Aegis advocate emblem" className="brand-mark size-10 lg:hidden" />
            <div className="min-w-0"><p className="truncate text-[10px] font-medium uppercase tracking-[.16em] text-subtle">Aegis / {title}</p><p className="truncate text-sm font-semibold">{title === "Overview" ? "Legal document analyser" : title}</p></div>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            <button onClick={() => setStep("assistant")} className="flex min-h-10 items-center gap-2 rounded-xl border border-border bg-bg px-3 text-xs font-semibold text-fg transition hover:bg-elevated"><Bot size={16} /><span className="hidden sm:inline">Ask Lexa</span></button>
            <span className="hidden max-w-40 truncate text-sm text-muted sm:inline">{user.displayName ?? user.primaryEmail}</span>
            <button onClick={() => void signOut()} className="flex size-9 items-center justify-center rounded-lg text-muted transition hover:bg-elevated hover:text-fg" aria-label="Sign out" title="Sign out"><LogOut size={17} /></button>
          </div>
        </header>

        <nav className="flex shrink-0 flex-wrap gap-1 border-b border-border bg-surface px-3 py-2 lg:hidden" aria-label="Workspace pages">
          {steps.map(({ id, shortLabel, icon: Icon }) => <button key={id} onClick={() => setStep(id)} aria-current={view === id ? "page" : undefined} className={cn("flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[11px] font-medium", view === id ? "bg-accent-soft text-fg" : "text-muted hover:bg-elevated")}><Icon size={14} />{shortLabel}</button>)}
        </nav>

        <main className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-3 pt-4 sm:px-7 sm:pt-6">
          <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
            <div><p className="text-[10px] font-semibold uppercase tracking-[.18em] text-accent">Page {currentIndex + 1} of {steps.length}</p>{view === "overview" ? <p className="mt-1 text-sm font-semibold">Welcome back, {user.displayName ?? ""}</p> : <h1 className="mt-1 font-display text-3xl leading-tight sm:text-4xl">{title}</h1>}</div>
            {view !== "overview" && <p className="hidden text-xs text-muted sm:block">One workspace at a time · Your work saves to your account</p>}
          </div>

          <section className={cn("mb-12 min-h-0 flex-1 overscroll-contain", view === "overview" ? "overflow-hidden" : "overflow-y-auto")} aria-label={`${title} page`}>
            {view === "overview" ? (
              <div className="relative flex min-h-full flex-col overflow-hidden rounded-[26px] border border-border bg-surface p-5 sm:p-8 lg:p-10">
                <div className="relative z-10 max-w-full py-1 sm:max-w-[72%] sm:py-2 lg:max-w-[48%]">
                  <div className="inline-flex items-center gap-2 rounded-full border border-border bg-bg px-3 py-1.5 text-[11px] font-medium text-muted"><span className="size-1.5 rounded-full bg-accent" />LEGAL DOCUMENT INTELLIGENCE</div>
                  <h2 className="mt-3 max-w-[550px] font-display text-[38px] leading-[1.03] tracking-tight sm:mt-4 sm:text-[48px]">Clarity in every clause.</h2>
                  <p className="mt-3 max-w-lg text-sm leading-6 text-muted">Review agreements, surface important terms, and keep every matter organized in one calm, secure workspace.</p>
                  <button onClick={() => setStep("analyze")} className="mt-4 inline-flex min-h-11 items-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-accent-fg transition hover:-translate-y-0.5">Begin document review <ArrowUpRight size={16} /></button>
                </div>
                <div className="legal-hero-art" aria-hidden="true"><div className="legal-hero-orbit" /><div className="legal-hero-seal"><img src="/aegis-logo.png" alt="" /><span>AEGIS</span></div><div className="legal-float-card legal-float-one"><FileSearch size={17} /><span>Clause review</span><small>Structured analysis</small></div><div className="legal-float-card legal-float-two"><ShieldCheck size={17} /><span>Private workspace</span><small>Personal to your account</small></div><div className="legal-float-card legal-float-three"><GitCompareArrows size={16} /><span>Side-by-side review</span></div><div className="legal-float-card legal-float-four"><FileClock size={16} /><span>Saved document history</span></div></div>
                <div className="overview-shortcuts relative z-10 mt-auto grid max-w-[650px] gap-2 pt-4 sm:grid-cols-3">
                  {steps.slice(1, 4).map(({ id, label, icon: Icon }) => <button key={id} onClick={() => setStep(id)} className="group flex min-h-[58px] items-center gap-3 rounded-2xl border border-border bg-bg/95 p-3 text-left transition hover:-translate-y-0.5 hover:border-border-strong"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Icon size={17} /></span><span className="min-w-0 text-xs font-semibold sm:text-sm">{label}</span><ArrowUpRight className="ml-auto shrink-0 text-subtle transition group-hover:translate-x-0.5" size={15} /></button>)}
                </div>
              </div>
            ) : (
              <div className="min-h-full rounded-[22px] border border-border bg-surface p-3 sm:p-5">
                {view === "analyze" && <AnalyzePanel onDocumentLoaded={(text, name) => { setDocText(text); setDocName(name); setDocVersion((version) => version + 1); }} />}
                {view === "compare" && <ComparePanel />}
                {view === "draft" && <GeneratePanel />}
                {view === "history" && <DocumentHistoryPage />}
                {view === "assistant" && <div className="grid min-h-56 place-items-center text-sm text-muted">Your private Lexa workspace is ready.</div>}
              </div>
            )}
          </section>

          <footer className="absolute bottom-2 left-4 right-4 z-10 flex items-center justify-between border-t border-border bg-bg pt-2 sm:left-7 sm:right-7">
            <button disabled={currentIndex === 0} onClick={() => setStep(steps[Math.max(0, currentIndex - 1)]!.id)} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-medium text-muted transition hover:bg-elevated disabled:cursor-not-allowed disabled:opacity-40"><ArrowLeft size={15} />Previous</button>
            <div className="flex items-center gap-1.5" aria-label={`Step ${currentIndex + 1} of ${steps.length}`}>{steps.map((step, index) => <span key={step.id} className={cn("h-1.5 rounded-full transition-all", index === currentIndex ? "w-7 bg-accent" : "w-1.5 bg-border-strong")} />)}</div>
            <button disabled={currentIndex === steps.length - 1} onClick={() => setStep(steps[Math.min(steps.length - 1, currentIndex + 1)]!.id)} className="inline-flex min-h-10 items-center gap-2 rounded-xl px-3 text-xs font-semibold text-accent transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40">Next<ArrowRight size={15} /></button>
          </footer>
        </main>
      </div>
      <LexaChat open={chatOpen} fullPage={view === "assistant"} onClose={() => setStep("analyze")} documentText={docText} documentName={docName} documentVersion={docVersion} onRestoreDocument={(text, name) => { setDocText(text); setDocName(name); }} />
    </div>
  );
}
