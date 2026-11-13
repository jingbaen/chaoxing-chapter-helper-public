/* Deterministic scheduler. No network, DOM, or browser APIs. */
(function (root) {
  "use strict";
  const defaults = Object.freeze({ rate: 2, documents: true, guard: true, autoNext: true, muted: true });
  const confirmWaitMs = 20000;
  function config(input = {}) {
    const out = { ...defaults };
    if ([1, 1.25, 1.5, 2].includes(Number(input.rate))) out.rate = Number(input.rate);
    for (const k of ["documents", "guard", "autoNext", "muted"]) {
      if (typeof input[k] === "boolean") out[k] = input[k];
    }
    return out;
  }
  function create(settings = {}, now = Date.now()) {
    return { running: false, config: config(settings), message: "等待开始", logs: [],
      scope: "", scopeSince: now, active: null, inventory: {}, order: [], confirmed: [], completed: 0,
      navigation: null, waitingSince: now, lastLog: "", course: "", controlRevision: 0 };
  }
  function note(s, message, now) {
    s.message = message;
    if (s.lastLog !== message) {
      s.logs.push({ time: now, message });
      s.logs = s.logs.slice(-120);
      s.lastLog = message;
    }
  }
  function stop(s, message, now) {
    s.controlRevision = (s.controlRevision || 0) + 1;
    s.running = false;
    s.active = null;
    s.navigation = null;
    note(s, message, now);
    return [{ type: "STOP_ALL" }];
  }
  function key(f) { return `${f.chapter || ""}:${f.card ?? "0"}`; }
  function target(f, type, extra = {}) {
    return { type, frameId: f.frameId, token: f.token, ...extra };
  }
  function step(s, snapshots, now = Date.now()) {
    if (!s.running) return [];
    // Document identity is stable until navigation. Hidden-frame timers are not a liveness signal.
    const frames = snapshots.filter(f => f && typeof f.token === "string");
    const nav = frames.filter(f => f.navigation?.kind === "study")
      .sort((a, b) => a.frameId - b.frameId)[0];
    const catalog = !nav && frames.find(f => f.navigation?.kind === "catalog");
    const scope = nav ? key(nav) : "";
    if (nav?.course) {
      if (s.course && s.course !== nav.course) return stop(s, "当前课程已改变，助手已暂停；请确认课程后重新开始", now);
      s.course = nav.course;
    }
    const relevant = frames.filter(f => !nav || (f.chapter === nav.chapter && String(f.card ?? "0") === String(nav.card ?? "0")));
    const blocked = frames.find(f => f.blocker && (f.frameId === 0 || relevant.includes(f)));
    if (blocked) return stop(s, blocked.blocker, now);
    if (s.navigation) {
      if (nav && scope !== s.navigation.from) {
        s.navigation = null;
      } else if (nav && now - nav.received < 10000 && nav.received > s.navigation.since && now - s.navigation.since > 25000) {
        return stop(s, "页面没有完成切换，请手动进入下一小节后再开始", now);
      } else {
        note(s, "正在切换小节，等待新页面", now);
        return [];
      }
    }
    if (!nav) {
      if (s.active || s.scope) {
        note(s, "正在恢复后台课程框架，保留当前播放任务", now);
        return [];
      }
      const first = catalog?.navigation.chapters?.find(c => !c.complete && !c.locked);
      if (first) {
        s.navigation = { since: now, from: "" };
        note(s, "打开首个未完成章节", now);
        return [target(catalog, "NAVIGATE", { id: first.id })];
      }
      if (now - s.waitingSince > 25000) return stop(s, "请进入课程中的一个子单元，再点击开始", now);
      note(s, "等待章节页面与播放器加载", now);
      return [];
    }
    if (scope !== s.scope) {
      const old = s.active;
      s.scope = scope;
      s.scopeSince = now;
      s.inventory = {};
      s.order = [];
      s.inventoryAuthority = 0;
      s.confirmed = [];
      s.active = null;
      s.waitingSince = now;
      note(s, "已进入小节，正在识别全部任务点", now);
      if (old) return [{ type: "STOP_ALL" }];
    }
    const allInventories = relevant.filter(f => f.inventoryReady);
    const authority = Math.max(s.inventoryAuthority || 0, ...allInventories.map(f => f.inventoryAuthority || 0));
    s.inventoryAuthority = authority;
    const inventoryFrames = allInventories.filter(f => (f.inventoryAuthority || 0) === authority);
    s.order = s.order || [];
    for (const f of inventoryFrames) {
      const ordered = [...(f.jobs || [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
      for (const j of ordered) {
        if (j.required || s.inventory[j.id]) {
          s.inventory[j.id] = { ...s.inventory[j.id], ...j };
          if (!s.order.includes(j.id)) s.order.push(j.id);
        }
      }
    }
    const jobs = s.order.map(id => s.inventory[id]).filter(Boolean);
    for (const j of jobs) {
      if (j.confirmed && !s.confirmed.includes(j.id)) {
        s.confirmed.push(j.id);
        if (s.active?.jobId === j.id) s.completed++;
      }
    }
    if (s.active) {
      const a = s.active;
      const job = s.inventory[a.jobId];
      if (job && job.owner !== a.owner) return stop(s, "当前任务的阅读器绑定已改变，请重新开始识别", now);
      if (job?.confirmed) {
        s.controlRevision = (s.controlRevision || 0) + 1;
        s.active = null;
        s.waitingSince = now;
        note(s, `页面已确认完成：${job.name}`, now);
        return [{ type: "STOP_ALL" }];
      }
      const f = relevant.find(f => f.token === a.token && f.frameId === a.frameId);
      if (!f || now - f.received >= 10000) {
        note(s, "等待后台播放器回应，保留当前任务", now);
        return [];
      }
      const task = f?.tasks?.find(t => t.id === a.id && t.jobId === a.jobId && t.owner === a.owner && t.visible !== false);
      if (!task) {
        if (now - a.lastSeen > 12000) return stop(s, "任务页面已改变，未确认完成；请重新开始识别", now);
        return [];
      }
      a.lastSeen = now;
      if (task.error) return stop(s, task.error, now);
      if (task.kind === "media") {
        if (Number(task.time) > a.lastTime + 0.1) {
          a.lastTime = Number(task.time);
          a.progressAt = now;
        }
        if (task.ended) {
          a.finishedAt = a.finishedAt || now;
          note(s, `视频播完，等待任务点确认：${job.name}`, now);
        } else {
          if (task.phase && task.phase !== "playing" && task.phase !== "idle") {
            a.rateMismatchSince = 0;
            a.initializingSince = a.initializingSince || now;
            if (now - a.initializingSince > 60000) return stop(s, "原播放器启动超时，请手动点击中央播放后重新开始", now);
            note(s, task.phase === "recovering" ? `正在恢复原播放器：${job.name}` : `正在初始化原播放器：${job.name}`, now);
            return [];
          }
          a.initializingSince = 0;
          if (Number.isFinite(task.rate) && Math.abs(task.rate - s.config.rate) > 0.05) {
            a.rateMismatchSince = a.rateMismatchSince || now;
            if (now - a.rateMismatchSince > 20000) return stop(s, "播放器未保持所选倍速，请暂停调整为 1 倍后重新开始", now);
          } else a.rateMismatchSince = 0;
          if (now - a.progressAt > 90000) return stop(s, "视频 90 秒没有前进，请检查加载、倍速限制或手动点播放", now);
          note(s, `正在播放 ${s.config.rate} 倍速：${job.name}`, now);
        }
      } else if (task.bottom) {
        a.finishedAt = a.finishedAt || now;
        note(s, `阅读器底部已核验，等待平台确认（最多 20 秒）：${job.name}`, now);
      } else {
        a.finishedAt = 0;
        const stamp = JSON.stringify([task.reader?.top, task.reader?.height, task.reader?.viewport]);
        if (a.readerStamp !== stamp) { a.readerStamp = stamp; a.progressAt = now; }
        if (now - a.progressAt > 90000) return stop(s, "未能核验文档阅读器底部，请检查文档是否已加载", now);
        note(s, task.reader?.state === "locating" ? `正在定位文档内部滚动区域：${job.name}` :
          task.reader?.state === "loading" ? `等待文档页面加载：${job.name}` : `正在翻阅文档：${job.name}`, now);
      }
      if (a.finishedAt && now - a.finishedAt >= confirmWaitMs) {
        return stop(s, "操作已结束，但平台在 20 秒内未确认当前任务点；已暂停", now);
      }
      return [];
    }
    if (now - s.scopeSince < 5000) return [];
    const pending = jobs.filter(j => !j.confirmed);
    if (pending.length) {
      const j = pending[0];
      if (j.kind === "manual" || j.kind === "unknown") return stop(s, `需要手动处理的任务点：${j.name}`, now);
      if (j.kind === "document" && !s.config.documents) return stop(s, "此小节有文档任务，请打开文档处理或手动完成", now);
      const options = relevant.flatMap(f => (f.tasks || []).filter(t => j.owner && t.owner === j.owner &&
        t.jobId === j.id && t.kind === j.kind && t.visible !== false && f.visible !== false).map(t => ({ f, t })))
        .sort((a, b) => (b.t.quality || 0) - (a.t.quality || 0) || (b.f.depth || 0) - (a.f.depth || 0));
      const { f, t: task } = options[0] || {};
      if (!f || !task) {
        if (now - s.waitingSince >= 20000) return stop(s, `20 秒内未能精确绑定当前任务的阅读器：${j.name}；已暂停`, now);
        note(s, `正在精确匹配当前任务阅读器：${j.name}`, now);
        return [];
      }
      s.active = { frameId: f.frameId, token: f.token, id: task.id, jobId: j.id, owner: j.owner,
        kind: task.kind, startedAt: now, lastSeen: now, lastTime: Number(task.time) || 0,
        progressAt: now, finishedAt: 0 };
      note(s, `开始处理：${j.name}`, now);
      return [target(f, "RUN", { id: task.id, jobId: j.id, owner: j.owner, config: s.config })];
    }
    if (!inventoryFrames.length) {
      if (now - s.scopeSince > 45000) return stop(s, "尚未读到任务点清单；请刷新课程页或手动进入子单元", now);
      note(s, "等待任务点清单，暂不切换小节", now);
      return [];
    }
    if (!s.config.autoNext) return stop(s, "当前页任务点已确认完成，自动切换已关闭", now);
    const n = nav.navigation;
    let next = n.tabs?.find((t, i) => i > n.activeTab);
    if (next?.locked) return stop(s, "下一子单元尚未解锁，请先核对当前任务", now);
    if (!next) {
      const current = n.chapters?.findIndex(c => c.active) ?? -1;
      if (current < 0 && n.chapters?.length) return stop(s, "无法定位当前目录位置，请手动切换下一小节", now);
      const remaining = n.chapters?.slice(current + 1) || [];
      const firstPending = remaining.find(c => !c.complete);
      if (firstPending?.locked) return stop(s, "下一章节尚未解锁，请检查当前章节的任务与测验", now);
      next = firstPending;
    }
    if (!next) {
      return stop(s, "已处理到当前目录末尾，请在课程目录核对整体进度", now);
    }
    s.navigation = { from: scope, since: now };
    note(s, `切换到：${next.name}`, now);
    return [target(nav, "NAVIGATE", { id: next.id })];
  }
  root.CXEngine = { defaults, config, create, step, stop, note, confirmWaitMs };
  if (typeof module === "object" && module.exports) module.exports = root.CXEngine;
})(globalThis);
