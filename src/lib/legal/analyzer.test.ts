
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { MissingClauseAssessment } from "./types.ts";
import {
  analyzeText,
  scoreDocument,
  compareAnalyses,
  extractEntities,
  getMissingClauseNames,
} from "./analyzer.ts";
import { SAMPLE_NDA, SAMPLE_RISKY } from "./samples.ts";

describe("analyzeText", () => {
  it("detects clause types in the balanced NDA", () => {
    const result = analyzeText(SAMPLE_NDA, "nda.txt");
    const clauseTypes = Object.keys(result.clauses);

    assert.ok(clauseTypes.includes("confidentiality"));
    assert.ok(clauseTypes.includes("indemnification"));
    assert.ok(clauseTypes.includes("liability"));
    assert.ok(clauseTypes.includes("termination"));
    assert.ok(clauseTypes.includes("governing_law"));
    assert.ok(clauseTypes.includes("dispute_resolution"));
    assert.ok(clauseTypes.includes("amendment"));
    assert.ok(clauseTypes.includes("warranty"));
    assert.ok(clauseTypes.includes("severability"));
  });

  it("detects additional legal clause categories", () => {
    const text = `
      The parties shall comply with data protection and data privacy laws.
      Each party must implement data security measures to prevent a data breach.
      This agreement provides for automatic renewal.
      Either party must provide 30 days written notice.
      The customer has the right to audit records.
      Subcontracting requires prior written consent.
    `;

    const result = analyzeText(text, "keyword-test.txt");
    const detectedTypes = Object.keys(result.clauses);

    assert.ok(detectedTypes.includes("data_protection"));
    assert.ok(detectedTypes.includes("data_security"));
    assert.ok(detectedTypes.includes("renewal"));
    assert.ok(detectedTypes.includes("notice"));
    assert.ok(detectedTypes.includes("audit_rights"));
    assert.ok(detectedTypes.includes("subcontracting"));
  });

  it("detects risk factors in the risky contract", () => {
    const result = analyzeText(SAMPLE_RISKY, "risky.txt");

    assert.ok(
      result.signing.findings.risks.length > 0,
      "should have risk factors",
    );

    const riskTypes = result.signing.findings.risks.map((r) => r.type);

    assert.ok(
      riskTypes.includes("unlimited_liability"),
      "should flag unlimited liability",
    );
    assert.ok(
      riskTypes.includes("waiver_of_rights"),
      "should flag waiver of rights",
    );
    assert.ok(riskTypes.includes("as_is"), "should flag as-is terms");
  });

  it("produces a lower score for the risky contract", () => {
    const nda = analyzeText(SAMPLE_NDA, "nda.txt");
    const risky = analyzeText(SAMPLE_RISKY, "risky.txt");

    assert.ok(
      nda.signing.percentage > risky.signing.percentage,
      "NDA should score higher than risky",
    );
  });

  it("extracts entities from the NDA", () => {
    const result = analyzeText(SAMPLE_NDA, "nda.txt");

    assert.ok(
      Object.keys(result.entities).length > 0,
      "should extract at least some entities",
    );
    assert.ok(
      result.entities.MONEY_AMOUNTS?.length,
      "should find money amounts",
    );
    assert.ok(
      result.entities.GOVERNING_LAW?.length,
      "should find governing law",
    );
  });

  it("generates a summary", () => {
    const result = analyzeText(SAMPLE_NDA, "nda.txt");
    assert.ok(result.summary.length > 50, "summary should be substantive");
  });

  it("returns readable names only for clauses flagged as missing", () => {
    const assessments: MissingClauseAssessment[] = [
      {
        clauseId: "termination",
        clauseName: "Termination",
        status: "not_detected",
        reason: "No termination clause found",
        alternativeMatches: [],
        importance: "important",
        relevantContractTypes: [],
      },
      {
        clauseId: "liability",
        clauseName: "Limitation of liability",
        status: "uncertain",
        reason: "Could not determine whether a limitation is present",
        alternativeMatches: [],
        importance: "critical",
        relevantContractTypes: [],
      },
      {
        clauseId: "confidentiality",
        clauseName: "Confidentiality",
        status: "confirmed",
        reason: "Clause found",
        alternativeMatches: [],
        importance: "standard",
        relevantContractTypes: [],
      },
    ];

    assert.deepEqual(getMissingClauseNames(assessments), [
      "Termination",
      "Limitation of liability",
    ]);
  });

  it("computes statistics", () => {
    const result = analyzeText(SAMPLE_NDA, "nda.txt");

    assert.ok(result.statistics.wordCount > 100, "should count words");
    assert.ok(result.statistics.charCount > 1000, "should count chars");
    assert.ok(result.statistics.paragraphCount > 0, "should count paragraphs");
    assert.ok(result.statistics.sentenceCount > 0, "should count sentences");
  });

  it("handles empty text gracefully", () => {
    const result = analyzeText("", "empty.txt");

    assert.ok(
      result.statistics.wordCount >= 0,
      "word count should be non-negative",
    );
    assert.ok(
      result.signing.percentage >= 0 && result.signing.percentage <= 100,
      "score should be 0-100",
    );
  });

  it("handles very short text", () => {
    const result = analyzeText("Short contract.", "short.txt");

    assert.ok(result.statistics.wordCount >= 1, "should count at least one word");
    assert.ok(
      result.signing.findings.risks.some((r) => r.type === "short_document"),
    );
  });

  it("preserves the file name", () => {
    const result = analyzeText(SAMPLE_NDA, "custom-name.pdf");
    assert.equal(result.fileName, "custom-name.pdf");
  });
});

describe("scoreDocument", () => {
  it("returns a score between 0 and 100", () => {
    const result = scoreDocument(SAMPLE_NDA, {}, {}, "nda", false);

    assert.ok(
      result.percentage >= 0 && result.percentage <= 100,
      "score should be 0-100",
    );
  });

  it("assigns correct labels", () => {
    const favorable = scoreDocument("A".repeat(5000), {}, {}, "general", false);

    assert.ok(
      ["Favorable", "Cautious", "Needs review", "Unfavorable", "High risk"].includes(
        favorable.label,
      ),
    );
  });
});

describe("compareAnalyses", () => {
  it("returns similarity and clause diff", () => {
    const a = analyzeText(SAMPLE_NDA, "A.txt");
    const b = analyzeText(SAMPLE_RISKY, "B.txt");
    const diff = compareAnalyses(a, b);

    assert.ok(typeof diff.similarity === "number", "similarity should be a number");
    assert.ok(diff.clauseDiff.length > 0, "should have clause diff entries");
  });

  it("flags score divergence as critical", () => {
    const a = analyzeText(SAMPLE_NDA, "A.txt");
    const b = analyzeText(SAMPLE_RISKY, "B.txt");
    const diff = compareAnalyses(a, b);

    assert.ok(diff.critical.length > 0, "should have critical differences");
  });

  it("detects when the same document is compared to itself", () => {
    const a = analyzeText(SAMPLE_NDA, "A.txt");
    const b = analyzeText(SAMPLE_NDA, "A.txt");
    const diff = compareAnalyses(a, b);

    assert.equal(diff.similarity, 100, "identical docs should have 100% similarity");
    assert.equal(diff.critical.length, 0, "identical docs should have no critical differences");
  });
});

describe("extractEntities", () => {
  it("extracts organizations", () => {
    const entities = extractEntities(
      "Novacore Systems Ltd. signed with Orbital Solutions Inc.",
    );

    assert.ok(entities.ORGANIZATIONS?.length, "should find organizations");
  });

  it("extracts money amounts", () => {
    const entities = extractEntities("The fee is USD 50,000 per month.");

    assert.ok(entities.MONEY_AMOUNTS?.length, "should find money amounts");
  });

  it("returns empty for no entities", () => {
    const entities = extractEntities("just some random text");

    assert.equal(Object.keys(entities).length, 0, "should return empty");
  });
});
