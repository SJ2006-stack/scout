export async function readSse<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The search stream did not start.");
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
      if (!line) continue;
      onEvent(JSON.parse(line.slice(5).trim()) as T);
    }
  }
}
