import { requireWorkspaceUser } from "@/lib/workspace-auth";
import { BrowserProjectWorkspace } from "@/components/workspace/BrowserProjectWorkspace";

export const metadata = {
  title: "Anvil Project",
  description: "Anvil browser project workspace.",
};

type ProjectPageProps = {
  params: Promise<{ projectId: string }>;
};

export default async function BrowserProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const user = await requireWorkspaceUser(`/app/project/${encodeURIComponent(projectId)}`);
  return <BrowserProjectWorkspace projectId={projectId} user={user} />;
}

