import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "@/lib/auth/middleware";

const SYSTEM = `You are a precise legal document assistant for Aegis, a contract analysis platform.
Answer only from the provided document. If the document does not contain the answer, say so.
Be concise, structured, and cautious. This is not legal advice. Do not invent clauses.`;

// Groq's free-tier API is OpenAI-compatible, so this is a near drop-in swap for the
// previous xAI call. Get a free key at https://console.groq.com/keys and set
// GROQ_API_KEY in the environment (a .env file works for local dev; use your
// deploy platform's env var settings in production).
const GROQ_MODEL = "qwen/qwen3.8-27b";

async function chatGroq(
  messages: { role: "system" | "user" | "assistant"; content: string }[],
  opts: { temperature?: number; maxTokens?: number; jsonMode?: boolean } = {},
) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { ok: false as const, error: "AI is not available: GROQ_API_KEY is not set." };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 700,
      ...(opts.jsonMode ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    if (res.status === 429) {
      return { ok: false as const, error: "Rate limited by the free Groq tier. Wait a moment and try again." };
    }
    return {
      ok: false as const,
      error: `The language model returned ${res.status}.${detail ? ` ${detail.slice(0, 200)}` : ""}`,
    };
  }
  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = body.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) return { ok: false as const, error: "Empty response from the model." };
  return { ok: true as const, text };
}

export const askDocument = createServerFn({ method: "POST" })
  .validator((input: { question: string; documentText: string }) => input)
  .middleware([authMiddleware])
  .handler(async ({ data }) => {
    const question = data.question.trim();
    if (!question) return { ok: false as const, error: "Enter a question." };
    const doc = data.documentText.slice(0, 12000);
    return chatGroq([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Document:\n${doc}\n\nQuestion: ${question}\n\nAnswer from the document only.`,
      },
    ]);
  });

export const refineSummary = createServerFn({ method: "POST" })
  .validator((input: { documentText: string }) => input)
  .middleware([authMiddleware])
  .handler(async ({ data }) => {
    const doc = data.documentText.slice(0, 12000);
    return chatGroq([
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Summarize this legal document in 5 tight bullets covering parties, purpose, key obligations, risk hotspots, and term/termination. Document:\n${doc}`,
      },
    ]);
  });

// --- Hybrid clause review -------------------------------------------------
// The regex pass in analyzer.ts is fast and deterministic but keyword-only: it
// can't tell "liability shall not exceed $100" from a clause that merely
// *discusses* liability caps, and it can't catch paraphrased clauses at all.
// This sends each regex-flagged candidate to the model for a real read, so the
// UI can show a verdict instead of trusting the keyword match blindly.

export type ClauseVerdict = {
  index: number;
  verdict: "confirmed" | "false_positive" | "uncertain";
  severity: "high" | "medium" | "low" | "none";
  note: string;
};

type RiskCandidate = { index: number; type: string; description: string; excerpt: string };

const REVIEW_SYSTEM = `You are a contract risk reviewer. You will be given short excerpts flagged by a
keyword scanner as possible risk or favorable factors. For each one, judge from the excerpt's actual
wording whether the flag is correct — keyword scanners misfire on negation, hypotheticals, struck
clauses, and definitions sections. Respond ONLY with a JSON object: {"verdicts":[{"index":number,
"verdict":"confirmed"|"false_positive"|"uncertain","severity":"high"|"medium"|"low"|"none","note":string}]}
One entry per candidate, in the same order. "note" is one short sentence explaining the call. This is not
legal advice; do not invent facts not in the excerpt.`;

export const reviewClauseCandidates = createServerFn({ method: "POST" })
  .validator((input: { candidates: RiskCandidate[] }) => input)
  .middleware([authMiddleware])
  .handler(async ({ data }) => {
    const candidates = data.candidates.slice(0, 40);
    if (!candidates.length) return { ok: false as const, error: "Nothing to review." };

    const listing = candidates
      .map((c) => `[${c.index}] flagged as "${c.type}": "${c.excerpt}"`)
      .join("\n");

    const res = await chatGroq(
      [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: listing },
      ],
      { temperature: 0.1, maxTokens: 1500, jsonMode: true },
    );
    if (!res.ok) return res;

    let parsed: { verdicts?: unknown };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false as const, error: "The model returned malformed JSON. Try again." };
    }

    const raw = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
    const validVerdicts = new Set(["confirmed", "false_positive", "uncertain"]);
    const validSeverity = new Set(["high", "medium", "low", "none"]);
    const verdicts: ClauseVerdict[] = raw
      .filter(
        (v): v is ClauseVerdict =>
          typeof v === "object" &&
          v !== null &&
          typeof (v as ClauseVerdict).index === "number" &&
          validVerdicts.has((v as ClauseVerdict).verdict) &&
          validSeverity.has((v as ClauseVerdict).severity),
      )
      .map((v) => ({
        index: v.index,
        verdict: v.verdict,
        severity: v.severity,
        note: typeof v.note === "string" ? v.note.slice(0, 240) : "",
      }));

    if (!verdicts.length) return { ok: false as const, error: "The model returned no usable verdicts." };
    return { ok: true as const, verdicts };
  });

// --- LLM-native discovery --------------------------------------------------
// The regex scanner only catches what its fixed pattern list can name. This
// pass reads the whole document and looks for risk or favorable clauses that
// don't match any of those patterns — paraphrased liability caps, unusual
// indemnification structure, non-standard termination language, etc. — so the
// two approaches are complementary rather than one paved over the other.

export type AiFinding = {
  kind: "risk" | "favorable";
  description: string;
  severity: "high" | "medium" | "low";
  excerpt: string;
};

const KNOWN_TYPES = [
  "unlimited liability",
  "unilateral changes",
  "broad indemnification",
  "automatic renewal",
  "waiver of rights",
  "perpetual obligations",
  "as-is / non-negotiable terms",
  "mutual termination",
  "limited liability",
  "notice period",
  "dispute resolution",
  "mutual confidentiality",
  "governing law defined",
  "right to cure",
];

const DISCOVERY_SYSTEM = `You are a contract risk reviewer for Aegis. A keyword scanner already checked this
document for a fixed list of known clause types (listed below) — do not report those again. Your job is to
find OTHER risk or favorable factors the scanner's fixed pattern list would miss: paraphrased clauses,
unusual structure, non-standard obligations, one-sided terms phrased without the scanner's exact keywords.
Already-checked types: ${KNOWN_TYPES.join(", ")}.
Respond ONLY with a JSON object: {"findings":[{"kind":"risk"|"favorable","description":string,
"severity":"high"|"medium"|"low","excerpt":string}]}. "excerpt" must be a short direct quote (under 25 words)
copied verbatim from the document. Return at most 8 findings. If there is nothing new to report, return an
empty array. This is not legal advice; do not invent clauses not present in the text.`;

export const discoverAdditionalFindings = createServerFn({ method: "POST" })
  .validator((input: { documentText: string }) => input)
  .middleware([authMiddleware])
  .handler(async ({ data }) => {
    const doc = data.documentText.slice(0, 12000);
    if (!doc.trim()) return { ok: false as const, error: "No document text to scan." };

    const res = await chatGroq(
      [
        { role: "system", content: DISCOVERY_SYSTEM },
        { role: "user", content: `Document:\n${doc}` },
      ],
      { temperature: 0.2, maxTokens: 1500, jsonMode: true },
    );
    if (!res.ok) return res;

    let parsed: { findings?: unknown };
    try {
      parsed = JSON.parse(res.text);
    } catch {
      return { ok: false as const, error: "The model returned malformed JSON. Try again." };
    }

    const raw = Array.isArray(parsed.findings) ? parsed.findings : [];
    const validKind = new Set(["risk", "favorable"]);
    const validSeverity = new Set(["high", "medium", "low"]);
    const findings: AiFinding[] = raw
      .filter(
        (f): f is AiFinding =>
          typeof f === "object" &&
          f !== null &&
          validKind.has((f as AiFinding).kind) &&
          validSeverity.has((f as AiFinding).severity) &&
          typeof (f as AiFinding).description === "string" &&
          typeof (f as AiFinding).excerpt === "string",
      )
      .slice(0, 8)
      .map((f) => ({
        kind: f.kind,
        description: f.description.slice(0, 200),
        severity: f.severity,
        excerpt: f.excerpt.slice(0, 240),
      }));

    return { ok: true as const, findings };
  });

// --- AI-powered comparison --------------------------------------------------
// Explains in plain language what actually changed between two documents' key
// clauses, going beyond keyword diffs to surface practical differences.

const COMPARE_SYSTEM = `You are a contract comparison analyst for Aegis. You will receive two documents.
Explain in plain language what actually changed between them, focusing on:
1. Key clause differences (liability, termination, indemnification, confidentiality, governing law)
2. Which document is more favorable to the signing party and why
3. Any critical gaps in one document that the other covers
4. Practical implications a non-lawyer should understand
Be specific — cite clause language. Max 5 bullet points. This is not legal advice.`;

export type CompareAiResult = {
  explanation: string;
};

export const compareWithAi = createServerFn({ method: "POST" })
  .validator(
    (input: { docA: string; docB: string; fileNameA: string; fileNameB: string }) => input,
  )
  .middleware([authMiddleware])
  .handler(async ({ data }) => {
    const docA = data.docA.slice(0, 10000);
    const docB = data.docB.slice(0, 10000);
    if (!docA.trim() || !docB.trim()) {
      return { ok: false as const, error: "Both documents must have content." };
    }

    const res = await chatGroq(
      [
        { role: "system", content: COMPARE_SYSTEM },
        {
          role: "user",
          content: `Document A (${data.fileNameA}):\n${docA}\n\n---\n\nDocument B (${data.fileNameB}):\n${docB}`,
        },
      ],
      { temperature: 0.2, maxTokens: 1200 },
    );
    if (!res.ok) return res;
    return { ok: true as const, explanation: res.text };
  });

// --- Lexa AI — conversational document assistant ---------------------------
// A persistent side-panel chat that remembers the conversation history and
// grounds every answer in the supplied document text.

const LEXA_SYSTEM = `You are Lexa AI, a sharp, concise legal-document assistant inside Aegis.
Rules:
- Answer ONLY from the supplied document text. If the answer isn't in the document, say so.
- Be direct. No filler. No disclaimers unless asked.
- Use short paragraphs, bullet points, and bold for emphasis.
- If the user asks something outside the document's scope, redirect to what the document *does* say.
- Never invent clauses, dates, or parties not present in the text.
- You may reference the document's analysis score, clauses, entities, or risk factors when helpful.`;

export const lexaChat = createServerFn({ method: "POST" })
  .validator(
    (input: {
      messages: { role: "user" | "assistant"; content: string }[];
      documentText: string;
      documentName: string;
      threadId?: string;
    }) => input,
  )
  .middleware([authMiddleware])
  .handler(async ({ data, context }) => {
    const latest = data.messages.at(-1);
    if (!latest || latest.role !== "user" || !latest.content.trim()) {
      return { ok: false as const, error: "Enter a message to continue." };
    }
    const [{ getSql }, { randomUUID }] = await Promise.all([
      import("@/lib/db"),
      import("node:crypto"),
    ]);
    const sql = await getSql();
    let threadId = data.threadId;
    let savedMessages: { role: "user" | "assistant"; content: string }[] = [];
    let docText = data.documentText.slice(0, 100000);
    let documentName = data.documentName.slice(0, 500);

    if (threadId) {
      const rows = await sql.query<{
        document_name: string;
        document_text: string;
        messages: { role: "user" | "assistant"; content: string }[];
      }>(
        `SELECT document_name, document_text, messages FROM legal_chat_threads
         WHERE id = $1 AND user_id = $2 LIMIT 1`,
        [threadId, context.userId],
      );
      const thread = rows[0];
      if (!thread) return { ok: false as const, error: "This conversation is no longer available." };
      documentName = thread.document_name;
      docText = thread.document_text.slice(0, 12000);
      savedMessages = Array.isArray(thread.messages) ? thread.messages : [];
    } else {
      threadId = randomUUID();
      await sql.query(
        `INSERT INTO legal_chat_threads (id, user_id, document_name, document_text)
         VALUES ($1, $2, $3, $4)`,
        [threadId, context.userId, documentName, data.documentText.slice(0, 100000)],
      );
    }

    const userMessage = { role: "user" as const, content: latest.content.slice(0, 12000) };
    await sql.query(
      `UPDATE legal_chat_threads SET messages = messages || $1::jsonb, updated_at = now()
       WHERE id = $2 AND user_id = $3`,
      [JSON.stringify([userMessage]), threadId, context.userId],
    );
    if (!docText.trim()) {
      return { ok: false as const, error: "No document loaded. Upload or paste a contract first." };
    }

    const groqMessages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: LEXA_SYSTEM },
      {
        role: "system",
        content: `Document: "${documentName}"\n\n${docText.slice(0, 12000)}`,
      },
      ...savedMessages.slice(-20).map((message) => ({
        ...message,
        content: message.content.slice(0, 4000),
      })),
      userMessage,
    ];

    const response = await chatGroq(groqMessages, { temperature: 0.3, maxTokens: 1000 });
    if (response.ok) {
      await sql.query(
        `UPDATE legal_chat_threads SET messages = messages || $1::jsonb, updated_at = now()
         WHERE id = $2 AND user_id = $3`,
        [JSON.stringify([{ role: "assistant", content: response.text }]), threadId, context.userId],
      );
      return { ...response, threadId };
    }
    return { ...response, threadId };
  });
