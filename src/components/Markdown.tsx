// Markdown renderer for AI-generated text (chat bubbles, degraded diagnosis
// cards, structured card fields). Sanitized via DOMPurify — model output is
// untrusted input and must never inject HTML.

import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ breaks: true, gfm: true });

// Streaming chunk arrival can be very fast (several per second); re-parsing
// the full text on every chunk causes visible jank on long replies. `live`
// re-renders at most every 150 ms and always flushes the final text.
const LIVE_INTERVAL_MS = 150;

export function Markdown({
  text,
  className,
  live = false,
}: {
  text: string;
  className?: string;
  live?: boolean;
}) {
  const latest = useRef(text);
  latest.current = text;
  const [shown, setShown] = useState(text);

  // Static mode: always in sync with the incoming text.
  useEffect(() => {
    if (!live) setShown(text);
  }, [live, text]);

  // Live (streaming) mode: re-render at most every LIVE_INTERVAL_MS; the
  // cleanup flushes the authoritative final text on unmount.
  useEffect(() => {
    if (!live) return;
    const id = window.setInterval(() => {
      setShown((cur) => (cur === latest.current ? cur : latest.current));
    }, LIVE_INTERVAL_MS);
    return () => {
      window.clearInterval(id);
      setShown(latest.current);
    };
  }, [live]);

  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(shown ?? "") as string),
    [shown],
  );
  return <div className={`md-body ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
