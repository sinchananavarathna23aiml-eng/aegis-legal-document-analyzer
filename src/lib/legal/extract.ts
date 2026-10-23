
type PdfTextResult = { text: string; usedOcr: boolean; pageCount: number };

export type FileTextResult = { text: string; warnings: string[] };

async function extractPdfText(buf: ArrayBuffer): Promise<PdfTextResult> {
  const pdfjsLib = await import("pdfjs-dist");

  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.mjs",
    import.meta.url,
  ).toString();

  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const pages: string[] = [];

  // First, extract selectable text from the PDF.
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    const strings = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .filter(Boolean);

    pages.push(strings.join(" "));
  }

  const text = pages.join("\n\n");

  // Return existing text without running OCR.
  if (text.trim()) {
    return { text, usedOcr: false, pageCount: pdf.numPages };
  }

  // OCR fallback for scanned PDFs.
  const { createWorker } = await import("tesseract.js");
  const worker = await createWorker("eng");

  try {
    const ocrPages: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = (await pdf.getPage(i)) as unknown as {
        getViewport: (options: { scale: number }) => {
          width: number;
          height: number;
        };
        render: (options: {
          canvasContext: CanvasRenderingContext2D;
          viewport: {
            width: number;
            height: number;
          };
        }) => {
          promise: Promise<void>;
        };
      };

      const viewport = page.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");

      if (!context) {
        throw new Error("Could not create a canvas for PDF OCR.");
      }

      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);

      await page.render({
        canvasContext: context,
        viewport,
      }).promise;

      try {
        const result = await worker.recognize(canvas);
        ocrPages.push(result.data.text);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }

    const ocrText = ocrPages.join("\n\n");

    if (!ocrText.trim()) {
      throw new Error("OCR could not find readable text in this PDF.");
    }

    return { text: ocrText, usedOcr: true, pageCount: pdf.numPages };
  } finally {
    await worker.terminate();
  }
}

export async function extractFileTextWithWarnings(file: File): Promise<FileTextResult> {
  const name = file.name.toLowerCase();
  let text: string;
  const warnings: string[] = [];

  // Photograph or scan of a legal document.
  if (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|tiff?)$/.test(name)
  ) {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(file);
      if (!result.data.text.trim()) {
        throw new Error("No readable text was found in that image. Try a sharper, well-lit photo.");
      }
      text = result.data.text;
      warnings.push("Text was read using OCR. Check names, numbers, dates, and each page against the original image.");
    } finally {
      await worker.terminate();
    }
  } else if (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    file.type.startsWith("text/")
  ) {
    text = await file.text();
  } else if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const buf = await file.arrayBuffer();

    const result = await mammoth.extractRawText({
      arrayBuffer: buf,
    });

    if (!result.value.trim()) {
      throw new Error("That Word file had no readable text.");
    }

    text = result.value;
  } else if (name.endsWith(".pdf")) {
    const result = await extractPdfText(await file.arrayBuffer());
    text = result.text;
    if (result.usedOcr) {
      warnings.push("This PDF appears to be scanned; OCR was used. Check names, numbers, dates, and every page against the original.");
    } else if (text.trim().length / result.pageCount < 100) {
      warnings.push("This PDF yielded little selectable text for its page count. It may be incomplete; compare the extracted text against every page.");
    }
  } else {
    throw new Error("Use a PDF, DOCX, TXT, or image file (JPG, PNG, or WebP), or paste the legal text.");
  }

  if (text.trim().length < 120) {
    warnings.push("Very little text was extracted. Verify that the full document and all pages were included before relying on this review.");
  }
  return { text, warnings };
}

export async function extractFileText(file: File): Promise<string> {
  const result = await extractFileTextWithWarnings(file);
  return result.text;
}
