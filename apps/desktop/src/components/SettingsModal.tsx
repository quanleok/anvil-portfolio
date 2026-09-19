import { useState, type Dispatch, type KeyboardEvent, type SetStateAction } from "react";
import { Modal } from "./Modal";
import { Field } from "./Field";
import type {
  AccountEntitlement,
  AgentRouteInfo,
  ApiProvider,
  ApiProviderCapability,
  ForgeProjectData,
} from "../types";

export type AgentTestResult = {
  ok: boolean;
  binPath?: string;
  error?: string;
  route?: AgentRouteInfo;
  routeError?: string;
  version?: string;
};
type AgentProvider = { id: string; label: string; installHint: string };
type AgentProviderId = "openclaw" | "hermes";
type SettingsTab = "account" | "agent" | "providers";
type MediaCapability = Extract<ApiProviderCapability, "image" | "video" | "music" | "voice">;
type AgentCapability = Extract<ApiProviderCapability, "text" | "code">;
type ProviderCapability = MediaCapability | AgentCapability;
type CreditMediaCapability = "image" | "video";

const SHOW_ACCOUNT_SETTINGS = false;
const LOCAL_PROVIDERS: AgentProviderId[] = ["openclaw", "hermes"];
const MEDIA_CAPABILITIES: Array<{ id: MediaCapability; label: string; hint: string }> = [
  { id: "image", label: "Image", hint: "Use this key for still/reference generation." },
  { id: "video", label: "Video", hint: "Use this key for rendered clips/takes." },
  { id: "music", label: "Music", hint: "Use this key for score/music generation." },
  { id: "voice", label: "Voice", hint: "Use this key for voice/TTS generation." },
];
const AGENT_CAPABILITIES: Array<{ id: AgentCapability; label: string; hint: string }> = [
  { id: "text", label: "Agent LLM", hint: "Use this key for writing, reasoning, planning, and review." },
  { id: "code", label: "File actions", hint: "Use this provider for tool/file-edit capable agent work." },
];
const FALLBACK_AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: "openclaw",
    label: "OpenClaw gateway",
    installHint: "Uses your local OpenClaw install and its configured local-agent route.",
  },
  {
    id: "hermes",
    label: "Hermes local agent",
    installHint: "Uses your local Hermes runtime.",
  },
];
const ACCOUNT_PRICING_PLANS: Array<{
  id: "free" | "pro";
  name: string;
  yearlyPrice: number | null;
  trialDays?: number;
  recommended?: boolean;
  intro: string;
  features: string[];
}> = [
  {
    id: "free",
    name: "Free",
    yearlyPrice: null,
    intro: "Includes:",
    features: [
      "Local workspace access",
      "Bring your own local agent",
      "Bring your own API keys",
    ],
  },
  {
    id: "pro",
    name: "Anvil Membership",
    yearlyPrice: 99,
    trialDays: 7,
    recommended: true,
    intro: "7-day trial, then:",
    features: [
      "Hosted Anvil agent",
      "Protected workflow methods",
      "Membership usage allowance",
    ],
  },
];
const CREDIT_MODEL_OPTIONS: Record<CreditMediaCapability, Array<{ value: string; label: string }>> = {
  image: [
    { value: "nanobanana-pro", label: "Nano Banana Pro" },
    { value: "gpt-image-2", label: "GPT Image 2" },
  ],
  video: [
    { value: "seedance-2.0", label: "Seedance 2" },
  ],
};
const DEFAULT_CREDIT_MODELS: Record<CreditMediaCapability, string> = {
  image: "nanobanana-pro",
  video: "seedance-2.0",
};
const DEFAULT_HOSTED_AGENT_ENDPOINT = "https://www.myriadanvil.com/api/anvil-agent/turn";

function normalizeAgentProvider(value: string | undefined | null): AgentProviderId {
  return value === "hermes" ? "hermes" : "openclaw";
}

function routeLabel(route: AgentRouteInfo | undefined) {
  if (!route) return "";
  if (route.provider && route.model) return `${route.provider} · ${route.model}`;
  return route.resolvedDefault || route.defaultModel || route.model || "";
}

function showHostedAgentSettings() {
  return false;
}

export function SettingsModal({
  draft,
  setDraft,
  onCancel,
  onSubmit,
  agentProviders,
  accountSignedIn = false,
  accountEmail = "local@anvil.app",
  accountEntitlement = { plan: "free", status: "unknown" },
  onAccountLogin,
  onAccountSignUp,
  onAccountSignOut,
  showAgentSettings = true,
}: {
  draft: ForgeProjectData["settings"];
  setDraft: Dispatch<SetStateAction<ForgeProjectData["settings"]>>;
  onCancel: () => void;
  onSubmit: () => void;
  agentProviders: AgentProvider[];
  accountSignedIn?: boolean;
  accountEmail?: string;
  accountEntitlement?: AccountEntitlement;
  onAccountLogin?: () => void;
  onAccountSignUp?: () => void;
  onAccountSignOut?: () => void;
  showAgentSettings?: boolean;
}) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [agentTesting, setAgentTesting] = useState(false);
  const [agentTestResult, setAgentTestResult] = useState<AgentTestResult | null>(null);
  const effectiveActiveTab: SettingsTab =
    (!SHOW_ACCOUNT_SETTINGS && activeTab === "account") || (!showAgentSettings && activeTab === "agent")
      ? "providers"
      : activeTab;
  const showHostedAgent = showHostedAgentSettings();

  const provider = normalizeAgentProvider(draft.agentProvider);
  const providerCatalog = (agentProviders.length
    ? agentProviders
    : FALLBACK_AGENT_PROVIDERS)
    .filter((p): p is AgentProvider => (LOCAL_PROVIDERS as readonly string[]).includes(p.id))
    .map((p) => {
      if (p.id === "openclaw") {
        return {
          ...p,
          label: p.label || "OpenClaw gateway",
          installHint:
            p.installHint || "Uses your local OpenClaw install and its configured local-agent route.",
        };
      }
      return {
        ...p,
        label: p.label || "Hermes local agent",
        installHint: p.installHint || "Uses your local Hermes runtime.",
      };
    });
  const activeProvider =
    providerCatalog.find((entry) => entry.id === provider) ||
    FALLBACK_AGENT_PROVIDERS.find((entry) => entry.id === provider) ||
    FALLBACK_AGENT_PROVIDERS[0];
  const settingsTabs: Array<{ id: SettingsTab; label: string }> = [
    ...(SHOW_ACCOUNT_SETTINGS ? ([{ id: "account", label: "Account" }] as const) : []),
    ...(showAgentSettings ? ([{ id: "agent", label: "Agent" }] as const) : []),
    { id: "providers", label: "API Keys" },
  ];
  const moveTabFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const currentIndex = settingsTabs.findIndex((tab) => tab.id === effectiveActiveTab);
    const nextIndex = event.key === "ArrowRight"
      ? (currentIndex + 1) % settingsTabs.length
      : (currentIndex - 1 + settingsTabs.length) % settingsTabs.length;
    setActiveTab(settingsTabs[nextIndex].id);
  };

  const runTestConnection = async () => {
    setAgentTesting(true);
    setAgentTestResult(null);
    try {
      const result = await window.forgeDesktop.testAgentConnection({
        provider,
        binPath: draft.agentBinPath || "",
      });
      setAgentTestResult(result);
    } catch (testError) {
      setAgentTestResult({
        ok: false,
        error: testError instanceof Error ? testError.message : String(testError),
      });
    } finally {
      setAgentTesting(false);
    }
  };

  return (
    <Modal
      title="Settings"
      onCancel={onCancel}
      onSubmit={onSubmit}
      submitLabel="Save Settings"
      className="settings-modal-card"
    >
      <div className="settings-tabs" role="tablist" aria-label="Settings sections" onKeyDown={moveTabFocus}>
        {settingsTabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={effectiveActiveTab === tab.id}
            tabIndex={effectiveActiveTab === tab.id ? 0 : -1}
            className={`settings-tab-btn${effectiveActiveTab === tab.id ? " active" : ""}`}
            onClick={() => setActiveTab(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {SHOW_ACCOUNT_SETTINGS && effectiveActiveTab === "account" ? (
        <AccountTab
          draft={draft}
          setDraft={setDraft}
          signedIn={accountSignedIn}
          email={accountEmail}
          entitlement={accountEntitlement}
          onLogin={onAccountLogin}
          onSignUp={onAccountSignUp}
          onSignOut={onAccountSignOut}
        />
      ) : showAgentSettings && effectiveActiveTab === "agent" ? (
        <>
          <div className="settings-install-hint">
            Run Codex, Claude Code, OpenClaw, Hermes, or any local CLI you own in the project terminal.
          </div>

          <label className="field">
            <span>Provider</span>
            <select
              autoComplete="off"
              id="settings-agent-provider"
              name="agent-provider"
              value={provider}
              onChange={(event) => {
                const value = normalizeAgentProvider(event.target.value);
                setDraft((current) => ({ ...current, agentProvider: value }));
                setAgentTestResult(null);
              }}
            >
              {providerCatalog.map((p) => (
                <option key={p.id} value={p.id}>{p.label}</option>
              ))}
            </select>
          </label>
          {activeProvider.installHint ? (
            <div className="settings-field-subhint">{activeProvider.installHint}</div>
          ) : null}

          {showHostedAgent ? (
            <>
              <Field
                label="Hosted endpoint"
                name="remote-agent-url"
                placeholder="https://your-site.com/api/anvil/agent-turn"
                value={draft.remoteAgentUrl || ""}
                onChange={(value) => {
                  setDraft((current) => ({ ...current, remoteAgentUrl: value }));
                  setAgentTestResult(null);
                }}
              />
              <Field
                label="Endpoint token"
                name="remote-agent-token"
                placeholder="Bearer token"
                value={draft.remoteAgentToken || ""}
                onChange={(value) => {
                  setDraft((current) => ({ ...current, remoteAgentToken: value }));
                  setAgentTestResult(null);
                }}
                type="password"
                autoComplete="off"
                revealable
              />
              <div className="settings-field-subhint">
                Developer-only remote agent transport. The launch path stays local-first.
              </div>
            </>
          ) : null}

          <Field
            label="Binary path"
            name="agent-binary-path"
            placeholder="Auto-detected from PATH if blank…"
            value={draft.agentBinPath || ""}
            onChange={(value) => {
              setDraft((current) => ({ ...current, agentBinPath: value }));
              setAgentTestResult(null);
            }}
          />

          <label className={`settings-risk-toggle${draft.agentApprovalMode !== "ask" ? " enabled" : ""}`}>
            <input
              type="checkbox"
              checked={draft.agentApprovalMode !== "ask"}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  agentApprovalMode: event.target.checked ? "autonomous" : "ask",
                  agentBypassPermissions: event.target.checked,
                }))
              }
            />
            <span>
              <strong>Autonomous agent launches</strong>
              <em>Only affects Anvil-launched wrappers. Plain Terminal stays user-controlled.</em>
            </span>
          </label>

          <label className="settings-field">
            <span>Generated media routing</span>
            <select
              value={draft.agentMediaStaging === "inbox" ? "inbox" : "direct"}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  agentMediaStaging: event.target.value === "inbox" ? "inbox" : "direct",
                }))
              }
            >
              <option value="direct">All media by default</option>
              <option value="inbox">Temporary trash/review</option>
            </select>
          </label>
          <div className="settings-field-subhint">
            Untargeted generated media goes to All media. Use temporary trash/review only when you explicitly want a holding lane.
          </div>

          <div className="settings-inline-row">
            <button
              type="button"
              className="sf-btn compact"
              disabled={agentTesting}
              onClick={runTestConnection}
            >
              {agentTesting ? "Testing…" : "Test connection"}
            </button>
            {agentTestResult ? (
              <div
                className={`settings-test-result ${agentTestResult.ok ? "ok" : "err"}`}
                role={agentTestResult.ok ? "status" : "alert"}
                aria-live="polite"
              >
                {agentTestResult.ok ? (
                  <>
                    <span className="dot" aria-hidden>✓</span>
                    <span>
                      {agentTestResult.binPath ? (
                        <>Found at <code>{agentTestResult.binPath}</code></>
                      ) : (
                        <>Connected</>
                      )}
                      {agentTestResult.version ? ` · ${agentTestResult.version}` : ""}
                      {agentTestResult.route ? (
                        <>
                          <br />
                          Route: <code>{routeLabel(agentTestResult.route)}</code>
                        </>
                      ) : agentTestResult.routeError ? (
                        <>
                          <br />
                          Route unavailable: {agentTestResult.routeError}
                        </>
                      ) : provider === "openclaw" ? (
                        <>
                          <br />
                          Route shown after first agent response.
                        </>
                      ) : null}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="dot" aria-hidden>✗</span>
                    <span>{agentTestResult.error}</span>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <ProvidersTab draft={draft} setDraft={setDraft} />
      )}
    </Modal>
  );
}

function AccountTab({
  draft,
  setDraft,
  signedIn,
  email,
  entitlement,
  onLogin,
  onSignUp,
  onSignOut,
}: {
  draft: ForgeProjectData["settings"];
  setDraft: Dispatch<SetStateAction<ForgeProjectData["settings"]>>;
  signedIn: boolean;
  email: string;
  entitlement: AccountEntitlement;
  onLogin?: () => void;
  onSignUp?: () => void;
  onSignOut?: () => void;
}) {
  // Plan id comes from the hosted billing API (Codex 1's `/api/billing/status`).
  // Until that lands the parent feeds a `{plan: "free"}` stub, so the UI
  // is wired correctly the moment real entitlement data is plumbed in.
  const currentPlanId = entitlement.plan === "studio" ? "pro" : entitlement.plan;
  const hostedEndpoint = draft.remoteAgentUrl || DEFAULT_HOSTED_AGENT_ENDPOINT;
  const desktopTokenSaved = draft.remoteAgentTokenSaved === true;
  const desktopTokenConfigured = Boolean(draft.remoteAgentToken?.trim() || desktopTokenSaved);
  const hostedAgentEnabled = draft.remoteAgentEnabled === true;
  const openAccount = (path = "/app") => {
    void window.forgeDesktop.openExternal(`https://www.myriadanvil.com${path}`).catch(() => {
      window.open(`https://www.myriadanvil.com${path}`, "_blank", "noopener,noreferrer");
    });
  };
  const formatPrice = (plan: (typeof ACCOUNT_PRICING_PLANS)[number]) => {
    if (plan.yearlyPrice === null) return "Free";
    return `$${plan.yearlyPrice}/yr.`;
  };
  const choosePlan = (planId: string) => {
    if (planId === currentPlanId) return;
    if (!signedIn) {
      onSignUp?.();
      return;
    }
    openAccount(`/app?plan=${encodeURIComponent(planId)}`);
  };
  const creditRows: Array<{ id: CreditMediaCapability; label: string; hint: string }> = [
    { id: "image", label: "Images", hint: "Reference images, character cards, locations, props, keyframes." },
    { id: "video", label: "Videos", hint: "Rendered clips and ordered prompt takes." },
  ];
  const creditValue = (capability: CreditMediaCapability) => {
    const configured = draft.anvilCredits?.[capability];
    return {
      enabled: configured?.enabled === true,
      model: configured?.model || draft.mediaModels?.[capability] || DEFAULT_CREDIT_MODELS[capability],
    };
  };
  const updateCredit = (
    capability: CreditMediaCapability,
    patch: { enabled?: boolean; model?: string },
  ) => {
    setDraft((current) => {
      const prior = current.anvilCredits?.[capability] || {};
      const model = patch.model || prior.model || current.mediaModels?.[capability] || DEFAULT_CREDIT_MODELS[capability];
      return {
        ...current,
        mediaModels: {
          ...(current.mediaModels || {}),
          [capability]: model,
        },
        anvilCredits: {
          ...(current.anvilCredits || {}),
          [capability]: {
            ...prior,
            ...patch,
            model,
          },
        },
      };
    });
  };

  return (
    <div className="settings-account">
      <div className="settings-account-card">
        <div>
          <span className="settings-account-label">Anvil account</span>
          <strong>{desktopTokenConfigured ? "Desktop token saved" : signedIn ? "Local mode" : "Not signed in"}</strong>
          <p>
            {desktopTokenConfigured
              ? `Hosted Anvil endpoint is configured for this project.`
              : signedIn
                ? `Local session as ${email}. Create a desktop token from the account page to unlock hosted Anvil.`
              : "Sign in to use hosted Anvil agent features and subscription plans."}
          </p>
        </div>
        <div className={`settings-account-status${desktopTokenConfigured || signedIn ? " is-on" : ""}`} aria-hidden />
      </div>

      <section className="settings-credit-card" aria-label="Desktop hosted Anvil connection">
        <div className="settings-credit-head">
          <span className="settings-credit-icon" aria-hidden />
          <div>
            <strong>Desktop connection</strong>
            <p>Create a desktop token on the web account page, then paste it here. The token is encrypted on this machine.</p>
          </div>
        </div>
        <label className="settings-credit-toggle">
          <input
            type="checkbox"
            checked={hostedAgentEnabled}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                remoteAgentEnabled: event.target.checked,
                remoteAgentUrl: current.remoteAgentUrl || DEFAULT_HOSTED_AGENT_ENDPOINT,
              }))
            }
          />
          <span>
            <strong>Use hosted Anvil agent for this project</strong>
            <em>Terminal `anvil` calls will use the protected server when configured.</em>
          </span>
        </label>
        <Field
          label="Endpoint"
          name="anvil-desktop-endpoint"
          value={hostedEndpoint}
          onChange={(value) => setDraft((current) => ({ ...current, remoteAgentUrl: value }))}
        />
        <Field
          label="Desktop token"
          name="anvil-desktop-token"
          placeholder={desktopTokenSaved ? "Saved token - paste a new token to replace" : "avdt_..."}
          value={draft.remoteAgentToken || ""}
          onChange={(value) => setDraft((current) => ({ ...current, remoteAgentToken: value }))}
          type="password"
          autoComplete="off"
          revealable
        />
        <div className="settings-account-actions">
          <button type="button" onClick={() => openAccount("/app")}>
            Open account page
          </button>
          {desktopTokenConfigured ? (
            <button
              type="button"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  remoteAgentToken: "",
                  remoteAgentTokenSaved: false,
                  remoteAgentEnabled: false,
                }))
              }
            >
              Remove token
            </button>
          ) : null}
        </div>
      </section>

      <section className="settings-credit-card" aria-label="Anvil credits">
        <div className="settings-credit-head">
          <span className="settings-credit-icon" aria-hidden />
          <div>
            <strong>Anvil credits</strong>
            <p>Hosted usage controls for Anvil media and method calls.</p>
          </div>
        </div>
        <div className="settings-credit-rows">
          {creditRows.map((row) => {
            const value = creditValue(row.id);
            return (
              <div key={row.id} className="settings-credit-row">
                <label className="settings-credit-toggle">
                  <input
                    type="checkbox"
                    checked={value.enabled}
                    onChange={(event) => updateCredit(row.id, { enabled: event.target.checked })}
                  />
                  <span>
                    <strong>{row.label}</strong>
                    <em>{row.hint}</em>
                  </span>
                </label>
                <select
                  value={value.model}
                  disabled={!value.enabled}
                  onChange={(event) => updateCredit(row.id, { model: event.target.value })}
                  aria-label={`${row.label} credit model`}
                >
                  {CREDIT_MODEL_OPTIONS[row.id].map((model) => (
                    <option key={model.value} value={model.value}>{model.label}</option>
                  ))}
                </select>
              </div>
            );
          })}
        </div>
      </section>

      <div className="settings-account-pricing-head">
        <div>
          <span className="settings-account-label">Individual plans</span>
          <strong>Membership starts with a 7-day trial</strong>
        </div>
      </div>

      <div className="settings-account-plans" aria-label="Pricing plans">
        {ACCOUNT_PRICING_PLANS.map((plan) => {
          const isCurrent = plan.id === currentPlanId;
          const cta = isCurrent
            ? "Current plan"
            : plan.id === "free"
              ? "Use Free"
              : `Get ${plan.name}`;
          return (
            <article
              key={plan.id}
              className={`settings-account-plan-card${plan.recommended ? " recommended" : ""}${isCurrent ? " current" : ""}`}
            >
              <div className="settings-account-plan-top">
                <h4>
                  {plan.name}
                  {plan.recommended ? <span>Recommended</span> : null}
                </h4>
                <div className="settings-account-plan-price">
                  {formatPrice(plan)}
                  {plan.trialDays ? <small>{plan.trialDays}-day trial</small> : null}
                </div>
              </div>
              <p>{plan.intro}</p>
              <ul>
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
              </ul>
              <button
                type="button"
                className={plan.recommended ? "settings-account-plan-cta primary" : "settings-account-plan-cta"}
                disabled={isCurrent}
                onClick={() => choosePlan(plan.id)}
              >
                {cta}
              </button>
            </article>
          );
        })}
      </div>

      <div className="settings-account-actions">
        {signedIn ? (
          <button type="button" className="sf-btn compact" onClick={onSignOut}>
            Sign out
          </button>
        ) : (
          <>
            <button type="button" className="sf-btn compact primary-btn" onClick={onLogin}>
              Log In
            </button>
            <button type="button" className="sf-btn compact" onClick={onSignUp}>
              Sign Up
            </button>
          </>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------
// Providers tab — generic registry. Any external API the user wants the
// local agent to know about (EvoLink, Suno, ElevenLabs, OpenAI, custom
// internal APIs, etc.). Each entry holds a key, optional endpoint, and
// user-pasted docs that the agent reads via `read_provider_docs`.
// ---------------------------------------------------------------------

function deriveEnvVarPlaceholder(label: string): string {
  const source = (label || "").trim();
  if (!source) return "AUTO_FROM_NAME";
  const slug = source.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!slug) return "AUTO_FROM_NAME";
  return slug.endsWith("API_KEY") || slug.endsWith("KEY") || slug.endsWith("TOKEN")
    ? slug
    : `${slug}_API_KEY`;
}

function newProviderTemplate(): ApiProvider {
  const now = new Date().toISOString();
  return {
    id: `provider-${Math.random().toString(36).slice(2, 8)}`,
    label: "",
    capability: "custom",
    capabilities: [],
    endpoint: "",
    apiKey: "",
    envVar: "",
    defaultModel: "",
    docs: "",
    notes: "",
    createdAt: now,
    updatedAt: now,
  };
}

function isEvolinkProvider(provider: ApiProvider | undefined) {
  if (!provider) return false;
  const haystack = [
    provider.id,
    provider.label,
    provider.endpoint,
    provider.envVar,
    provider.docs,
  ].join(" ").toLowerCase();
  return haystack.includes("evolink");
}

function providerCapabilities(provider: ApiProvider): ApiProviderCapability[] {
  const raw = Array.isArray(provider.capabilities) && provider.capabilities.length
    ? provider.capabilities
    : provider.capability
      ? [provider.capability]
      : [];
  const allowed = new Set<ApiProviderCapability>(["image", "video", "music", "voice", "code", "text", "custom"]);
  return Array.from(new Set(raw.filter((cap): cap is ApiProviderCapability => allowed.has(cap as ApiProviderCapability))));
}

function providerCapabilitySummary(provider: ApiProvider) {
  const caps = providerCapabilities(provider).filter((cap): cap is ProviderCapability =>
    cap === "image" || cap === "video" || cap === "music" || cap === "voice" || cap === "text" || cap === "code",
  );
  if (!caps.length) return "Terminal/native unless checked";
  return `External for ${caps.join(", ")}`;
}

function ProvidersTab({
  draft,
  setDraft,
}: {
  draft: ForgeProjectData["settings"];
  setDraft: Dispatch<SetStateAction<ForgeProjectData["settings"]>>;
}) {
  const providers = Array.isArray(draft.apiProviders) ? draft.apiProviders : [];

  const updateProvider = (id: string, patch: Partial<ApiProvider>) => {
    setDraft((current) => {
      const list = Array.isArray(current.apiProviders) ? current.apiProviders : [];
      const next = list.map((entry) =>
        entry.id === id ? { ...entry, ...patch, updatedAt: new Date().toISOString() } : entry,
      );
      return { ...current, apiProviders: next };
    });
  };

  const toggleProviderCapability = (provider: ApiProvider, capability: ProviderCapability) => {
    const current = providerCapabilities(provider).filter((cap) => cap !== "custom");
    const next = current.includes(capability)
      ? current.filter((cap) => cap !== capability)
      : [...current, capability];
    updateProvider(provider.id, {
      capabilities: next,
      capability: next[0] || "custom",
    });
  };

  const addProvider = () => {
    const fresh = newProviderTemplate();
    setDraft((current) => ({
      ...current,
      apiProviders: [...(Array.isArray(current.apiProviders) ? current.apiProviders : []), fresh],
    }));
  };

  const removeProvider = (id: string) => {
    setDraft((current) => {
      const list = Array.isArray(current.apiProviders) ? current.apiProviders : [];
      const removed = list.find((entry) => entry.id === id);
      const apiProviders = list.filter((entry) => entry.id !== id);
      const next: ForgeProjectData["settings"] = {
        ...current,
        apiProviders,
      };

      if (apiProviders.length === 0) {
        next.mediaKeys = {};
        next.mediaModels = {};
        next.evolinkApiKey = "";
        return next;
      }

      if (isEvolinkProvider(removed)) {
        const mediaKeys = { ...(current.mediaKeys || {}) };
        const mediaModels = { ...(current.mediaModels || {}) };
        for (const cap of ["image", "video", "music"] as const) {
          delete mediaKeys[cap];
          delete mediaModels[cap];
        }
        next.mediaKeys = mediaKeys;
        next.mediaModels = mediaModels;
        next.evolinkApiKey = "";
      }

      return next;
    });
  };

  return (
    <div className="settings-providers">
      <div className="settings-install-hint">
        BYOK APIs are optional. Agent LLM keys are for user-owned model access; media keys are for image, video, music, or voice providers. The terminal agent can read this provider setup without seeing stored secret values.
      </div>

      <div className="settings-providers-list">
        {providers.length === 0 ? (
          <div className="settings-providers-empty">
            <strong>No BYOK providers.</strong>
            <span>Run a terminal agent that already has access, or add a provider here.</span>
          </div>
        ) : null}
        {providers.map((provider) => (
          <div key={provider.id} className="settings-provider-card">
            <div className="settings-provider-body">
              <Field
                label="Name"
                value={provider.label}
                onChange={(value) => updateProvider(provider.id, { label: value })}
                autoComplete="off"
                placeholder="EvoLink, OpenAI, Anthropic, …"
              />
              <Field
                label="API key"
                value={provider.apiKey || ""}
                onChange={(value) => updateProvider(provider.id, { apiKey: value })}
                type="password"
                autoComplete="off"
                placeholder="paste key"
                revealable
              />
              <Field
                label="Env var"
                value={provider.envVar || ""}
                onChange={(value) => updateProvider(provider.id, { envVar: value })}
                autoComplete="off"
                placeholder={`${deriveEnvVarPlaceholder(provider.label)} (auto from Name)`}
              />
              <div className="settings-provider-capabilities">
                <div className="settings-provider-capability-head">
                  <span>Use this provider for</span>
                  <em>{providerCapabilitySummary(provider)}</em>
                </div>
                <span className="settings-provider-capability-label">Agent</span>
                <div className="settings-provider-capability-grid">
                  {AGENT_CAPABILITIES.map((capability) => {
                    const checked = providerCapabilities(provider).includes(capability.id);
                    return (
                      <label
                        key={capability.id}
                        className={`settings-provider-capability${checked ? " checked" : ""}`}
                        title={capability.hint}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProviderCapability(provider, capability.id)}
                        />
                        <span>{capability.label}</span>
                      </label>
                    );
                  })}
                </div>
                <span className="settings-provider-capability-label">Media</span>
                <div className="settings-provider-capability-grid">
                  {MEDIA_CAPABILITIES.map((capability) => {
                    const checked = providerCapabilities(provider).includes(capability.id);
                    return (
                      <label
                        key={capability.id}
                        className={`settings-provider-capability${checked ? " checked" : ""}`}
                        title={capability.hint}
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleProviderCapability(provider, capability.id)}
                        />
                        <span>{capability.label}</span>
                      </label>
                    );
                  })}
                </div>
              </div>
              <label className="field">
                <span>Docs</span>
                <textarea
                  rows={8}
                  value={provider.docs || ""}
                  onChange={(e) => updateProvider(provider.id, { docs: e.target.value })}
                  placeholder="Paste endpoint, auth, models, and any notes the agent needs to call this API."
                />
              </label>
              <div className="settings-provider-actions">
                <button
                  type="button"
                  className="settings-provider-delete"
                  onClick={() => removeProvider(provider.id)}
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <button type="button" className="settings-provider-add" onClick={addProvider}>
        + Add provider
      </button>
    </div>
  );
}
