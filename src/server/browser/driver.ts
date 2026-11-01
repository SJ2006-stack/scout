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
  /** Skips images, fonts, and media. Only for pages no one watches. */
  lean?: boolean;
  /** The user's delivery point, for stores that read it from the browser. */
  geolocation?: { latitude: number; longitude: number };
  /** Sends the context's traffic through this HTTP proxy, such as the owner's phone relay. */
  proxy?: { server: string; username: string; password: string };
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
