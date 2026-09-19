import { requireWorkspaceUser } from "@/lib/workspace-auth";
import { WorkspaceProjectBootstrap } from "@/components/workspace/WorkspaceProjectBootstrap";

export const metadata = {
  title: "Anvil",
  description: "Anvil browser workspace.",
};

export default async function BrowserAppPage() {
  await requireWorkspaceUser("/app");
  return <WorkspaceProjectBootstrap />;
}
