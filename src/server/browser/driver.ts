export type PageElement = {
  role: string;
  name: string;
};

export type ElementTarget = {
  role: string;
  name: string;
  nth: number;
};

export type IsolatedOpen = {
  allow: (url: string) => boolean;
  storageState?: unknown;
  headed?: boolean;
};

export interface IsolatedPage {
  goto(url: string, signal: AbortSignal): Promise<{ url: string; title: string }>;
  location(signal: AbortSignal): Promise<{ url: string; title: string }>;
  html(signal: AbortSignal): Promise<string>;
  elements(signal: AbortSignal): Promise<PageElement[]>;
  click(target: ElementTarget, signal: AbortSignal): Promise<void>;
  fill(target: ElementTarget, value: string, signal: AbortSignal): Promise<void>;
  takePayment(): string | null;
  screenshot(signal: AbortSignal): Promise<Uint8Array>;
  storageState(signal: AbortSignal): Promise<unknown>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  openIsolated(options: IsolatedOpen): Promise<IsolatedPage>;
  close(): Promise<void>;
  warm?(): Promise<void>;
}
