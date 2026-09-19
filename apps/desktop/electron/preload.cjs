const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("forgeDesktop", {
  askAgent: (requestId, settings, payload) =>
    ipcRenderer.invoke("forge:ask-agent", requestId, settings, payload),
  cancelAgent: (requestId) => ipcRenderer.invoke("forge:cancel-agent", requestId),
  onAgentEvent: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("forge:agent-event", wrapped);
    return () => ipcRenderer.removeListener("forge:agent-event", wrapped);
  },
  createProject: (name) => ipcRenderer.invoke("forge:create-project", name),
  createProjectAtPath: (projectDir, name) =>
    ipcRenderer.invoke("forge:create-project-at-path", projectDir, name),
  getRecentProjects: () => ipcRenderer.invoke("forge:get-recent-projects"),
  loadChatHistory: (projectDir, sessionKey) =>
    ipcRenderer.invoke("forge:load-chat-history", projectDir, sessionKey),
  onProjectChanged: (listener) => {
    const wrapped = () => listener();
    ipcRenderer.on("forge:project-changed", wrapped);
    return () => ipcRenderer.removeListener("forge:project-changed", wrapped);
  },
  // Granular Workshop NLE events from main-process timeline tools. The
  // renderer applies them in-place so multi-step agent edits become
  // visible per-op, instead of only after the full project reload.
  onTimelineEvent: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("forge:timeline-event", wrapped);
    return () => ipcRenderer.removeListener("forge:timeline-event", wrapped);
  },
  // Inbox events: filesystem changes inside assets/inbox/ + built-in
  // generation tool lifecycle (job-started / job-completed / job-failed).
  onInboxEvent: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("forge:inbox-event", wrapped);
    return () => ipcRenderer.removeListener("forge:inbox-event", wrapped);
  },
  openProject: () => ipcRenderer.invoke("forge:open-project"),
  openProjectAtPath: (projectDir) => ipcRenderer.invoke("forge:open-project-at-path", projectDir),
  openRecentProject: (projectDir) => ipcRenderer.invoke("forge:open-recent-project", projectDir),
  saveChatHistory: (projectDir, sessionKey, history) =>
    ipcRenderer.invoke("forge:save-chat-history", projectDir, sessionKey, history),
  saveProject: (projectDir, project) => ipcRenderer.invoke("forge:save-project", projectDir, project),
  saveProjectSettings: (projectDir, project) =>
    ipcRenderer.invoke("forge:save-project-settings", projectDir, project),
  unwatchProject: (projectDir) => ipcRenderer.invoke("forge:unwatch-project", projectDir),
  uploadAssets: (projectDir, section, entityId, entityName) =>
    ipcRenderer.invoke("forge:upload-assets", projectDir, section, entityId, entityName),
  createAssetEntriesFromFiles: (projectDir, section) =>
    ipcRenderer.invoke("forge:create-asset-entries-from-files", projectDir, section),
  detachAssetVariant: (projectDir, section, assetId, mediaId) =>
    ipcRenderer.invoke("forge:detach-asset-variant", projectDir, section, assetId, mediaId),
  deleteAssetEntry: (projectDir, section, assetId) =>
    ipcRenderer.invoke("forge:delete-asset-entry", projectDir, section, assetId),
  uploadLibraryAssets: (projectDir) => ipcRenderer.invoke("forge:upload-library-assets", projectDir),
  uploadLibraryFolder: (projectDir) => ipcRenderer.invoke("forge:upload-library-folder", projectDir),
  dropLibraryFiles: (projectDir, filePaths) => ipcRenderer.invoke("forge:drop-library-files", projectDir, filePaths),
  // Workshop media — import video takes and audio assets into the NLE bin.
  importWorkshopMedia: (projectDir, filePaths) =>
    ipcRenderer.invoke("forge:import-workshop-media", projectDir, filePaths),
  // Videos — import takes + reveal videos folder in Finder.
  importVideos: (projectDir, destSubPath, filePaths) =>
    ipcRenderer.invoke("forge:import-videos", projectDir, destSubPath, filePaths),
  generatePromptVideo: (projectDir, promptId) =>
    ipcRenderer.invoke("forge:generate-prompt-video", projectDir, promptId),
  generateAssetImage: (projectDir, payload) =>
    ipcRenderer.invoke("forge:generate-asset-image", projectDir, payload),
  trimAssetMedia: (projectDir, section, assetId, mediaId, payload) =>
    ipcRenderer.invoke("forge:trim-asset-media", projectDir, section, assetId, mediaId, payload),
  deleteVideoEntry: (projectDir, videoId) =>
    ipcRenderer.invoke("forge:delete-video-entry", projectDir, videoId),
  revealPath: (projectDir, relativePath) =>
    ipcRenderer.invoke("forge:reveal-path", projectDir, relativePath),
  listInboxFiles: (projectDir) => ipcRenderer.invoke("forge:list-inbox-files", projectDir),
  listInboxPending: (projectDir) => ipcRenderer.invoke("forge:list-inbox-pending", projectDir),
  moveInboxToLibrary: (projectDir, name) =>
    ipcRenderer.invoke("forge:move-inbox-to-library", projectDir, name),
  deleteInboxFile: (projectDir, name) =>
    ipcRenderer.invoke("forge:delete-inbox-file", projectDir, name),
  copyImageToClipboard: (projectDir, relativePath) =>
    ipcRenderer.invoke("forge:copy-image-to-clipboard", projectDir, relativePath),
  exportTimeline: (projectDir, clips) =>
    ipcRenderer.invoke("forge:export-timeline", projectDir, clips),
  exportTimelineSequences: (projectDir, sequences) =>
    ipcRenderer.invoke("forge:export-timeline-sequences", projectDir, sequences),
  exportWorkshopNLE: (projectDir, payload) =>
    ipcRenderer.invoke("forge:export-workshop-nle", projectDir, payload),
  // Pool IPC bindings retired — staging pool merged into unified media.
  repairProject: (projectDir) => ipcRenderer.invoke("forge:repair-project", projectDir),
  getAppVersion: () => ipcRenderer.invoke("forge:get-app-version"),
  openExternal: (url) => ipcRenderer.invoke("forge:open-external", url),
  getMethodDirective: (settings, payload) =>
    ipcRenderer.invoke("forge:get-method-directive", settings, payload),
  protectedAnvilTurn: (projectDir, payload) =>
    ipcRenderer.invoke("forge:protected-anvil-turn", projectDir, payload),
  getDesktopAccountStatus: (projectDir) =>
    ipcRenderer.invoke("forge:get-desktop-account-status", projectDir),
  getDesktopAccountSession: () =>
    ipcRenderer.invoke("forge:get-desktop-account-session"),
  connectDesktopAccountSession: (payload) =>
    ipcRenderer.invoke("forge:connect-desktop-account-session", payload),
  clearDesktopAccountSession: () =>
    ipcRenderer.invoke("forge:clear-desktop-account-session"),
  openProjectTerminal: (projectDir, launcher) =>
    ipcRenderer.invoke("forge:open-project-terminal", projectDir, launcher),
  startProjectTerminal: (payload) =>
    ipcRenderer.invoke("forge:start-project-terminal", payload),
  readProjectTerminalTranscript: (projectDir, launcher) =>
    ipcRenderer.invoke("forge:read-project-terminal-transcript", projectDir, launcher),
  clearProjectTerminalTranscript: (projectDir, launcher) =>
    ipcRenderer.invoke("forge:clear-project-terminal-transcript", projectDir, launcher),
  writeProjectTerminal: (sessionId, data) =>
    ipcRenderer.send("forge:write-project-terminal", sessionId, data),
  resizeProjectTerminal: (sessionId, cols, rows) =>
    ipcRenderer.send("forge:resize-project-terminal", sessionId, cols, rows),
  killProjectTerminal: (sessionId) =>
    ipcRenderer.send("forge:kill-project-terminal", sessionId),
  onProjectTerminalData: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("forge:project-terminal-data", wrapped);
    return () => ipcRenderer.removeListener("forge:project-terminal-data", wrapped);
  },
  onProjectTerminalExit: (listener) => {
    const wrapped = (_event, message) => listener(message);
    ipcRenderer.on("forge:project-terminal-exit", wrapped);
    return () => ipcRenderer.removeListener("forge:project-terminal-exit", wrapped);
  },
  listAgentProviders: () => ipcRenderer.invoke("forge:list-agent-providers"),
  testAgentConnection: (payload) => ipcRenderer.invoke("forge:test-agent-connection", payload),
  detectEntityPlaceholders: (payload) => ipcRenderer.invoke("forge:detect-entity-placeholders", payload),
  uploadChatAttachments: (projectDir) => ipcRenderer.invoke("forge:upload-chat-attachments", projectDir),
  watchProject: (projectDir) => ipcRenderer.invoke("forge:watch-project", projectDir),
  readConventions: (projectDir) => ipcRenderer.invoke("forge:read-conventions", projectDir),
  writeConventions: (projectDir, text) => ipcRenderer.invoke("forge:write-conventions", projectDir, text),
  resetConventions: (projectDir) => ipcRenderer.invoke("forge:reset-conventions", projectDir),
  listSkillLibrary: (projectDir) => ipcRenderer.invoke("forge:list-skill-library", projectDir),
  readSkillMarkdown: (projectDir, name) => ipcRenderer.invoke("forge:read-skill-markdown", projectDir, name),
  writeSkillMarkdown: (projectDir, name, text) =>
    ipcRenderer.invoke("forge:write-skill-markdown", projectDir, name, text),
  resetSkillMarkdown: (projectDir, name) =>
    ipcRenderer.invoke("forge:reset-skill-markdown", projectDir, name),
  createCustomSkill: (projectDir, name) =>
    ipcRenderer.invoke("forge:create-custom-skill", projectDir, name),
  importSkillMarkdown: (projectDir) =>
    ipcRenderer.invoke("forge:import-skill-markdown", projectDir),
  exportSkillMarkdown: (projectDir, name) =>
    ipcRenderer.invoke("forge:export-skill-markdown", projectDir, name),
  createCustomSubsection: (payload) => ipcRenderer.invoke("forge:create-custom-subsection", payload),
  readCustomSubsectionInstructions: (projectDir, instructionsPath) =>
    ipcRenderer.invoke("forge:read-custom-subsection-instructions", projectDir, instructionsPath),
  writeCustomSubsectionInstructions: (projectDir, instructionsPath, text) =>
    ipcRenderer.invoke("forge:write-custom-subsection-instructions", projectDir, instructionsPath, text),
  listCustomSubsectionFiles: (projectDir, folder, fileExtensions) =>
    ipcRenderer.invoke("forge:list-custom-subsection-files", projectDir, folder, fileExtensions),
  deleteCustomSubsection: (projectDir, folder) =>
    ipcRenderer.invoke("forge:delete-custom-subsection", projectDir, folder),
  readCustomSubsectionDoc: (projectDir, filePath) =>
    ipcRenderer.invoke("forge:read-custom-subsection-doc", projectDir, filePath),
  writeCustomSubsectionDoc: (projectDir, filePath, text) =>
    ipcRenderer.invoke("forge:write-custom-subsection-doc", projectDir, filePath, text),
  createCustomSubsectionDoc: (projectDir, folder, title) =>
    ipcRenderer.invoke("forge:create-custom-subsection-doc", projectDir, folder, title),
  renameCustomSubsectionDoc: (projectDir, filePath, title) =>
    ipcRenderer.invoke("forge:rename-custom-subsection-doc", projectDir, filePath, title),
  createScript: (payload) => ipcRenderer.invoke("forge:create-script", payload),
  readScript: (projectDir, scriptPath) =>
    ipcRenderer.invoke("forge:read-script", projectDir, scriptPath),
  writeScript: (projectDir, scriptPath, payload) =>
    ipcRenderer.invoke("forge:write-script", projectDir, scriptPath, payload),
  renameScript: (projectDir, scriptPath, newName) =>
    ipcRenderer.invoke("forge:rename-script", projectDir, scriptPath, newName),
  deleteScript: (projectDir, scriptPath) =>
    ipcRenderer.invoke("forge:delete-script", projectDir, scriptPath),
  readProjectContext: (projectDir, projectName) =>
    ipcRenderer.invoke("forge:read-project-context", projectDir, projectName),
  writeProjectContext: (projectDir, text) =>
    ipcRenderer.invoke("forge:write-project-context", projectDir, text),
  readAgentEntrypoints: (projectDir) =>
    ipcRenderer.invoke("forge:read-agent-entrypoints", projectDir),
  writeAgentEntrypoint: (projectDir, fileName, text) =>
    ipcRenderer.invoke("forge:write-agent-entrypoint", projectDir, fileName, text),
  readAgentNote: (projectDir) =>
    ipcRenderer.invoke("forge:read-agent-note", projectDir),
  writeAgentNote: (projectDir, text) =>
    ipcRenderer.invoke("forge:write-agent-note", projectDir, text),
  listReviewFiles: (projectDir) =>
    ipcRenderer.invoke("forge:list-review-files", projectDir),
  readReviewFile: (projectDir, target) =>
    ipcRenderer.invoke("forge:read-review-file", projectDir, target),
  writeReviewFile: (projectDir, target, text) =>
    ipcRenderer.invoke("forge:write-review-file", projectDir, target, text),
  appendReviewNote: (projectDir, note) =>
    ipcRenderer.invoke("forge:append-review-note", projectDir, note),
  readSectionConvention: (projectDir, kind) =>
    ipcRenderer.invoke("forge:read-section-convention", projectDir, kind),
  writeSectionConvention: (projectDir, kind, text) =>
    ipcRenderer.invoke("forge:write-section-convention", projectDir, kind, text),
  resetSectionConvention: (projectDir, kind) =>
    ipcRenderer.invoke("forge:reset-section-convention", projectDir, kind),
  readAssetContextGuide: (projectDir) =>
    ipcRenderer.invoke("forge:read-asset-context-guide", projectDir),
  writeAssetContextGuide: (projectDir, text) =>
    ipcRenderer.invoke("forge:write-asset-context-guide", projectDir, text),
  uploadAssetContextGuideReferences: (projectDir) =>
    ipcRenderer.invoke("forge:upload-asset-context-guide-references", projectDir),
  addAssetContextGuideReferencePaths: (projectDir, relativePaths) =>
    ipcRenderer.invoke("forge:add-asset-context-guide-reference-paths", projectDir, relativePaths),
  deleteAssetContextGuideReference: (projectDir, relativePath) =>
    ipcRenderer.invoke("forge:delete-asset-context-guide-reference", projectDir, relativePath),
  getMediaIndex: (projectDir) => ipcRenderer.invoke("forge:get-media-index", projectDir),
  attachMedia: (projectDir, mediaId, section, entityId, mode) =>
    ipcRenderer.invoke("forge:attach-media", projectDir, mediaId, section, entityId, mode),
  attachMediaBatch: (projectDir, items) =>
    ipcRenderer.invoke("forge:attach-media-batch", projectDir, items),
  getPinboard: (projectDir) => ipcRenderer.invoke("forge:get-pinboard", projectDir),
  updatePinboard: (projectDir, entries) => ipcRenderer.invoke("forge:update-pinboard", projectDir, entries),
  syncMagicDoc: (projectDir, name, force = false) =>
    ipcRenderer.invoke("forge:sync-magic-doc", projectDir, name, force),
});
