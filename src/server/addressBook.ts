import { randomBytes } from "node:crypto";
import type { AddressDraft, SavedAddress } from "../shared/address.ts";

export class AddressBook {
  private readonly sessions = new Map<string, SavedAddress[]>();
  private readonly now: () => number;

  constructor(now: () => number) {
    this.now = now;
  }

  list(sessionId: string): SavedAddress[] {
    return this.rows(sessionId)
      .map((address) => ({ ...address }))
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault) || left.createdAt.localeCompare(right.createdAt));
  }

  create(sessionId: string, draft: AddressDraft): SavedAddress {
    const rows = this.rows(sessionId);
    const stamp = new Date(this.now()).toISOString();
    const address: SavedAddress = {
      ...draft,
      id: randomBytes(8).toString("hex"),
      isDefault: draft.isDefault || rows.length === 0,
      createdAt: stamp,
      updatedAt: stamp,
    };
    rows.push(address);
    if (address.isDefault) this.keepOneDefault(rows, address.id);
    return { ...address };
  }

  update(sessionId: string, id: string, draft: AddressDraft): SavedAddress | undefined {
    const rows = this.rows(sessionId);
    const current = rows.find((address) => address.id === id);
    if (!current) return undefined;
    current.label = draft.label;
    current.formattedAddress = draft.formattedAddress;
    current.latitude = draft.latitude;
    current.longitude = draft.longitude;
    current.accuracyMeters = draft.accuracyMeters;
    current.placeId = draft.placeId;
    current.house = draft.house;
    current.street = draft.street;
    current.locality = draft.locality;
    current.landmark = draft.landmark;
    current.postalCode = draft.postalCode;
    current.updatedAt = new Date(this.now()).toISOString();
    if (draft.isDefault) this.keepOneDefault(rows, current.id);
    return { ...current };
  }

  makeDefault(sessionId: string, id: string): SavedAddress | undefined {
    const rows = this.rows(sessionId);
    if (!rows.some((address) => address.id === id)) return undefined;
    this.keepOneDefault(rows, id);
    const current = rows.find((address) => address.id === id);
    if (!current) return undefined;
    current.updatedAt = new Date(this.now()).toISOString();
    return { ...current };
  }

  delete(sessionId: string, id: string): boolean {
    const rows = this.rows(sessionId);
    const index = rows.findIndex((address) => address.id === id);
    if (index < 0) return false;
    const removed = rows[index];
    rows.splice(index, 1);
    if (removed?.isDefault && rows[0]) this.keepOneDefault(rows, rows[0].id);
    return true;
  }

  private rows(sessionId: string): SavedAddress[] {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created: SavedAddress[] = [];
    this.sessions.set(sessionId, created);
    return created;
  }

  private keepOneDefault(rows: SavedAddress[], id: string): void {
    for (const address of rows) address.isDefault = address.id === id;
  }
}
