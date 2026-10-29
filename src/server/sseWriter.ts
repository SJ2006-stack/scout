import type { ServerResponse } from "node:http";

export async function writeEvents<T extends { type: string }>(
  response: ServerResponse,
  run: (emit: (event: T) => void, signal: AbortSignal) => Promise<void>,
): Promise<void> {
  const controller = new AbortController();
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  response.socket?.setNoDelay(true);
  const abort = (): void => controller.abort();
  response.on("close", abort);
  try {
    await run((event: T) => {
      if (response.writableEnded || controller.signal.aborted) return;
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }, controller.signal);
  } finally {
    response.off("close", abort);
    if (!response.writableEnded) response.end();
  }
}
