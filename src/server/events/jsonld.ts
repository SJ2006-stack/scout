export function readJsonLd(html: string): unknown[] {
  const found: unknown[] = [];
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi)) {
    const raw = match[1];
    if (raw == null) continue;
    try {
      found.push(JSON.parse(raw) as unknown);
    } catch {
      continue;
    }
  }
  return found;
}

export function itemLists(blocks: unknown[]): Record<string, unknown>[] {
  const lists: Record<string, unknown>[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (record["@type"] === "ItemList") lists.push(record);
  }
  return lists;
}
