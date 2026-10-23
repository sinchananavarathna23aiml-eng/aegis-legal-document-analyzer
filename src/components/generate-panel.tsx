import { useState } from "react";
import { Download, FileText, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { draftContract } from "@/lib/legal/ai";
import { parseDraft, type DraftRun } from "@/lib/legal/draft-format";
import { CONTRACT_META } from "@/lib/legal/templates";
import type { ContractType } from "@/lib/legal/types";
import { cn } from "@/lib/utils";

const TYPES: ContractType[] = ["nda", "service", "freelance", "employment", "general"];

function pdfSafeText(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[—–]/g, "-")
    .replace(/…/g, "...")
    .replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
}

export function GeneratePanel() {
  const [type, setType] = useState<ContractType>("nda");
  const [prompt, setPrompt] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function generate() {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    setDraft("");
    try {
      const result = await draftContract({ data: { type, prompt: prompt.trim() } });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDraft(result.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Lexa could not draft the document. Try again.");
    } finally {
      setBusy(false);
    }
  }

  async function downloadPdf() {
    if (!draft) return;
    setError("");
    try {
      const { jsPDF } = await import("jspdf");
      const pdf = new jsPDF({ unit: "mm", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const margin = 20;
      const contentWidth = pageWidth - margin * 2;
      const footerY = pageHeight - 12;
      let y = 23;

      pdf.setFont("helvetica", "bold");
      pdf.setFontSize(17);
      pdf.text(CONTRACT_META[type].title, margin, y);
      y += 8;
      pdf.setFont("helvetica", "normal");
      pdf.setFontSize(8);
      pdf.setTextColor(105, 112, 120);
      pdf.text("AI-GENERATED WORKING DRAFT - REVIEW BEFORE USE", margin, y);
      y += 10;
      pdf.setDrawColor(220, 224, 220);
      pdf.line(margin, y - 4, pageWidth - margin, y - 4);
      pdf.setTextColor(30, 34, 33);
      const paragraphs = parseDraft(draft);
      for (const paragraph of paragraphs) {
        const lines: DraftRun[][] = [];
        let line: DraftRun[] = [];
        let lineWidth = 0;
        for (const run of paragraph.runs) {
          const chunks = run.text.match(/\s+|\S+/g) ?? [];
          for (const chunk of chunks) {
            const text = pdfSafeText(chunk);
            if (!text) continue;
            pdf.setFont("helvetica", run.bold || paragraph.heading ? "bold" : "normal");
            pdf.setFontSize(paragraph.heading ? 10.5 : 10);
            const width = pdf.getTextWidth(text);
            if (lineWidth + width > contentWidth && line.length > 0) {
              while (line.length && !line.at(-1)?.text.trim()) line.pop();
              lines.push(line);
              line = [];
              lineWidth = 0;
              if (!text.trim()) continue;
            }
            if (!line.length && !text.trim()) continue;
            const last = line.at(-1);
            if (last?.bold === (run.bold || paragraph.heading)) last.text += text;
            else line.push({ text, bold: run.bold || paragraph.heading });
            lineWidth += width;
          }
        }
        while (line.length && !line.at(-1)?.text.trim()) line.pop();
        if (line.length) lines.push(line);

        for (const wrappedLine of lines) {
          if (y > footerY - 8) {
            pdf.addPage();
            y = 22;
          }
          let x = margin;
          for (const run of wrappedLine) {
            pdf.setFont("helvetica", run.bold ? "bold" : "normal");
            pdf.setFontSize(paragraph.heading ? 10.5 : 10);
            pdf.text(run.text, x, y);
            x += pdf.getTextWidth(run.text);
          }
          y += paragraph.heading ? 5.5 : 5;
        }
        y += paragraph.heading ? 1 : 2;
      }

      const pageCount = pdf.getNumberOfPages();
      for (let page = 1; page <= pageCount; page += 1) {
        pdf.setPage(page);
        pdf.setFont("helvetica", "normal");
        pdf.setFontSize(8);
        pdf.setTextColor(115, 120, 118);
        pdf.text(
          "AI-generated working draft. Have qualified counsel review before signing.",
          margin,
          footerY,
        );
        pdf.text(`${page} / ${pageCount}`, pageWidth - margin, footerY, { align: "right" });
      }

      pdf.save(`${type}-draft.pdf`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The PDF could not be created. Try again.");
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="rounded-[var(--radius-xl)] border border-border bg-surface p-5 sm:p-6">
        <p className="text-[11px] uppercase tracking-[0.16em] text-subtle">AI document studio</p>
        <h2 className="mt-1 font-display text-3xl leading-none">Draft a document</h2>
        <p className="mt-2 text-sm leading-6 text-muted">
          Choose a starting type, then tell Lexa what you need in your own words.
        </p>

        <div className="mt-5 grid grid-cols-2 gap-2">
          {TYPES.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => {
                setType(item);
                setDraft("");
                setError("");
              }}
              aria-pressed={type === item}
              className={cn(
                "min-h-16 rounded-[var(--radius-md)] border px-3 py-3 text-left transition-colors",
                type === item
                  ? "border-accent bg-elevated text-fg"
                  : "border-border text-muted hover:text-fg",
              )}
            >
              <span className="block text-sm text-fg">
                {item === "general" ? "Custom template" : CONTRACT_META[item].title}
              </span>
              <span className="mt-1 block text-xs text-subtle">
                {item === "general"
                  ? "Create any document from your requirements."
                  : CONTRACT_META[item].blurb}
              </span>
            </button>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="text-xs font-medium uppercase tracking-[0.12em] text-subtle">
            {type === "general" ? "Describe your custom template" : "Your instructions for Lexa"}
          </span>
          <textarea
            rows={8}
            maxLength={4000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={type === "general"
              ? "Describe the document you need, its structure, parties, purpose, sections, key clauses, tone, and any required terms. Lexa will build a custom template from your instructions and use placeholders for missing facts."
              : "Describe the parties, purpose, jurisdiction, key terms, dates, payment or confidentiality requirements, and any clauses to include or avoid. Mention anything you don't know so Lexa can mark it as a placeholder."}
            className="mt-2 w-full resize-y rounded-[var(--radius-sm)] border border-border bg-bg px-3 py-3 text-sm leading-6 outline-none focus:border-accent"
          />
          <span className="mt-1 block text-right text-[11px] text-subtle">{prompt.length}/4000</span>
        </label>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <Button className="w-full" onClick={() => void generate()} disabled={!prompt.trim() || busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? "Lexa is drafting…" : "Generate with Lexa"}
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void downloadPdf()}
            disabled={!draft || busy}
          >
            <Download className="size-4" />
            Download PDF
          </Button>
        </div>
        {error && (
          <p role="alert" className="mt-3 rounded-xl border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
            {error}
          </p>
        )}
        <p className="mt-4 text-xs leading-5 text-subtle">
          Drafts are AI-generated and are not legal advice. Review all terms with qualified counsel before use.
        </p>
      </div>

      <section
        aria-label="Draft preview"
        className="flex max-h-[52rem] min-h-[24rem] flex-col overflow-hidden rounded-[var(--radius-xl)] border border-border bg-bg shadow-[var(--shadow-panel)]"
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-4">
          <FileText className="size-4 text-accent" />
          <h3 className="text-sm font-semibold">
            {draft
              ? `${type === "general" ? "Custom template" : CONTRACT_META[type].title} draft`
              : "Draft preview"}
          </h3>
        </div>
        {draft ? (
          <div className="overflow-auto px-5 py-5 font-sans text-sm leading-7 text-fg">
            {parseDraft(draft).map((paragraph, index) => (
              <p key={index} className={paragraph.heading ? "mt-4 first:mt-0 font-semibold" : "mt-3 first:mt-0"}>
                {paragraph.runs.map((run, runIndex) => (
                  <span key={runIndex} className={run.bold || paragraph.heading ? "font-semibold" : undefined}>
                    {run.text}
                  </span>
                ))}
              </p>
            ))}
          </div>
        ) : (
          <div className="grid flex-1 place-items-center p-8 text-center">
            <div className="max-w-sm">
              <Sparkles className="mx-auto size-7 text-accent" />
              <p className="mt-3 text-sm font-medium text-fg">Your draft will appear here</p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Give Lexa a clear prompt with the details and clauses you want, then generate a draft to review and download as PDF.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
