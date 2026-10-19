import { createServerFn } from "@tanstack/react-start";
import { authMiddleware } from "./auth/middleware";
import type { AnalysisResult, ComparisonResult } from "./legal/types";

export type LegalChatMessage = { role: "user" | "assistant"; content: string };
export type LegalChatThreadSummary = {
  id: string;
  documentName: string;
  preview: string;
  updatedAt: number;
};
export type LegalChatThread = LegalChatThreadSummary & {
  documentText: string;
  messages: LegalChatMessage[];
};

const listChatThreadsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    return sql.query<LegalChatThreadSummary>(
      `SELECT id, document_name AS "documentName",
              COALESCE(messages->(jsonb_array_length(messages) - 1)->>'content', '') AS preview,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::double precision AS "updatedAt"
       FROM legal_chat_threads WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 100`,
      [context.userId],
    );
  });

const loadChatThreadFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{
      id: string;
      documentName: string;
      documentText: string;
      messages: LegalChatMessage[];
      updatedAt: number;
    }>(
      `SELECT id, document_name AS "documentName", document_text AS "documentText", messages,
              (EXTRACT(EPOCH FROM updated_at) * 1000)::double precision AS "updatedAt"
       FROM legal_chat_threads WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [data.id, context.userId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ...row,
      preview: row.messages.at(-1)?.content.slice(0, 180) ?? "New conversation",
      messages: Array.isArray(row.messages) ? row.messages : [],
    } satisfies LegalChatThread;
  });

export async function listChatThreads(): Promise<LegalChatThreadSummary[]> {
  return listChatThreadsFn();
}

export async function loadChatThread(id: string): Promise<LegalChatThread | null> {
  return loadChatThreadFn({ data: { id } });
}

export type SavedAnalysisSummary = {
  id: string;
  fileName: string;
  savedAt: number;
  score: number;
  hasOriginalFile?: boolean;
};

export type OriginalFilePayload = {
  fileName: string;
  mimeType: string;
  base64: string;
};

const MAX_ORIGINAL_FILE_BYTES = 5 * 1024 * 1024;

const saveAnalysisFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { result: AnalysisResult; originalFile?: OriginalFilePayload }) => input)
  .handler(async ({ data, context }) => {
    if (!data.result || typeof data.result.fileName !== "string") {
      throw new Error("Invalid analysis result.");
    }

    let originalBytes: Buffer | null = null;
    let mimeType: string | null = null;
    let originalSize: number | null = null;
    if (data.originalFile) {
      const { base64, mimeType: suppliedMimeType } = data.originalFile;
      if (typeof base64 !== "string" || base64.length > Math.ceil(MAX_ORIGINAL_FILE_BYTES * 4 / 3) + 8) {
        throw new Error("Original files must be 5 MB or smaller to save.");
      }
      originalBytes = Buffer.from(base64, "base64");
      if (originalBytes.byteLength > MAX_ORIGINAL_FILE_BYTES) {
        throw new Error("Original files must be 5 MB or smaller to save.");
      }
      mimeType = typeof suppliedMimeType === "string" ? suppliedMimeType.slice(0, 160) : "application/octet-stream";
      originalSize = originalBytes.byteLength;
    }

    const [{ getSql }, { randomUUID }] = await Promise.all([
      import("./db"),
      import("node:crypto"),
    ]);
    const sql = await getSql();
    const id = randomUUID();
    await sql.query(
      `INSERT INTO legal_analyses
        (id, user_id, file_name, score, result, original_file, original_mime_type, original_size)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        id,
        context.userId,
        data.result.fileName.slice(0, 500),
        Math.max(0, Math.min(100, Math.round(Number(data.result.signing?.percentage) || 0))),
        JSON.stringify(data.result),
        originalBytes,
        mimeType,
        originalSize,
      ],
    );
    return id;
  });

const loadAnalysisFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{ result: AnalysisResult }>(
      "SELECT result FROM legal_analyses WHERE id = $1 AND user_id = $2 LIMIT 1",
      [data.id, context.userId],
    );
    return rows[0]?.result ?? null;
  });

const listAnalysesFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    return sql.query<SavedAnalysisSummary>(
      `SELECT id, file_name AS "fileName",
              (EXTRACT(EPOCH FROM saved_at) * 1000)::double precision AS "savedAt",
              score,
              (original_file IS NOT NULL) AS "hasOriginalFile"
       FROM legal_analyses
       WHERE user_id = $1
       ORDER BY saved_at DESC`,
      [context.userId],
    );
  });

const deleteAnalysisFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    await sql.query("DELETE FROM legal_analyses WHERE id = $1 AND user_id = $2", [
      data.id,
      context.userId,
    ]);
  });

const loadOriginalFileFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    const rows = await sql.query<{
      file_name: string;
      original_mime_type: string | null;
      original_file: Buffer | Uint8Array | null;
    }>(
      `SELECT file_name, original_mime_type, original_file
       FROM legal_analyses WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [data.id, context.userId],
    );
    const row = rows[0];
    if (!row?.original_file) return null;
    return {
      fileName: row.file_name,
      mimeType: row.original_mime_type ?? "application/octet-stream",
      base64: Buffer.from(row.original_file).toString("base64"),
    };
  });

const saveComparisonFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { fileA: string; fileB: string; result: ComparisonResult }) => input)
  .handler(async ({ data, context }) => {
    const [{ getSql }, { randomUUID }] = await Promise.all([
      import("./db"),
      import("node:crypto"),
    ]);
    const sql = await getSql();
    const id = randomUUID();
    await sql.query(
      `INSERT INTO legal_comparisons (id, user_id, file_a, file_b, result)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        id,
        context.userId,
        data.fileA.slice(0, 500),
        data.fileB.slice(0, 500),
        JSON.stringify(data.result),
      ],
    );
    return id;
  });

const listComparisonsFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    return sql.query<{ id: string; fileA: string; fileB: string; savedAt: number }>(
      `SELECT id, file_a AS "fileA", file_b AS "fileB",
              (EXTRACT(EPOCH FROM saved_at) * 1000)::double precision AS "savedAt"
       FROM legal_comparisons
       WHERE user_id = $1
       ORDER BY saved_at DESC`,
      [context.userId],
    );
  });

const deleteComparisonFn = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .validator((input: { id: string }) => input)
  .handler(async ({ data, context }) => {
    const { getSql } = await import("./db");
    const sql = await getSql();
    await sql.query("DELETE FROM legal_comparisons WHERE id = $1 AND user_id = $2", [
      data.id,
      context.userId,
    ]);
  });

export async function saveAnalysis(
  result: AnalysisResult,
  originalFile?: OriginalFilePayload,
): Promise<string> {
  return saveAnalysisFn({ data: { result, originalFile } });
}

export async function loadAnalysis(id: string): Promise<AnalysisResult | null> {
  return loadAnalysisFn({ data: { id } });
}

export async function listAnalyses(): Promise<SavedAnalysisSummary[]> {
  return listAnalysesFn();
}

export async function deleteAnalysis(id: string): Promise<void> {
  await deleteAnalysisFn({ data: { id } });
}

export async function loadOriginalFile(id: string): Promise<OriginalFilePayload | null> {
  return loadOriginalFileFn({ data: { id } });
}

export async function saveComparison(
  fileA: string,
  fileB: string,
  result: ComparisonResult,
): Promise<string> {
  return saveComparisonFn({ data: { fileA, fileB, result } });
}

export async function listComparisons(): Promise<
  { id: string; fileA: string; fileB: string; savedAt: number }[]
> {
  return listComparisonsFn();
}

export async function deleteComparison(id: string): Promise<void> {
  await deleteComparisonFn({ data: { id } });
}
