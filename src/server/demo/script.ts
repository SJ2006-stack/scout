import type { SearchEvent } from "../../shared/events.ts";
import { DEMO_AREA_LABEL, DEMO_REQUEST } from "../../shared/demoRequest.ts";
import { DEMO_FAILURE, DEMO_OFFERS } from "./fixtures.ts";

const SCRIPT_START = Date.parse("2026-01-01T00:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(SCRIPT_START + offsetMs).toISOString();
}

export function buildDemoEvents(): SearchEvent[] {
  const [first, second] = DEMO_OFFERS;
  if (!first || !second) return [];
  return [
    { type: "status", message: `Replaying the demonstration search: ${DEMO_REQUEST}` },
    { type: "status", message: DEMO_AREA_LABEL },
    { type: "offer", offer: first },
    { type: "offer", offer: second },
    {
      type: "connector",
      connectorId: "demo-mart",
      startedAt: at(0),
      firstOfferAt: at(400),
      completedAt: at(800),
      timedOut: false,
      cacheHit: false,
      ok: true,
      failure: null,
    },
    {
      type: "connector",
      connectorId: DEMO_FAILURE.connectorId,
      startedAt: at(800),
      firstOfferAt: null,
      completedAt: at(1200),
      timedOut: false,
      cacheHit: false,
      ok: false,
      failure: { code: DEMO_FAILURE.code, message: DEMO_FAILURE.message },
    },
    { type: "done", firstUsefulOfferMs: 400, totalMs: 1200, offerCount: 2 },
  ];
}

export async function streamDemo(
  emit: (event: SearchEvent) => void,
  stepMs: number,
  signal: AbortSignal,
): Promise<void> {
  const events = buildDemoEvents();
  for (let index = 0; index < events.length; index += 1) {
    if (signal.aborted) return;
    if (index > 0 && stepMs > 0) {
      await delay(stepMs, signal);
      if (signal.aborted) return;
    }
    const event = events[index];
    if (event) emit(event);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    function finish(): void {
      clearTimeout(timer);
      resolve();
    }
  });
}
