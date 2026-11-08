import { useState, type FormEvent, type ReactNode } from "react";
import { ABOUT_CITIES, DIETS, EVENT_INTERESTS, REPLY_LANGUAGES, type OnboardingStep } from "../shared/onboarding.ts";
import { apiUrl, rememberSignedInUser } from "./backend.ts";
import { signInWithGoogle } from "./googleSignIn.ts";
import { insideNativeApp, nativeSignOut } from "./nativeApp.ts";

type Step = Exclude<OnboardingStep, "ready">;

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

/** Google, then phone, then name, then a short about-you step. onAdvance re-reads the session to pick the next step. */
export function Onboarding({ step, onAdvance }: { step: Step; onAdvance: () => void }) {
  switch (step) {
    case "google":
      return <GoogleStep onAdvance={onAdvance} />;
    case "phone":
      return <PhoneStep onAdvance={onAdvance} />;
    case "name":
      return <NameStep onAdvance={onAdvance} />;
    case "about":
      return <AboutStep onAdvance={onAdvance} />;
    default: {
      const neverStep: never = step;
      return neverStep;
    }
  }
}

function useSave(onAdvance: () => void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save(path: string, body: unknown, fallback: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(apiUrl(path), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const payload = (await response.json()) as { error?: unknown };
      if (!response.ok) {
        setError(typeof payload.error === "string" ? payload.error : fallback);
        return;
      }
      onAdvance();
    } catch {
      setError(`${fallback} Try again.`);
    } finally {
      setBusy(false);
    }
  }
  const errorLine = error ? <p className="form-error" role="alert">{error}</p> : null;
  return { busy, save, errorLine, setError, setBusy };
}

function GoogleStep({ onAdvance }: { onAdvance: () => void }) {
  const { busy, errorLine, setError, setBusy } = useSave(onAdvance);
  const native = insideNativeApp();

  async function start(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);
    if (native) {
      if (!nativeSignOut()) setError("Update the Scout app, then sign in again.");
      return;
    }
    setBusy(true);
    const result = await signInWithGoogle();
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    rememberSignedInUser(result.session.userId);
    onAdvance();
  }

  return (
    <AuthFrame step={1} title="Sign in" lead="Use your Google account. Scout keeps your chats and preferences under it." onSubmit={(event) => void start(event)}>
      {errorLine}
      <button className="auth-submit google" type="submit" disabled={busy}>
        <GoogleMark />
        {busy ? "Opening Google…" : "Continue with Google"}
      </button>
    </AuthFrame>
  );
}

function PhoneStep({ onAdvance }: { onAdvance: () => void }) {
  const [phone, setPhone] = useState("");
  const { busy, save, errorLine } = useSave(onAdvance);
  return (
    <AuthFrame
      step={2}
      title="Your mobile number"
      lead="Scout uses it to sign in to Blinkit, Zepto, and booking sites for you. Add an Indian mobile number."
      onSubmit={(event) => { event.preventDefault(); void save("/api/onboarding/phone", { phone }, "That number could not be saved."); }}
    >
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
}

function NameStep({ onAdvance }: { onAdvance: () => void }) {
  const [name, setName] = useState("");
  const { busy, save, errorLine } = useSave(onAdvance);
  return (
    <AuthFrame
      step={3}
      title="What should Scout call you?"
      lead="A first name is fine."
      onSubmit={(event) => { event.preventDefault(); void save("/api/onboarding/name", { name }, "That name could not be saved."); }}
    >
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
      {errorLine}
      <button className="auth-submit" type="submit" disabled={busy || name.trim().length === 0}>
        {busy ? "Saving…" : "Continue"}
      </button>
    </AuthFrame>
  );
}

function AboutStep({ onAdvance }: { onAdvance: () => void }) {
  const [city, setCity] = useState("");
  const [pincode, setPincode] = useState("");
  const [diets, setDiets] = useState<string[]>([]);
  const [interests, setInterests] = useState<string[]>([]);
  const [language, setLanguage] = useState("");
  const { busy, save, errorLine } = useSave(onAdvance);

  function toggle(id: string): void {
    setInterests((current) => (current.includes(id) ? current.filter((item) => item !== id) : [...current, id]));
  }

  return (
    <AuthFrame
      step={4}
      title="Help Scout know you"
      lead="Every scout uses these, so you are asked less later. Pick what fits and skip the rest. You can change them by telling Scout."
      onSubmit={(event) => { event.preventDefault(); void save("/api/onboarding/about", { city, pincode, diet: diets, interests, language }, "Those could not be saved."); }}
    >
      <fieldset className="about-group">
        <legend>Your city</legend>
        <div className="about-chips">
          {ABOUT_CITIES.map((option) => (
            <button key={option.id} type="button" className={city === option.id ? "chip on" : "chip"} aria-pressed={city === option.id} onClick={() => setCity(city === option.id ? "" : option.id)}>
              {option.name}
            </button>
          ))}
        </div>
      </fieldset>
      <label htmlFor="about-pincode">Home pincode, for delivery prices</label>
      <input
        id="about-pincode"
        inputMode="numeric"
        autoComplete="postal-code"
        maxLength={6}
        placeholder="110016"
        value={pincode}
        onChange={(event) => setPincode(event.target.value.replace(/\D/g, "").slice(0, 6))}
      />
      <fieldset className="about-group">
        <legend>Food</legend>
        <div className="about-chips">
          {DIETS.map((option) => (
            <button key={option.id} type="button" className={diets.includes(option.id) ? "chip on" : "chip"} aria-pressed={diets.includes(option.id)} onClick={() => setDiets((current) => current.includes(option.id) ? current.filter((item) => item !== option.id) : [...current, option.id])}>
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="about-group">
        <legend>What you go out for</legend>
        <div className="about-chips">
          {EVENT_INTERESTS.map((option) => (
            <button key={option.id} type="button" className={interests.includes(option.id) ? "chip on" : "chip"} aria-pressed={interests.includes(option.id)} onClick={() => toggle(option.id)}>
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset className="about-group">
        <legend>Scout replies in</legend>
        <div className="about-chips">
          {REPLY_LANGUAGES.map((option) => (
            <button key={option} type="button" className={language === option ? "chip on" : "chip"} aria-pressed={language === option} onClick={() => setLanguage(language === option ? "" : option)}>
              {option}
            </button>
          ))}
        </div>
      </fieldset>
      {errorLine}
      <button className="auth-submit" type="submit" disabled={busy}>
        {busy ? "Saving…" : "Start using Scout"}
      </button>
      <div className="auth-links">
        <button className="auth-link" type="button" disabled={busy} onClick={() => void save("/api/onboarding/about", {}, "That did not go through.")}>
          Skip for now
        </button>
      </div>
    </AuthFrame>
  );
}

function GoogleMark() {
  return (
    <svg className="google-mark" viewBox="0 0 18 18" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}
