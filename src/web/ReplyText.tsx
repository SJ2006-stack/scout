import type { ReactNode } from "react";

const INLINE = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|https:\/\/[^\s)]+)/g;
const INTERNAL = /^\s*(?:\[?Shown on screen in order:.*|Mentioned in order:.*|.*\bheld back \d+.*)$/i;
const LIST = /^\s*(?:\d+[.)]|[-•*])\s+(.*)$/;

/** Chat reply with bold, lists, and links shortened to the site name. Raw Markdown stars never show. */
export function ReplyText({ text }: { text: string }) {
  const lines = text.split("\n").filter((line) => !INTERNAL.test(line));
  const blocks: ReactNode[] = [];
  let items: string[] = [];
  let ordered = false;
  const flush = () => {
    if (items.length === 0) return;
    const rows = items.map((item, index) => <li key={index}>{inline(item)}</li>);
    blocks.push(ordered ? <ol key={blocks.length}>{rows}</ol> : <ul key={blocks.length}>{rows}</ul>);
    items = [];
  };
  for (const line of lines) {
    const match = LIST.exec(line);
    if (match?.[1]) {
      const numbered = /^\s*\d/.test(line);
      if (items.length > 0 && numbered !== ordered) flush();
      ordered = numbered;
      items.push(match[1]);
      continue;
    }
    flush();
    if (line.trim().length === 0) continue;
    blocks.push(<p key={blocks.length}>{inline(line.trim())}</p>);
  }
  flush();
  return <div className="reply reply-rich">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > last) out.push(text.slice(last, start));
    if (token.startsWith("**")) out.push(<strong key={start}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith("*")) out.push(<em key={start}>{token.slice(1, -1)}</em>);
    else out.push(<a key={start} className="reply-link" href={token} target="_blank" rel="noreferrer">{siteName(token)}</a>);
    last = start + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function siteName(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^www\.|^in\./, "");
    if (host.includes("bookmyshow")) return "BookMyShow";
    if (host.includes("district")) return "District";
    if (host.includes("luma") || host === "lu.ma") return "Luma";
    if (host.includes("blinkit")) return "Blinkit";
    if (host.includes("zepto")) return "Zepto";
    if (host.includes("swiggy") || host.includes("instamart")) return "Instamart";
    return host;
  } catch {
    return "Open";
  }
}
