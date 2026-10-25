const USER_AGENT = "Scout/0.1 (personal event prototype)";

export async function plainGet(
  url: string,
  accept: string,
  timeoutMs: number,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; body: string } | { ok: false; message: string }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const linked = AbortSignal.any([signal, timeout]);
  try {
    const response = await fetchImpl(url, {
      headers: { accept, "user-agent": USER_AGENT },
      signal: linked,
    });
    if (!response.ok) return { ok: false, message: `HTTP ${response.status}` };
    return { ok: true, body: await response.text() };
  } catch {
    if (signal.aborted) return { ok: false, message: "Search stopped." };
    if (timeout.aborted) return { ok: false, message: "The source timed out." };
    return { ok: false, message: "The source could not be reached." };
  }
}
