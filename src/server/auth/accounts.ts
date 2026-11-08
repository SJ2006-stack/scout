import { gmailAddress } from "../../shared/onboarding.ts";
import type { Account, UserDirectory } from "../db/userDirectory.ts";

export type SignInResult =
  | { ok: true; userId: string; email: string }
  | { ok: false; status: number; error: string };

/** Scout accounts. Google sign-in is the only way in; the ID token is checked before this runs. */
export class Accounts {
  private readonly directory: UserDirectory;
  private readonly now: () => number;

  constructor(directory: UserDirectory, now: () => number) {
    this.directory = directory;
    this.now = now;
  }

  account(userId: string | null): Account | null {
    if (!userId) return null;
    return this.directory.account(userId);
  }

  sessionForVerifiedGmail(rawEmail: string): SignInResult {
    const email = gmailAddress(rawEmail);
    if (!email) return { ok: false, status: 400, error: "Use a Gmail account." };
    const user = this.directory.ensureEmailUser(email, this.now());
    return { ok: true, userId: user.id, email: user.email };
  }
}
