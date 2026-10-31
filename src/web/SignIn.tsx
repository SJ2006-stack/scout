import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { apiUrl, rememberSignedInUser } from "./backend.ts";

type IdentityStep = "email" | "code" | "phone";

const RESEND_SECONDS = 60;
const STEPS = 4;

export function Splash() {
  return (
    <main className="auth-screen" aria-busy="true" aria-label="Loading Scout">
      <span className="logo splash" aria-hidden="true">S</span>
    </main>
  );
}

function AuthFrame({ step, title, lead, children, onSubmit }: {
  step: number;
  title: string;
  lead: string;
  children: ReactNode;
  onSubmit: (event: FormEvent) => void;
}) {
  return (
    <main className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="logo" aria-hidden="true">S</span>
        <p className="auth-step" aria-label={`Step ${step} of ${STEPS}`}>
          {Array.from({ length: STEPS }, (_, index) => (
            <span className={index < step ? "dot on" : "dot"} key={index} />
          ))}
        </p>
        <h1>{title}</h1>
        <p className="auth-lead">{lead}</p>
        {children}
      </form>
    </main>
  );
}

export function SignIn({ start, onSignedIn }: { start: "email" | "phone"; onSignedIn: () => void }) {
  const [step, setStep] = useState<IdentityStep>(start === "phone" ? "phone" : "email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [resendIn, setResendIn] = useState(0);

  useEffect(() => {
    if (step !== "code") return;
    const bridge = (window as Window & { ScoutOtp?: { listen: () => void } }).ScoutOtp;
    bridge?.listen();
  }, [step]);

  useEffect(() => {
    if (resendIn <= 0) return;
    const timer = window.setTimeout(() => setResendIn((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [resendIn]);

  async function requestCode(): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/auth/email"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const payload = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "The code could not be sent.");
        return false;
      }
      setResendIn(RESEND_SECONDS);
      return true;
    } catch {
      setError("The code could not be sent. Check your connection and try again.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function sendCode(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    if (await requestCode()) {
      setCode("");
      setStep("code");
    }
  }

  async function resend(): Promise<void> {
    if (busy || resendIn > 0) return;
    await requestCode();
  }

  async function verifyCode(value: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/auth/verify"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, code: value }),
      });
      const payload = (await response.json()) as { error?: unknown; userId?: unknown };
      if (!response.ok || typeof payload.userId !== "string") {
        setError(typeof payload.error === "string" ? payload.error : "That code does not match.");
        setCode("");
        return;
      }
      rememberSignedInUser(payload.userId);
      setStep("phone");
    } catch {
      setError("That code could not be checked. Try again.");
    } finally {
      setBusy(false);
    }
  }

  function changeCode(raw: string): void {
    const digits = raw.replace(/\D/g, "").slice(0, 6);
    setCode(digits);
    if (digits.length === 6) void verifyCode(digits);
  }

  async function savePhone(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/onboarding/phone"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const payload = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "That number could not be saved.");
        return;
      }
      onSignedIn();
    } catch {
      setError("That number could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error ? <p className="form-error" role="alert">{error}</p> : null;

  switch (step) {
    case "email":
      return (
        <AuthFrame step={1} title="Sign in" lead="Use your Gmail address. We'll email you a 6-digit code." onSubmit={(event) => void sendCode(event)}>
          <label htmlFor="auth-email">Gmail</label>
          <input
            id="auth-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            placeholder="you@gmail.com"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
          {errorLine}
          <button className="auth-submit" type="submit" disabled={busy || email.trim().length === 0}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </AuthFrame>
      );
    case "code":
      return (
        <AuthFrame step={2} title="Check your email" lead={`We sent a 6-digit code to ${email}. It works for 10 minutes.`} onSubmit={(event) => { event.preventDefault(); if (code.length === 6) void verifyCode(code); }}>
          <label htmlFor="auth-code">Code</label>
          <input
            id="auth-code"
            className="code-input"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            autoFocus
            maxLength={6}
            placeholder="······"
            value={code}
            onChange={(event) => changeCode(event.target.value)}
            required
          />
          {errorLine}
          <button className="auth-submit" type="submit" disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Continue"}
          </button>
          <div className="auth-links">
            <button className="auth-link" type="button" disabled={busy || resendIn > 0} onClick={() => void resend()}>
              {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
            </button>
            <button className="auth-link" type="button" onClick={() => { setStep("email"); setCode(""); setError(null); }}>
              Use a different Gmail
            </button>
          </div>
        </AuthFrame>
      );
    case "phone":
      return (
        <AuthFrame step={3} title="Your mobile number" lead="Scout uses it to sign in to booking sites for you. Add an Indian mobile number." onSubmit={(event) => void savePhone(event)}>
          <label htmlFor="auth-phone">Mobile number</label>
          <div className="phone-field">
            <span aria-hidden="true">+91</span>
            <input
              id="auth-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              autoFocus
              placeholder="98765 43210"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              required
            />
          </div>
          {errorLine}
          <button className="auth-submit" type="submit" disabled={busy || phone.trim().length === 0}>
            {busy ? "Saving…" : "Continue"}
          </button>
        </AuthFrame>
      );
    default: {
      const neverStep: never = step;
      return neverStep;
    }
  }
}

export function PreferredName({ onNamed }: { onNamed: () => void }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl("/api/onboarding/name"), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const payload = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : "That name could not be saved.");
        return;
      }
      onNamed();
    } catch {
      setError("That name could not be saved. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthFrame step={4} title="What should Scout call you?" lead="A first name is fine." onSubmit={(event) => void save(event)}>
      <label htmlFor="preferred-name">Name</label>
      <input
        id="preferred-name"
        autoComplete="nickname"
        autoFocus
        placeholder="Your name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        required
      />
      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <button className="auth-submit" type="submit" disabled={busy || name.trim().length === 0}>
        {busy ? "Saving…" : "Start using Scout"}
      </button>
    </AuthFrame>
  );
}
