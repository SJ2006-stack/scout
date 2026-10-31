import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { deskConversations, type DeskConversation } from "../shared/deskBoard.ts";

export class DeskStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  read(): DeskConversation[] {
    if (!existsSync(this.file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { conversations?: unknown };
      return deskConversations(parsed.conversations);
    } catch {
      return [];
    }
  }

  write(value: unknown): DeskConversation[] | null {
    if (!value || typeof value !== "object" || !Array.isArray((value as { conversations?: unknown }).conversations)) return null;
    const incoming = deskConversations((value as { conversations: unknown }).conversations);
    const conversations = incoming.length === 0 ? this.read() : incoming;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify({ conversations }));
    return conversations;
  }
}
