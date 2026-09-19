"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, type FormEvent } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

function safeNextPath(value: string | null | undefined): string {
  if (!value || typeof value !== "string") return "/app";
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\")) return "/app";
  return value;
}

function safeRequestedPlan(value: string | null | undefined) {
  return value === "pro" || value === "membership" ? "pro" : null;
}

function authConfigErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Auth is not configured.";
  if (message.includes("not configured")) {
    return "Supabase Auth is not configured yet. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to enable real sign in.";
  }
  return message;
}

export function WorkspaceLogin({ devMode = false }: { devMode?: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedPlan = safeRequestedPlan(searchParams.get("plan"));
  const nextPath = searchParams.has("next")
    ? safeNextPath(searchParams.get("next"))
    : requestedPlan
      ? `/app?plan=${requestedPlan}`
      : "/app";
  const errorParam = searchParams.get("error");
  const callbackError =
    errorParam === "auth_callback_failed"
      ? "Could not finish sign in. Try Google again, or use an email link."
      : errorParam === "email_not_allowed"
        ? "Your email isn't on the Anvil early-access list yet. Request access at hello@myriadanvil.com."
        : null;
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [status, setStatus] = useState<string | null>(
    devMode ? "Local dev auth is bypassed. This form is wired for production Supabase auth." : null,
  );
  const [error, setError] = useState<string | null>(callbackError);
  const [busy, setBusy] = useState(false);
  const [emailMode, setEmailMode] = useState(false);

  async function handleGoogleSignIn() {
    if (busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = new URL("/auth/callback", window.location.origin);
      redirectTo.searchParams.set("next", nextPath);
      const { error: oauthError } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirectTo.toString(),
          queryParams: {
            prompt: "select_account",
          },
        },
      });

      if (oauthError) {
        setError(oauthError.message);
        setBusy(false);
      }
    } catch (oauthError) {
      setError(authConfigErrorMessage(oauthError));
      setBusy(false);
    }
  }

  async function handlePasswordSignIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!email.trim() || !password || busy) return;

    setBusy(true);
    setStatus(null);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) {
        setError(signInError.message);
        return;
      }

      router.replace(nextPath);
      router.refresh();
    } catch (signInError) {
      setError(authConfigErrorMessage(signInError));
    } finally {
      setBusy(false);
    }
  }

  async function handleMagicLink() {
    if (!email.trim() || busy) return;
    setBusy(true);
    setStatus(null);
    setError(null);

    try {
      const supabase = createSupabaseBrowserClient();
      const redirectTo = new URL("/auth/callback", window.location.origin);
      redirectTo.searchParams.set("next", nextPath);
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: email.trim(),
        options: {
          emailRedirectTo: redirectTo.toString(),
        },
      });

      if (otpError) {
        setError(otpError.message);
        return;
      }

      setStatus("Check your email for the Anvil sign-in link.");
    } catch (otpError) {
      setError(authConfigErrorMessage(otpError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace-login">
      <form className="workspace-login-panel workspace-login-panel-wide" onSubmit={handlePasswordSignIn}>
        <div className="workspace-login-mark" aria-hidden>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/anvil-logo.png" alt="" draggable={false} />
        </div>
        <h1>Sign in to Anvil Cloud</h1>
        <p className="workspace-login-tagline">Open browser projects, cloud files, and hosted Anvil Agent.</p>

        <div className="workspace-login-plan" aria-label="Anvil subscription plans">
          <div>
            <strong>Browser workspace</strong>
            <span>Projects, markdown docs, media storage, and server-side agent workflow.</span>
          </div>
          <div className="workspace-login-price">Cloud</div>
        </div>

        <button
          className="workspace-login-google"
          type="button"
          disabled={busy}
          onClick={handleGoogleSignIn}
        >
          <span aria-hidden>G</span>
          Continue with Google
        </button>

        {emailMode ? (
          <>
            <div className="workspace-login-divider" aria-hidden>
              <span />
              <em>Sign in with email</em>
              <span />
            </div>

            <div className="workspace-login-fields">
              <input
                autoFocus
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email"
                disabled={busy}
              />
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Password"
                disabled={busy}
              />
            </div>

            {error ? <p className="workspace-login-error">{error}</p> : null}
            {status ? <p className="workspace-login-status">{status}</p> : null}

            <div className="workspace-login-actions">
              <button type="submit" disabled={busy || !email.trim() || !password}>
                Sign in
              </button>
              <button type="button" disabled={busy || !email.trim()} onClick={handleMagicLink}>
                Email link
              </button>
            </div>

            <button
              type="button"
              className="workspace-login-toggle"
              onClick={() => setEmailMode(false)}
              disabled={busy}
            >
              Use Google instead
            </button>
          </>
        ) : (
          <>
            {error ? <p className="workspace-login-error">{error}</p> : null}
            {status ? <p className="workspace-login-status">{status}</p> : null}
            <button
              type="button"
              className="workspace-login-toggle"
              onClick={() => setEmailMode(true)}
              disabled={busy}
            >
              Sign in with email instead
            </button>
          </>
        )}

        {devMode ? (
          <a className="workspace-login-dev-link" href="/app">
            Continue with local dev session
          </a>
        ) : null}
      </form>
    </div>
  );
}
