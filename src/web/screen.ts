export type Screen =
  | { kind: "home" }
  | { kind: "tasks" }
  | { kind: "settings" }
  | { kind: "chat"; conversationId: string };

export type Account = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

export type Toast = {
  text: string;
  action?: { label: string; run: () => void };
};
