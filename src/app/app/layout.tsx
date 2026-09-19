import type { ReactNode } from "react";

// No layout-level title — each /app/* route owns its own document title
// so the browser tab reads correctly across the workspace, account,
// login, and project pages instead of being forced to "Anvil Account"
// everywhere by the layout.
export const metadata = {
  description: "Anvil — the workshop for AI-generated film.",
};

export default function WorkspaceLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
