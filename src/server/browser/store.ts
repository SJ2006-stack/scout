import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { BrowserSessionStatus, BrowserTaskEvent, BrowserTaskStatus } from "../../shared/browser.ts";

export type StoredTask = {
  id: string;
  ownerId: string;
  status: BrowserTaskStatus;
  createdAt: number;
  updatedAt: number;
};

export type StoredSession = {
  id: string;
  taskId: string;
  ownerId: string;
  status: BrowserSessionStatus;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

type StoredEvent = {
  at: number;
  event: BrowserTaskEvent;
};

type Database = {
  version: 1;
  tasks: StoredTask[];
  sessions: StoredSession[];
  events: StoredEvent[];
};

const EVENT_LIMIT = 200;
const SECRET_KEY = /cookie|storageState|password|authorization|otp|cardNumber|cvv/i;

export class BrowserStore {
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
  }

  task(id: string): StoredTask | null {
    return this.read().tasks.find((item) => item.id === id) ?? null;
  }

  session(id: string): StoredSession | null {
    return this.read().sessions.find((item) => item.id === id) ?? null;
  }

  live(): StoredSession[] {
    return this.read().sessions.filter((session) => session.status === "open" || session.status === "paused");
  }

  list(ownerId: string): StoredSession[] {
    return this.read().sessions.filter((session) => session.ownerId === ownerId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 20);
  }

  events(taskId: string): BrowserTaskEvent[] {
    return this.read().events.filter((entry) => entry.event.taskId === taskId).map((entry) => entry.event);
  }

  openSession(input: { ownerId: string; taskId: string | null; now: number; ttlMs: number }): StoredSession {
    return this.mutate((data) => {
      const task = resolveTask(data, input);
      const session: StoredSession = {
        id: newId(),
        taskId: task.id,
        ownerId: input.ownerId,
        status: "open",
        url: "",
        title: "",
        createdAt: input.now,
        updatedAt: input.now,
        expiresAt: input.now + input.ttlMs,
      };
      data.sessions.push(session);
      return session;
    });
  }

  updateOpen(sessionId: string, fields: { url: string; title: string }, now: number): void {
    this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId);
      if (!session || session.status !== "open") return;
      session.url = fields.url;
      session.title = fields.title;
      session.updatedAt = now;
      touchTask(data, session.taskId, now);
    });
  }

  setRunningStatus(sessionId: string, status: "open" | "paused", now: number): void {
    this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId);
      if (!session) return;
      if (status === "paused" && session.status !== "open" && session.status !== "paused") return;
      if (status === "open" && session.status !== "paused") return;
      session.status = status;
      session.updatedAt = now;
      touchTask(data, session.taskId, now);
    });
  }

  mark(sessionId: string, status: "closed" | "expired" | "failed", now: number): void {
    this.mutate((data) => {
      const session = data.sessions.find((item) => item.id === sessionId);
      if (!session || (session.status !== "open" && session.status !== "paused")) return;
      session.status = status;
      session.updatedAt = now;
      touchTask(data, session.taskId, now);
    });
  }

  addEvent(event: BrowserTaskEvent, now: number): void {
    this.mutate((data) => {
      data.events.push({ at: now, event });
      if (data.events.length > EVENT_LIMIT) data.events.splice(0, data.events.length - EVENT_LIMIT);
    });
  }

  expireRunning(now: number, message: string): void {
    const data = this.read();
    const running = data.sessions.filter((session) => session.status === "open" || session.status === "paused");
    if (running.length === 0) return;
    const taskIds = new Set<string>();
    for (const session of running) {
      session.status = "expired";
      session.updatedAt = now;
      taskIds.add(session.taskId);
      data.events.push(
        { at: now, event: { type: "status", taskId: session.taskId, sessionId: session.id, message } },
        { at: now, event: { type: "done", taskId: session.taskId, sessionId: session.id, status: "expired" } },
      );
    }
    for (const taskId of taskIds) touchTask(data, taskId, now);
    if (data.events.length > EVENT_LIMIT) data.events.splice(0, data.events.length - EVENT_LIMIT);
    this.write(data);
  }

  private mutate<T>(fn: (data: Database) => T): T {
    const data = this.read();
    const result = fn(data);
    this.write(data);
    return result;
  }

  private read(): Database {
    if (!existsSync(this.file)) return { version: 1, tasks: [], sessions: [], events: [] };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
    } catch {
      throw new Error("Browser session store could not be read.");
    }
    if (!isDatabase(parsed)) throw new Error("Browser session store could not be read.");
    return parsed;
  }

  private write(data: Database): void {
    assertPublic(data);
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, this.file);
  }
}

function resolveTask(data: Database, input: { ownerId: string; taskId: string | null; now: number }): StoredTask {
  if (!input.taskId) {
    const created: StoredTask = {
      id: newId(),
      ownerId: input.ownerId,
      status: "running",
      createdAt: input.now,
      updatedAt: input.now,
    };
    data.tasks.push(created);
    return created;
  }
  const existing = data.tasks.find((item) => item.id === input.taskId);
  if (!existing || existing.ownerId !== input.ownerId) throw new Error("That task was not found.");
  existing.status = "running";
  existing.updatedAt = input.now;
  return existing;
}

function touchTask(data: Database, taskId: string, now: number): void {
  const task = data.tasks.find((item) => item.id === taskId);
  if (!task) return;
  task.status = derive(data.sessions.filter((session) => session.taskId === taskId));
  task.updatedAt = now;
}

function derive(sessions: readonly StoredSession[]): BrowserTaskStatus {
  if (sessions.some((session) => session.status === "open")) return "running";
  if (sessions.some((session) => session.status === "paused")) return "paused";
  if (sessions.some((session) => session.status === "failed")) return "failed";
  if (sessions.some((session) => session.status === "expired")) return "expired";
  return "closed";
}

function newId(): string {
  return randomBytes(16).toString("hex");
}

function isDatabase(value: unknown): value is Database {
  if (!value || typeof value !== "object") return false;
  const data = value as Database;
  return data.version === 1 && Array.isArray(data.tasks) && Array.isArray(data.sessions) && Array.isArray(data.events);
}

function assertPublic(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) throw new Error("Refusing to persist browser secrets.");
    assertPublic(entry);
  }
}
