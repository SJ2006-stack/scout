import type { Listing } from "./event.ts";

export type ChatStatusEvent = {
  type: "status";
  message: string;
};

export type ChatQuestionEvent = {
  type: "question";
  message: string;
};

export type ChatCardEvent = {
  type: "card";
  listing: Listing;
};

export type ChatSourceEvent = {
  type: "source";
  source: string;
  ok: boolean;
  message: string;
};

export type ChatDoneEvent = {
  type: "done";
  count: number;
};

export type ChatEvent = ChatStatusEvent | ChatQuestionEvent | ChatCardEvent | ChatSourceEvent | ChatDoneEvent;
