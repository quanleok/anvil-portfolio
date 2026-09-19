import { createElement, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { AnvilMark } from "./AnvilMark";
import { useReducedMotion } from "../hooks/useReducedMotion";

type DesktopLoginGateProps = {
  appVersion: { version: string; build: string; commitCount?: number; appName?: string; variant?: string } | null;
  onLogin: () => void;
  onSignUp: () => void;
  onConnectToken: (token: string) => Promise<void>;
  busy?: boolean;
  error?: string | null;
  status?: string | null;
};

type ModelViewerAttrs = {
  src: string;
  alt: string;
  className?: string;
  "auto-rotate"?: boolean;
  "auto-rotate-delay"?: string | number;
  "rotation-per-second"?: string;
  "camera-controls"?: boolean;
  "disable-zoom"?: boolean;
  "disable-pan"?: boolean;
  "interaction-prompt"?: string;
  "shadow-intensity"?: string | number;
  "shadow-softness"?: string | number;
  "environment-image"?: string;
  exposure?: string | number;
  "camera-orbit"?: string;
  "field-of-view"?: string;
  style?: CSSProperties;
};

const MODEL_VIEWER_SCRIPT_SRC = "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";

function ModelViewer(props: ModelViewerAttrs) {
  const flattened: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === undefined || value === null) continue;
    flattened[key] = value === true ? "" : value;
  }
  return createElement("model-viewer", flattened);
}

export function DesktopLoginGate({
  appVersion,
  onLogin,
  onSignUp,
  onConnectToken,
  busy = false,
  error = null,
  status = null,
}: DesktopLoginGateProps) {
  const reducedMotion = useReducedMotion();
  const versionText = appVersion?.version ? `v${appVersion.version}` : "Local preview";
  const [token, setToken] = useState("");
  const [modelViewerReady, setModelViewerReady] = useState(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.customElements?.get("model-viewer"));
  });
  const [modelViewerFailed, setModelViewerFailed] = useState(false);
  const modelSrc = useMemo(() => {
    if (typeof window === "undefined") return "anvil.glb";
    return new URL("anvil.glb", window.location.href).toString();
  }, []);

  function handleTokenSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanToken = token.trim();
    if (!cleanToken || busy) return;
    void onConnectToken(cleanToken);
  }

  useEffect(() => {
    if (window.customElements?.get("model-viewer")) {
      return;
    }

    let cancelled = false;
    const existing = document.querySelector<HTMLScriptElement>("script[data-anvil-model-viewer]");
    const onReady = () => {
      if (!cancelled) setModelViewerReady(true);
    };
    const onError = () => {
      if (!cancelled) setModelViewerFailed(true);
    };

    if (existing) {
      existing.addEventListener("load", onReady, { once: true });
      existing.addEventListener("error", onError, { once: true });
      return () => {
        cancelled = true;
        existing.removeEventListener("load", onReady);
        existing.removeEventListener("error", onError);
      };
    }

    const script = document.createElement("script");
    script.type = "module";
    script.src = MODEL_VIEWER_SCRIPT_SRC;
    script.crossOrigin = "anonymous";
    script.dataset.anvilModelViewer = "true";
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.appendChild(script);

    return () => {
      cancelled = true;
      script.removeEventListener("load", onReady);
      script.removeEventListener("error", onError);
    };
  }, []);

  return (
    <main className="desktop-auth-shell" aria-label="Anvil sign in">
      <section className="desktop-auth-window">
        <div className="desktop-auth-dots" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="desktop-auth-stage">
          <div className="desktop-auth-logo-scene" aria-hidden>
            <div className="desktop-auth-logo-shadow" />
            <div className={`desktop-auth-logo-fallback${modelViewerReady && !modelViewerFailed ? " is-hidden" : ""}`}>
              <AnvilMark size={142} variant="static" />
            </div>
            {modelViewerReady && !modelViewerFailed ? (
              <ModelViewer
                src={modelSrc}
                alt="Anvil"
                className="desktop-auth-model-viewer"
                auto-rotate={!reducedMotion}
                auto-rotate-delay={2500}
                rotation-per-second="18deg"
                camera-controls
                disable-zoom
                disable-pan
                interaction-prompt="none"
                shadow-intensity={1.4}
                shadow-softness={0.85}
                environment-image="neutral"
                exposure={1.05}
                camera-orbit="-22deg 80deg auto"
                field-of-view="22deg"
                style={{
                  width: "100%",
                  height: "100%",
                  backgroundColor: "transparent",
                }}
              />
            ) : null}
          </div>

          <div className="desktop-auth-copy">
            <p className="desktop-auth-kicker">{versionText}</p>
            <h1>ANVIL</h1>
            <p>Account tools are paused for the free local launch.</p>
          </div>

          <div className="desktop-auth-actions" aria-label="Account actions">
            <button type="button" className="desktop-auth-primary" onClick={onLogin} disabled={busy}>
              Continue with Google
            </button>
            <button type="button" className="desktop-auth-secondary" onClick={onSignUp} disabled={busy}>
              Create account
            </button>
          </div>

          <form className="desktop-auth-token-form" onSubmit={handleTokenSubmit}>
            <label>
              Desktop token
              <input
                value={token}
                onChange={(event) => setToken(event.target.value)}
                placeholder="Paste token from Anvil account page"
                autoComplete="off"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <button type="submit" disabled={busy || !token.trim()}>
              {busy ? "Checking..." : "Connect account"}
            </button>
          </form>

          {error ? <p className="desktop-auth-error">{error}</p> : null}
          {status ? <p className="desktop-auth-status">{status}</p> : null}
        </div>
      </section>
    </main>
  );
}
