export type BrowserSessionStatus = "open" | "paused" | "closed" | "expired" | "failed";

export type BrowserTaskStatus = "running" | "paused" | "closed" | "expired" | "failed";

export type BrowserElement = {
  ref: string;
  role: string;
  name: string;
};

export type BrowserSessionView = {
  id: string;
  taskId: string;
  status: BrowserSessionStatus;
  taskStatus: BrowserTaskStatus;
  url: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
};

export type BrowserTaskEvent =
  | { type: "status"; taskId: string; sessionId: string; message: string }
  | { type: "error"; taskId: string; sessionId: string; message: string }
  | { type: "snapshot"; taskId: string; sessionId: string; url: string; title: string; elements: BrowserElement[] }
  | { type: "done"; taskId: string; sessionId: string; status: BrowserSessionStatus };
