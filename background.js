"use strict";
importScripts("engine.js");
const sessions = new Map();
const frames = new Map();
const queues = new Map();
const closedTabs = new Set();
const watchdogName = "cx-chapter-playback-watchdog";
const loaded = chrome.storage.session.get(null).then(data => {
  for (const [k, v] of Object.entries(data)) {
    if (/^(?:tab|frames):/.test(k) && closedTabs.has(Number(k.split(":")[1]))) continue;
    if (k.startsWith("tab:") && v && typeof v === "object") sessions.set(Number(k.slice(4)), v);
    if (k.startsWith("frames:") && Array.isArray(v)) frames.set(Number(k.slice(7)), new Map(v.filter(f => f && typeof f.token === "string").map(f => [f.frameId, f])));
  }
});
async function syncWatchdog() {
  await loaded;
  const enabled = Array.from(sessions.values()).some(s => s.running);
  const alarm = await chrome.alarms.get(watchdogName);
  if (enabled && !alarm) await chrome.alarms.create(watchdogName, { periodInMinutes: 0.5 });
  if (!enabled && alarm) await chrome.alarms.clear(watchdogName);
}
async function persist(tabId, s) {
  if (closedTabs.has(tabId)) return;
  await chrome.storage.session.set({ [`tab:${tabId}`]: s, [`frames:${tabId}`]: roster(tabId) });
  // A close event can arrive while the asynchronous write is in flight.
  if (closedTabs.has(tabId)) await chrome.storage.session.remove([`tab:${tabId}`, `frames:${tabId}`]);
}
function serial(tabId, operation) {
  const next = (queues.get(tabId) || Promise.resolve()).catch(() => {}).then(() => {
    if (closedTabs.has(tabId)) throw new Error("tab closed");
    return operation();
  });
  queues.set(tabId, next);
  next.finally(() => { if (queues.get(tabId) === next) queues.delete(tabId); }).catch(() => {});
  return next;
}
async function session(tabId) {
  await loaded;
  if (closedTabs.has(tabId)) throw new Error("tab closed");
  if (!sessions.has(tabId)) {
    const { settings } = await chrome.storage.local.get("settings");
    if (closedTabs.has(tabId)) throw new Error("tab closed");
    sessions.set(tabId, CXEngine.create(settings));
  }
  return sessions.get(tabId);
}
function roster(tabId) { return Array.from(frames.get(tabId)?.values() || []); }
async function syncTabAudio(tabId, s) {
  if (s.running && s.config.muted) {
    if (!s.tabAudio) {
      const tab = await chrome.tabs.get(tabId);
      const originalMuted = !!tab.mutedInfo?.muted;
      await chrome.tabs.update(tabId, { muted: true });
      s.tabAudio = { originalMuted, applied: true };
    }
  } else if (s.tabAudio) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.mutedInfo?.reason === "extension" && tab.mutedInfo.extensionId === chrome.runtime.id) {
      await chrome.tabs.update(tabId, { muted: s.tabAudio.originalMuted });
    }
    delete s.tabAudio;
  }
}
function playbackConfig(s) {
  return { ...s.config, muted: s.config.muted && !s.tabAudio?.applied };
}
function rememberDiagnostic(s, tabId) {
  const a = s.active;
  const frame = a && roster(tabId).find(f => f.frameId === a.frameId && f.token === a.token);
  const task = frame?.tasks?.find(t => t.id === a.id && t.jobId === a.jobId);
  if (!task) return;
  s.lastDiagnostic = { kind: task.kind, phase: task.phase || "", nativeErrorCode: Number(task.nativeErrorCode) || 0,
    readyState: Number(task.readyState) || 0, hasSource: !!task.hasSource, rate: Number(task.rate) || 0,
    reader: task.reader || null, ownerMatched: task.owner === a.owner,
    mediaNode: task.mediaNode || "", elementMuted: !!task.muted, tabMutedByHelper: !!s.tabAudio?.applied,
    pendingTask: s.inventory[a.jobId]?.name || "" };
}
function view(s, tabId) {
  const nextJob = (s.order || []).map(id => s.inventory[id]).find(j => j && !j.confirmed);
  const candidates = nextJob ? roster(tabId).flatMap(f => (f.tasks || []).filter(t => t.jobId === nextJob.id).map(t => ({
    kind: t.kind, boundToCurrentTask: t.owner === nextJob.owner, visible: t.visible !== false && f.visible !== false,
    mediaNode: t.mediaNode || "", nativeErrorCode: Number(t.nativeErrorCode) || 0, readyState: Number(t.readyState) || 0
  }))).slice(0, 12) : [];
  return { running: s.running, config: s.config, message: s.message, completed: s.completed,
    jobs: (s.order || Object.keys(s.inventory)).map(id => s.inventory[id]).filter(Boolean)
      .map(j => ({ name: j.name, kind: j.kind, confirmed: j.confirmed, binding: j.binding || "", active: s.active?.jobId === j.id })),
    connected: roster(tabId).some(f => Date.now() - f.received < 7000), logs: s.logs,
    diagnostic: { ...(s.lastDiagnostic || {}), nextTask: nextJob?.name || "", binding: nextJob?.binding || "", candidates } };
}
async function send(tabId, frameId, command) {
  let timer;
  try {
    return await Promise.race([chrome.tabs.sendMessage(tabId, { type: "CX_COMMAND", command }, { frameId }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("frame response timeout")), 3500); })]);
  } finally { clearTimeout(timer); }
}
async function stopAll(tabId) {
  const revision = sessions.get(tabId)?.controlRevision || 0;
  await Promise.allSettled(roster(tabId).map(f => send(tabId, f.frameId, { type: "STOP", token: f.token, revision })));
}
function wakeCommand(s, f) {
  const a = s.active;
  const mine = a && a.frameId === f.frameId && a.token === f.token;
  return { type: "WAKE", token: f.token, revision: s.controlRevision || 0,
    keepAlive: s.running && !!a, guard: s.config.guard,
    task: mine ? { id: a.id, jobId: a.jobId, owner: a.owner, config: playbackConfig(s) } : null };
}
async function discardSession(tabId) {
  const s = sessions.get(tabId);
  if (s) {
    CXEngine.stop(s, "已离开课程页面，助手已暂停", Date.now());
    await syncTabAudio(tabId, s);
    await stopAll(tabId);
  }
  sessions.delete(tabId);
  frames.delete(tabId);
  await chrome.storage.session.remove([`tab:${tabId}`, `frames:${tabId}`]);
  await syncWatchdog();
}
async function discoverTop(tabId) {
  const response = await send(tabId, 0, { type: "POLL" }).catch(() => null);
  return response?.ok === true;
}
async function pulse(tabId, s) {
  const known = roster(tabId);
  s.lastBackgroundPulse = Date.now();
  if (!known.length) {
    if (await discoverTop(tabId)) return true;
  } else {
    const replies = await Promise.allSettled(known.map(f => send(tabId, f.frameId, wakeCommand(s, f))));
    if (replies.some(result => result.status === "fulfilled" && result.value?.ok === true)) return true;
  }
  await discardSession(tabId);
  return false;
}
async function execute(tabId, s, actions) {
  try { if (s.running) await syncTabAudio(tabId, s); }
  catch {
    CXEngine.stop(s, "无法设置课程标签页静音，已暂停；请重载扩展后重试", Date.now());
    await stopAll(tabId);
    return;
  }
  for (const action of actions) {
    if (action.type === "STOP_ALL") { await stopAll(tabId); continue; }
    if (action.type === "RUN") {
      await stopAll(tabId);
      const holder = roster(tabId).find(f => f.inventoryReady && f.jobs?.some(j => j.id === action.jobId && j.owner === action.owner));
      if (holder) {
        const hasFrame = holder.jobs.find(j => j.id === action.jobId)?.owner?.includes("/node-");
        if (hasFrame) {
          const revealed = await send(tabId, holder.frameId, { type: "REVEAL", token: holder.token, jobId: action.jobId, owner: action.owner, revision: s.controlRevision || 0 }).catch(() => null);
          if (!revealed?.ok) {
            CXEngine.stop(s, "当前任务的页面定位失败，未操作其他任务", Date.now());
            await stopAll(tabId);
            continue;
          }
        }
      }
    }
    if (action.type === "RUN" && s.config.guard) {
      await Promise.allSettled(roster(tabId).map(f => send(tabId, f.frameId,
        { type: "GUARD", token: f.token, enabled: true, revision: s.controlRevision || 0 })));
    }
    try {
      const response = await send(tabId, action.frameId, { ...action,
        ...(action.type === "RUN" ? { config: playbackConfig(s) } : {}), revision: s.controlRevision || 0 });
      if (!response?.ok) throw new Error("frame unavailable");
    } catch {
      CXEngine.stop(s, "任务页面暂时不可用，请重新开始识别", Date.now());
      await stopAll(tabId);
    }
  }
  if (!s.running) await syncTabAudio(tabId, s);
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!message || sender.id !== chrome.runtime.id) return false;
  const isPopup = sender.url === chrome.runtime.getURL("popup.html");
  // Only the popup and top-level extension bridge may control or inspect a tab.
  if (["CX_CONTROL", "CX_STATUS"].includes(message.type) && !isPopup && sender.frameId !== 0) return false;
  if (message.type === "CX_CONTROL" && !["start", "pause"].includes(message.action)) {
    reply({ error: "unsupported action" }); return false;
  }
  const tabId = sender.tab?.id ?? (isPopup ? message.tabId : undefined);
  if (!Number.isInteger(tabId)) { reply({ error: "请先打开一个学习通章节页" }); return false; }
  serial(tabId, async () => {
    const s = await session(tabId);
    if (message.type === "CX_REPORT" && sender.tab) {
      const p = message.snapshot;
      if (!p || typeof p.token !== "string" || p.token.length > 100 || !Array.isArray(p.tasks) || !Array.isArray(p.jobs)) return { error: "invalid snapshot" };
      if (!frames.has(tabId)) frames.set(tabId, new Map());
      const old = frames.get(tabId).get(sender.frameId);
      if (sender.frameId === 0 && old && old.token !== p.token) frames.get(tabId).clear();
      frames.get(tabId).set(sender.frameId, { ...p, frameId: sender.frameId, received: Date.now() });
      if (s.running && s.active && s.active.frameId === sender.frameId) {
        const matching = p.tasks.find(t => t.jobId === s.active.jobId && t.owner === s.active.owner);
        if (matching && (s.active.token !== p.token || (!p.activeTask && s.active.id !== matching.id))) {
          Object.assign(s.active, { token: p.token, id: matching.id, lastSeen: Date.now(), progressAt: Date.now(), lastTime: Number(matching.time) || 0 });
        }
        if (matching && (!p.activeTask || p.activeTask.owner !== s.active.owner || p.activeTask.jobId !== s.active.jobId)) {
          Object.assign(s.active, { startedAt: Date.now(), progressAt: Date.now(), rateMismatchSince: 0 });
          await send(tabId, sender.frameId, wakeCommand(s, frames.get(tabId).get(sender.frameId))).catch(() => {});
        }
      } else if (s.running && s.active && s.config.guard && old?.token !== p.token) {
        await send(tabId, sender.frameId, { type: "GUARD", token: p.token, enabled: true, revision: s.controlRevision || 0 }).catch(() => {});
      }
      rememberDiagnostic(s, tabId);
      await execute(tabId, s, CXEngine.step(s, roster(tabId)));
      await persist(tabId, s);
      await syncWatchdog();
      return { ok: true, keepAlive: s.running && !!s.active, guard: s.config.guard, revision: s.controlRevision || 0 };
    }
    if (message.type === "CX_CONTROL") {
      if (message.action === "pause") {
        CXEngine.stop(s, "已暂停", Date.now());
        await stopAll(tabId);
      } else if (message.action === "start") {
        s.controlRevision = (s.controlRevision || 0) + 1;
        await stopAll(tabId);
        s.config = CXEngine.config(message.config || s.config);
        await chrome.storage.local.set({ settings: s.config });
        s.running = true;
        s.active = null;
        s.navigation = null;
        s.scope = "";
        s.course = "";
        s.lastDiagnostic = null;
        s.waitingSince = Date.now();
        CXEngine.note(s, "已开始，正在核对任务点", Date.now());
        await execute(tabId, s, CXEngine.step(s, roster(tabId)));
      }
      await syncTabAudio(tabId, s);
      await persist(tabId, s);
      await syncWatchdog();
      return view(s, tabId);
    }
    if (message.type === "CX_STATUS") return view(s, tabId);
    return { error: "unsupported message" };
  }).then(reply).catch(() => reply({ error: "助手暂时无法连接，请刷新课程页" }));
  return true;
});
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name !== watchdogName) return;
  loaded.then(() => Promise.allSettled(Array.from(sessions).filter(([, s]) => s.running).map(([tabId]) =>
    serial(tabId, async () => {
      const s = await session(tabId);
      if (s.running && await pulse(tabId, s) && sessions.get(tabId) === s) await persist(tabId, s);
    }))))
    .then(syncWatchdog).catch(() => {});
});
loaded.then(syncWatchdog).catch(() => {});
chrome.tabs.onRemoved.addListener(tabId => {
  closedTabs.add(tabId);
  sessions.delete(tabId);
  frames.delete(tabId);
  chrome.storage.session.remove([`tab:${tabId}`, `frames:${tabId}`]).catch(() => {});
  syncWatchdog().catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  serial(tabId, async () => {
    await loaded;
    if (!sessions.has(tabId) && !frames.has(tabId)) return;
    if (!await discoverTop(tabId)) await discardSession(tabId);
  }).catch(() => {});
});
