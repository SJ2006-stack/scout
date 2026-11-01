export type OnboardingStep = "email" | "phone" | "name" | "ready";

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

export function onboardingStep(profile: { signedIn: boolean; phone: string | null; name: string | null }): OnboardingStep {
  if (!profile.signedIn) return "email";
  if (profile.phone == null || profile.phone.length === 0) return "phone";
  if (profile.name == null || profile.name.length === 0) return "name";
  return "ready";
}
