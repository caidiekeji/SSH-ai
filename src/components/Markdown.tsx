// Markdown renderer for AI-generated text (chat bubbles, degraded diagnosis
// cards, structured card fields). Sanitized via DOMPurify — model output is
// untrusted input and must never inject HTML.

import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text ?? "") as string),
    [text],
  );
  return <div className={`md-body ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
