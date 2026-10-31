import jsQR from "jsqr";
import { PNG } from "pngjs";
import { paymentTarget, payPageUrl } from "../../shared/payLink.ts";

export function decodeQrPng(bytes: Uint8Array): string | null {
  if (bytes.byteLength < 32) return null;
  try {
    const png = PNG.sync.read(Buffer.from(bytes));
    const code = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
    const text = code?.data.trim() ?? "";
    if (text.length === 0) return null;
    return paymentTarget(text) ?? payPageUrl(text);
  } catch {
    return null;
  }
}
