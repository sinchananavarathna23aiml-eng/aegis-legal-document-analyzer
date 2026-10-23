import { useState } from "react";
import { FileText, GitCompareArrows, Loader2, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScoreRing } from "@/components/score-ring";
import { analyzeText, compareAnalyses } from "@/lib/legal/analyzer";
import { extractFileTextWithWarnings } from "@/lib/legal/extract";
import { SAMPLE_NDA, SAMPLE_RISKY } from "@/lib/legal/samples";
import { compareWithAi } from "@/lib/legal/ai";
import { useAiCooldown } from "@/lib/hooks/ai-cooldown";
import type { ComparisonResult } from "@/lib/legal/types";

export function ComparePanel() {
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [leftName, setLeftName] = useState("");
  const [rightName, setRightName] = useState("");
  const [leftWarnings, setLeftWarnings] = useState<string[]>([]);
  const [rightWarnings, setRightWarnings] = useState<string[]>([]);
  const [pasteMode, setPasteMode] = useState(false);
  const [extracting, setExtracting] = useState<"A" | "B" | null>(null);
  const [inputError, setInputError] = useState<string | null>(null);
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const aiCooldown = useAiCooldown();

  async function attachFile(file: File, side: "A" | "B") {
    setInputError(null);
    if (side === "A") setLeftWarnings([]);
    else setRightWarnings([]);
    setExtracting(side);
    try {
      const extraction = await extractFileTextWithWarnings(file);
      const extracted = extraction.text;
      if (!extracted.trim()) throw new Error(`No readable text was found in ${file.name}.`);
      if (side === "A") {
        setLeft(extracted);
        setLeftName(file.name);
        setLeftWarnings(extraction.warnings);
      } else {
        setRight(extracted);
        setRightName(file.name);
        setRightWarnings(extraction.warnings);
      }
      setResult(null);
      setAiExplanation(null);
      setAiError(null);
    } catch (cause) {
      setInputError(cause instanceof Error ? cause.message : "Could not read that file. Try another document.");
    } finally {
      setExtracting(null);
    }
  }

  function run() {
    if (!left.trim() || !right.trim()) {
      setInputError("Attach or enter text for both documents before comparing.");
      return;
    }
    setInputError(null);
    const a = analyzeText(left, leftName || "Document A");
    const b = analyzeText(right, rightName || "Document B");
    const diff = compareAnalyses(a, b);
    setResult({ doc1: a, doc2: b, ...diff });
    setAiExplanation(null);
    setAiError(null);
  }

  async function onAiCompare() {
    if (!result) return;
    setAiBusy(true);
    setAiError(null);
    try {
      const res = await compareWithAi({
        data: {
          docA: result.doc1.cleanedText,
          docB: result.doc2.cleanedText,
          fileNameA: result.doc1.fileName,
          fileNameB: result.doc2.fileName,
        },
      });
      if (res.ok) {
        setAiExplanation(res.explanation);
        aiCooldown.startCooldown();
      } else {
        setAiError(res.error);
      }
    } catch {
      setAiError("AI comparison could not complete. Try again.");
    } finally {
      setAiBusy(false);
    }
  }

  function loadExampleComparison() {
    setLeft(SAMPLE_NDA);
    setRight(SAMPLE_RISKY);
    setLeftName("Example mutual NDA");
    setRightName("Example one-sided services agreement");
    setLeftWarnings([]);
    setRightWarnings([]);
    setPasteMode(true);
    setResult(null);
    setAiExplanation(null);
    setAiError(null);
    setInputError(null);
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        {(["A", "B"] as const).map((side) => {
          const name = side === "A" ? leftName : rightName;
          const value = side === "A" ? left : right;
          const setValue = side === "A" ? setLeft : setRight;
          const warnings = side === "A" ? leftWarnings : rightWarnings;
          return (
            <section key={side} className="rounded-[var(--radius-xl)] border border-border bg-surface p-5">
              <p className="text-[11px] uppercase tracking-[0.16em] text-subtle">Document {side}</p>
              {pasteMode ? (
                <textarea
                  aria-label={`Document ${side} text`}
                  value={value}
                  onChange={(event) => {
                    setValue(event.target.value);
                    if (side === "A") setLeftName("");
                    else setRightName("");
                    if (side === "A") setLeftWarnings([]);
                    else setRightWarnings([]);
                    setResult(null);
                    setInputError(null);
                  }}
                  rows={12}
                  placeholder="Paste the document text here…"
                  className="mt-3 w-full resize-y rounded-[var(--radius-md)] border border-border bg-bg p-3 font-mono text-xs text-fg outline-none"
                />
              ) : (
                <label className="mt-3 flex min-h-40 cursor-pointer flex-col items-center justify-center rounded-[var(--radius-md)] border border-dashed border-border bg-bg px-4 py-6 text-center transition hover:border-accent">
                  <input
                    type="file"
                    accept=".pdf,.docx,.txt,.md,.png,.jpg,.jpeg,.webp,.tif,.tiff"
                    className="sr-only"
                    aria-label={`Attach document ${side}`}
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0];
                      event.currentTarget.value = "";
                      if (file) void attachFile(file, side);
                    }}
                  />
                  {extracting === side ? (
                    <Loader2 className="size-6 animate-spin text-accent" />
                  ) : name ? (
                    <FileText className="size-6 text-accent" />
                  ) : (
                    <Upload className="size-6 text-accent" />
                  )}
                  <span className="mt-3 max-w-full truncate text-sm font-medium text-fg">
                    {extracting === side ? "Reading attachment…" : name || "Choose a document"}
                  </span>
                  <span className="mt-1 text-xs text-muted">
                    {name ? `${value.length.toLocaleString()} characters extracted · Choose another to replace` : "PDF, DOCX, TXT, Markdown, or image"}
                  </span>
                </label>
              )}
              {warnings.length > 0 && (
                <div role="status" className="mt-3 rounded-lg border border-warn/40 bg-warn/10 p-3 text-xs leading-5 text-fg">
                  <p className="font-semibold text-warn">Check extraction completeness</p>
                  {warnings.map((warning) => <p key={warning} className="mt-1">{warning}</p>)}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted">Attachments are read in your browser to extract text for comparison.</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={loadExampleComparison}
            className="min-h-10 rounded-lg px-3 text-sm font-medium text-accent transition hover:bg-accent-soft"
          >
            Try sample comparison
          </button>
          <button
            type="button"
            onClick={() => {
              setPasteMode((current) => {
                if (current) {
                  setLeft("");
                  setRight("");
                  setLeftName("");
                  setRightName("");
                  setLeftWarnings([]);
                  setRightWarnings([]);
                }
                return !current;
              });
              setResult(null);
              setInputError(null);
            }}
            className="min-h-10 rounded-lg px-3 text-sm font-medium text-accent transition hover:bg-accent-soft"
          >
            {pasteMode ? "Use attachments instead" : "Paste text instead"}
          </button>
        </div>
      </div>
      <p className="text-[11px] leading-5 text-muted">
        If you choose AI Explain Differences, both documents’ extracted text are sent to the configured AI provider.
      </p>
      {inputError ? <p role="alert" className="text-sm text-danger">{inputError}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button onClick={run} disabled={extracting !== null || !left.trim() || !right.trim()} className="w-full sm:w-auto">
          <GitCompareArrows className="size-4" />
          Compare
        </Button>
        {result ? (
          <Button
            variant="outline"
            onClick={() => void onAiCompare()}
            disabled={aiBusy || aiCooldown.isDisabled}
            className="w-full sm:w-auto"
          >
            {aiBusy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            AI Explain Differences
            {aiCooldown.cooldownRemaining > 0 ? ` (${aiCooldown.cooldownRemaining}s)` : ""}
          </Button>
        ) : null}
      </div>

      {result ? (
        <div className="rounded-[var(--radius-xl)] border border-border bg-surface p-5 sm:p-6">
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[11px] uppercase tracking-[0.16em] text-subtle">Overlap</p>
              <p className="font-display text-4xl tabular-nums">{result.similarity}%</p>
              <p className="mt-1 text-sm text-muted">Lexical similarity of significant terms.</p>
            </div>
            <div className="flex gap-8">
              <div className="text-center">
                <ScoreRing value={result.doc1.signing.percentage} size={108} />
                <p className="mt-2 text-xs text-muted">A · {result.doc1.signing.label}</p>
              </div>
              <div className="text-center">
                <ScoreRing value={result.doc2.signing.percentage} size={108} />
                <p className="mt-2 text-xs text-muted">B · {result.doc2.signing.label}</p>
              </div>
            </div>
          </div>

          {aiError ? <p className="mt-4 text-sm text-danger">{aiError}</p> : null}
          {aiExplanation ? (
            <div className="mt-4 rounded-[var(--radius-md)] border border-accent/40 bg-bg p-4">
              <p className="text-xs uppercase tracking-[0.14em] text-accent">AI Analysis</p>
              <div className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-fg/90">
                {aiExplanation}
              </div>
            </div>
          ) : null}

          <h3 className="mt-8 text-xs uppercase tracking-[0.16em] text-subtle">Critical differences</h3>
          <ul className="mt-3 space-y-2">
            {result.critical.map((c) => (
              <li key={c.title} className="flex items-start justify-between gap-3 rounded-[var(--radius-md)] border border-border bg-bg p-3">
                <div>
                  <p className="text-sm text-fg">{c.title}</p>
                  <p className="mt-1 text-xs text-muted">{c.detail}</p>
                </div>
                <Badge tone={c.severity === "high" ? "danger" : c.severity === "medium" ? "warn" : "neutral"}>
                  {c.severity}
                </Badge>
              </li>
            ))}
          </ul>

          <h3 className="mt-8 text-xs uppercase tracking-[0.16em] text-subtle">Clause coverage</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[28rem] text-left text-sm">
              <thead className="text-xs uppercase tracking-[0.12em] text-subtle">
                <tr>
                  <th className="py-2 font-medium">Clause</th>
                  <th className="py-2 font-medium">A</th>
                  <th className="py-2 font-medium">B</th>
                  <th className="py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {result.clauseDiff.map((row) => (
                  <tr key={row.name} className="border-t border-border">
                    <td className="py-2 capitalize">{row.name.replaceAll("_", " ")}</td>
                    <td className="py-2 tabular-nums">{row.in1}</td>
                    <td className="py-2 tabular-nums">{row.in2}</td>
                    <td className="py-2">
                      <Badge
                        tone={row.status === "both" ? "ok" : "warn"}
                      >
                        {row.status === "both" ? "both" : row.status === "only1" ? "A only" : "B only"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
