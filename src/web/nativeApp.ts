type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

/** True inside the Scout Android app, where the WebView exposes the native bridge. */
export function insideNativeApp(): boolean {
  return typeof (window as NativeWindow).ScoutNative?.request === "function";
}

/** Sends the Android app back to its own Google sign-in screen. Older app builds refuse the op. */
export function nativeSignOut(): boolean {
  const native = (window as NativeWindow).ScoutNative;
  if (typeof native?.request !== "function") return false;
  try {
    const parsed = JSON.parse(native.request(JSON.stringify({ op: "sign_out" }))) as { accepted?: unknown };
    return parsed.accepted === true;
  } catch {
    return false;
  }
}

/** Opens the app's own permissions screen (microphone, location, camera, notifications). */
export function openNativePermissions(): boolean {
  const native = (window as NativeWindow).ScoutNative;
  if (typeof native?.request !== "function") return false;
  try {
    const parsed = JSON.parse(native.request(JSON.stringify({ op: "permissions" }))) as { accepted?: unknown };
    return parsed.accepted === true;
  } catch {
    return false;
  }
}
