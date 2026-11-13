/* Export an explicit allowlist; page-controlled strings are never exported. */
(function (root) {
  "use strict";
  const pick = (value, allowed, fallback = "unknown") => allowed.includes(value) ? value : fallback;
  const number = (value, max = 1e9) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : 0;
  const flag = value => value === true;
  function build(state = {}, version = "") {
    const config = state.config || {};
    const diagnostic = state.diagnostic || {};
    const reader = diagnostic.reader || {};
    return {
      schemaVersion: 1,
      version: /^\d+\.\d+\.\d+$/.test(version) ? version : "unknown",
      running: flag(state.running), connected: flag(state.connected), completed: number(state.completed),
      config: { rate: [1, 1.25, 1.5, 2].includes(config.rate) ? config.rate : 2,
        documents: flag(config.documents), guard: flag(config.guard), autoNext: flag(config.autoNext), muted: flag(config.muted) },
      tasks: (Array.isArray(state.jobs) ? state.jobs : []).slice(0, 500).map(task => ({
        kind: pick(task?.kind, ["media", "document", "manual", "unknown"]),
        confirmed: flag(task?.confirmed), active: flag(task?.active),
        binding: pick(task?.binding, ["bound", "ambiguous", "missing"])
      })),
      diagnostic: {
        kind: pick(diagnostic.kind, ["media", "document"]),
        phase: pick(diagnostic.phase, ["idle", "initializing", "playing", "recovering"]),
        nativeErrorCode: number(diagnostic.nativeErrorCode, 4), readyState: number(diagnostic.readyState, 4),
        hasSource: flag(diagnostic.hasSource), rate: number(diagnostic.rate, 16),
        ownerMatched: flag(diagnostic.ownerMatched), elementMuted: flag(diagnostic.elementMuted),
        tabMutedByHelper: flag(diagnostic.tabMutedByHelper),
        reader: { state: pick(reader.state, ["locating", "loading", "scrolling", "at-bottom"]),
          progress: number(reader.progress, 100), top: number(reader.top), height: number(reader.height), viewport: number(reader.viewport) }
      }
    };
  }
  root.CXDiagnostics = { build };
  if (typeof module === "object" && module.exports) module.exports = root.CXDiagnostics;
})(globalThis);
