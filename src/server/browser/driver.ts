export type PageElement = {
  role: string;
  name: string;
};

export type ElementTarget = {
  role: string;
  name: string;
  nth: number;
};

export interface IsolatedPage {
  goto(url: string, signal: AbortSignal): Promise<{ url: string; title: string }>;
  elements(signal: AbortSignal): Promise<PageElement[]>;
  click(target: ElementTarget, signal: AbortSignal): Promise<void>;
  fill(target: ElementTarget, value: string, signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

export interface BrowserDriver {
  openIsolated(allow: (url: string) => boolean): Promise<IsolatedPage>;
  close(): Promise<void>;
}
