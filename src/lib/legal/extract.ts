
async function extractPdfText(buf: ArrayBuffer): Promise<string> {
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
    return text;
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

    return ocrText;
  } finally {
    await worker.terminate();
  }
}

export async function extractFileText(file: File): Promise<string> {
  const name = file.name.toLowerCase();

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
      return result.data.text;
    } finally {
      await worker.terminate();
    }
  }

  // Plain text and Markdown files.
  if (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    file.type.startsWith("text/")
  ) {
    return file.text();
  }

  // Microsoft Word documents.
  if (name.endsWith(".docx")) {
    const mammoth = await import("mammoth");
    const buf = await file.arrayBuffer();

    const result = await mammoth.extractRawText({
      arrayBuffer: buf,
    });

    if (!result.value.trim()) {
      throw new Error("That Word file had no readable text.");
    }

    return result.value;
  }

  // PDF documents, including scanned PDFs.
  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    return extractPdfText(buf);
  }

  throw new Error("Use a PDF, DOCX, TXT, or image file (JPG, PNG, or WebP), or paste the legal text.");
}
