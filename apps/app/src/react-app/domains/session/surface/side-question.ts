/** "/btw …": the question (a string, "" for a bare /btw), or null when the text is not /btw (the server's side-question.mjs reads it the same way). */
export function parseSideQuestion(text: string): string | null {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(text);
  return match ? (match[1] ?? "").trim().slice(0, 4_000) : null;
}

export type SideAnswer = { id: number; question: string; status: "thinking" | "done" | "error"; answer: string; sources: string[] };
