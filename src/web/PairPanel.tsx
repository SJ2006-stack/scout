import { useEffect, useRef, useState } from "react";
import { Html5Qrcode } from "html5-qrcode";
import { toDataURL } from "qrcode";
import {
  pairDevice,
  pairPayload,
  pairScanMessage,
  parsePairTicket,
  readPairPayload,
  SCOUT_USER,
  type PairDevice,
} from "../shared/pairCode.ts";
import { apiUrl } from "./backend.ts";

export function PairPanel() {
  const device = pairDevice(window.navigator.userAgent);
  const [image, setImage] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let refresh = 0;
    let ticker = 0;
    let expiry = 0;

    function tick(): void {
      if (expiry === 0) return;
      setSecondsLeft(Math.max(0, Math.ceil((expiry - Date.now()) / 1000)));
    }

    function fail(): void {
      if (!controller.signal.aborted) setError("The device code could not be loaded.");
    }

    async function pull(): Promise<void> {
      const response = await fetch(apiUrl("/api/pair"), {
        signal: controller.signal,
        headers: { "bypass-tunnel-reminder": "true" },
      });
      if (!response.ok) throw new Error("pair");
      const ticket = parsePairTicket(await response.json());
      if (!ticket) throw new Error("pair");
      const imageUrl = await toDataURL(pairPayload(window.location.origin, ticket), {
        margin: 1,
        width: 280,
        errorCorrectionLevel: "M",
      });
      if (controller.signal.aborted) return;
      expiry = ticket.expiresAt;
      setImage(imageUrl);
      setError(null);
      tick();
      window.clearTimeout(refresh);
      refresh = window.setTimeout(() => {
        void pull().catch(fail);
      }, Math.max(250, ticket.expiresAt - Date.now()));
    }

    ticker = window.setInterval(tick, 1000);
    void pull().catch(fail);
    return () => {
      controller.abort();
      window.clearTimeout(refresh);
      window.clearInterval(ticker);
    };
  }, []);

  return (
    <div className="pair">
      <p className="plain">
        Show this code on one device and scan it from another. Scanning does not sign you in yet.
      </p>
      <p className="plain">{deviceLine(device)}</p>
      <div className="pair-card">
        {image ? <img src={image} width={220} height={220} alt={`Scout device code for ${SCOUT_USER}`} /> : <p className="plain">Preparing a device code…</p>}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        {secondsLeft != null ? <p className="plain">{countdown(secondsLeft)}</p> : null}
      </div>
      {device === "phone" ? (
        <PairScanner onCode={(text) => setScanNote(pairScanMessage(readPairPayload(text, Date.now())))} note={scanNote} />
      ) : null}
    </div>
  );
}

function deviceLine(device: PairDevice): string {
  switch (device) {
    case "phone":
      return "This phone can show a code and scan one.";
    case "desk":
      return "This computer can show a code. Scan it with the Scout app on your phone.";
    default: {
      const neverDevice: never = device;
      return neverDevice;
    }
  }
}

function countdown(seconds: number): string {
  if (seconds === 1) return "New code in 1 second.";
  return `New code in ${seconds} seconds.`;
}

function PairScanner({ onCode, note }: { onCode: (text: string) => void; note: string | null }) {
  const regionId = "scout-pair-scan";
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const onCodeRef = useRef(onCode);
  const gone = useRef(false);
  const [running, setRunning] = useState(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  onCodeRef.current = onCode;

  useEffect(() => {
    return () => {
      gone.current = true;
      const scanner = scannerRef.current;
      scannerRef.current = null;
      if (scanner?.isScanning) void scanner.stop().then(() => scanner.clear()).catch(() => undefined);
    };
  }, []);

  async function stop(): Promise<void> {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner?.isScanning) {
      await scanner.stop();
      scanner.clear();
    }
    setRunning(false);
  }

  async function start(): Promise<void> {
    setCameraError(null);
    setRunning(true);
    const scanner = new Html5Qrcode(regionId, false);
    scannerRef.current = scanner;
    try {
      await scanner.start(
        { facingMode: "environment" },
        {
          fps: 8,
          qrbox: (viewfinderWidth, viewfinderHeight) => {
            const edge = Math.max(120, Math.floor(Math.min(viewfinderWidth, viewfinderHeight) * 0.7));
            return { width: edge, height: edge };
          },
        },
        (text) => {
          onCodeRef.current(text);
          void stop();
        },
        () => undefined,
      );
      if (gone.current && scanner.isScanning) {
        await scanner.stop();
        scanner.clear();
      }
    } catch {
      scannerRef.current = null;
      if (!gone.current) {
        setRunning(false);
        setCameraError("The camera could not be opened.");
      }
    }
  }

  return (
    <div className="pair-scan">
      <div className="pair-scan-view" id={regionId} />
      {running ? (
        <button className="ghost-button" type="button" onClick={() => void stop()}>Stop scanning</button>
      ) : (
        <button className="ghost-button" type="button" onClick={() => void start()}>Scan a code</button>
      )}
      {cameraError ? <p className="form-error" role="alert">{cameraError}</p> : null}
      {note ? <p className="plain">{note}</p> : null}
    </div>
  );
}
