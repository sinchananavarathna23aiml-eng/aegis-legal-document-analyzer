import { useEffect, useState } from "react";
import { Download, FileClock, FileSearch, LoaderCircle, Trash2 } from "lucide-react";
import { deleteAnalysis, listAnalyses, loadAnalysis, loadOriginalFile, type SavedAnalysisSummary } from "@/lib/persistence";
import type { AnalysisResult } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

export function DocumentHistoryPage() {
  const [items, setItems] = useState<SavedAnalysisSummary[]>([]);
  const [selected, setSelected] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(true);
  const [workingId, setWorkingId] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void listAnalyses().then((result) => { if (active) setItems(result); }).catch(() => { if (active) setError("Document history could not be loaded."); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);

  async function openAnalysis(id: string) {
    setWorkingId(id);
    setError("");
    try {
      const result = await loadAnalysis(id);
      if (result) setSelected(result);
      else setError("This saved analysis is no longer available.");
    } catch { setError("This saved analysis could not be opened."); }
    finally { setWorkingId(""); }
  }

  async function downloadOriginal(id: string) {
    setWorkingId(id);
    try {
      const payload = await loadOriginalFile(id);
      if (!payload) throw new Error("The original document is unavailable.");
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = payload.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The original document could not be downloaded."); }
    finally { setWorkingId(""); }
  }

  async function removeAnalysis(id: string) {
    setWorkingId(id);
    try {
      await deleteAnalysis(id);
      setItems((current) => current.filter((item) => item.id !== id));
      if (selected?.fileName === items.find((item) => item.id === id)?.fileName) setSelected(null);
    } catch { setError("This item could not be removed from history."); }
    finally { setWorkingId(""); }
  }

  return (
    <div className="grid min-h-full gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(280px,.82fr)]">
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        <div className="flex items-center gap-3"><span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent"><FileClock size={18} /></span><div><h2 className="font-display text-2xl">Saved documents</h2><p className="text-xs text-muted">Private to your account</p></div><span className="ml-auto rounded-full bg-bg px-3 py-1 text-xs font-semibold text-muted">{items.length}</span></div>
        {error && <p role="alert" className="mt-4 rounded-xl bg-danger/10 p-3 text-sm text-danger">{error}</p>}
        {busy ? <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted"><LoaderCircle className="animate-spin" size={16} />Loading your history…</div> : items.length ? <ul className="mt-4 divide-y divide-border">{items.map((item) => <li key={item.id} className={cn("flex items-center gap-3 py-3", selected?.fileName === item.fileName && "rounded-xl bg-accent-soft/50 px-3")}>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg text-accent"><FileSearch size={16} /></span>
          <button className="min-w-0 flex-1 text-left" onClick={() => void openAnalysis(item.id)}><span className="block truncate text-sm font-semibold">{item.fileName}</span><span className="mt-1 block text-[11px] text-muted">{new Date(item.savedAt).toLocaleDateString()} · Score {item.score}/100</span></button>
          <button disabled={workingId === item.id || !item.hasOriginalFile} onClick={() => void downloadOriginal(item.id)} aria-label={`Download ${item.fileName}`} title={item.hasOriginalFile ? "Download original" : "Original file not saved"} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-bg hover:text-fg disabled:opacity-40"><Download size={16} /></button>
          <button disabled={workingId === item.id} onClick={() => void removeAnalysis(item.id)} aria-label={`Delete ${item.fileName}`} className="grid size-9 shrink-0 place-items-center rounded-lg text-muted transition hover:bg-danger/10 hover:text-danger disabled:opacity-40"><Trash2 size={16} /></button>
        </li>)}</ul> : <div className="flex min-h-48 flex-col items-center justify-center text-center"><FileClock className="text-accent" size={25} /><p className="mt-3 text-sm font-semibold">No saved documents yet</p><p className="mt-1 max-w-xs text-xs leading-5 text-muted">Analyses you save from Document review will appear here.</p></div>}
      </section>
      <section className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
        {selected ? <><p className="text-[10px] font-semibold uppercase tracking-[.16em] text-accent">Saved analysis</p><h2 className="mt-2 font-display text-2xl">{selected.signing.label}</h2><p className="mt-2 text-sm leading-6 text-muted">{selected.signing.recommendation}</p><div className="mt-4 flex flex-wrap gap-2"><span className="rounded-full bg-accent-soft px-3 py-1 text-xs font-semibold">{selected.signing.percentage}/100</span><span className="rounded-full bg-bg px-3 py-1 text-xs text-muted">{selected.statistics.wordCount.toLocaleString()} words</span></div><p className="mt-5 border-t border-border pt-4 text-xs leading-5 text-muted">{selected.signing.missingClauses.length ? `Missing clauses: ${selected.signing.missingClauses.join(", ")}` : "No missing clauses were flagged in this saved review."}</p></> : <div className="flex min-h-48 flex-col items-center justify-center text-center"><FileSearch className="text-accent" size={25} /><p className="mt-3 text-sm font-semibold">Choose a document</p><p className="mt-1 max-w-xs text-xs leading-5 text-muted">Open a saved item to see its review summary and score.</p></div>}
      </section>
    </div>
  );
}
