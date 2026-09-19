import { Suspense } from "react";
import { workspaceAuthBypassed } from "@/lib/workspace-auth";
import { WorkspaceLogin } from "@/components/workspace/WorkspaceLogin";

export const metadata = {
  title: "Sign In - Anvil",
  description: "Sign in to Anvil Cloud.",
};

export default function WorkspaceLoginPage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceLogin devMode={workspaceAuthBypassed()} />
    </Suspense>
  );
}
