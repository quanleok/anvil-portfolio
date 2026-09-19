"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { WorkspaceUser } from "@/lib/workspace-auth";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

type BillingStatus = {
  active: boolean;
  billingConfigured: boolean;
  checkoutConfigured: boolean;
  paymentLinksConfigured?: boolean;
  plans: Array<{
    id: "free" | "pro" | "studio";
    label: string;
    priceLabel: string;
    priceDetail: string;
    annualUsd: number;
    trialDays?: number;
    backendAccess: boolean;
    features: string[];
  }>;
  message?: string;
  plan: "free" | "pro" | "studio";
  status: string;
};

type PlanId = BillingStatus["plans"][number]["id"];
type PaidPlanId = Exclude<PlanId, "free">;

// Browser-subscription plan placeholders. The real plan list comes
// from /api/billing/status (server config); this is the local
// fallback shown when billing status is unavailable. Plans are
// framed for the browser cloud product — Anvil covers Claude/OpenAI
// inference plus image/video/audio media generation credits.
// Numbers are placeholders until the user finalizes pricing.
const DEFAULT_PLANS: BillingStatus["plans"] = [
  {
    id: "free",
    label: "Free",
    priceLabel: "$0",
    priceDetail: "per month",
    annualUsd: 0,
    backendAccess: false,
    features: [
      "Browser workspace + cloud project drive",
      "Limited monthly agent turns",
      "Sampler media credits (image / video / audio)",
    ],
  },
  {
    id: "pro",
    label: "Pro",
    priceLabel: "$25",
    priceDetail: "per month",
    annualUsd: 300,
    trialDays: 7,
    backendAccess: true,
    features: [
      "Hosted Anvil Agent",
      "Included image generation credits",
      "Included video generation credits",
      "Included voice + SFX generation credits",
      "Protected Anvil workflow methods",
    ],
  },
  {
    id: "studio",
    label: "Studio",
    priceLabel: "$60",
    priceDetail: "per month",
    annualUsd: 720,
    backendAccess: true,
    features: [
      "Higher hosted Anvil Agent limits",
      "Expanded image generation credits",
      "Expanded video generation credits",
      "Expanded voice + SFX generation credits",
      "Priority protected workflow methods",
    ],
  },
];

export function WorkspaceAppHome({ user, devMode = false }: { user: WorkspaceUser; devMode?: boolean }) {
  const router = useRouter();
  const [billing, setBilling] = useState<BillingStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/billing/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((data) => {
        if (!cancelled) setBilling(data as BillingStatus);
      })
      .catch(() => {
        if (!cancelled) {
          setBilling({
            active: false,
            billingConfigured: false,
            checkoutConfigured: false,
            plans: DEFAULT_PLANS,
            message: "Billing status is not available in this build yet.",
            plan: "free",
            status: "placeholder",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function startCheckout(planId: PaidPlanId) {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ planId, returnUrl: "/app" }),
      });
      const data = await response.json();
      if (!response.ok || !data?.url) {
        setNotice(data?.message || "Checkout is not configured yet.");
        return;
      }
      window.location.href = data.url;
    } catch {
      setNotice("Checkout is not available yet.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setNotice(null);
    try {
      const supabase = createSupabaseBrowserClient();
      await supabase.auth.signOut();
      router.replace("/app/login");
      router.refresh();
    } catch {
      setNotice("Sign out needs Supabase auth config. Local dev session remains active.");
      setBusy(false);
    }
  }

  return (
    <main className="workspace-account-shell">
      <section className="workspace-account-panel">
        {/* No left rail on the account page — this is a settings
            surface, not a project workspace, and the rail's
            Context/Script/Assets/Workshop section icons were all
            disabled here (no project context). A simple "Projects"
            back-link handles re-entry. */}
        <Link className="workspace-account-back" href="/app/projects" title="Back to projects">
          ← Projects
        </Link>
        <header className="workspace-account-head">
          <div>
            <p>Account</p>
            <h1>{user.email}</h1>
          </div>
          <button
            type="button"
            className="workspace-account-signout"
            onClick={signOut}
            disabled={busy || devMode}
          >
            Sign out
          </button>
        </header>

        <div className="workspace-account-grid">
          {(billing?.plans || DEFAULT_PLANS).map((plan) => {
            const isCurrent = billing?.plan === plan.id;
            const checkoutPlanId: PaidPlanId | null = plan.id === "free" ? null : plan.id;
            return (
              <article key={plan.id} className="workspace-account-card">
                <div>
                  <p>{isCurrent ? "Current plan" : plan.label}</p>
                  <h2>{plan.priceLabel}</h2>
                </div>
                <span>{plan.priceDetail}</span>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                {checkoutPlanId ? (
                  <button
                    type="button"
                    className="workspace-account-cta"
                    onClick={() => startCheckout(checkoutPlanId)}
                    disabled={busy || isCurrent}
                  >
                    {isCurrent ? "Current plan" : `Upgrade to ${plan.label}`}
                  </button>
                ) : null}
              </article>
            );
          })}
        </div>

        {notice || billing?.message ? (
          <div className="workspace-account-note">
            {notice || billing?.message}
          </div>
        ) : null}
      </section>
    </main>
  );
}
