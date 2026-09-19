// Focus-lock enforcement predicates.
//
// The scope is stored as the canonical scene path (never a frozen array of
// enumerated children), so child paths created AFTER the lock was set (new
// beats, shots, new prompts) are still within scope. This is the whole point of the
// predicate approach — locks describe an intent, not a snapshot.

function normalizePath(p) {
  return String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

// Extract the scene folder stem used to derive beats/<stem>/, shots/<stem>/ and
// prompts/<stem>/ prefixes. Input must be normalized first — we defend by
// normalizing again here so callers can't hand us a Windows path.
// Returns an empty string when the input is unusable; callers MUST treat
// that as "no scope" and deny everything rather than matching ""-prefix
// (which would accidentally permit all beats/, shots/, and prompts/).
function sceneStemFromPath(scenePath) {
  const norm = normalizePath(scenePath);
  if (!norm) return "";
  const base = norm.split("/").pop() || "";
  const stem = base.replace(/\.md$/i, "");
  return stem;
}

// Returns a predicate `(path) => boolean` describing which normalized paths
// the current focus lock permits writes to. Read tools are not gated by this
// function — enforcement sites call it only for mutating tools.
function buildScopePredicate(focusLock) {
  if (!focusLock || !focusLock.kind || focusLock.kind === "none") {
    return () => true; // no lock — allow
  }
  if (focusLock.kind === "readonly") {
    return () => false; // hard-deny — callers check kind === "readonly" first
  }
  if (focusLock.kind === "file") {
    const want = normalizePath(focusLock.path);
    if (!want) return () => false;
    return (p) => normalizePath(p) === want;
  }
  if (focusLock.kind === "scene") {
    const scenePath = normalizePath(focusLock.scenePath);
    const stem = sceneStemFromPath(focusLock.scenePath);
    // Defense against a malformed lock: if we couldn't derive a stem,
    // refuse writes entirely rather than permit all beats/**, shots/** and prompts/**
    // (which would happen if stem were "" → prefix "beats/" → matches all).
    if (!scenePath || !stem) return () => false;
    const beatsPrefix = `beats/${stem}/`;
    const shotsPrefix = `shots/${stem}/`;
    const promptsPrefix = `prompts/${stem}/`;
    return (p) => {
      const norm = normalizePath(p);
      return (
        norm === scenePath
        || norm.startsWith(beatsPrefix)
        || norm.startsWith(shotsPrefix)
        || norm.startsWith(promptsPrefix)
      );
    };
  }
  if (focusLock.kind === "shot") {
    const shotPath = normalizePath(focusLock.shotPath);
    const stem = sceneStemFromPath(focusLock.scenePath);
    if (!shotPath || !stem) return () => false;
    const promptsPrefix = `prompts/${stem}/`;
    return (p) => {
      const norm = normalizePath(p);
      return norm === shotPath || norm.startsWith(promptsPrefix);
    };
  }
  return () => false;
}

// Human-readable description of the current lock for surfacing into error
// messages. Prefers a friendly basename over the raw project-relative path
// so chat-surfaced errors don't dump internal paths at the user (M3 from
// the 2026-04-21 focus-lock audit). Raw path still included in parens for
// debuggability.
function shortBasename(p) {
  const norm = normalizePath(p);
  if (!norm) return "";
  const base = norm.split("/").pop() || norm;
  return base.replace(/\.md$/i, "");
}

function describeScope(focusLock) {
  if (!focusLock || focusLock.kind === "none") return null;
  if (focusLock.kind === "readonly") return "read-only mode";
  if (focusLock.kind === "file") {
    const base = shortBasename(focusLock.path);
    return base ? `file: ${base}` : `file: ${focusLock.path}`;
  }
  if (focusLock.kind === "scene") {
    const base = shortBasename(focusLock.scenePath);
    return base ? `scene "${base}" (+ its beats + shots + prompts)` : `scene subtree (${focusLock.scenePath})`;
  }
  if (focusLock.kind === "shot") {
    const base = shortBasename(focusLock.shotPath);
    return base ? `shot "${base}" (+ its prompts)` : `shot scope (${focusLock.shotPath})`;
  }
  return "unknown scope";
}

// Suggestion for the NEXT wider scope that would cover a given attempted
// path when the current lock rejects it. Used in agent error messages so
// users see "or extend to scene X" in addition to "release" (M5 from the
// 2026-04-21 focus-lock audit).
function suggestExtension(focusLock, attemptedPath) {
  if (!focusLock || focusLock.kind === "none" || focusLock.kind === "readonly") return null;
  const norm = normalizePath(attemptedPath);
  if (!norm) return null;
  // file → maybe the target is under a scene subtree; suggest the scene
  if (focusLock.kind === "file") {
    if (norm.startsWith("beats/") || norm.startsWith("shots/") || norm.startsWith("prompts/")) {
      return "extend to the parent scene subtree to cover its beats + shots + prompts";
    }
    return "release the lock";
  }
  // scene → the target is either outside the scene, or a sibling scene's subtree
  if (focusLock.kind === "scene") {
    return "release the lock to allow other scenes";
  }
  // shot → target may be another shot in the same scene, or a totally different scene
  if (focusLock.kind === "shot") {
    if (norm.startsWith("beats/") || norm.startsWith("shots/") || norm.startsWith("prompts/")) {
      return "extend to the parent scene subtree to cover the whole scene, or release to unlock entirely";
    }
    return "release the lock";
  }
  return "release the lock";
}

module.exports = {
  normalizePath,
  sceneStemFromPath,
  buildScopePredicate,
  describeScope,
  suggestExtension,
};
