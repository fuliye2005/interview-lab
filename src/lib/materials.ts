import mammoth from "mammoth";

export async function extractMaterialText(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "txt" || extension === "md") return file.text();
  if (extension === "docx") {
    const result = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return result.value;
  }
  if (extension === "pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const document = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(" "));
    }
    return pages.join("\n\n");
  }
  throw new Error("仅支持 PDF、DOCX、TXT 或 Markdown 文件");
}

export function makeCandidateDraft(resume: string, notes: string) {
  return `请用户确认以下候选人事实后再用于回答。\n\n【简历原文摘录】\n${resume.slice(0, 8000)}\n\n【个人补充】\n${notes.slice(0, 4000)}`;
}

export function makeJobDraft(jobDescription: string) {
  return `请用户确认以下岗位要求后再用于回答。\n\n【JD 原文摘录】\n${jobDescription.slice(0, 8000)}`;
}
