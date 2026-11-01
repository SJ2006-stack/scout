// Stands in for the Android relay: holds this machine's connection open for your signed-in Scout account,
// so the server's Chromium reaches Blinkit, Zepto, and Instamart from this machine's address.
// It also keeps sealed copies of your site sign-ins in SCOUT_DEVICE_VAULT (default ~/.scout-test/vault).
// node --experimental-strip-types scripts/relayDevice.ts https://scout.shrianshjaiswal.me <scout_session>
import { homedir } from "node:os";
import { join } from "node:path";
import { RELAY_PATH } from "../src/shared/relay.ts";
import { runRelayDevice } from "../src/server/relay/deviceClient.ts";
import { fileDeviceVault } from "../src/server/relay/deviceVault.ts";

const origin = process.argv[2] ?? "http://127.0.0.1:8787";
const session = process.argv[3] ?? process.env.SCOUT_SESSION ?? "";
if (!/^[a-f0-9]{32}$/.test(session)) {
  console.error("Pass your scout_session cookie value.");
  process.exit(1);
}
const vault = fileDeviceVault(process.env.SCOUT_DEVICE_VAULT ?? join(homedir(), ".scout-test", "vault"));
const url = `${origin.replace(/^http/, "ws").replace(/\/$/, "")}${RELAY_PATH}`;

function start(): void {
  const device = runRelayDevice({
    url,
    headers: { cookie: `scout_session=${session}`, "x-scout-session": session },
    vault,
    onEvent: (message) => console.log(`${new Date().toISOString().slice(11, 19)} ${message}`),
  });
  device.ready.then(
    () => console.log(`Relay connected to ${origin}`),
    (error: unknown) => console.error(`Relay failed: ${error instanceof Error ? error.message : "unknown"}`),
  );
  void device.closed.then(() => {
    console.log("Relay closed. Reconnecting in 3 s.");
    setTimeout(start, 3_000);
  });
}

start();
