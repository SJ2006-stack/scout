type NativeWindow = Window & {
  ScoutNative?: { request?: (json: string) => string };
};

/** True inside the Scout Android app, where the WebView exposes the native bridge. */
export function insideNativeApp(): boolean {
  return typeof (window as NativeWindow).ScoutNative?.request === "function";
}

/** Opens the app's own permissions screen (microphone, location, camera, notifications). */
export function openNativePermissions(): boolean {
  const request = (window as NativeWindow).ScoutNative?.request;
  if (typeof request !== "function") return false;
  try {
    const parsed = JSON.parse(request(JSON.stringify({ op: "permissions" }))) as { accepted?: unknown };
    return parsed.accepted === true;
  } catch {
    return false;
  }
}
