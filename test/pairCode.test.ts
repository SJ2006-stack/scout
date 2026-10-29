import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PAIR_WINDOW_MS,
  pairDevice,
  pairPayload,
  pairScanMessage,
  parsePairTicket,
  readPairPayload,
  SCOUT_USER,
} from "../src/shared/pairCode.ts";
import { PairTickets } from "../src/server/pairTickets.ts";
import { withApi } from "./helpers.ts";

describe("device codes", () => {
  it("keeps one code for user0 for 110 seconds, then replaces it", () => {
    let clock = 1_000;
    const issued = ["a".repeat(32), "b".repeat(32)];
    const tickets = new PairTickets(() => clock, () => {
      const next = issued.shift();
      if (!next) throw new Error("missing code");
      return next;
    });
    const first = tickets.current();
    clock = PAIR_WINDOW_MS - 1;
    const same = tickets.current();
    clock = PAIR_WINDOW_MS;
    const next = tickets.current();
    assert.equal(first.userId, SCOUT_USER);
    assert.equal(same.code, first.code);
    assert.equal(same.expiresAt, first.expiresAt);
    assert.notEqual(next.code, first.code);
    assert.equal(next.expiresAt - next.issuedAt, PAIR_WINDOW_MS);
    assert.equal(next.userId, SCOUT_USER);
  });

  it("reads a fresh user0 code and ignores anything else", () => {
    const ticket = {
      userId: SCOUT_USER,
      code: "c".repeat(32),
      issuedAt: 0,
      expiresAt: PAIR_WINDOW_MS,
    };
    const payload = pairPayload("https://scout.example", ticket);
    const fresh = readPairPayload(payload, 1_000);
    assert.equal(fresh.ok, true);
    assert.equal(pairScanMessage(fresh), "This code is for user0. Sign-in from another device is not connected, so this phone stays user0.");
    const stale = readPairPayload(payload, PAIR_WINDOW_MS);
    assert.equal(pairScanMessage(stale), "This code has expired. The other device shows a new one every 110 seconds.");
    assert.equal(readPairPayload("https://scout.example/pair?user=user1&code=" + "d".repeat(32) + "&exp=110000", 1).ok, false);
    assert.equal(readPairPayload("not a code", 1).ok, false);
    assert.equal(parsePairTicket(ticket)?.code, ticket.code);
    assert.equal(parsePairTicket({ ...ticket, userId: "user1" }), null);
  });

  it("gives a phone both roles and a computer the code only", () => {
    assert.equal(pairDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit Mobile/15E148"), "phone");
    assert.equal(pairDevice("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit Chrome/120.0.0.0 Mobile Safari/537.36"), "phone");
    assert.equal(pairDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit Chrome/120.0.0.0 Safari/537.36"), "desk");
    assert.equal(pairDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit Chrome/120.0.0.0 Safari/537.36"), "desk");
    assert.equal(pairDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit Mobile/15E148"), "desk");
  });

  it("serves the current user0 code without starting a session", async () => {
    let clock = 5_000;
    const issued = ["e".repeat(32), "f".repeat(32)];
    const tickets = new PairTickets(() => clock, () => {
      const next = issued.shift();
      if (!next) throw new Error("missing code");
      return next;
    });
    await withApi({ now: () => clock, pairTickets: tickets }, async (base) => {
      const response = await fetch(`${base}/api/pair`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("set-cookie"), null);
      const body = await response.json() as { secondsLeft: number; userId: string; code: string };
      assert.equal(body.userId, SCOUT_USER);
      assert.equal(body.code, "e".repeat(32));
      assert.equal(body.secondsLeft, 105);
      clock = PAIR_WINDOW_MS + 5_000;
      const rotated = await fetch(`${base}/api/pair`);
      const next = await rotated.json() as { code: string; userId: string };
      assert.equal(next.userId, SCOUT_USER);
      assert.notEqual(next.code, body.code);
    });
  });
});
