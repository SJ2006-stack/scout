import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut } from "firebase/auth";
import { apiUrl } from "./backend.ts";

const PROJECT_ID = "scout-b4da3";

export type GoogleSession = { userId: string; phone: string | null; name: string | null; onboarded: boolean };
export type GoogleResult = { ok: true; session: GoogleSession } | { ok: false; error: string | null };

let app: FirebaseApp | null = null;

function firebaseApp(): FirebaseApp | null {
  if (app) return app;
  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY ?? "";
  const appId = import.meta.env.VITE_FIREBASE_APP_ID ?? "";
  if (apiKey.length === 0 || appId.length === 0) return null;
  app = initializeApp({ apiKey, appId, projectId: PROJECT_ID, authDomain: `${PROJECT_ID}.firebaseapp.com` });
  return app;
}

/** Google popup, then Scout trades the Firebase ID token for this person's session cookie. */
export async function signInWithGoogle(): Promise<GoogleResult> {
  const firebase = firebaseApp();
  if (!firebase) return { ok: false, error: "Google sign-in is not set up on this site." };
  const auth = getAuth(firebase);
  let idToken: string;
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    const credential = await signInWithPopup(auth, provider);
    idToken = await credential.user.getIdToken();
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return { ok: false, error: null };
    if (code === "auth/popup-blocked") return { ok: false, error: "Allow pop-ups for this site, then try again." };
    if (code === "auth/unauthorized-domain") return { ok: false, error: "Google sign-in is not allowed on this address yet." };
    return { ok: false, error: "Google sign-in did not finish. Try again." };
  }
  try {
    const response = await fetch(apiUrl("/api/auth/google"), {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const payload = (await response.json()) as { error?: unknown; userId?: unknown; phone?: unknown; name?: unknown; onboarded?: unknown };
    if (!response.ok || typeof payload.userId !== "string") {
      return { ok: false, error: typeof payload.error === "string" ? payload.error : "Scout could not sign you in." };
    }
    return {
      ok: true,
      session: {
        userId: payload.userId,
        phone: typeof payload.phone === "string" ? payload.phone : null,
        name: typeof payload.name === "string" ? payload.name : null,
        onboarded: payload.onboarded === true,
      },
    };
  } catch {
    return { ok: false, error: "Scout could not be reached. Check your connection and try again." };
  } finally {
    await signOut(auth).catch(() => undefined);
  }
}
