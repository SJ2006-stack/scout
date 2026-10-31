export type PayLinkSource = "deeplink" | "qr" | "page";

export type PayLink = {
  url: string;
  source: PayLinkSource;
  merchant: string;
  title: string;
  amount: string | null;
};

const SCHEMES = new Set(["upi:", "tez:", "gpay:", "phonepe:", "paytmmp:", "bhim:"]);

export function paymentTarget(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 2_000) return null;
  try {
    const url = new URL(text);
    if (!SCHEMES.has(url.protocol) || url.username !== "" || url.password !== "") return null;
    return text;
  } catch {
    return null;
  }
}

export function payPageUrl(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0 || text.length > 2_000) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function paymentUrlInText(text: string): string | null {
  const match = text.match(/(?:upi|tez|gpay|phonepe|paytmmp|bhim):\/\/[^\s"'<>]+/i);
  if (!match) return null;
  return paymentTarget(match[0]);
}

export function isPayLink(value: unknown): value is PayLink {
  if (!value || typeof value !== "object") return false;
  const pay = value as Partial<PayLink>;
  if (pay.source !== "deeplink" && pay.source !== "qr" && pay.source !== "page") return false;
  if (typeof pay.url !== "string" || typeof pay.merchant !== "string" || typeof pay.title !== "string") return false;
  if (pay.amount != null && typeof pay.amount !== "string") return false;
  return paymentTarget(pay.url) != null || payPageUrl(pay.url) != null;
}
