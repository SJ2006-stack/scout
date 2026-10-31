const PICTOGRAPH = /\p{Extended_Pictographic}/u;

const RULES: { test: RegExp; emoji: string }[] = [
  { test: /sign-?in code|otp|approve it on your phone/i, emoji: "🔐" },
  { test: /not charged|expired|outside the approved|quote changed/i, emoji: "⚠️" },
  { test: /register/i, emoji: "✅" },
  { test: /upi|pay link|pay page|payment qr/i, emoji: "💳" },
  { test: /comedy|standup|stand-up/i, emoji: "😂" },
  { test: /music|concert|gig/i, emoji: "🎵" },
  { test: /movie|film|cinema/i, emoji: "🎬" },
  { test: /workshop/i, emoji: "🛠️" },
  { test: /dosa|restaurant|dinner|lunch|breakfast/i, emoji: "🍽️" },
  { test: /blinkit|zepto|instamart|grocery|milk/i, emoji: "🛒" },
  { test: /cheapest/i, emoji: "🏷️" },
  { test: /cab|airport|\btrip\b|fare/i, emoji: "🚕" },
  { test: /haircut|appointment/i, emoji: "💈" },
  { test: /nothing matched|could not|couldn't|can't|cannot|unavailable|not connected/i, emoji: "🤔" },
  { test: /which city|look in/i, emoji: "📍" },
  { test: /tomorrow|tonight|today|weekend|happening/i, emoji: "📅" },
  { test: /thank/i, emoji: "🙏" },
  { test: /^(?:hi|hey|hello)\b/i, emoji: "👋" },
];

export function hasEmoji(text: string): boolean {
  return PICTOGRAPH.test(text);
}

export function stripEmoji(text: string): string {
  return text.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ").replace(/[ \t]{2,}/g, " ").trim();
}

export function withEmoji(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || hasEmoji(trimmed)) return text;
  const match = RULES.find((rule) => rule.test.test(trimmed));
  return `${match?.emoji ?? "✨"} ${trimmed}`;
}
