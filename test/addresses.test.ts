import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SavedAddress } from "../src/shared/address.ts";
import { withApi } from "./helpers.ts";

const home = {
  label: "Home",
  house: "12",
  street: "Example Road",
  locality: "Karol Bagh",
  landmark: "Near the park",
  postalCode: "110005",
  latitude: 28.66,
  longitude: 77.21,
  userId: "someone-else",
};

describe("saved addresses", () => {
  it("saves, lists, updates, and deletes only the caller's addresses", async () => {
    await withApi({}, async (base) => {
      const first = await fetch(`${base}/api/addresses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(home),
      });
      assert.equal(first.status, 201);
      const created = (await first.json()) as { address: SavedAddress & { userId?: string } };
      assert.equal(created.address.isDefault, true);
      assert.equal(created.address.userId, undefined);
      assert.equal(created.address.formattedAddress.includes("Example Road"), true);
      const cookie = sessionCookie(first);

      const listed = await fetch(`${base}/api/addresses`, { headers: { cookie } });
      const mine = (await listed.json()) as { addresses: SavedAddress[] };
      assert.equal(mine.addresses.length, 1);

      const other = await fetch(`${base}/api/addresses`);
      const otherCookie = sessionCookie(other);
      const foreign = (await other.json()) as { addresses: SavedAddress[] };
      assert.equal(foreign.addresses.length, 0);
      assert.notEqual(cookie, otherCookie);

      const stolen = await fetch(`${base}/api/addresses/${created.address.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: otherCookie },
        body: JSON.stringify({ ...home, label: "Stolen" }),
      });
      assert.equal(stolen.status, 404);
      const removed = await fetch(`${base}/api/addresses/${created.address.id}`, {
        method: "DELETE",
        headers: { cookie: otherCookie },
      });
      assert.equal(removed.status, 404);

      const work = await fetch(`${base}/api/addresses`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ...home, label: "Work", house: "4" }),
      });
      const second = (await work.json()) as { address: SavedAddress };
      assert.equal(second.address.isDefault, false);
      const madeDefault = await fetch(`${base}/api/addresses/${second.address.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ isDefault: true }),
      });
      assert.equal(madeDefault.status, 200);
      const after = (await (await fetch(`${base}/api/addresses`, { headers: { cookie } })).json()) as { addresses: SavedAddress[] };
      assert.equal(after.addresses.filter((address) => address.isDefault).length, 1);
      assert.equal(after.addresses[0]?.id, second.address.id);

      const edited = await fetch(`${base}/api/addresses/${created.address.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ...home, label: "Home", street: "Revised Road" }),
      });
      const updated = (await edited.json()) as { address: SavedAddress };
      assert.equal(updated.address.street, "Revised Road");

      const deleted = await fetch(`${base}/api/addresses/${created.address.id}`, { method: "DELETE", headers: { cookie } });
      assert.equal(deleted.status, 204);
      const remaining = (await (await fetch(`${base}/api/addresses`, { headers: { cookie } })).json()) as { addresses: SavedAddress[] };
      assert.deepEqual(remaining.addresses.map((address) => address.id), [second.address.id]);
    });
  });

  it("rejects an address with no postal code and no point", async () => {
    await withApi({}, async (base) => {
      const response = await fetch(`${base}/api/addresses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: "Nowhere", street: "Example Road" }),
      });
      assert.equal(response.status, 400);
    });
  });
});

function sessionCookie(response: Response): string {
  const lines = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  const pair = lines.map((line) => line.split(";")[0] ?? "").find((line) => line.startsWith("scout_session="));
  if (!pair) throw new Error("missing session cookie");
  return pair;
}
