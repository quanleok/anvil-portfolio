import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./App";
import "./styles.css";

class RendererErrorBoundary extends React.Component<
  React.PropsWithChildren,
  { errorMessage: string | null }
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { errorMessage: null };
  }

  static getDerivedStateFromError(error: unknown) {
    return {
      errorMessage: error instanceof Error ? error.message : "Renderer crashed.",
    };
  }

  componentDidCatch(error: unknown) {
    console.error("Forge renderer crashed", error);
  }

  render() {
    if (this.state.errorMessage) {
      return (
        <div
          style={{
            minHeight: "100vh",
            background: "#0b0e12",
            color: "#f4f7fb",
            padding: "32px",
            fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
          }}
        >
          <p
            style={{
              color: "#92a0af",
              fontSize: "12px",
              letterSpacing: "0.18em",
              margin: 0,
              textTransform: "uppercase",
            }}
          >
            Forge Desktop
          </p>
          <h1 style={{ fontSize: "32px", lineHeight: 1.05, margin: "12px 0 0" }}>
            Renderer error
          </h1>
          <p style={{ color: "#a2acb7", lineHeight: 1.6, maxWidth: "720px" }}>
            The UI hit a render exception instead of failing silently to a black window.
            Restart the app after the fix lands. Current error: {this.state.errorMessage}
          </p>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>,
);
