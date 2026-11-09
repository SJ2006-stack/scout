type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

/** True inside the Scout Android app, where the WebView exposes the native bridge. */
export function insideNativeApp(): boolean {
  return typeof (window as NativeWindow).ScoutNative?.request === "function";
}

/** Sends the Android app back to its own Google sign-in screen. Older app builds refuse the op. */
export function nativeSignOut(): boolean {
  return nativeOp("sign_out");
}

/** Opens Android's Accessibility settings so the user can turn Scout on. Older builds open the in-app permissions list instead. */
export function openAccessibilitySettings(): boolean {
  if (nativeOp("accessibility")) return true;
  return openNativePermissions();
}

/** Opens the app's own permissions screen (microphone, location, camera, notifications, automation). */
export function openNativePermissions(): boolean {
  return nativeOp("permissions");
}

function nativeOp(op: "accessibility" | "permissions" | "sign_out"): boolean {
  const native = (window as NativeWindow).ScoutNative;
  if (typeof native?.request !== "function") return false;
  try {
    const parsed = JSON.parse(native.request(JSON.stringify({ op }))) as { accepted?: unknown };
    return parsed.accepted === true;
  } catch {
    return false;
  }
}
