import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
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
  assessLegalSoundness,
  discoverAdditionalFindings,
  lexaChat,
  refineSummary,
  reviewClauseCandidates,
  type AiFinding,
  type ClauseVerdict,
  type RiskScore,
  type AnalysisQuality,
  type LegalReviewResult,
} from "@/lib/legal/ai";
import { analyzeText, getMissingClauseNames, isLikelyLegalDocument } from "@/lib/legal/analyzer";
import { extractFileTextWithWarnings } from "@/lib/legal/extract";
import { SAMPLE_NDA, SAMPLE_RISKY } from "@/lib/legal/samples";
import type {
  AnalysisResult,
  Factor,
  Finding,
  FindingCategory,
  FindingSeverity,
  FindingStatus,
  ScoringBreakdown,
  SigningRecommendation,
} from "@/lib/legal/types";
import { cn } from "@/lib/utils";
import {
  saveAnalysis,
  listAnalyses,
  loadAnalysis,
  deleteAnalysis,
  loadOriginalFile,
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

const LEGAL_REVIEW_STATUS: Record<LegalReviewResult["status"], { label: string; tone: string }> = {
  high_risk: { label: "High-risk clauses found", tone: "text-danger" },
  needs_review: { label: "Needs legal review", tone: "text-warn" },
  no_major_issues_found: { label: "No major issues identified", tone: "text-ok" },
  insufficient_information: { label: "Unable to assess fully", tone: "text-warn" },
};

const LEGAL_ISSUE_KIND: Record<LegalReviewResult["issues"][number]["kind"], string> = {
  ambiguity: "Ambiguous wording",
  risk: "Potentially dangerous clause",
  one_sided: "One-sided term",
  missing_protection: "Missing protection",
};

function findingStatusBadge(status: FindingStatus): { tone: string; label: string } {
  switch (status) {
    case "confirmed":
      return { tone: "danger", label: "Confirmed" };
    case "possible":
      return { tone: "warn", label: "Possible" };
    case "uncertain":
      return { tone: "warn", label: "Uncertain" };
    case "not_applicable":
      return { tone: "neutral", label: "N/A" };
    default:
      return { tone: "subtle", label: "—" };
  }
}

function findingSeverityLabel(severity: FindingSeverity): string {
  const labels: Record<FindingSeverity, string> = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    informational: "Info",
  };
  return labels[severity];
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
  const [extractionWarnings, setExtractionWarnings] = useState<string[]>([]);
  const [tab, setTab] = useState<"summary" | "clauses" | "entities" | "risks" | "source" | "chat" | "breakdown">("summary");
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
  const [legalReview, setLegalReview] = useState<LegalReviewResult | null>(null);
  const [legalReviewBusy, setLegalReviewBusy] = useState(false);
  const [legalReviewError, setLegalReviewError] = useState<string | null>(null);
  const [selectedIssueIndex, setSelectedIssueIndex] = useState<number | null>(null);
  const [savedAnalyses, setSavedAnalyses] = useState<SavedAnalysisSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [saveBusy, setSaveBusy] = useState(false);
  const [originalFile, setOriginalFile] = useState<File | null>(null);
  const legalReviewRequest = useRef(0);
  const [savedCurrent, setSavedCurrent] = useState(false);
  const reviewCooldown = useAiCooldown();
  const sumCooldown = useAiCooldown();

  const clauseEntries = useMemo(
    () => (result ? Object.entries(result.clauses).sort((a, b) => b[1].length - a[1].length) : []),
    [result],
  );

  // Stable indexed list of findings for verdict matching
  const allFindings = useMemo(() => {
    if (!result) return [] as Finding[];
    return result.findings;
  }, [result]);

  // Factors for backward-compatible UI
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

  const riskScore = result?.signing.riskScore;
  const analysisQuality = riskScore?.analysisQuality;

  async function runLegalReview(documentText: string) {
    const requestId = ++legalReviewRequest.current;
    setLegalReview(null);
    setLegalReviewError(null);
    setSelectedIssueIndex(null);
    setLegalReviewBusy(true);
    try {
      const response = await assessLegalSoundness({ data: { documentText } });
      if (requestId !== legalReviewRequest.current) return;
      if (response.ok) setLegalReview(response.review);
      else setLegalReviewError(response.error);
    } catch (cause) {
      if (requestId === legalReviewRequest.current) {
        setLegalReviewError(
          cause instanceof Error ? cause.message : "The legal review could not complete. Try again.",
        );
      }
    } finally {
      if (requestId === legalReviewRequest.current) setLegalReviewBusy(false);
    }
  }

  useEffect(() => {
    if (tab !== "source" || selectedIssueIndex === null) return;
    document.getElementById(`source-issue-${selectedIssueIndex}`)?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, [tab, selectedIssueIndex]);

  async function onFile(file: File) {
    setError(null);
    setExtractionWarnings([]);
    setBusy(true);
    legalReviewRequest.current += 1;
    setLegalReview(null);
    setLegalReviewError(null);
    try {
      if (!/\.(pdf|docx|txt|md|png|jpe?g|webp|tiff?)$/i.test(file.name)) {
        throw new Error("Upload a legal document as PDF, DOCX, TXT, JPG, PNG, or WebP.");
      }
      const extraction = await extractFileTextWithWarnings(file);
      const extracted = extraction.text;
      setExtractionWarnings(extraction.warnings);
      if (!isLikelyLegalDocument(extracted)) {
        throw new Error("We could not find enough legal language in this file. Check the image is readable and upload a legal document.");
      }
      setText(extracted);
      setFileName(file.name);
      setOriginalFile(file);
      const analysis = analyzeText(extracted, file.name);
      setResult(analysis);
      void runLegalReview(extracted);
      setSavedCurrent(false);
      onDocumentLoaded?.(extracted, file.name);
      setAiSummary(null);
      setChat([]);
      setAnalysisChatThreadId(undefined);
      setVerdicts(null);
      setAiFindings(null);
      setReviewError(null);
      setTab("summary");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read that file.");
    } finally {
      setBusy(false);
    }
  }

  function runAnalysis(source: string, name: string) {
    setError(null);
    setExtractionWarnings([]);
    if (!isLikelyLegalDocument(source)) {
      setError("This workspace analyzes legal documents. Add legal text before starting an analysis.");
      return;
    }
    setOriginalFile(null);
    setFileName(name);
    setText(source);
    setResult(analyzeText(source, name));
    void runLegalReview(source);
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
          isRisk: f.factor.isRisk,
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
      void runLegalReview(loaded.cleanedText);
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

  // Helper: convert new-format findings to legacy Factor arrays for UI compatibility
  const legacyFactors = useMemo(() => {
    if (!result) return { favorable: [], risks: [] };
    const legacyFavorable: Factor[] = [];
    const legacyRisks: Factor[] = [];
    if (result.signing.findings.favorable) {
      result.signing.findings.favorable.forEach((f: any) => {
        legacyFavorable.push({
          type: f.id,
          description: f.description,
          weight: f.weight,
          matches: f.evidence?.length,
          examples: f.evidence?.slice(0, 2).map((e: any) => e.excerpt),
          isRisk: f.isRisk,
        });
      });
    }
    if (result.signing.findings.risks) {
      result.signing.findings.risks.forEach((f: any) => {
        legacyRisks.push({
          type: f.id,
          description: f.description,
          weight: -f.weight,
          matches: f.evidence?.length,
          examples: f.evidence?.slice(0, 2).map((e: any) => e.excerpt),
          isRisk: f.isRisk,
        });
      });
    }
    return { favorable: legacyFavorable, risks: legacyRisks };
  }, [result]);

  const sourceSegments = useMemo(() => {
    if (!result) return [] as { text: string; issue?: LegalReviewResult["issues"][number]; index?: number }[];
    const segments: { text: string; issue?: LegalReviewResult["issues"][number]; index?: number }[] = [];
    const issues = (legalReview?.issues ?? [])
      .map((issue, index) => ({ issue, index }))
      .filter(({ issue }) => issue.evidence.start >= 0 && issue.evidence.end <= result.cleanedText.length)
      .sort((a, b) => a.issue.evidence.start - b.issue.evidence.start);
    let cursor = 0;
    for (const { issue, index } of issues) {
      const { start, end } = issue.evidence;
      if (start < cursor || end <= start) continue;
      if (start > cursor) segments.push({ text: result.cleanedText.slice(cursor, start) });
      segments.push({ text: result.cleanedText.slice(start, end), issue, index });
      cursor = end;
    }
    if (cursor < result.cleanedText.length) segments.push({ text: result.cleanedText.slice(cursor) });
    if (segments.length === 0) segments.push({ text: result.cleanedText });
    return segments;
  }, [result, legalReview]);

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
          Upload or paste a legal document. Aegis checks the text, assesses legal soundness risks, and highlights ambiguous or one-sided clauses for review.
        </p>
        <p className="mt-2 rounded-lg bg-accent-soft/70 px-3 py-2 text-[11px] leading-5 text-muted">
          AI reviews send extracted document text to the configured AI provider. Analyses are saved only when you choose Save; with sign-in off, saved items stay in this browser profile and are not synced or encrypted by Aegis.
        </p>

        <label
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const dropped = event.dataTransfer.files[0];
            if (dropped) void onFile(dropped);
          }}
          className={cn("mt-4 flex min-h-36 flex-col items-center justify-center rounded-[var(--radius-lg)] border border-dashed border-border-strong bg-elevated px-4 py-8 text-center transition-colors", busy ? "cursor-not-allowed opacity-65" : "cursor-pointer hover:border-accent")}
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
            disabled={busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
        </label>

        {extractionWarnings.length > 0 && (
          <div role="status" className="mt-3 space-y-1 rounded-xl border border-warn/40 bg-warn/10 p-3 text-xs leading-5 text-fg">
            <p className="font-semibold text-warn">Check extraction completeness</p>
            {extractionWarnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        )}

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
          onChange={(e) => {
            setText(e.target.value);
            setExtractionWarnings([]);
          }}
          rows={10}
          className="mt-2 w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg px-3 py-3 font-mono text-xs leading-relaxed text-fg outline-none focus:ring-2 focus-ring-[color-mix(in_oklab,var(--color-accent)_45%,transparent)]"
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
                <h2 className="mt-1 font-display text-3xl leading-none">{result.signing.riskScore.label}</h2>
                <p className="mt-2 max-w-md text-sm text-muted">{result.signing.riskScore.value}/100 risk</p>
                <p className="mt-2 max-w-md text-sm text-muted">{result.signing.safetyLabel}: {result.signing.safetyRecommendation}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Badge tone={toneForScore(result.signing.riskScore.value)}>
                    {result.signing.riskScore.value} / 100
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
                <ScoreRing value={result.signing.riskScore.value} />
              </div>
            </div>
            <p className="mt-3 text-right text-[10px] leading-4 text-subtle">Risk screening estimate from detected terms and missing clauses; verify flagged language before acting.</p>

            <div className="mt-6 flex flex-wrap gap-1 rounded-[var(--radius-md)] bg-elevated p-1">
              {(
                [
                  ["summary", "Summary"],
                  ["clauses", "Clauses"],
                  ["entities", "Entities"],
                  ["risks", "Risks"],
                  ["source", "Highlights"],
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
                  <section className="rounded-[var(--radius-md)] border border-border bg-bg p-4" aria-live="polite">
                    <div className="flex items-start gap-3">
                      {legalReviewBusy ? (
                        <Loader2 className="mt-0.5 size-5 shrink-0 animate-spin text-accent" />
                      ) : legalReview?.status === "no_major_issues_found" ? (
                        <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-ok" />
                      ) : (
                        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warn" />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-subtle">
                          AI legal review
                        </p>
                        <h3 className={cn("mt-1 text-base font-semibold", legalReview && LEGAL_REVIEW_STATUS[legalReview.status].tone)}>
                          {legalReviewBusy
                            ? "Reviewing ambiguities and risky clauses…"
                            : legalReview
                              ? LEGAL_REVIEW_STATUS[legalReview.status].label
                              : legalReviewError
                                ? "Legal review could not complete"
                                : "Preparing the legal review…"}
                        </h3>
                        {legalReview && (
                          <>
                            <p className="mt-2 text-sm leading-6 text-fg/90">{legalReview.summary}</p>
                            <p className="mt-2 text-xs text-muted">
                              {legalReview.issues.length} material issue{legalReview.issues.length === 1 ? "" : "s"} found
                              {legalReview.confidence > 0 ? ` · AI confidence ${Math.round(legalReview.confidence * 100)}%` : ""}
                            </p>
                            {legalReview.issues.length > 0 && (
                              <ul className="mt-3 space-y-2">
                                {legalReview.issues.slice(0, 4).map((issue, index) => (
                                  <li key={`${issue.evidence.start}-${issue.kind}`}>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSelectedIssueIndex(index);
                                        setTab("source");
                                      }}
                                      className="w-full rounded-lg border border-border bg-surface p-3 text-left transition hover:border-accent"
                                    >
                                      <span className={cn(
                                        "text-[10px] font-semibold uppercase tracking-[0.1em]",
                                        issue.severity === "critical" || issue.severity === "high" ? "text-danger" : "text-warn",
                                      )}>
                                        {LEGAL_ISSUE_KIND[issue.kind]} · {issue.severity}
                                      </span>
                                      <span className="mt-1 block text-sm font-medium text-fg">{issue.title}</span>
                                      <span className="mt-1 block text-xs leading-5 text-muted">{issue.explanation}</span>
                                    </button>
                                  </li>
                                ))}
                              </ul>
                            )}
                            {legalReview.issues.length > 0 && (
                              <Button
                                className="mt-3"
                                variant="outline"
                                size="sm"
                                onClick={() => setTab("source")}
                              >
                                View highlighted clauses
                              </Button>
                            )}
                          </>
                        )}
                        {legalReviewError && (
                          <div className="mt-2 flex flex-wrap items-center gap-3">
                            <p role="alert" className="text-sm text-danger">{legalReviewError}</p>
                            <Button variant="outline" size="sm" onClick={() => void runLegalReview(result.cleanedText)}>
                              Retry review
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                    <p className="mt-3 border-t border-border pt-3 text-[11px] leading-5 text-subtle">
                      Automated issue-spotting only. “No major issues identified” does not establish legal validity or guarantee enforceability; consult qualified counsel for your jurisdiction.
                    </p>
                  </section>
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

              {tab === "source" && (
                <div className="space-y-4">
                  <div>
                    <h3 className="text-sm font-semibold text-fg">Original document and evidence</h3>
                    <p className="mt-1 text-xs leading-5 text-muted">
                      Highlighted passages are exact excerpts from the extracted document text. Select a finding to jump to its source.
                    </p>
                  </div>
                  {legalReviewBusy && (
                    <p className="flex items-center gap-2 text-sm text-muted">
                      <Loader2 className="size-4 animate-spin" /> AI review is still in progress.
                    </p>
                  )}
                  {legalReview && legalReview.issues.length > 0 ? (
                    <ol className="space-y-3">
                      {legalReview.issues.map((issue, index) => (
                        <li key={`${issue.evidence.start}-${issue.kind}`}>
                          <article className={cn(
                            "rounded-[var(--radius-md)] border bg-bg p-4",
                            selectedIssueIndex === index ? "border-accent" : "border-border",
                          )}>
                            <button
                              type="button"
                              onClick={() => setSelectedIssueIndex(index)}
                              className="w-full text-left"
                            >
                              <span className={cn(
                                "text-[10px] font-semibold uppercase tracking-[0.1em]",
                                issue.severity === "critical" || issue.severity === "high" ? "text-danger" : "text-warn",
                              )}>
                                {LEGAL_ISSUE_KIND[issue.kind]} · {issue.severity}
                              </span>
                              <span className="mt-1 block text-sm font-semibold text-fg">{issue.title}</span>
                            </button>
                            <blockquote className="mt-3 border-l-2 border-accent pl-3 text-sm italic leading-6 text-fg/90">
                              “{issue.excerpt}”
                            </blockquote>
                            <p className="mt-3 text-sm leading-6 text-muted">{issue.explanation}</p>
                            <p className="mt-2 text-xs leading-5 text-subtle"><strong className="text-fg">Potential impact:</strong> {issue.impact}</p>
                            <p className="mt-2 text-xs leading-5 text-subtle"><strong className="text-fg">Consider:</strong> {issue.recommendation}</p>
                          </article>
                        </li>
                      ))}
                    </ol>
                  ) : !legalReviewBusy && (
                    <p className="rounded-[var(--radius-md)] border border-border bg-bg p-4 text-sm text-muted">
                      {legalReview?.status === "no_major_issues_found"
                        ? "No material passages were flagged by this automated review. This is not a guarantee that the document is safe or legally sound."
                        : legalReviewError
                          ? "The legal review did not complete. Retry it from the Summary tab."
                          : "No verifiable source passages are available for this review."}
                    </p>
                  )}
                  <div className="max-h-[32rem] overflow-auto rounded-[var(--radius-md)] border border-border bg-bg p-4">
                    <pre className="whitespace-pre-wrap break-words font-sans text-sm leading-7 text-fg/90">
                      {sourceSegments.map((segment, i) => segment.issue ? (
                        <mark
                          key={`source-${segment.index}`}
                          id={`source-issue-${segment.index}`}
                          title={`${LEGAL_ISSUE_KIND[segment.issue.kind]}: ${segment.issue.title}`}
                          onClick={() => setSelectedIssueIndex(segment.index ?? null)}
                          className={cn(
                            "cursor-pointer rounded-sm px-0.5 text-fg",
                            segment.issue.severity === "critical" || segment.issue.severity === "high"
                              ? "bg-danger/25"
                              : "bg-warn/30",
                            selectedIssueIndex === segment.index && "ring-2 ring-accent",
                          )}
                        >
                          {segment.text}
                        </mark>
                      ) : <span key={`source-text-${i}`}>{segment.text}</span>)}
                    </pre>
                  </div>
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
                      AI-verify & discover
                      {reviewCooldown.cooldownRemaining > 0 ? ` (${reviewCooldown.cooldownRemaining}s)` : ""}
                    </Button>
                    <p className="text-xs text-subtle">
                      Verifies each keyword flag against its context, and separately scans the full text for
                      risks the keyword scanner's fixed pattern list would miss.
                    </p>
                  </div>
                  {reviewError ? <p className="mb-3 text-sm text-danger">{reviewError}</p> : null}

                  {/* AI-discovered findings from LLM-native discovery */}
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

                  {/* Risk factors from regex analysis */}
                  <div className="grid gap-4 md:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-[0.14em] text-danger">Risk factors</p>
                      <ul className="mt-2 space-y-2">
                        {allFactors
                          .filter((f) => f.kind === "risk")
                          .map(({ index, factor }) => {
                            const v = verdicts?.get(index);
                            return (
                              <li key={`${index}-${factor.type}`} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
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
                              <li key={`${index}-${factor.type}`} className="rounded-[var(--radius-md)] border border-border bg-bg p-3">
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
                      {getMissingClauseNames(result.signing.missingClauses).length ? (
                        <p className="mt-3 text-sm text-warn">
                          Missing: {getMissingClauseNames(result.signing.missingClauses).join(", ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}

              {/* NEW: Scoring Breakdown Panel */}
              {tab === "breakdown" && result && (
                <div className="mt-5 space-y-4">
                  <h3 className="text-xs uppercase tracking-[0.14em] text-fg">Risk Score Breakdown</h3>
                  
                  <div className="rounded-[var(--radius-md)] border border-border bg-bg p-4">
                    <p className="text-sm font-medium">Final Risk Score: {result.signing.riskScore.value}/100</p>
                    <p className="text-sm text-muted">{result.signing.riskScore.label}</p>
                    <p className="mt-2 text-xs">Safety Score: {result.signing.safetyScore}/100 ({result.signing.safetyLabel})</p>
                  </div>
                  
                  {/* Risk Penalties */}
                  {result.signing.riskScore.breakdown.riskPenalties.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.1em] text-danger">Risk Penalties</p>
                      <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                        {result.signing.riskScore.breakdown.riskPenalties.map((p) => (
                          <li key={p.findingId} className="flex items-start gap-2 p-1 rounded bg-surface/50">
                            <span className="text-[10px] capitalize text-danger">{p.reason}</span>
                            <span className="ml-auto text-danger font-mono text-xs">{p.penalty}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {/* Favorable Contributions */}
                  {result.signing.riskScore.breakdown.favorableContributions.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.1em] text-ok">Favorable Provisions</p>
                      <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                        {result.signing.riskScore.breakdown.favorableContributions.map((c) => (
                          <li key={c.findingId} className="flex items-start gap-2 p-1 rounded bg-surface/50">
                            <span className="text-[10px] capitalize text-ok">{c.reason}</span>
                            <span className="ml-auto text-ok font-mono text-xs">{c.contribution}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {/* Missing Clause Penalties */}
                  {result.signing.riskScore.breakdown.missingClausePenalties.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.1em] text-warn">Missing Clause Penalties</p>
                      <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                        {result.signing.riskScore.breakdown.missingClausePenalties.map((m) => (
                          <li key={m.clauseId} className="flex items-start gap-2 p-1 rounded bg-surface/50">
                            <span className="text-[10px] capitalize text-warn">{m.reason}</span>
                            <span className="ml-auto text-warn font-mono text-xs">{m.penalty}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  
                  {/* Adjustments */}
                  {result.signing.riskScore.breakdown.adjustments.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.1em] text-subtle">Adjustments</p>
                      <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                        {result.signing.riskScore.breakdown.adjustments.map((a) => (
                          <li key={a.name} className="flex items-start gap-2 p-1 rounded bg-surface/50">
                            <span className="text-[10px] capitalize text-subtle">{a.name}: {a.value >= 0 ? `+${a.value}` : a.value}</span>
                            <span className="ml-auto text-subtle font-mono text-xs">{a.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {tab === "breakdown" && result && (
                <div className="mt-5">
                  <h3 className="text-xs uppercase tracking-[0.14em] text-fg">Analysis Quality</h3>
                  <div className="rounded-[var(--radius-md)] border border-border bg-bg p-4">
                    <p className="text-sm font-medium">{analysisQuality?.label}</p>
                    <p className="text-xs text-muted mt-1">{analysisQuality?.explanation}</p>
                    <div className="mt-3 space-y-2">
                      {analysisQuality?.signals.map((signal) => (
                        <div key={signal.name} className="flex items-start gap-2 text-xs">
                          <span className={cn("w-2 rounded-full", {
                            good: "bg-ok",
                            warning: "bg-warn",
                            poor: "bg-danger",
                          })} ml-1 />
                          <span className="text-[10px] capitalize text-subtle">{signal.name}</span>
                          <span className="ml-auto text-subtle">{signal.value}</span>
                          <span className="ml-2 text-xs capitalize text-fg/{signal.status}">{signal.status}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              {tab === "summary" && (
                <Button variant="outline" size="sm" onClick={() => void onRefine()} disabled={sumBusy || sumCooldown.isDisabled}>
                  {sumBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  Refine with AI
                  {sumCooldown.cooldownRemaining > 0 ? ` (${sumCooldown.cooldownRemaining}s)` : ""}
                </Button>
              )}

              {tab === "clauses" && (
                <Button variant="outline" size="sm" onClick={() => void onReviewRisks()} disabled={reviewBusy || reviewCooldown.isDisabled}>
                  {reviewBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
                  AI-verify & discover
                  {reviewCooldown.cooldownRemaining > 0 ? ` (${reviewCooldown.cooldownRemaining}s)` : ""}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}