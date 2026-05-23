"use client";

// /admin — sign-in form that unlocks the dev affordances (the 🧪 DEV
// button in the header + the After-hours testing mode toggle). Hardcoded
// credentials: admin / pass (matches the user's OpenEMR convention).
//
// NOT a security boundary. See app/src/lib/adminMode.ts for the rationale —
// the affordance behind this gate only flips client-side UI checks, the
// on-chain program already permits the underlying transactions. The
// password is intentionally committed into the client bundle.
//
// Why /admin instead of an icon menu off the header: an unauthenticated
// landing page should not telegraph "we have a hidden admin mode" to
// random visitors. Anyone who knows to visit /admin already knows the
// affordance exists.

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

import {
  ADMIN_PASSWORD,
  ADMIN_USERNAME,
  isAdminEnabled,
  setAdminEnabled,
} from "@/lib/adminMode";

export const dynamic = "force-dynamic";

export default function AdminPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Read the current flag after mount so we can show a different layout
  // for already-signed-in users (sign-out button instead of a form). SSR
  // safe because the initial render is the unsigned-in layout.
  const [alreadyIn, setAlreadyIn] = useState(false);
  useEffect(() => {
    setAlreadyIn(isAdminEnabled());
  }, []);

  function submit(e: FormEvent) {
    e.preventDefault();
    // Trim leading/trailing whitespace — common paste-in problem with
    // password managers — but be exact otherwise. No case-insensitivity:
    // "Admin" should not work where "admin" does, so the user has clear
    // feedback when they typo.
    if (username.trim() === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
      setAdminEnabled(true);
      // Bounce to /markets — the most likely place the user wants to go
      // after unlocking the dev toggle. Use router.push so client state
      // (incl. the just-set localStorage flag) carries forward.
      router.push("/markets");
    } else {
      setError("Invalid credentials. Try admin / pass.");
    }
  }

  function signOut() {
    setAdminEnabled(false);
    setAlreadyIn(false);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-stretch gap-6 px-6 py-16">
      <header className="text-center">
        <h1 className="text-2xl font-bold tracking-tight">Admin sign-in</h1>
        <p className="mt-2 text-sm text-muted">
          Unlocks dev affordances on the deployed app (the 🧪 DEV button + after-hours testing
          mode).
        </p>
      </header>

      {alreadyIn ? (
        <section className="rounded-2xl border border-yes/40 bg-yes/5 p-6 text-center">
          <p className="mb-3 text-sm text-text">
            <span className="font-semibold text-yes">Already signed in.</span> The 🧪 DEV button
            should be visible in the header.
          </p>
          <button
            type="button"
            onClick={signOut}
            className="rounded-lg border border-no/40 bg-no/10 px-3 py-1.5 text-sm font-semibold text-no hover:bg-no/20"
          >
            Sign out
          </button>
        </section>
      ) : (
        <form onSubmit={submit} className="rounded-2xl border border-panel bg-panel/40 p-6">
          <label className="mb-3 block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
              Username
            </span>
            <input
              type="text"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full rounded-lg border border-panel bg-bg px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
              placeholder="admin"
            />
          </label>
          <label className="mb-4 block text-sm">
            <span className="mb-1 block text-xs uppercase tracking-wider text-muted">
              Password
            </span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full rounded-lg border border-panel bg-bg px-3 py-2 font-mono text-sm text-text focus:border-accent focus:outline-none"
              placeholder="pass"
            />
          </label>
          {error && (
            <p className="mb-3 rounded-md border border-no/40 bg-no/10 p-2 text-xs text-no">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="w-full rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-white hover:bg-accentHover"
          >
            Sign in
          </button>
          <p className="mt-3 text-center text-[11px] text-muted">
            Hint: admin / pass.{" "}
            <span className="text-muted/80">This is not a security boundary.</span>
          </p>
        </form>
      )}
    </main>
  );
}
