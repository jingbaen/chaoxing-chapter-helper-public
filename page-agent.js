(function () {
  "use strict";
  if (window.__cxChapterAgentV1) return;
  window.__cxChapterAgentV1 = true;
  const BUS = "cx-chapter-v1";
  const uuid = () => {
    // randomUUID is only available in secure contexts; HTTP course pages fall back to getRandomValues.
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  };
  const token = uuid();
  const ids = new WeakMap();
  const nodes = new Map();
  let sequence = 0;
  let inherited = {};
  let active = null;
  let error = "";
  let guard = false;
  let leaseUntil = 0;
  const leaseMs = 120000;
  let controlRevision = 0;
  let lastReportAt = 0;
  let mediaWakeQueued = false;
  let bottomTicks = 0;
  let lastHeight = 0;
  let readerState = { state: "locating", progress: 0 };
  let lastPointer = 0;
  const saved = [];
  const clean = (value, limit = 140) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const safeJSON = text => { try { return JSON.parse(text || "{}"); } catch { return {}; } };
  function id(el) {
    if (!ids.has(el)) { const value = `node-${++sequence}`; ids.set(el, value); nodes.set(value, el); }
    return ids.get(el);
  }
  function visible(el) {
    if (!el || !el.isConnected) return false;
    const style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && Array.from(el.getClientRects()).some(r => r.width > 1 && r.height > 1);
  }
  function raw(win = window) {
    try {
      if (Array.isArray(win.mArg?.attachments)) return win.mArg.attachments;
      if (Array.isArray(win.attachments)) return win.attachments;
    } catch {}
    return null;
  }
  function jobId(item) {
    return clean(item?.jobid || item?._jobid || item?.property?._jobid || "", 100);
  }
  function kind(item) {
    const module = String(item?.property?.module || item?.module || item?.type || "").toLowerCase();
    if (/video|audio/.test(module)) return "media";
    if (/doc|ppt|book|read|pdf/.test(module)) return "document";
    if (/work|quiz|test/.test(module)) return "manual";
    return "unknown";
  }
  function frameJob(frame, items) {
    const data = safeJSON(frame.getAttribute("data"));
    const jid = jobId(data) || frame.dataset.jobid || frame.getAttribute("jobid");
    if (jid) return items.find(item => jobId(item) === String(jid)) || null;
    const objectId = clean(data.objectid || data.objectId || frame.getAttribute("objectid"), 120);
    if (!objectId) return null;
    const matches = items.filter(item => clean(item.property?.objectid || item.objectid || item.property?.objectId, 120) === objectId);
    return matches.length === 1 ? matches[0] : null;
  }
  function completedMarker(el) {
    return el.classList.contains("ans-job-finished") ||
      /已完成/.test(`${el.getAttribute("title") || ""} ${el.getAttribute("aria-label") || ""}`) ||
      (el.matches(".ans-job-icon") && clean(el.textContent, 80) === "任务点已完成");
  }
  function badge(frame, jid) {
    const exact = Array.from(document.querySelectorAll('.ans-job-icon,.ans-job-finished')).find(el =>
      String(el.dataset.jobid || el.getAttribute("jobid") || "") === jid);
    if (exact && completedMarker(exact)) return true;
    let box = frame?.parentElement;
    for (let depth = 0; box && depth < 4; depth++, box = box.parentElement) {
      const items = raw() || [];
      const idsInBox = new Set(Array.from(box.querySelectorAll('iframe[data],iframe[data-jobid],iframe[jobid],iframe[objectid]'))
        .map(el => jobId(frameJob(el, items)) || jobId(safeJSON(el.getAttribute("data"))) || el.dataset.jobid || el.getAttribute("jobid")).filter(Boolean));
      if (idsInBox.size > 1 || (idsInBox.size === 1 && !idsInBox.has(jid))) return false;
      // The platform places completion on the task container itself as well as on badges.
      const markers = [box, ...box.querySelectorAll('.ans-job-icon,.ans-job-finished,[title*="任务点"],[aria-label*="任务点"]')];
      if (markers.some(el => {
        const markerJob = el.dataset.jobid || el.getAttribute("jobid");
        return (!markerJob || String(markerJob) === jid) && completedMarker(el);
      })) return true;
      if (box.matches(".ans-attach-ct,.ans-attach-online")) return false;
    }
    return false;
  }
  function ownJobs() {
    const items = raw() || [];
    const childFrames = Array.from(document.querySelectorAll("iframe[data],iframe[data-jobid],iframe[jobid],iframe[objectid]"));
    return items.map((item, index) => {
      const jid = jobId(item);
      const matches = childFrames.filter(el => frameJob(el, items) === item);
      const shown = matches.filter(visible);
      const frame = shown.length === 1 ? shown[0] : matches.length === 1 ? matches[0] : null;
      const type = kind(item);
      const local = !childFrames.length && items.filter(i => kind(i) === type).length === 1 &&
        ((type === "media" && document.querySelector("video,audio")) || (type === "document" && documentReader()));
      const owner = frame ? `${token}/${id(frame)}` : local ? `${token}/self/${jid}` : "";
      if (frame) {
        frame.setAttribute("data-cx-task-owner", owner);
        frame.setAttribute("data-cx-task-job", jid);
      }
      return { id: jid, owner, order: frame ? childFrames.indexOf(frame) : childFrames.length + index,
        binding: frame || local ? "bound" : matches.length > 1 ? "ambiguous" : "missing",
        kind: type, name: clean(item.property?.name || item.property?.title || item.property?.bookname || "未命名任务"),
        required: item.job === true || item.job === "true" || !!item.jobid || item.isPassed === true,
        confirmed: item.isPassed === true || item.isPassed === "true" || badge(frame, jid) };
    }).filter(j => j.id).sort((a, b) => a.order - b.order);
  }
  function context() {
    const out = { ...inherited };
    const localJobs = ownJobs();
    let win = window;
    let nearestBinding = null;
    let branchVisible = inherited.branchVisible !== false;
    let depth = 0;
    for (; depth < 8; depth++) {
      try {
        const doc = win.document;
        const params = new URL(win.location.href).searchParams;
        const course = doc.querySelector("#curCourseId")?.value || params.get("courseId") || params.get("courseid");
        if (course) out.course = clean(course, 100);
        const chapter = doc.querySelector("#curChapterId")?.value || params.get("chapterId") || params.get("knowledgeid");
        if (chapter) out.chapter = clean(chapter, 100);
        const tabs = Array.from(doc.querySelectorAll("#prev_tab .prev_ul li,.prev_ul li"));
        const index = tabs.findIndex(t => t.classList.contains("active"));
        if (index >= 0) out.card = String(index);
        else if (params.has("num")) out.card = params.get("num");
        const frame = win.frameElement;
        if (frame) {
          const style = win.parent.getComputedStyle(frame);
          branchVisible = branchVisible && style.display !== "none" && style.visibility !== "hidden" &&
            Array.from(frame.getClientRects()).some(r => r.width > 1 && r.height > 1);
          const owner = frame.getAttribute("data-cx-task-owner");
          const jid = frame.getAttribute("data-cx-task-job");
          if (!nearestBinding && owner && jid) nearestBinding = { owner, jobId: jid };
        }
        if (win === win.parent) break;
        win = win.parent;
      } catch { break; }
    }
    if (nearestBinding) Object.assign(out, nearestBinding);
    if (!out.owner) {
      const local = localJobs.filter(j => j.owner.startsWith(`${token}/self/`));
      if (local.length === 1) Object.assign(out, { owner: local[0].owner, jobId: local[0].id });
    }
    out.branchVisible = branchVisible;
    out.depth = Math.max(depth, Number(inherited.depth) || 0);
    out.card = String(out.card ?? "0");
    return out;
  }
  function blocker() {
    if (/passport|\/login(?:\b|\/)/i.test(location.pathname + location.hostname)) return "登录已失效，请手动登录后再开始";
    const checks = [
      ['.chapterVideoFaceMaskDiv,#fcqrimg[src]:not([src=""]),.face-recognition', "出现人脸验证，请手动处理后再开始"],
      ['#videoquiz-submit,.ans-videoquiz,.TiMu', "出现随堂题或章节测验，请手动完成后再开始"],
      ['iframe[src*="captcha"],#captcha,.yidun_popup,.geetest_panel', "出现验证码，请手动处理后再开始"]
    ];
    for (const [selector, reason] of checks) {
      if (Array.from(document.querySelectorAll(selector)).some(visible)) return reason;
    }
    return "";
  }
  function navSnapshot(ctx) {
    const tabs = Array.from(document.querySelectorAll("#prev_tab .prev_ul li,.prev_ul li"));
    const entries = Array.from(document.querySelectorAll('[onclick^="getTeacherAjax"],a[href*="/mycourse/studentstudy"]'));
    const dedupe = new Set();
    const chapters = entries.filter(el => {
      const row = el.closest(".posCatalog_select,li,.chapter_item") || el;
      if (dedupe.has(row)) return false;
      dedupe.add(row);
      return true;
    }).map(el => {
      const row = el.closest(".posCatalog_select,li,.chapter_item") || el.parentElement;
      const count = row?.querySelector(".jobUnfinishCount")?.value;
      return { id: id(el), name: clean(el.textContent) || "下一章节",
        active: row?.classList.contains("posCatalog_active") || el.classList.contains("posCatalog_active"),
        complete: !!row?.querySelector(".icon_Completed") || (count !== undefined && String(count).trim() !== "" && Number(count) === 0),
        locked: el.getAttribute("aria-disabled") === "true" || !!row?.querySelector(".icon_lock,.locked") };
    });
    const isStudy = /\/mycourse\/studentstudy/.test(location.pathname) || !!document.querySelector("#curChapterId");
    if (isStudy && ctx.chapter) return { kind: "study", chapters, tabs: tabs.map(el => ({
      id: id(el), name: clean(el.textContent) || "下一子单元", locked: el.getAttribute("aria-disabled") === "true"
    })), activeTab: Math.max(0, tabs.findIndex(el => el.classList.contains("active"))) };
    if (chapters.length && /\/mycourse\/(?:stu|studentcourse)/.test(location.pathname)) return { kind: "catalog", chapters, tabs: [] };
    return null;
  }
  function delegatedReader() {
    return Array.from(document.querySelectorAll("iframe")).some(frame => {
      try {
        const url = new URL(frame.getAttribute("src") || "about:blank", location.href);
        return /(?:^|\.)(?:chaoxing\.com|sslibrary\.com|xuexi365\.com)$/.test(url.hostname) &&
          /\/screen\/|\/reader\/|\/readsvr\/|\/ananas\/modules\/(?:pdf|doc|ppt)/i.test(url.pathname);
      } catch { return false; }
    });
  }
  function documentReader() {
    if (document.querySelector("video,audio")) return false;
    if (delegatedReader()) return false;
    const localReader = document.querySelector("#img.imglook,.pdfViewer,#viewerContainer,.swiper-container");
    if (!localReader && document.querySelector("iframe[src]")) return false;
    return !!localReader ||
      /\/ananas\/modules\/(?:doc|ppt|pdf)|\/readsvr\/book\/mooc|\/reader\/|\/screen\/(?:v2\/)?file_/i.test(location.pathname);
  }
  function scrollables() {
    const root = document.scrollingElement || document.documentElement;
    const minWidth = Math.max(100, (window.innerWidth || root.clientWidth || 600) * 0.42);
    const list = new Set([root]);
    for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 5000)) {
      if (el.clientHeight < 80 || el.clientWidth < minWidth || el.scrollHeight <= el.clientHeight + 4 || !visible(el)) continue;
      if (el.closest('nav,aside,[role="navigation"],.thumbnail,.thumbnails,.toolbar')) continue;
      // overflow:hidden readers still support programmatic scrolling; visible boxes do not.
      if (/(auto|scroll|hidden)/.test(getComputedStyle(el).overflowY)) list.add(el);
    }
    return Array.from(list).filter(el => el && el.clientHeight > 0 && el.clientWidth > 0 &&
      el.scrollHeight > el.clientHeight + 4).sort((a, b) =>
      (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
  }
  function renderedPages(container) {
    const minImageWidth = Math.max(160, container.clientWidth * 0.4);
    const pageImages = Array.from(container.querySelectorAll("img")).filter(img => {
      const box = img.getBoundingClientRect();
      return box.width >= minImageWidth && !img.closest('nav,aside,[role="navigation"],.thumbnail,.thumbnails');
    });
    const canvases = Array.from(container.querySelectorAll("canvas")).filter(el => el.width > 100 && el.height > 80);
    if (pageImages.length) {
      const root = document.scrollingElement || document.documentElement;
      const box = container === root || container === document.body ? { top: 0 } : container.getBoundingClientRect();
      const viewportBottom = box.top + (container === document.body ? window.innerHeight : container.clientHeight || window.innerHeight);
      const inView = pageImages.filter(img => {
        const bounds = img.getBoundingClientRect();
        const bottom = Number.isFinite(bounds.bottom) ? bounds.bottom : bounds.top + bounds.height;
        return bottom > box.top && bounds.top < viewportBottom;
      });
      // Lazy middle pages may stay unloaded after jumping down; verify the pages actually at the viewport bottom.
      return inView.length > 0 && inView.every(img => img.complete && img.naturalWidth > 16 && img.naturalHeight > 16);
    }
    if (canvases.length) return true;
    return !!container.querySelector('.page[data-loaded="true"],.swiper-slide-active') ||
      (!!container.querySelector(".page,.reader-page") && clean(container.textContent, 200).length > 40);
  }
  function scrollDocument() {
    if (!documentReader()) { bottomTicks = 0; readerState = { state: "locating", progress: 0 }; return; }
    const slides = Array.from(document.querySelectorAll(".swiper-container .swiper-slide"));
    let slidesDone = true;
    if (slides.length > 1) {
      const last = slides[slides.length - 1];
      slidesDone = last.classList.contains("swiper-slide-active");
      const next = document.querySelector(".swiper-button-next:not(.swiper-button-disabled)");
      if (!slidesDone && next) next.click();
    }
    const candidates = scrollables();
    let target = null;
    for (const el of candidates) {
      const previous = el.scrollTop;
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight);
      if (Math.abs(el.scrollTop - previous) > 1 || el.scrollTop > 1) { target = el; break; }
    }
    // A non-scrolling outer shell is never sufficient evidence of reaching the reader bottom.
    if (!target) {
      const root = document.scrollingElement || document.documentElement;
      const lastPage = document.querySelector('.swiper-slide-active:last-child,#img.imglook');
      const box = lastPage?.getBoundingClientRect();
      if (lastPage && renderedPages(document.body) && box && box.height > 0 && box.bottom <= window.innerHeight + 5 && slidesDone &&
          root.clientHeight > 0 && root.scrollHeight <= root.clientHeight + 5) target = root;
    }
    if (!target) {
      bottomTicks = 0;
      readerState = { state: "locating", progress: 0 };
      return;
    }
    target.dispatchEvent(new Event("scroll"));
    const top = Math.max(0, Math.round(target.scrollTop));
    const height = Math.round(target.scrollHeight);
    const viewport = Math.round(target.clientHeight);
    const maximum = Math.max(0, height - viewport);
    const rendered = viewport > 0 && document.readyState === "complete" && renderedPages(target === document.documentElement ? document.body : target);
    const bottom = maximum - top <= 5;
    const stamp = `${id(target)}:${height}:${viewport}`;
    bottomTicks = rendered && bottom && slidesDone && stamp === lastHeight ? bottomTicks + 1 : 0;
    lastHeight = stamp;
    readerState = { state: !rendered ? "loading" : bottomTicks >= 3 ? "at-bottom" : "scrolling",
      progress: maximum > 0 ? Math.min(100, Math.round(top / maximum * 100)) : 100,
      top, height, viewport, target: clean(target.id || target.className || target.tagName, 80) };
  }
  function tasks(ctx) {
    const result = [];
    if (!ctx.owner || !ctx.jobId || ctx.branchVisible === false) return result;
    const media = selectedMedia();
    const jid = ctx.jobId || (ownJobs().filter(j => j.kind === "media").length === 1 ? ownJobs().find(j => j.kind === "media").id : "");
    for (const el of media) {
      const mid = el.closest("[data-jobid]")?.dataset.jobid || jid;
      if (!mid) continue;
      result.push({ id: active?.element === el ? active.id : id(el), jobId: mid, owner: ctx.owner,
        visible: true, quality: 200, kind: "media", time: Number(el.currentTime) || 0,
        duration: Number.isFinite(el.duration) ? el.duration : 0, ended: el.ended, rate: el.playbackRate,
        paused: el.paused, nativeErrorCode: el.error?.code || 0,
        muted: el.muted,
        mediaNode: clean(el.id || el.tagName, 80),
        readyState: el.readyState, hasSource: !!(el.currentSrc || el.getAttribute("src") || el.querySelector("source[src]") || el.srcObject),
        phase: active?.element === el ? active.phase || "initializing" : "idle",
        error: active?.element === el ? error : "" });
    }
    if (documentReader()) {
      const djid = ctx.jobId || (ownJobs().filter(j => j.kind === "document").length === 1 ? ownJobs().find(j => j.kind === "document").id : "");
      if (djid) result.push({ id: "document", jobId: djid, owner: ctx.owner, visible: true,
        quality: /\/screen\//.test(location.pathname) ? 150 : location.protocol === "about:" ? 20 : 100,
        kind: "document", bottom: bottomTicks >= 3,
        reader: { ...readerState }, error });
    }
    return result;
  }
  function setGuard(enabled) {
    if (guard === enabled) return;
    guard = enabled;
    if (enabled) {
      for (const [object, prop, value] of [[document, "hidden", false], [document, "visibilityState", "visible"], [document, "hasFocus", () => true]]) {
        try {
          saved.push([object, prop, Object.getOwnPropertyDescriptor(object, prop)]);
          Object.defineProperty(object, prop, { configurable: true, ...(typeof value === "function" ? { value } : { get: () => value }) });
        } catch {}
      }
    } else {
      for (const [object, prop, descriptor] of saved.splice(0)) {
        try { if (descriptor) Object.defineProperty(object, prop, descriptor); else delete object[prop]; } catch {}
      }
    }
  }
  function guardEvent(event) {
    if (!guard) return;
    if (event.type === "visibilitychange" || ((event.type === "blur" || event.type === "focusout") &&
      [window, document, document.body, document.documentElement].includes(event.target)) ||
      ((event.type === "mouseout" || event.type === "mouseleave" || event.type === "pointerleave") && !event.relatedTarget)) {
      event.stopImmediatePropagation();
    }
  }
  for (const type of ["visibilitychange", "blur", "focusout", "mouseout", "mouseleave", "pointerleave"]) {
    window.addEventListener(type, guardEvent, true);
    document.addEventListener(type, guardEvent, true);
  }
  function stop() {
    const previous = active;
    active = null;
    error = "";
    bottomTicks = 0;
    lastHeight = 0;
    readerState = { state: "locating", progress: 0 };
    setGuard(false);
    if (previous?.element) {
      try {
        const player = playerFor(previous.element);
        if (typeof player?.pause === "function") player.pause(); else previous.element.pause();
        if (typeof player?.playbackRate === "function") player.playbackRate(previous.originalRate);
        if (typeof player?.muted === "function") player.muted(previous.originalMuted);
        previous.element.playbackRate = previous.originalRate;
        previous.element.muted = previous.originalMuted;
      } catch {}
    }
  }
  function pointer(el) {
    const box = el.getBoundingClientRect();
    const target = el.closest(".video-js") || el;
    for (const type of ["mouseenter", "mouseover", "mousemove"]) target.dispatchEvent(new MouseEvent(type, {
      bubbles: type !== "mouseenter", clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, view: window
    }));
  }
  function registeredPlayerFor(el) {
    try {
      const root = el.closest(".video-js");
      const playerId = root?.id || el.id.replace(/_html5_api$/, "");
      return root?.player || el.player || window.videojs?.getPlayer?.(playerId) || window.videojs?.players?.[playerId] || null;
    } catch { return null; }
  }
  function playerMedia(player) {
    try {
      const tech = player?.tech_?.el?.() || player?.tech_?.el_ || null;
      return tech && tech.isConnected && /^(VIDEO|AUDIO)$/.test(tech.tagName) ? tech : null;
    } catch { return null; }
  }
  function playerFor(el) {
    const player = registeredPlayerFor(el);
    const tech = playerMedia(player);
    // A stale registered player must not control an unrelated replacement media element.
    return tech && tech !== el ? null : player;
  }
  function selectedMedia() {
    const elements = Array.from(document.querySelectorAll("video,audio"));
    const candidates = new Map();
    for (const original of elements) {
      const tech = playerMedia(registeredPlayerFor(original));
      for (const el of new Set([original, tech].filter(Boolean))) {
        if (!visible(el) && el.tagName !== "AUDIO") continue;
        const score = (tech === el ? 2000 : 0) + (!el.error ? 10000 : 0) + (el.readyState > 0 ? 300 : 0) +
          (!el.paused && el.readyState > 0 ? 5000 : 0) + (el.currentSrc || el.getAttribute("src") ? 100 : 0);
        candidates.set(el, Math.max(candidates.get(el) || 0, score));
      }
    }
    // A task player can leave hidden/obsolete media nodes behind after its technology changes.
    return Array.from(candidates).sort((a, b) => b[1] - a[1]).slice(0, 1).map(([el]) => el);
  }
  function startButton(el) {
    const root = el.closest(".video-js") || el.parentElement;
    const button = Array.from(root?.querySelectorAll('.vjs-big-play-button,.vjs-poster[role="button"],.vjs-play-control:not(.vjs-playing),.playButton,.play-btn') || []).find(visible);
    return button && visible(button) ? button : null;
  }
  function mediaFailure(code) {
    if (code === 4) return "原播放器初始化后仍未取得可播放资源（错误 4），请手动点击中央播放后重试";
    if (code === 3) return "原播放器报告视频解码失败（错误 3），请尝试页面自带的清晰度选项";
    if (code === 2) return "原播放器报告媒体请求失败（错误 2），请检查课程视频地址是否仍有效";
    return "原播放器启动未完成，请手动点击一次中央播放后重新开始";
  }
  async function maintain() {
    if (leaseUntil && Date.now() > leaseUntil) { stop(); leaseUntil = 0; }
    if (!active) return;
    if (blocker()) { stop(); return; }
    const ctx = context();
    if (ctx.owner !== active.owner || ctx.jobId !== active.jobId) { error = "任务与页面绑定已改变，已停止操作当前阅读器"; return; }
    if (active.id === "document") { scrollDocument(); return; }
    let el = active.element;
    const preferred = selectedMedia()[0];
    if (!el?.isConnected || (preferred && preferred !== el)) {
      const replacement = preferred;
      if (replacement) { el = replacement; active.element = el; nodes.set(active.id, el); }
      else { error = "播放器已被页面移除，请重新开始识别"; return; }
    }
    if (el.ended) return;
    const current = active;
    const now = Date.now();
    const player = playerFor(el);
    const hasSource = !!(el.currentSrc || el.getAttribute("src") || el.querySelector("source[src]") || el.srcObject);
    try {
      if (el.muted !== active.config.muted) el.muted = active.config.muted;
      if (typeof player?.muted === "function" && player.muted() !== active.config.muted) player.muted(active.config.muted);
      if (!el.paused && !el.error) {
        current.phase = "playing";
        current.started = true;
        error = "";
      }
      if (el.readyState > 0 || current.started) {
        if (typeof player?.playbackRate === "function" && Number(player.playbackRate()) !== active.config.rate) player.playbackRate(active.config.rate);
        if (el.playbackRate !== active.config.rate) el.playbackRate = active.config.rate;
      }
      if (active.config.guard && Date.now() - lastPointer > 1800) { pointer(el); lastPointer = Date.now(); }
      if (!current.started && now - current.startAt > 30000) { error = mediaFailure(el.error?.code); return; }
      if ((el.paused || el.error) && !current.playing) {
        if (current.lastAttempt && now - current.lastAttempt < 3000) return;
        current.lastAttempt = now;
        current.phase = el.error ? "recovering" : "initializing";
        const button = startButton(el);
        if (button && current.buttonAttempts < 2) {
          current.buttonAttempts++;
          button.click();
          return;
        }
        if (!player && !hasSource) return;
        current.playing = true;
        try {
          // Video.js owns lazy source selection and task initialization. Never initialize a second player.
          const promise = typeof player?.play === "function" ? player.play() : el.play();
          if (promise?.then) await promise;
          if (active !== current) return;
          if (!el.paused && !el.error) { current.phase = "playing"; current.started = true; error = ""; }
          if (el.readyState > 0 || current.started) {
            if (typeof player?.playbackRate === "function") player.playbackRate(current.config.rate);
            el.playbackRate = current.config.rate;
          }
        } finally { if (active === current) current.playing = false; }
      }
    } catch (e) {
      if (active !== current) return;
      if (e.name === "NotAllowedError") error = "浏览器阻止自动播放，请手动点一次视频播放，再点击开始";
      else if (e.name !== "AbortError" && now - current.startAt > 30000) error = mediaFailure(el.error?.code);
    }
  }
  function allowedOrigin(origin) { try { return /(?:^|\.)(chaoxing\.com|sslibrary\.com|xuexi365\.com)$/.test(new URL(origin).hostname); } catch { return false; } }
  window.addEventListener("message", event => {
    if (event.source === window.parent && window.parent !== window && allowedOrigin(event.origin) && event.data?.channel === BUS && event.data?.type === "CONTEXT") {
      const value = event.data.context;
      if (value && typeof value === "object") inherited = { course: clean(value.course, 100), chapter: clean(value.chapter, 100),
        card: clean(value.card, 20), jobId: clean(value.jobId, 100), owner: clean(value.owner, 200),
        branchVisible: value.branchVisible !== false, depth: Number(value.depth) || 0 };
    }
  });
  function propagate(ctx) {
    const jobs = ownJobs();
    for (const frame of document.querySelectorAll("iframe")) {
      try {
        const url = new URL(frame.src || location.href, location.href);
        const origin = url.protocol === "about:" ? location.origin : url.origin;
        if (!allowedOrigin(origin)) continue;
        const bound = jobs.find(j => j.owner && j.owner === frame.getAttribute("data-cx-task-owner"));
        const next = { ...ctx, branchVisible: ctx.branchVisible !== false && visible(frame), depth: (ctx.depth || 0) + 1 };
        if (bound) Object.assign(next, { jobId: bound.id, owner: bound.owner });
        if (next.owner && next.jobId) {
          frame.setAttribute("data-cx-task-owner", next.owner);
          frame.setAttribute("data-cx-task-job", next.jobId);
        }
        frame.contentWindow?.postMessage({ channel: BUS, type: "CONTEXT", context: next }, origin);
      } catch {}
    }
  }
  function report() {
    try {
      lastReportAt = Date.now();
      const ctx = context();
      const snapshot = { token, owner: ctx.owner || "", depth: ctx.depth, visible: ctx.branchVisible,
        course: ctx.course || "", chapter: ctx.chapter || "", card: ctx.card,
        inventoryReady: raw() !== null && document.readyState !== "loading",
        inventoryAuthority: /\/knowledge\/cards/.test(location.pathname) ? 100 : 10,
        jobs: ownJobs(), tasks: tasks(ctx), blocker: blocker(), navigation: navSnapshot(ctx),
        activeTask: active ? { id: active.id, jobId: active.jobId, owner: active.owner } : null };
      document.dispatchEvent(new CustomEvent(`${BUS}:snapshot`, { detail: JSON.stringify(snapshot) }));
      propagate(ctx);
      for (const [nid, el] of nodes) if (!el.isConnected) nodes.delete(nid);
    } catch {}
  }
  function activateTask(c) {
    const found = tasks(context()).find(t => t.id === c.id && t.jobId === c.jobId && t.owner === c.owner);
    if (!found) throw new Error("missing task");
    stop();
    leaseUntil = Date.now() + leaseMs;
    const cfg = { rate: [1, 1.25, 1.5, 2].includes(Number(c.config?.rate)) ? Number(c.config.rate) : 2,
      muted: c.config?.muted !== false, guard: c.config?.guard !== false };
    const el = c.id === "document" ? null : nodes.get(c.id);
    active = { id: c.id, element: el, config: cfg, originalRate: el?.playbackRate, originalMuted: el?.muted,
      startAt: Date.now(), started: false, phase: "initializing", buttonAttempts: 0, lastAttempt: 0,
      jobId: c.jobId, owner: c.owner, rootId: el?.closest(".video-js")?.id || "" };
    setGuard(cfg.guard);
    maintain();
  }
  function onMediaEvent(event) {
    if (!active || event.target !== active.element) return;
    const urgent = ["pause", "playing", "ended", "error", "loadedmetadata"].includes(event.type);
    if (urgent && !mediaWakeQueued) {
      mediaWakeQueued = true;
      // Native media events keep working when chained page timers are heavily throttled.
      queueMicrotask(() => { mediaWakeQueued = false; maintain().then(() => report()).catch(() => {}); });
    } else if (Date.now() - lastReportAt >= 1500) {
      maintain().catch(() => {});
      report();
    }
  }
  for (const type of ["timeupdate", "pause", "playing", "ended", "error", "loadedmetadata"]) document.addEventListener(type, onMediaEvent, true);
  document.addEventListener(`${BUS}:command`, event => {
    const { request, command: c } = safeJSON(event.detail);
    if (!c || typeof request !== "string") return;
    let ok = c.type === "POLL" || c.token === token;
    try {
      if (!ok) throw new Error("stale frame");
      if (Number.isFinite(c.revision)) {
        if (c.revision < controlRevision) throw new Error("stale control revision");
        controlRevision = c.revision;
      }
      if (c.type === "STOP") stop();
      else if (c.type === "POLL") report();
      else if (c.type === "REVEAL") {
        ownJobs();
        const frame = Array.from(document.querySelectorAll("iframe[data-cx-task-owner]")).find(el =>
          el.getAttribute("data-cx-task-owner") === c.owner && el.getAttribute("data-cx-task-job") === c.jobId);
        if (frame) frame.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
        else throw new Error("task frame binding missing");
      }
      else if (c.type === "GUARD") { setGuard(c.enabled === true); leaseUntil = Date.now() + leaseMs; }
      else if (c.type === "LEASE") {
        leaseUntil = Date.now() + leaseMs;
        if (!c.keepAlive) stop();
        else setGuard(c.guard === true);
      } else if (c.type === "WAKE") {
        leaseUntil = Date.now() + leaseMs;
        if (!c.keepAlive) stop();
        else {
          setGuard(c.guard === true);
          if (c.task && (!active || active.owner !== c.task.owner || active.jobId !== c.task.jobId)) activateTask(c.task);
          else maintain();
        }
        report();
      } else if (c.type === "RUN") {
        activateTask(c);
      } else if (c.type === "NAVIGATE") {
        const el = nodes.get(c.id);
        if (!el?.isConnected) throw new Error("stale navigation");
        const nav = navSnapshot(context());
        const item = [...(nav?.tabs || []), ...(nav?.chapters || [])].find(n => n.id === c.id);
        if (!item || item.locked) throw new Error("invalid navigation");
        stop();
        const clickElement = el.matches("li") ? el.querySelector("a,[onclick],button") || el : el;
        const previousTarget = clickElement.getAttribute("target");
        if (clickElement.tagName === "A") clickElement.setAttribute("target", "_self");
        clickElement.click();
        if (previousTarget === null) clickElement.removeAttribute("target"); else clickElement.setAttribute("target", previousTarget);
      } else throw new Error("invalid command");
    } catch { ok = false; }
    document.dispatchEvent(new CustomEvent(`${BUS}:reply`, { detail: JSON.stringify({ request, ok }) }));
  });
  const completionSelector = '.ans-job-icon,.ans-attach-ct,.ans-attach-online,.ans-job-finished,[title*="任务点"],[aria-label*="任务点"]';
  let completionReportQueued = false;
  new MutationObserver(records => {
    const changed = records.some(record => {
      const el = record.target.nodeType === 1 ? record.target : record.target.parentElement;
      if (record.type === "attributes") return el?.matches(completionSelector);
      if (el?.matches(".ans-job-icon")) return true;
      return [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1 &&
        (node.matches(completionSelector) || node.querySelector(completionSelector)));
    });
    if (!changed || completionReportQueued) return;
    completionReportQueued = true;
    queueMicrotask(() => { completionReportQueued = false; report(); });
  }).observe(document, { subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ["class", "title", "aria-label"] });
  setInterval(maintain, 1000);
  setInterval(report, 1500);
  document.addEventListener("DOMContentLoaded", report, { once: true });
  window.addEventListener("pagehide", stop);
})();
