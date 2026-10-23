import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFileText, extractFileTextWithWarnings } from "./extract.ts";

function makeFile(name: string, content: string, type = "text/plain"): File {
  return new File([content], name, { type });
}

describe("extractFileText", () => {
  it("extracts plain text from .txt files", async () => {
    const file = makeFile("contract.txt", "This is a contract.");
    const text = await extractFileText(file);
    assert.equal(text, "This is a contract.");
  });

  it("extracts text from .md files", async () => {
    const file = makeFile("doc.md", "# Title\n\nContent here.");
    const text = await extractFileText(file);
    assert.ok(text.includes("Title"));
    assert.ok(text.includes("Content here."));
  });

  it("extracts text from text/* MIME types", async () => {
    const file = new File(["Hello"], "file", { type: "text/csv" });
    const text = await extractFileText(file);
    assert.equal(text, "Hello");
  });

  it("warns when a file yields unusually little text", async () => {
    const file = makeFile("short.txt", "A short extracted passage.");
    const result = await extractFileTextWithWarnings(file);
    assert.equal(result.text, "A short extracted passage.");
    assert.ok(result.warnings.some((warning) => warning.includes("Very little text")));
  });

  it("does not warn about low text volume for a sufficiently long text file", async () => {
    const file = makeFile("contract.txt", "A".repeat(200));
    const result = await extractFileTextWithWarnings(file);
    assert.deepEqual(result.warnings, []);
  });

  it("rejects unknown file types", async () => {
    const file = makeFile("doc.xlsx", "spreadsheet", "application/vnd.ms-excel");
    try {
      await extractFileText(file);
      assert.fail("Should have thrown");
    } catch (e) {
      assert.ok(e instanceof Error);
      assert.ok(e.message.includes("PDF"), "error should mention available formats");
    }
  });
});
