import { useEffect, useMemo, useState } from "react";
import { Modal } from "./Modal";
import type {
  SkillAddonGroupId,
  SkillLibraryEntry,
  SkillLibraryPayload,
} from "../types";

interface SkillLibraryModalProps {
  disabledSkills: string[];
  enabledSkillAddons: SkillAddonGroupId[];
  onCancel: () => void;
  onSaveSkillSettings: (payload: { enabledSkillAddons: SkillAddonGroupId[]; disabledSkills: string[] }) => Promise<void>;
  projectDir: string;
}

export function SkillLibraryModal({
  disabledSkills,
  enabledSkillAddons,
  onCancel,
  onSaveSkillSettings,
  projectDir,
}: SkillLibraryModalProps) {
  const [skillLibrary, setSkillLibrary] = useState<SkillLibraryPayload | null>(null);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [selectedSkillSlug, setSelectedSkillSlug] = useState("");
  const [skillMarkdown, setSkillMarkdown] = useState("");
  const [skillEditorStatus, setSkillEditorStatus] = useState("");
  const [skillSaving, setSkillSaving] = useState(false);
  const [librarySaving, setLibrarySaving] = useState(false);
  const [draftEnabledAddons, setDraftEnabledAddons] = useState<SkillAddonGroupId[]>(enabledSkillAddons);
  const [draftDisabledSkills, setDraftDisabledSkills] = useState<string[]>(disabledSkills);

  useEffect(() => {
    setDraftEnabledAddons(enabledSkillAddons);
  }, [enabledSkillAddons]);

  useEffect(() => {
    setDraftDisabledSkills(disabledSkills);
  }, [disabledSkills]);

  const addonGroupIds = useMemo(
    () =>
      (skillLibrary?.groups || [])
        .filter((group) => group.kind === "addon")
        .map((group) => group.id as SkillAddonGroupId),
    [skillLibrary],
  );
  const normalizedEnabledAddons = useMemo(
    () =>
      draftEnabledAddons.filter((id): id is SkillAddonGroupId =>
        addonGroupIds.length ? addonGroupIds.includes(id as SkillAddonGroupId) : true,
      ),
    [addonGroupIds, draftEnabledAddons],
  );
  const normalizedDisabledSkills = useMemo(() => {
    const available = new Set((skillLibrary?.skills || []).map((skill) => skill.slug));
    const seen = new Set<string>();
    for (const slug of draftDisabledSkills) {
      const clean = String(slug || "").trim();
      if (!clean || (available.size && !available.has(clean))) continue;
      seen.add(clean);
    }
    return [...seen];
  }, [draftDisabledSkills, skillLibrary]);
  const selectedSkill = useMemo<SkillLibraryEntry | null>(() => {
    if (!skillLibrary) return null;
    return skillLibrary.skills.find((skill) => skill.slug === selectedSkillSlug) || skillLibrary.skills[0] || null;
  }, [selectedSkillSlug, skillLibrary]);

  useEffect(() => {
    let cancelled = false;
    setSkillsLoading(true);
    setSkillEditorStatus("");
    window.forgeDesktop.listSkillLibrary(projectDir)
      .then((library) => {
        if (cancelled) return;
        setSkillLibrary(library);
        setSelectedSkillSlug((current) => {
          const currentSkill = library.skills.find((skill) => skill.slug === current);
          if (currentSkill) return current;
          return library.skills[0]?.slug || "";
        });
      })
      .catch((error) => {
        if (cancelled) return;
        setSkillEditorStatus(error instanceof Error ? error.message : "Failed to load skill library.");
      })
      .finally(() => {
        if (!cancelled) setSkillsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  useEffect(() => {
    if (!selectedSkillSlug) return;
    let cancelled = false;
    setSkillEditorStatus("");
    window.forgeDesktop.readSkillMarkdown(projectDir, selectedSkillSlug)
      .then((result) => {
        if (!cancelled) setSkillMarkdown(result.content);
      })
      .catch((error) => {
        if (!cancelled) {
          setSkillMarkdown("");
          setSkillEditorStatus(error instanceof Error ? error.message : "Failed to read skill.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir, selectedSkillSlug]);

  const toggleSkillAddonGroup = (groupId: SkillAddonGroupId, checked: boolean) => {
    setDraftEnabledAddons((current) =>
      checked
        ? [...new Set([...current, groupId])]
        : current.filter((id) => id !== groupId),
    );
  };

  const toggleSkill = (slug: string, checked: boolean) => {
    setDraftDisabledSkills((current) =>
      checked
        ? current.filter((entry) => entry !== slug)
        : [...new Set([...current, slug])],
    );
  };

  const saveSelectedSkill = async () => {
    if (!selectedSkill) return;
    setSkillSaving(true);
    setSkillEditorStatus("");
    try {
      await window.forgeDesktop.writeSkillMarkdown(projectDir, selectedSkill.slug, skillMarkdown);
      setSkillEditorStatus("Saved.");
      const library = await window.forgeDesktop.listSkillLibrary(projectDir);
      setSkillLibrary(library);
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to save skill.");
    } finally {
      setSkillSaving(false);
    }
  };

  const resetSelectedSkill = async () => {
    if (!selectedSkill) return;
    setSkillSaving(true);
    setSkillEditorStatus("");
    try {
      const result = await window.forgeDesktop.resetSkillMarkdown(projectDir, selectedSkill.slug);
      setSkillMarkdown(result.content);
      setSkillEditorStatus("Reset to default.");
      const library = await window.forgeDesktop.listSkillLibrary(projectDir);
      setSkillLibrary(library);
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to reset skill.");
    } finally {
      setSkillSaving(false);
    }
  };

  const enableCustomAddonDraft = () => {
    setDraftEnabledAddons((current) =>
      current.includes("custom") ? current : [...current, "custom"],
    );
  };

  const reloadSkillLibrary = async (selectSlug?: string) => {
    const library = await window.forgeDesktop.listSkillLibrary(projectDir);
    setSkillLibrary(library);
    if (selectSlug) setSelectedSkillSlug(selectSlug);
    return library;
  };

  const createCustomSkill = async () => {
    const name = window.prompt("Custom skill name");
    const cleanName = name?.trim();
    if (!cleanName) return;
    setSkillSaving(true);
    setSkillEditorStatus("");
    try {
      const result = await window.forgeDesktop.createCustomSkill(projectDir, cleanName);
      enableCustomAddonDraft();
      await reloadSkillLibrary(result.slug);
      setSkillMarkdown(result.content);
      setSkillEditorStatus("Custom skill created. Save Skills to keep it enabled for the agent.");
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to create custom skill.");
    } finally {
      setSkillSaving(false);
    }
  };

  const importSkillMarkdown = async () => {
    setSkillSaving(true);
    setSkillEditorStatus("");
    try {
      const result = await window.forgeDesktop.importSkillMarkdown(projectDir);
      if (result.canceled || !result.imported.length) {
        setSkillEditorStatus("");
        return;
      }
      enableCustomAddonDraft();
      await reloadSkillLibrary(result.imported[0].slug);
      setSkillEditorStatus(
        `Imported ${result.imported.length} skill${result.imported.length === 1 ? "" : "s"}. Save Skills to keep Custom enabled for the agent.`,
      );
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to import skill.");
    } finally {
      setSkillSaving(false);
    }
  };

  const exportSelectedSkill = async () => {
    if (!selectedSkill) return;
    setSkillSaving(true);
    setSkillEditorStatus("");
    try {
      const result = await window.forgeDesktop.exportSkillMarkdown(projectDir, selectedSkill.slug);
      if (result.canceled) return;
      setSkillEditorStatus(result.path ? `Exported to ${result.path}.` : "Exported.");
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to export skill.");
    } finally {
      setSkillSaving(false);
    }
  };

  const saveLibrary = async () => {
    setLibrarySaving(true);
    setSkillEditorStatus("");
    try {
      await onSaveSkillSettings({
        enabledSkillAddons: normalizedEnabledAddons,
        disabledSkills: normalizedDisabledSkills,
      });
      setSkillEditorStatus("Library saved.");
    } catch (error) {
      setSkillEditorStatus(error instanceof Error ? error.message : "Failed to save skill library.");
    } finally {
      setLibrarySaving(false);
    }
  };

  return (
    <Modal
      title="Anvil Skills"
      onCancel={onCancel}
      onSubmit={saveLibrary}
      submitLabel={librarySaving ? "Saving…" : "Save Skills"}
      submitDisabled={librarySaving}
      className="settings-modal-card skill-library-modal-card"
    >
      <SkillsTab
        draftEnabledAddons={normalizedEnabledAddons}
        draftDisabledSkills={normalizedDisabledSkills}
        loading={skillsLoading}
        onChangeMarkdown={setSkillMarkdown}
        onCreateCustomSkill={createCustomSkill}
        onExportSkill={exportSelectedSkill}
        onImportSkill={importSkillMarkdown}
        onResetSkill={resetSelectedSkill}
        onSaveSkill={saveSelectedSkill}
        onSelectSkill={setSelectedSkillSlug}
        onToggleAddon={toggleSkillAddonGroup}
        onToggleSkill={toggleSkill}
        saving={skillSaving}
        selectedSkill={selectedSkill}
        selectedSkillSlug={selectedSkillSlug}
        skillLibrary={skillLibrary}
        skillMarkdown={skillMarkdown}
        status={skillEditorStatus}
      />
    </Modal>
  );
}

function SkillsTab({
  draftEnabledAddons,
  draftDisabledSkills,
  loading,
  onChangeMarkdown,
  onCreateCustomSkill,
  onExportSkill,
  onImportSkill,
  onResetSkill,
  onSaveSkill,
  onSelectSkill,
  onToggleAddon,
  onToggleSkill,
  saving,
  selectedSkill,
  selectedSkillSlug,
  skillLibrary,
  skillMarkdown,
  status,
}: {
  draftEnabledAddons: SkillAddonGroupId[];
  draftDisabledSkills: string[];
  loading: boolean;
  onChangeMarkdown: (value: string) => void;
  onCreateCustomSkill: () => void;
  onExportSkill: () => void;
  onImportSkill: () => void;
  onResetSkill: () => void;
  onSaveSkill: () => void;
  onSelectSkill: (slug: string) => void;
  onToggleAddon: (groupId: SkillAddonGroupId, checked: boolean) => void;
  onToggleSkill: (slug: string, checked: boolean) => void;
  saving: boolean;
  selectedSkill: SkillLibraryEntry | null;
  selectedSkillSlug: string;
  skillLibrary: SkillLibraryPayload | null;
  skillMarkdown: string;
  status: string;
}) {
  const groups = useMemo(() => skillLibrary?.groups || [], [skillLibrary]);
  const visibleGroups = useMemo(
    () => groups.filter((group) => group.skillCount > 0),
    [groups],
  );
  const [activeGroupId, setActiveGroupId] = useState<SkillLibraryGroupId>("cinematic");
  const activeGroup = visibleGroups.find((group) => group.id === activeGroupId) || visibleGroups[0] || null;
  const activeGroupEnabled = activeGroup
    ? Boolean(activeGroup.defaultEnabled) || draftEnabledAddons.includes(activeGroup.id as SkillAddonGroupId)
    : false;
  const enabledCountForGroup = (group: SkillLibraryPayload["groups"][number]) => {
    const groupEnabled = Boolean(group.defaultEnabled) || draftEnabledAddons.includes(group.id as SkillAddonGroupId);
    if (!groupEnabled) return 0;
    return group.skills.filter((skill) => !draftDisabledSkills.includes(skill.slug)).length;
  };
  const selectedSkillDisabled = Boolean(
    selectedSkill && (
      !(
        visibleGroups.find((group) => group.id === selectedSkill.groupId)?.defaultEnabled ||
        draftEnabledAddons.includes(selectedSkill.groupId as SkillAddonGroupId)
      ) ||
      draftDisabledSkills.includes(selectedSkill.slug)
    ),
  );

  useEffect(() => {
    if (selectedSkill) {
      window.queueMicrotask(() => setActiveGroupId(selectedSkill.groupId));
      return;
    }
    const firstSkill = visibleGroups.flatMap((group) => group.skills)[0];
    if (firstSkill) onSelectSkill(firstSkill.slug);
  }, [onSelectSkill, selectedSkill, visibleGroups]);

  useEffect(() => {
    if (!visibleGroups.length) return;
    if (!visibleGroups.some((group) => group.id === activeGroupId)) {
      const nextGroup = visibleGroups[0];
      window.queueMicrotask(() => setActiveGroupId(nextGroup.id));
      if (nextGroup.skills[0]) onSelectSkill(nextGroup.skills[0].slug);
    }
  }, [activeGroupId, onSelectSkill, visibleGroups]);

  const selectGroup = (group: SkillLibraryPayload["groups"][number]) => {
    setActiveGroupId(group.id);
    if (group.skills[0]) onSelectSkill(group.skills[0].slug);
  };

  return (
    <div className="settings-skills">
      <div className="skill-library-shell">
        <nav className="skill-library-groups" aria-label="Skill groups">
          <div className="skill-library-toolbar">
            <button type="button" onClick={onCreateCustomSkill} disabled={saving}>
              New
            </button>
            <button type="button" onClick={onImportSkill} disabled={saving}>
              Import
            </button>
            <button type="button" onClick={onExportSkill} disabled={saving || !selectedSkill}>
              Export
            </button>
          </div>
          {loading && !skillLibrary ? (
            <div className="settings-skill-empty">Loading…</div>
          ) : visibleGroups.length ? (
            <>
              {visibleGroups.map((group) => {
                const checked = Boolean(group.defaultEnabled) || draftEnabledAddons.includes(group.id as SkillAddonGroupId);
                const groupToggleDisabled = Boolean(group.defaultEnabled);
                return (
                  <div
                    key={group.id}
                    className={[
                      "skill-library-group-row",
                      activeGroupId === group.id ? "active" : "",
                      checked ? "" : "disabled",
                    ].filter(Boolean).join(" ")}
                  >
                    <button type="button" onClick={() => selectGroup(group)}>
                      <span>{group.label}</span>
                      <small>
                        {checked ? "On" : "Off"}
                        {` / ${enabledCountForGroup(group)} of ${group.skillCount}`}
                      </small>
                    </button>
                    {group.kind === "addon" ? (
                      <input
                        aria-label={`Enable ${group.label}`}
                        type="checkbox"
                        checked={checked}
                        disabled={groupToggleDisabled}
                        title={groupToggleDisabled ? `${group.label} is always on; disable individual skills instead.` : undefined}
                        onChange={(event) =>
                          onToggleAddon(group.id as SkillAddonGroupId, event.target.checked)
                        }
                      />
                    ) : null}
                  </div>
                );
              })}
            </>
          ) : (
            <div className="settings-skill-empty">No skills found.</div>
          )}
        </nav>
        <div className="settings-skill-sidebar" aria-busy={loading ? "true" : "false"}>
          {activeGroup ? (
            <>
              <div className="settings-skill-list-head">
                <div>
                  <strong>{activeGroup.label}</strong>
                  <small>{activeGroup.description}</small>
                </div>
                <span>{activeGroupEnabled ? "Enabled" : "Off"} / {enabledCountForGroup(activeGroup)} of {activeGroup.skillCount}</span>
              </div>
              <div className="settings-skill-list">
                {activeGroup.skills.map((skill) => {
                  const skillChecked = !draftDisabledSkills.includes(skill.slug);
                  const skillEnabled = activeGroupEnabled && skillChecked;
                  return (
                    <div
                      key={skill.slug}
                      className={[
                        "settings-skill-row-wrap",
                        selectedSkillSlug === skill.slug ? "active" : "",
                        skillEnabled ? "" : "disabled",
                      ].filter(Boolean).join(" ")}
                    >
                      <button
                        type="button"
                        className="settings-skill-row"
                        onClick={() => onSelectSkill(skill.slug)}
                      >
                        <span>{skill.name}</span>
                        {skill.summary ? <small>{skill.summary}</small> : null}
                      </button>
                      <input
                        aria-label={`Enable ${skill.name}`}
                        type="checkbox"
                        checked={skillEnabled}
                        disabled={!activeGroupEnabled}
                        onChange={(event) => onToggleSkill(skill.slug, event.target.checked)}
                      />
                    </div>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="settings-skill-empty">No skill docs found.</div>
          )}
        </div>
        <div className="settings-skill-editor">
          {selectedSkill ? (
            <>
              <div className="settings-skill-editor-head">
                <div>
                  <h4>{selectedSkill.name}</h4>
                  <span>
                    {selectedSkill.groupLabel}
                    {selectedSkill.words ? ` / ${selectedSkill.words} words` : ""}
                    {selectedSkillDisabled ? " / off for agent" : ""}
                  </span>
                  {selectedSkill.summary ? <p>{selectedSkill.summary}</p> : null}
                </div>
                <div className="settings-skill-editor-actions">
                  <button
                    type="button"
                    onClick={onResetSkill}
                    disabled={saving || Boolean(selectedSkill.custom)}
                    title={selectedSkill.custom ? "Custom skills have no built-in default." : "Reset to built-in default"}
                  >
                    Reset
                  </button>
                  <button type="button" onClick={onSaveSkill} disabled={saving}>
                    {saving ? "Saving…" : "Save"}
                  </button>
                </div>
              </div>
              <textarea
                className="settings-skill-markdown"
                spellCheck={false}
                value={skillMarkdown}
                onChange={(event) => onChangeMarkdown(event.target.value)}
              />
              {selectedSkillDisabled || status ? (
                <div className="settings-skill-status">
                  {selectedSkillDisabled ? "This skill is off for the agent." : null}
                  {status ? `${selectedSkillDisabled ? " " : ""}${status}` : null}
                </div>
              ) : null}
            </>
          ) : (
            <div className="settings-skill-empty">Select a skill.</div>
          )}
        </div>
      </div>
    </div>
  );
}

type SkillLibraryGroupId = SkillLibraryPayload["groups"][number]["id"];
