(function () {
  "use strict";
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
  const pending = new Map();
  let token = "";
  let disconnected = false;
  function command(c) {
    return new Promise(resolve => {
      const request = uuid();
      const timer = setTimeout(() => { pending.delete(request); resolve({ ok: false }); }, 1500);
      pending.set(request, result => { clearTimeout(timer); resolve(result); });
      document.dispatchEvent(new CustomEvent(`${BUS}:command`, { detail: JSON.stringify({ request, command: c }) }));
    });
  }
  document.addEventListener(`${BUS}:reply`, event => {
    try {
      const result = JSON.parse(event.detail);
      pending.get(result.request)?.(result);
      pending.delete(result.request);
    } catch {}
  });
  document.addEventListener(`${BUS}:snapshot`, async event => {
    if (disconnected) return;
    try {
      const snapshot = JSON.parse(event.detail);
      token = snapshot.token;
      const response = await chrome.runtime.sendMessage({ type: "CX_REPORT", snapshot });
      if (typeof response?.keepAlive === "boolean") command({ type: "LEASE", token, keepAlive: response.keepAlive,
        guard: response.guard, revision: response.revision });
    } catch {
      if (!chrome.runtime?.id) { disconnected = true; command({ type: "STOP", token }); }
    }
  });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "CX_DISCOVER") { command({ type: "POLL" }).then(reply); return true; }
    if (message?.type !== "CX_COMMAND") return false;
    command(message.command).then(reply);
    return true;
  });
  if (window !== window.top || !/(?:\/mycourse\/(?:stu|studentstudy|studentcourse))/.test(location.pathname)) return;
  let shadow;
  let collapsed = false;
  let last = null;
  async function control(action) {
    const response = await chrome.runtime.sendMessage({ type: "CX_CONTROL", action, config: readConfig() });
    if (response?.error) shadow.querySelector("#message").textContent = response.error;
    else render(response);
  }
  function readConfig() {
    return { rate: Number(shadow.querySelector("#rate").value), documents: shadow.querySelector("#documents").checked,
      guard: shadow.querySelector("#guard").checked, autoNext: shadow.querySelector("#next").checked, muted: shadow.querySelector("#muted").checked };
  }
  function render(value) {
    if (!value || !shadow) return;
    if (!last) {
      shadow.querySelector("#rate").value = value.config.rate;
      for (const [id, key] of [["documents", "documents"], ["guard", "guard"], ["next", "autoNext"], ["muted", "muted"]]) shadow.querySelector(`#${id}`).checked = value.config[key];
    }
    last = value;
    shadow.querySelector("#message").textContent = value.message;
    shadow.querySelector("#count").textContent = `本次会话平台确认完成 ${value.completed} 项`;
    shadow.querySelector("#start").disabled = value.running;
    for (const el of shadow.querySelectorAll("select,input")) el.disabled = value.running;
    shadow.querySelector("#light").style.background = value.running ? "#31c48d" : "#9ca3af";
    shadow.querySelector("#jobs").replaceChildren(...value.jobs.map((j, index) => {
      const el = document.createElement("div");
      el.textContent = `${index + 1}. ${j.confirmed ? "✓" : j.active ? "▶" : "○"} ${j.kind === "media" ? "视频" : j.kind === "document" ? "文档" : "其它"} · ${j.name}`;
      return el;
    }));
  }
  function mount() {
    if (!document.body) return;
    const host = document.createElement("div");
    host.id = "cx-chapter-helper-panel";
    host.style.cssText = "position:fixed;right:20px;top:96px;z-index:2147483646;";
    shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<style>
      :host{all:initial;color:#e5e7eb;font:13px/1.65 system-ui,'Microsoft YaHei',sans-serif}
      *{box-sizing:border-box}section{width:304px;background:#142239;border:1px solid #35445c;border-radius:15px;box-shadow:0 12px 38px #0003;overflow:hidden}
      header{display:flex;align-items:center;gap:8px;padding:13px 15px;background:#1c2e48;font-weight:700}#light{height:8px;width:8px;border-radius:50%;background:#9ca3af}
      #collapse{margin-left:auto;background:none;border:0;color:#bfccdd;cursor:pointer;font-size:18px}main{padding:14px 15px}#message{color:#fff;min-height:43px;overflow-wrap:anywhere}
      #count{color:#9db0c8;font-size:11px;margin:6px 0 12px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:7px}label{display:flex;gap:5px;align-items:center}
      select{background:#233953;color:#fff;border:1px solid #49617e;border-radius:5px;padding:3px}input{accent-color:#48b8ff}button{font:inherit}button:disabled,input:disabled,select:disabled{opacity:.55}
      .buttons{display:flex;gap:8px;margin-top:14px}.buttons button{flex:1;cursor:pointer;padding:8px;border-radius:8px;border:0;background:#3d92e4;color:#fff;font-weight:600}#pause{background:#34475f}
      #jobs{margin-top:12px;max-height:130px;overflow:auto;color:#bdcde1;font-size:12px}#jobs div{overflow-wrap:anywhere;padding:3px 0}small{display:block;font-size:11px;color:#94a9c2;margin-top:10px}
    </style><section><header><span id="light"></span>学习通章节助手 1.0.6<button id="collapse" title="收起">−</button></header><main>
      <div id="message" role="status" aria-live="polite">正在连接页面…</div><div id="count"></div>
      <div class="grid"><label>播放速度 <select id="rate"><option>1</option><option>1.25</option><option>1.5</option><option selected>2</option></select></label>
      <label><input type="checkbox" id="muted" checked>静音播放</label><label><input type="checkbox" id="documents" checked>文档滑到底</label>
      <label><input type="checkbox" id="guard" checked>离开继续播放</label><label><input type="checkbox" id="next" checked>自动下一节</label></div>
      <div class="buttons"><button id="start">开始</button><button id="pause">暂停</button></div><div id="jobs"></div><small>遇到题目、验证或完成状态不明时暂停。</small>
      </main></section>`;
    document.body.append(host);
    shadow.querySelector("#start").onclick = () => control("start").catch(() => { shadow.querySelector("#message").textContent = "连接已失效，请刷新课程页"; });
    shadow.querySelector("#pause").onclick = () => control("pause").catch(() => {});
    shadow.querySelector("#collapse").onclick = () => {
      collapsed = !collapsed;
      shadow.querySelector("main").hidden = collapsed;
      shadow.querySelector("#collapse").textContent = collapsed ? "+" : "−";
    };
    const refresh = async () => {
      try { render(await chrome.runtime.sendMessage({ type: "CX_STATUS" })); }
      catch { shadow.querySelector("#message").textContent = "扩展已更新或连接失效，请刷新课程页"; }
    };
    refresh();
    setInterval(refresh, 1500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
})();
