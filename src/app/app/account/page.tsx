import { requireWorkspaceUser, workspaceAuthBypassed } from "@/lib/workspace-auth";
import { WorkspaceAppHome } from "@/components/workspace/WorkspaceAppHome";

export const metadata = {
  title: "Anvil Account",
  description: "Account and desktop token management for Anvil.",
};

export default async function WorkspaceAccountPage() {
  const user = await requireWorkspaceUser("/app/account");
  return <WorkspaceAppHome user={user} devMode={workspaceAuthBypassed()} />;
}

