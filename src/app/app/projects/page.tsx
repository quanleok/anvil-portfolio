import { requireWorkspaceUser } from "@/lib/workspace-auth";
import { listProjectsForOwner } from "@/server/projects/list";
import { WorkspaceProjectPicker } from "@/components/workspace/WorkspaceProjectPicker";

export const metadata = {
  title: "Projects · Anvil",
  description: "All your Anvil projects.",
};

export default async function WorkspaceProjectsPage() {
  const user = await requireWorkspaceUser("/app/projects");
  const result = await listProjectsForOwner(user.id).catch(() => ({ items: [], nextCursor: null }));
  return <WorkspaceProjectPicker projects={result.items} />;
}
