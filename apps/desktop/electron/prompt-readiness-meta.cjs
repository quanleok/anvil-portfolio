function normalizePromptReadinessOverride(value) {
  if (!value || typeof value !== "object") return null;
  const issueKey =
    typeof value.issueKey === "string" && value.issueKey.trim()
      ? value.issueKey.trim()
      : "";
  if (!issueKey || value.state !== "ready") return null;
  const updatedAt =
    typeof value.updatedAt === "string" && value.updatedAt.trim()
      ? value.updatedAt.trim()
      : undefined;
  return updatedAt
    ? { issueKey, state: "ready", updatedAt }
    : { issueKey, state: "ready" };
}

function serializePromptReadinessOverrideMeta(value) {
  const normalized = normalizePromptReadinessOverride(value);
  return {
    readinessOverrideIssueKey: normalized?.issueKey || "",
    readinessOverrideState: normalized?.state || "",
    readinessOverrideUpdatedAt: normalized?.updatedAt || "",
  };
}

function parsePromptReadinessOverrideMeta(meta) {
  if (!meta || typeof meta !== "object") return null;
  return normalizePromptReadinessOverride({
    issueKey: meta.readinessOverrideIssueKey,
    state: meta.readinessOverrideState,
    updatedAt: meta.readinessOverrideUpdatedAt,
  });
}

module.exports = {
  normalizePromptReadinessOverride,
  parsePromptReadinessOverrideMeta,
  serializePromptReadinessOverrideMeta,
};
