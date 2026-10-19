import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Clock,
  Download,
  FileText,
  Loader2,
  MessageSquare,
  Save,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScoreRing } from "@/components/score-ring";
import {
  discoverAdditionalFindings,
  lexaChat,
  refineSummary,
  reviewClauseCandidates,
  type AiFinding,
  type ClauseVerdict,
} from "@/lib/legal/ai";
import { analyzeText, isLikelyLegalDocument } from "@/lib/legal/analyzer";
import { extractFileText } from "@/lib/legal/extract";
import { SAMPLE_NDA, SAMPLE_RISKY } from "@/lib/legal/samples";
import type { AnalysisResult, Factor } from "@/lib/legal/types";
import { cn } from "@/lib/utils";
import {
  saveAnalysis,
  listAnalyses,
  loadAnalysis,
  loadOriginalFile,
  deleteAnalysis,
  type OriginalFilePayload,
  type SavedAnalysisSummary,
} from "@/lib/persistence";
import { useAiCooldown } from "@/lib/hooks/ai-cooldown";

type ChatTurn = { role: "user" | "assistant"; content: string };

const MAX_SAVED_FILE_BYTES = 5 * 1024 * 1024;

async function fileToPayload(file: File): Promise<OriginalFilePayload> {
  if (file.size > MAX_SAVED_FILE_BYTES) {
    throw new Error("Files larger than 5 MB can be analyzed, but cannot be saved with the original file attached.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    base64: btoa(binary),
  };
}

const VERDICT_STYLE: Record<ClauseVerdict["verdict"], { label: string; className: string }> = {
  confirmed: { label: "Confirmed", className: "text-danger" },
  false_positive: { label: "False positive", className: "text-ok" },
  uncertain: { label: "Uncertain", className: "text-warn" },
};

function toneForScore(n: number): "ok" | "warn" | "danger" {
  if (n >= 65) return "ok";
  if (n >= 50) return "warn";
  return "danger";
}

export function AnalyzePanel({
  onDocumentLoaded,
  historyRequest = 0,
}: {
  onDocumentLoaded?: (text: string, name: string) => void;
  historyRequest?: number;
} = {}) {
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState("untitled.txt");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"summary" | "clauses" | "entities" | "risks" | "chat">("summary");
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [analysisChatThreadId, setAnalysisChatThreadId] = useState<string>();
  const [question, setQuestion] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [sumBusy, setSumBusy] = useState(false);
  const [verdicts, setVerdicts] = useState<Map<number, ClauseVerdict> | null>(null);
  const [aiFindings, setAiFindings] = useState<AiFinding[] | null>(null);
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysisSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const [legalConfirmation, setLegalConfirmation] = useState<boolean | null>(null);
  const [savedCurrent, setSavedCurrent] = useState(false);
  const reviewCooldown = useAiCooldown();
  const sumCooldown = useAiCooldown();

  const clauseEntries = useMemo(
    () => (result ? Object.entries(result.clauses).sort((a, b) => b[1].length - a[1].length) : []),
    [result],
  );

  // Stable indexed list spanning both risk and favorable factors, so a verdict
  // returned by the model (keyed by index) can be matched back to the right
  // factor regardless of which list it came from.
  const allFactors = useMemo(() => {
    if (!result) return [] as { index: number; kind: "risk" | "favorable"; factor: Factor }[];
    const risks = result.signing.findings.risks.map((factor, i) => ({
      index: i,
      kind: "risk" as const,
      factor,
    }));
    const favorable = result.signing.findings.favorable.map((factor, i) => ({
      index: risks.length + i,
      kind: "favorable" as const,
      factor,
    }));
    return [...risks, ...favorable];
  }, [result]);

  async function onFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      if (legalConfirmation !== true) {
        throw new Error("Confirm that this is a legal document before uploading.");
      }
      if (!/\.(pdf|docx|txt|md|png|jpe?g|webp|tiff?)$/i.test(file.name)) {
        throw new Error("Upload a legal document as PDF, DOCX, TXT, JPG, PNG, or WebP.");
      }
      const extracted = await extractFileText(file);
      if (!isLikelyLegalDocument(extracted)) {
        throw new Error("We could not find enough legal language in this file. Check the image is readable and upload a legal document.");
      }
      setText(extracted);
      setFileName(file.name);
      setOriginalFile(file);
      const analysis = analyzeText(extracted, file.name);
      setResult(analysis);
      setSavedCurrent(false);
      onDocumentLoaded?.(extracted, file.name);
      setAiSummary(null);
      setChat([]);
      setAnalysisChatThreadId(undefined);
      setVerdicts(null);
      setAiFindings(null);
      setReviewError(null);
      setTab("summary");
      try {
        const payload = file.size <= MAX_SAVED_FILE_BYTES ? await fileToPayload(file) : undefined;
        await saveAnalysis(analysis, payload);
        setSavedCurrent(true);
        await refreshHistory();
        if (file.size > MAX_SAVED_FILE_BYTES) {
          setError("Analysis saved. This file is over 5 MB, so the extracted text and results were saved without the original file.");
        }
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : "Analysis complete, but we could not save it to your history.");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }

  function runAnalysis(source: string, name: string) {
    setError(null);
    if (!isLikelyLegalDocument(source)) {
      setError("This workspace analyzes legal documents. Add legal text before starting an analysis.");
      return;
    }
    setOriginalFile(null);
    setFileName(name);
    setText(source);
    setResult(analyzeText(source, name));
    setSavedCurrent(false);
    onDocumentLoaded?.(source, name);
    setAiSummary(null);
    setChat([]);
    setAnalysisChatThreadId(undefined);
    setVerdicts(null);
    setAiFindings(null);
    setReviewError(null);
    setTab("summary");
  }

  async function onReviewRisks() {
    if (!result) return;
    setReviewBusy(true);
    setReviewError(null);
    try {
      const candidates = allFactors
        .filter((f) => f.factor.examples?.length)
        .map((f) => ({
          index: f.index,
          type: f.factor.type,
          description: f.factor.description,
          excerpt: f.factor.examples![0],
        }));

      // Run regex-verification and LLM-native discovery in parallel — they're
      // independent calls answering different questions (is this flag right?
      // vs. what did the flags miss?).
      const [verifyRes, discoverRes] = await Promise.all([
        candidates.length
          ? reviewClauseCandidates({ data: { candidates } })
          : Promise.resolve({ ok: false as const, error: "" }),
        discoverAdditionalFindings({ data: { documentText: result.cleanedText } }),
      ]);

      if (verifyRes.ok) {
        setVerdicts(new Map(verifyRes.verdicts.map((v) => [v.index, v])));
      } else if (verifyRes.error) {
        setReviewError(verifyRes.error);
      }

      if (discoverRes.ok) {
        setAiFindings(discoverRes.findings);
      } else if (!verifyRes.ok) {
        // Only surface the discovery error if verification also failed —
        // otherwise the successful half of the pair still renders.
        setReviewError((prev) => prev ?? discoverRes.error);
      }

      if (verifyRes.ok || discoverRes.ok) reviewCooldown.startCooldown();
    } catch {
      setReviewError("The review could not complete. Try again.");
    } finally {
      setReviewBusy(false);
    }
  }

  async function onAsk() {
    if (!result || !question.trim()) return;
    const q = question.trim();
    setQuestion("");
    const userMessage: ChatTurn = { role: "user", content: q };
    setChat((c) => [...c, userMessage]);
    setChatBusy(true);
    try {
      const res = await lexaChat({
        data: {
          messages: [...chat, userMessage],
          documentText: result.cleanedText,
          documentName: result.fileName,
          threadId: analysisChatThreadId,
        },
      });
      if ("threadId" in res && res.threadId) setAnalysisChatThreadId(res.threadId);
      setChat((c) => [
        ...c,
        { role: "assistant", content: res.ok ? res.text : res.error },
      ]);
    } catch {
      setChat((c) => [...c, { role: "assistant", content: "The assistant could not respond. Try again." }]);
    } finally {
      setChatBusy(false);
    }
  }

  async function onRefine() {
    if (!result) return;
    setSumBusy(true);
    try {
      const res = await refineSummary({ data: { documentText: result.cleanedText } });
      if (res.ok) {
        setAiSummary(res.text);
        sumCooldown.startCooldown();
      } else {
        setError(res.error);
      }
    } finally {
      setSumBusy(false);
    }
  }

  const refreshHistory = useCallback(async () => {
    try {
      const list = await listAnalyses();
      setSavedAnalyses(list);
    } catch {
      // A visitor who has not signed in has no personal history to display yet.
      setSavedAnalyses([]);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    if (historyRequest > 0) {
      setShowHistory(true);
      void refreshHistory();
    }
  }, [historyRequest, refreshHistory]);

  async function onSave() {
    if (!result) return;
    setSaveBusy(true);
    setError(null);
    try {
      const matchingFile = originalFile && originalFile.name === result.fileName
        ? originalFile
        : null;
      const payload = matchingFile && matchingFile.size <= MAX_SAVED_FILE_BYTES
        ? await fileToPayload(matchingFile)
        : undefined;
      await saveAnalysis(result, payload);
      setSavedCurrent(true);
      await refreshHistory();
      if (matchingFile && matchingFile.size > MAX_SAVED_FILE_BYTES) {
        setError("Analysis saved. The original file exceeded 5 MB, so only its extracted text and results were saved.");
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : "";
      setError(
        message === "Unauthorized"
          ? "Sign in or create an account before saving your document."
          : message || "Could not save this analysis. Please try again.",
      );
    } finally {
      setSaveBusy(false);
    }
  }

  async function onLoadSaved(id: string) {
    const loaded = await loadAnalysis(id);
    if (loaded) {
      setOriginalFile(null);
      setResult(loaded);
      setSavedCurrent(true);
      setText(loaded.cleanedText);
      setFileName(loaded.fileName);
      onDocumentLoaded?.(loaded.cleanedText, loaded.fileName);
      setAiSummary(null);
      setChat([]);
      setAnalysisChatThreadId(undefined);
      setVerdicts(null);
      setAiFindings(null);
      setReviewError(null);
      setTab("summary");
      setShowHistory(false);
    }
  }

  async function onDeleteSaved(id: string) {
    try {
      await deleteAnalysis(id);
      await refreshHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete this saved analysis.");
    }
  }

  async function onDownloadOriginal(id: string) {
    try {
      const payload = await loadOriginalFile(id);
      if (!payload) {
        setError("No original file was attached to this saved analysis.");
        return;
      }
      const binary = atob(payload.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: payload.mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = payload.fileName;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not download the original file.");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.18fr)]">
      <section className="rounded-[var(--radius-xl)] border border-border bg-surface p-5 shadow-[var(--shadow-panel)] sm:p-6">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.18em] text-subtle">Intake</p>
            <h2 className="mt-1 font-display text-3xl leading-none text-fg">Document</h2>
          </div>
          <img
            src="/aegis-logo.png"
            alt="Aegis advocate emblem"
            className="brand-mark size-9"
          />
        </div>
        <p className="mt-3 text-sm leading-6 text-muted">
          Add a contract, court filing, or other legal record. Scans and photos are read with OCR, then your analysis is saved to your account history.
        </p>

        <fieldset className="mt-5 rounded-xl border border-border bg-bg p-4">
          <legend className="px-1 text-xs font-semibold">Is this a legal document?</legend>
          <div className="mt-2 grid grid-cols-2 gap-2" role="radiogroup" aria-label="Confirm legal document">
            {[{ value: true, label: "Yes, it is legal" }, { value: false, label: "No" }].map(({ value, label }) => (
              <button key={label} type="button" role="radio" aria-checked={legalConfirmation === value} onClick={() => setLegalConfirmation(value)} className={cn("min-h-10 rounded-lg border px-3 text-xs font-medium transition", legalConfirmation === value ? "border-accent bg-accent/10 text-fg" : "border-border bg-surface text-muted hover:border-border-strong")}>{label}</button>
            ))}
          </div>
          <p className={cn("mt-2 text-[11px] leading-5", legalConfirmation === false ? "text-danger" : "text-muted")}>{legalConfirmation === false ? "This workspace accepts legal documents only. Choose Yes when you have a legal record to review." : "We also check for legal language after extraction to catch unrelated files."}</p>
        </fieldset>

        <label
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const dropped = event.dataTransfer.files[0];
            if (dropped) void onFile(dropped);
          }}
          className={cn("mt-4 flex min-h-36 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-border-strong bg-elevated px-4 py-8 text-center transition-colors", legalConfirmation === true ? "cursor-pointer hover:border-accent" : "cursor-not-allowed opacity-65")}
        >
          {busy ? (
            <>
              <img
                src="/aegis-logo.png"
                alt=""
                aria-hidden="true"
                className="aegis-logo-loading brand-mark size-16"
              />
              <span className="mt-3 text-sm text-fg">Reading your document…</span>
              <span className="mt-1 text-xs text-subtle">Aegis is preparing the analysis</span>
            </>
          ) : (
            <>
              <Upload className="size-5 text-accent" />
              <span className="mt-2 text-sm text-fg">Drop a legal file here or browse</span>
              <span className="mt-1 text-xs text-subtle">PDF · DOCX · TXT · JPG · PNG · WebP</span>
            </>
          )}
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.jpg,.jpeg,.png,.webp,.tif,.tiff,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,image/*"
            className="sr-only"
            disabled={busy || legalConfirmation !== true}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
        </label>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => runAnalysis(SAMPLE_NDA, "mutual-nda.txt")}
          >
            Load balanced NDA
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => runAnalysis(SAMPLE_RISKY, "one-sided-services.txt")}
          >
            Load high-risk draft
          </Button>
        </div>

        <label className="mt-5 block text-xs uppercase tracking-[0.14em] text-subtle">
          Or paste text
        </label>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          className="mt-2 w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg px-3 py-3 font-mono text-xs leading-relaxed text-fg outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]"
          placeholder="Paste contract language…"
        />
        <Button
          className="mt-3 w-full"
          disabled={!text.trim() || busy}
          onClick={() => runAnalysis(text, fileName)}
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : <FileText className="size-4" />}
          Analyze
        </Button>
        {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
      </section>

      <section className="min-h-[28rem] rounded-[var(--radius-xl)] border border-border bg-surface p-5 shadow-[var(--shadow-panel)] sm:p-6">
        {!result ? (
          <div className="flex h-full min-h-80 flex-col items-center justify-center text-center">
            <p className="font-display text-3xl text-fg">Awaiting a document</p>
            <p className="mt-2 max-w-sm text-sm text-muted">
              Load a sample or upload a contract to extract clauses, entities, and a signing score.
            </p>
          </div>
        ) : (
          <div>
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-[0.18em] text-subtle">{result.fileName}</p>
                <h2 className="mt-1 font-display text-3xl leading-none">{result.signing.label}</h2>
                <p className="mt-2 max-w-md text-sm text-muted">{result.signing.recommendation}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge tone={toneForScore(result.signing.percentage)}>
                    {result.signing.percentage} / 100
                  </Badge>
                  <Badge>{result.statistics.wordCount.toLocaleString()} words</Badge>
                  <Badge>{clauseEntries.length} clause types</Badge>
                  {result.detectedType ? (
                    <Badge tone="neutral">{result.detectedType.toUpperCase()}</Badge>
                  ) : null}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void (showHistory ? setShowHistory(false) : (refreshHistory(), setShowHistory(true)))}
                  >
                    <Clock className="size-4" />
                    History
                  </Button>
                  {showHistory ? (
                    <div className="absolute right-0 top-full z-50 mt-1 w-72 rounded-[var(--radius-lg)] border border-border bg-elevated p-2 shadow-lg">
                      {savedAnalyses.length === 0 ? (
                        <p className="px-2 py-3 text-center text-sm text-muted">No saved analyses yet.</p>
                      ) : (
                        <ul className="max-h-60 space-y-1 overflow-y-auto">
                          {savedAnalyses.map((s) => (
                            <li key={s.id} className="group flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-surface">
                              <button
                                type="button"
                                className="flex-1 text-left"
                                onClick={() => void onLoadSaved(s.id)}
                              >
                                <span className="text-sm text-fg">{s.fileName}</span>
                                <span className="ml-2 text-xs text-subtle">
                                  {s.score}/100 · {new Date(s.savedAt).toLocaleDateString()}
                                </span>
                              </button>
                              {s.hasOriginalFile ? (
                                <button
                                  type="button"
                                  title="Download original file"
                                  aria-label={`Download original file ${s.fileName}`}
                                  className="text-muted transition hover:text-fg"
                                  onClick={() => void onDownloadOriginal(s.id)}
                                >
                                  <Download className="size-3.5" />
                                </button>
                              ) : null}
                              <button
                                type="button"
                                title="Delete saved analysis"
                                aria-label={`Delete saved analysis ${s.fileName}`}
                                className="text-muted transition hover:text-danger"
                                onClick={() => void onDeleteSaved(s.id)}
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}
                </div>
                <Button variant="outline" size="sm" onClick={() => void onSave()} disabled={saveBusy || savedCurrent}>
                  {saveBusy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
                  {savedCurrent ? "Saved" : "Save"}
                </Button>
                <ScoreRing value={result.signing.percentage} />
              </div>
            </div>
            <p className="mt-3 text-right text-[10px] leading-4 text-subtle">Screening estimate from detected terms and missing clauses; verify flagged language before acting.</p>

            <div className="mt-6 flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-elevated p-1">
              {(
                [
                  ["summary", "Summary"],
                  ["clauses", "Clauses"],
                  ["entities", "Entities"],
                  ["risks", "Risks"],
                  ["chat", "Ask"],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={cn(
                    "h-10 flex-1 rounded-[var(--radius-sm)] px-3 text-sm transition-colors",
                    tab === id ? "bg-surface text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="mt-5">
              {tab === "summary" && (
                <div className="space-y-4">
                  <p className="text-sm leading-relaxed text-fg/90">{result.summary}</p>
                  <Button variant="outline" size="sm" onClick={() => void onRefine()} disabled={sumBusy || sumCooldown.isDisabled}>
                    {sumBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                    Refine with AI
                    {sumCooldown.cooldownRemaining > 0 ? ` (${sumCooldown.cooldownRemaining}s)` : ""}
                  </Button>
                  {aiSummary ? (
                    <div className="rounded-[var(--radius-md)] border border-border bg-bg p-4 text-sm whitespace-pre-wrap text-fg/90">
                      {aiSummary}
                    </div>
                  ) : null}
                </div>
              )}

              {tab === "clauses" && (
                <ul className="space-y-3">
                  {clauseEntries.map(([name, hits]) => (
                    <li key={name} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm capitalize text-fg">{name.replaceAll("_", " ")}</span>
                        <Badge>{hits.length}</Badge>
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-muted">{hits[0]?.excerpt}</p>
                    </li>
                  ))}
                </ul>
              )}

              {tab === "entities" && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {Object.entries(result.entities).map(([k, vals]) => (
                    <div key={k} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
                      <p className="text-[11px] uppercase tracking-[0.12em] text-subtle">
                        {k.replaceAll("_", " ")}
                      </p>
                      <ul className="mt-2 space-y-1">
                        {vals.slice(0, 8).map((v) => (
                          <li key={v} className="text-sm text-fg">
                            {v}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}

              {tab === "risks" && (
                <div>
                  <div className="mb-4 flex flex-wrap items-center gap-3">
                    <Button variant="outline" size="sm" onClick={() => void onReviewRisks()} disabled={reviewBusy || reviewCooldown.isDisabled}>
                      {reviewBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                      AI-verify &amp; discover
                      {reviewCooldown.cooldownRemaining > 0 ? ` (${reviewCooldown.cooldownRemaining}s)` : ""}
                    </Button>
                    <p className="text-xs text-subtle">
                      Verifies each keyword flag against its context, and separately scans the full text for
                      risks the keyword scanner's fixed pattern list would miss.
                    </p>
                  </div>
                  {reviewError ? <p className="mb-3 text-sm text-danger">{reviewError}</p> : null}

                  {aiFindings ? (
                    <div className="mb-5">
                      <p className="text-xs uppercase tracking-[0.14em] text-accent">
                        AI-discovered ({aiFindings.length})
                      </p>
                      {aiFindings.length === 0 ? (
                        <p className="mt-2 text-sm text-muted">Nothing beyond what the keyword scanner already flagged.</p>
                      ) : (
                        <ul className="mt-2 grid gap-2 md:grid-cols-2">
                          {aiFindings.map((f, i) => (
                            <li key={i} className="rounded-[var(--radius-md)] border border-accent/40 bg-bg p-3">
                              <div className="flex items-center justify-between gap-2">
                                <span
                                  className={cn(
                                    "text-xs font-medium uppercase tracking-[0.08em]",
                                    f.kind === "risk" ? "text-danger" : "text-ok",
                                  )}
                                >
                                  {f.kind === "risk" ? "Risk" : "Favorable"} · {f.severity}
                                </span>
                              </div>
                              <p className="mt-1 text-sm text-fg">{f.description}</p>
                              <p className="mt-1 text-xs italic text-subtle">“{f.excerpt}”</p>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-danger">Risk factors</p>
                      <ul className="mt-2 space-y-2">
                        {allFactors
                          .filter((f) => f.kind === "risk")
                          .map(({ index, factor }) => {
                            const v = verdicts?.get(index);
                            return (
                              <li key={factor.type} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
                                <p className="text-sm text-fg">{factor.description}</p>
                                <p className="mt-1 font-mono text-xs text-danger">{factor.weight}</p>
                                {v ? (
                                  <div className="mt-2 border-t border-border pt-2">
                                    <p className={cn("text-xs font-medium", VERDICT_STYLE[v.verdict].className)}>
                                      {VERDICT_STYLE[v.verdict].label} · {v.severity} severity
                                    </p>
                                    <p className="mt-1 text-xs text-muted">{v.note}</p>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                      </ul>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-ok">Favorable</p>
                      <ul className="mt-2 space-y-2">
                        {allFactors
                          .filter((f) => f.kind === "favorable")
                          .map(({ index, factor }) => {
                            const v = verdicts?.get(index);
                            return (
                              <li key={factor.type} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
                                <p className="text-sm text-fg">{factor.description}</p>
                                <p className="mt-1 font-mono text-xs text-ok">+{factor.weight}</p>
                                {v ? (
                                  <div className="mt-2 border-t border-border pt-2">
                                    <p className={cn("text-xs font-medium", VERDICT_STYLE[v.verdict].className)}>
                                      {VERDICT_STYLE[v.verdict].label} · {v.severity} severity
                                    </p>
                                    <p className="mt-1 text-xs text-muted">{v.note}</p>
                                  </div>
                                ) : null}
                              </li>
                            );
                          })}
                      </ul>
                      {result.signing.missingClauses.length ? (
                        <p className="mt-3 text-sm text-warn">
                          Missing: {result.signing.missingClauses.join(", ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}

              {tab === "chat" && (
                <div>
                  <div className="max-h-72 space-y-3 overflow-y-auto rounded-[var(--radius-md)] border border-border bg-bg p-3">
                    {chat.length === 0 ? (
                      <p className="text-sm text-muted">
                        Ask about parties, term, liability, or what is missing. Answers stay grounded in this document.
                      </p>
                    ) : (
                      chat.map((m, i) => (
                        <div key={i} className={cn("text-sm", m.role === "user" ? "text-accent" : "text-fg")}>
                          <span className="text-[10px] uppercase tracking-[0.14em] text-subtle">
                            {m.role === "user" ? "You" : "Aegis"}
                          </span>
                          <p className="mt-1 whitespace-pre-wrap leading-relaxed">{m.content}</p>
                        </div>
                      ))
                    )}
                    {chatBusy ? <p className="text-sm text-muted">Reading the document…</p> : null}
                  </div>
                  <div className="mt-3 flex gap-2">
                    <input
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void onAsk();
                      }}
                      className="h-11 flex-1 rounded-[var(--radius-sm)] border border-border bg-elevated px-3 text-sm outline-none focus:ring-2 focus:ring-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]"
                      placeholder="Who are the parties?"
                    />
                    <Button type="button" onClick={() => void onAsk()} disabled={chatBusy || !question.trim()}>
                      <MessageSquare className="size-4" />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
