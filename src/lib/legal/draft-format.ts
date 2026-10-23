export type DraftRun = { text: string; bold: boolean };
export type DraftParagraph = { runs: DraftRun[]; heading: boolean };

export function parseDraft(text: string): DraftParagraph[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .replace(
      /\s+(?=(?:\d{1,2}\.\s+\*\*[^*]+\*\*)|(?:\*\*(?:RECITALS|IN WITNESS WHEREOF)\*\*)|(?:IN WITNESS WHEREOF\b)|(?:NOW,\s+THEREFORE\b)|(?:WHEREAS\b))/gi,
      "\n\n",
    );

  return normalized
    .split(/\n+/)
    .map((line) => line.trim().replace(/^#{1,6}\s*/, "").replace(/^[*+-]\s+/, "- "))
    .filter(Boolean)
    .map((line) => {
      const heading = /^\*\*.+\*\*$/.test(line);
      const runs: DraftRun[] = [];
      const emphasis = /\*\*(.+?)\*\*/g;
      let lastIndex = 0;
      for (const match of line.matchAll(emphasis)) {
        const index = match.index ?? 0;
        if (index > lastIndex) {
          runs.push({ text: line.slice(lastIndex, index).replace(/\*/g, ""), bold: false });
        }
        runs.push({ text: match[1].replace(/\*/g, ""), bold: true });
        lastIndex = index + match[0].length;
      }
      if (lastIndex < line.length) {
        runs.push({ text: line.slice(lastIndex).replace(/\*/g, ""), bold: false });
      }
      if (runs.length === 0) runs.push({ text: line.replace(/\*/g, ""), bold: false });
      return { runs, heading };
    });
}
