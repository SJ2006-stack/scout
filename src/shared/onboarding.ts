import { CITIES, cityFromPincode, cityFromText } from "./cities.ts";
import type { EventKind } from "./event.ts";

export type OnboardingStep = "google" | "phone" | "name" | "about" | "accounts" | "ready";

/** A site Scout signs in to for the user. id is the browser skill, domain the vault key. */
export type Connector = {
  id: "blinkit" | "zepto" | "instamart" | "bookmyshow" | "district" | "luma";
  name: string;
  domain: string;
  uses: "phone" | "email" | "phone or email";
};

export const CONNECTOR_GROUPS: readonly { scout: string; connectors: readonly Connector[] }[] = [
  {
    scout: "Shop Scout",
    connectors: [
      { id: "blinkit", name: "Blinkit", domain: "blinkit.com", uses: "phone" },
      { id: "zepto", name: "Zepto", domain: "zepto.com", uses: "phone" },
      { id: "instamart", name: "Instamart", domain: "swiggy.com", uses: "phone" },
    ],
  },
  {
    scout: "Event Scout",
    connectors: [
      { id: "bookmyshow", name: "BookMyShow", domain: "bookmyshow.com", uses: "phone or email" },
      { id: "district", name: "District", domain: "district.in", uses: "phone" },
      { id: "luma", name: "Luma", domain: "luma.com", uses: "email" },
    ],
  },
];

export const PLAN_PROMPT = "What's the plan?";

export function gmailAddress(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (email.length === 0 || email.length > 254) return null;
  if (!/^[a-z0-9._%+-]+@(gmail|googlemail)\.com$/.test(email)) return null;
  return email;
}

export function indianMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91")
    ? digits.slice(2)
    : digits.length === 11 && digits.startsWith("0")
      ? digits.slice(1)
      : digits;
  if (!/^[6-9]\d{9}$/.test(local)) return null;
  return `+91${local}`;
}

export function preferredName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > 40) return null;
  if (!/^[\p{L}][\p{L} .'-]*$/u.test(name)) return null;
  return name;
}

export function onboardingStep(profile: { signedIn: boolean; phone: string | null; name: string | null; aboutDone: boolean; onboarded: boolean }): OnboardingStep {
  if (!profile.signedIn) return "google";
  if (profile.phone == null || profile.phone.length === 0) return "phone";
  if (profile.name == null || profile.name.length === 0) return "name";
  if (profile.onboarded) return "ready";
  if (!profile.aboutDone) return "about";
  return "accounts";
}

export const ABOUT_CITIES: readonly { id: string; name: string }[] = CITIES.map((city) => ({ id: city.id, name: city.name }));

export const DIETS = [
  { id: "veg", label: "Vegetarian" },
  { id: "eggetarian", label: "Eggetarian" },
  { id: "non-veg", label: "Non-veg" },
  { id: "vegan", label: "Vegan" },
  { id: "jain", label: "Jain" },
] as const;

export const EVENT_INTERESTS: readonly { id: Exclude<EventKind, "other">; label: string }[] = [
  { id: "concert", label: "Music" },
  { id: "comedy", label: "Comedy" },
  { id: "movie", label: "Movies" },
  { id: "theatre", label: "Theatre" },
  { id: "workshop", label: "Workshops" },
];

export const REPLY_LANGUAGES = ["English", "Hinglish", "Hindi"] as const;

export type AboutAnswers = { city?: string; pincode?: string; diet?: string | readonly string[]; interests?: string[]; language?: string };

/** Profile entries Scout keeps from the about step. Unknown or empty answers are dropped. */
export type AboutEntries = Partial<Record<"city" | "home_area" | "diet" | "event_kinds" | "language", string>>;

export function aboutEntries(answers: AboutAnswers): { ok: true; entries: AboutEntries } | { ok: false; error: string } {
  const entries: AboutEntries = {};
  const pincode = (answers.pincode ?? "").replace(/\s/g, "");
  if (pincode.length > 0) {
    if (!/^[1-9]\d{5}$/.test(pincode)) return { ok: false, error: "Enter a 6-digit pincode." };
    entries.home_area = pincode;
  }
  const cityText = (answers.city ?? "").trim().replace(/\s+/g, " ");
  if (cityText.length > 40 || (cityText.length > 0 && !/^[\p{L}][\p{L} .'-]*$/u.test(cityText))) return { ok: false, error: "Enter a city name." };
  const known = cityText.length > 0 ? cityFromText(cityText) : cityFromPincode(pincode);
  if (known) entries.city = known.id;
  else if (cityText.length > 0) entries.city = cityText;
  const chosen = Array.isArray(answers.diet) ? answers.diet : answers.diet ? [answers.diet] : [];
  const diets = DIETS.filter((option) => chosen.includes(option.id));
  if (diets.length > 0) entries.diet = diets.map((option) => option.label).join(", ");
  const interests = EVENT_INTERESTS.filter((option) => answers.interests?.includes(option.id));
  if (interests.length > 0) entries.event_kinds = interests.map((option) => option.id).join(", ");
  const language = REPLY_LANGUAGES.find((option) => option === answers.language);
  if (language) entries.language = language;
  return { ok: true, entries };
}
