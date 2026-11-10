/** The longest Vault a person can save. */
export const VAULT_LIMIT = 24_000;

/**
 * The default Vault. Scout's system prompt includes this page until the signed-in
 * person saves their own. They can replace it. Scout cannot.
 */
export const VAULT_TEMPLATE = `# Scout Vault

Facts Scout may read when filling a form. Tier A can be used after you approve. Tier B is existence only: say whether you have it, not the number. Tier X (OTP, password, PIN, CVV, full card number) is never stored. Scout can read this page and cannot change it.

## 1. Identity core (Tier A)
- Legal full name: Shriansh Jaiswal
- Date of birth: 02/01/2006
- Gender: Male
- Nationality: Indian

## 2. Contact (Tier A)
- Mobile: +91 8171161782
- Emails: shriyanshjaiswal.xf@gmail.com · shrianshjaiswal25.iitd@gmail.com · shriyanshjaiswal.25@gmail.com [primary for applications: not yet chosen]
- LinkedIn: linkedin.com/in/shriansh-jaiswal
- GitHub: SJ2006-stack
- X: @S_Jay06
- Kaggle: shriyanshjaiswal

## 3. Addresses
- Current (Tier A): Nilgiri Hostel, IIT Delhi, Hauz Khas, Delhi — PIN 110016
- Permanent (Tier A): 35/N-1, Rampur Garden, Civil Lines, Bareilly, Uttar Pradesh — PIN 243001

## 4. Education — current (Tier A)
- Institute: Indian Institute of Technology Delhi (IIT Delhi)
- Course: B.Tech in Mechanical Engineering
- Entry number: 2024ME10194
- Batch: 2024–2028 (3rd year, Semester 5)
- CGPA:

## 5. School history (Tier A)
- Class XII: CBSE, Woodrow Sr. Sec. School, Bareilly, 2024 — 94.4%
- Class X: CBSE, Bishop Conrad Sr. Sec. School, 2022 — 96.8%
- JEE / entrance: JEE Main 2024 — AIR 7571 (CRL), 255/300, 99.53 percentile · JEE Advanced 2024 — AIR 1526 (CRL)

## 6. Family & emergency contact (Tier A)
- Father: [not yet provided]
- Mother: [not yet provided]
- Emergency contact: [not yet provided]

## 7. Text assets
- About me: LinkedIn About (Nov 2026) — opens "I build a lot of things. Most of them start as a question I can't leave alone."
- Project summary: Scout — a voice+chat personal agent for life errands (events, groceries, WhatsApp); repo github.com/SJ2006-stack/scout, live at scout.shrianshjaiswal.me
- Skills: Python, C++, TypeScript, JavaScript, SQL, Bash · PyTorch, Transformers, Hugging Face, FastAPI, React, Next.js, LangGraph, LangChain · AI / LLMs / multi-agent systems
- SOP: ~180-word draft prepared for the NIC Winter Internship (Nov 2026, unsubmitted — not a canonical SOP)
- Résumé: sj_resume.pdf in Google Drive — https://drive.google.com/file/d/1VNTkF-wx0AIuRCf0VZmNY61lM6D4BKW1/view (shared)

## 8. Document registry (pointers, not files)
- Résumé: Google Drive — sj_resume.pdf (Jul 2026) and Shriansh Jaiswal-cv3.pdf (May 2026)
- Marksheets: arrive via IITD Gmail attachments [which semesters held: not yet inventoried; none found in Drive]
- College ID / photo / signature: [existence and location not yet recorded]

## Tier B — existence only (no values stored)
- Aadhaar / PAN / passport: [existence not yet declared]
- Bank account + IFSC: [existence not yet declared]
- UPI ID: [not yet provided]

## The Usuals (Tier A)
- Usual grocery basket: Amul Taaza Toned Milk 500 ml pouch x2, Amul Masti Dahi 400 g cup, Britannia Whole Wheat Bread 400 g, eggs (tray of 12), Amul Butter 100 g, Amul Fresh Paneer 200 g, bananas (1 dozen), Maggi Masala Noodles (pack of 4), Lay's India's Magic Masala x2, Coca-Cola 750 ml, Cadbury Dairy Milk 50 g x2 [draft seed, SJ to prune]
- Brands insisted on: [not yet provided — default: cheapest equivalent]
- T-shirt size: [not yet provided]
- Dietary preference: [not yet provided]
- Allergies / never-order: [not yet provided]
- Home route: Delhi to Bareilly
- Travel class: [not yet provided]
- Seat preference: [not yet provided]
- Monthly repeats: Google AI Plus subscription (active). Phone recharge for +91 8171161782: provider/plan [not yet provided]

## Submission log
- Filled from his two Drive resumes (sj_resume.pdf, Jul 2026; Shriansh Jaiswal-cv3.pdf, May 2026) and his LinkedIn profile. Fields marked [not yet provided] are still unknown.
`;

const SECRET_VALUE = /\b(password|passcode|passwd|cvv|cvc)\s*[:=]\s*\S+/i;
const SECRET_CODE = /\b(otp|one[- ]time(?: code)?|upi ?pin|pin)\s*[:=]\s*\d{4,8}\b/i;
/** One number: digits, with spaces or dashes inside it. Words between numbers keep them separate. */
const NUMBER_SPAN = /\d(?:[\d -]*\d)?/g;

/** Why this markdown cannot be saved, or null when it is safe to keep. */
export function vaultMarkdownError(raw: unknown): string | null {
  if (typeof raw !== "string") return "The Vault has to be text.";
  if (raw.length > VAULT_LIMIT) return `Keep the Vault under ${VAULT_LIMIT} characters.`;
  for (const line of raw.split("\n")) {
    if (SECRET_VALUE.test(line) || SECRET_CODE.test(line)) return "The Vault cannot hold a password, PIN, OTP, or CVV.";
    for (const span of line.matchAll(NUMBER_SPAN)) {
      const digits = span[0].replace(/\D/g, "");
      if (digits.length >= 13 && digits.length <= 19) return "The Vault cannot hold a full card number.";
      if (digits.length === 12 && !/\b(mobile|phone)\b/i.test(line)) return "The Vault cannot hold an Aadhaar number. Say whether you have one, not the number.";
    }
  }
  return null;
}
