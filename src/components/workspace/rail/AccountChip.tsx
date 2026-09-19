"use client";

import Link from "next/link";

import { useWorkspace } from "../WorkspaceProvider";

// Bottom-pinned identity card in the left rail. Click → /app/account.
// When the rail collapses, render the avatar only.

export function AccountChip({ collapsed = false }: { collapsed?: boolean }) {
  const { user } = useWorkspace();
  const initial = (user.email || "?").slice(0, 1).toUpperCase();
  return (
    <Link href="/app/account" className="anvil-workspace-account-chip" title={user.email || "Account"}>
      <span className="anvil-workspace-account-avatar" aria-hidden>
        {initial}
      </span>
      {collapsed ? null : (
        <span className="anvil-workspace-account-email">
          {user.email || "Anvil account"}
        </span>
      )}
    </Link>
  );
}
