"use strict";
let tabId;
let state;
const $ = id => document.getElementById(id);
function render(value) {
  if (value.error) { $("status").textContent = value.error; return; }
  if (!state) {
    $("rate").value = value.config.rate;
    for (const k of ["documents", "guard", "autoNext", "muted"]) $(k).checked = value.config[k];
  }
  state = value;
  $("status").textContent = value.connected ? value.message : "请打开学习通子单元，并刷新页面以连接助手";
  $("count").textContent = `本次会话平台确认完成 ${value.completed} 项`;
  $("start").disabled = value.running || !value.connected;
  for (const el of document.querySelectorAll("input,select")) el.disabled = value.running;
}
async function refresh() {
  if (!Number.isInteger(tabId)) return;
  try { render(await chrome.runtime.sendMessage({ type: "CX_STATUS", tabId })); }
  catch { $("status").textContent = "助手连接失败，请重新打开此面板"; }
}
async function control(action) {
  const config = { rate: Number($("rate").value) };
  for (const k of ["documents", "guard", "autoNext", "muted"]) config[k] = $(k).checked;
  try { render(await chrome.runtime.sendMessage({ type: "CX_CONTROL", tabId, action, config })); }
  catch { $("status").textContent = "助手连接失败，请刷新课程页"; }
}
$("start").onclick = () => control("start");
$("pause").onclick = () => control("pause");
$("export").onclick = () => {
  if (!state) return;
  const data = CXDiagnostics.build(state, chrome.runtime.getManifest().version);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "chaoxing-helper-diagnostics.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
  tabId = tabs[0]?.id;
  refresh();
}).catch(() => { $("status").textContent = "未找到当前标签页"; });
setInterval(refresh, 1500);
