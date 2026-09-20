const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let config;
let logs = [];
let sessions = [];
let currentSession;

function escape(text) {
  const element = document.createElement("span");
  element.textContent = text ?? "";
  return element.innerHTML;
}
function appendLog(item) {
  logs = [...logs.slice(-499), item];
  const text = logs.map((line) => `[${line.time}] ${line.text}`).join("\n");
  $("#overview-log").textContent = text;
  $("#all-log").textContent = text;
}
function showPage(page) {
  $$(".page").forEach((element) => element.classList.toggle("active", element.id === page));
  $$("nav button").forEach((element) => element.classList.toggle("active", element.dataset.page === page));
}
function renderConfig() {
  $("#model-label").textContent = config.model ? config.model.split(/[\\/]/).pop() : "未选择";
  $("#context-label").textContent = `${Math.round(config.context / 1024)}K`;
  $("#workspace-label").textContent = config.workspace || "未选择工作区";
  $("#allow-writes").checked = config.allowWrites;
  for (const [key, value] of Object.entries(config)) {
    const input = $(`#settings-form [name="${key}"]`);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (key !== "cloudApiKey") input.value = value ?? "";
  }
}
function renderSessions() {
  $("#sessions").innerHTML = sessions.map((session) => `<button class="session ${session.id === currentSession?.id ? "selected" : ""}" data-session="${session.id}">${escape(session.title)}</button>`).join("");
  $$(".session").forEach((button) => button.onclick = () => { currentSession = sessions.find((item) => item.id === button.dataset.session); renderSessions(); renderTranscript(); });
}
function renderTranscript() {
  const blocks = currentSession?.blocks || [];
  $("#agent-transcript").innerHTML = blocks.map((block) => `<div class="block ${block.type || "reply"}"><b>${escape(block.title || block.type)}</b><p>${escape(block.text)}</p></div>`).join("");
  $("#agent-transcript").scrollTop = $("#agent-transcript").scrollHeight;
}
function persistSessions() {
  window.harness.sessions.save(sessions);
}
function newSession() {
  currentSession = { id: crypto.randomUUID(), title: "新对话", workspace: config.workspace, blocks: [] };
  sessions.unshift(currentSession);
  renderSessions();
  renderTranscript();
  persistSessions();
}
function addBlock(block) {
  if (!currentSession) newSession();
  const id = block.id || `${block.type}-${crypto.randomUUID()}`;
  const existing = currentSession.blocks.find((item) => item.id === id);
  if (existing) existing.text = block.append ? existing.text + (block.text || "") : (block.text || existing.text);
  else currentSession.blocks.push({ id, type: block.type, title: block.name || block.type, text: block.text || "" });
  renderTranscript();
  persistSessions();
}
async function refreshFiles(path = config.workspace) {
  if (!path) return;
  try {
    const entries = await window.harness.files.list(path);
    $("#file-browser").innerHTML = `<button data-path="${escape(path)}">📁 ${escape(path)}</button>` + entries.map((entry) => `<button class="file" data-path="${escape(entry.path)}" data-dir="${entry.directory}">${entry.directory ? "📁" : "📄"} ${escape(entry.name)}</button>`).join("");
    $$("#file-browser .file").forEach((button) => button.onclick = async () => {
      const path = button.dataset.path;
      if (button.dataset.dir === "true") return refreshFiles(path);
      try { $("#file-preview").textContent = await window.harness.files.read(path); } catch { $("#file-preview").textContent = "无法预览此文件。"; }
    });
  } catch (error) { $("#file-browser").textContent = String(error); }
}
async function chooseModel(kind) {
  const path = (await window.harness.dialog.file(kind))[0];
  if (!path) return;
  config[kind === "model" ? "model" : "mmproj"] = path;
  renderConfig();
}
async function sendChat() {
  const input = $("#chat-input");
  const files = [...$("#chat-images").files].map(window.harness.pathForFile);
  const text = input.value.trim() || (files.length ? "请描述图片。" : "");
  if (!text) return;
  $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble user">${escape(text)}</div>`);
  input.value = "";
  try {
    const reply = await window.harness.chat({ text, images: files });
    $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble assistant">${escape(reply)}</div>`);
  } catch (error) { $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble error">${escape(String(error))}</div>`); }
}
async function sendAgent() {
  const input = $("#agent-input");
  const filePaths = [...$("#agent-files").files].map(window.harness.pathForFile);
  const prompt = input.value.trim() || (filePaths.length ? "请检查附件。" : "");
  if (!prompt) return;
  if (!currentSession) newSession();
  addBlock({ id: crypto.randomUUID(), type: "user", title: "你", text: prompt });
  input.value = "";
  await window.harness.agent.send({ prompt: filePaths.length ? `${prompt}\n\n已附加文件：\n${filePaths.map((path) => `- ${path}`).join("\n")}` : prompt, images: filePaths.filter((path) => /\.(png|jpe?g|gif|webp)$/i.test(path)), history: currentSession.blocks.filter((block) => block.type === "user" || block.type === "reply").map((block) => ({ role: block.type === "user" ? "user" : "assistant", content: block.text })), workspace: config.workspace, allowWrites: $("#allow-writes").checked });
}
function saveSettings() {
  const form = new FormData($("#settings-form"));
  const values = Object.fromEntries(form.entries());
  for (const key of ["compatibility", "ngram", "reasoning"]) values[key] = $(`#settings-form [name="${key}"]`).checked;
  values.context = Number(values.context) || 8192;
  if (!values.cloudApiKey) delete values.cloudApiKey;
  window.harness.config.save(values).then((next) => { config = { ...config, ...next }; renderConfig(); appendLog({ time: new Date().toLocaleTimeString(), text: "设置已保存", kind: "success" }); });
}

window.harness.on("server-log", appendLog);
window.harness.on("server-state", (value) => {
  const online = value.phase === "online" || value.phase === "external";
  $("#status").textContent = online ? "在线" : value.phase === "starting" ? "启动中" : "离线";
  $("#phase").textContent = `● ${$("#status").textContent}`;
  $("#slot-label").textContent = value.slots?.[0] ? `slot ${value.slots[0].id}` : online ? "服务就绪" : "等待服务";
});
window.harness.on("agent-event", (event) => addBlock(event));

$$("nav button").forEach((button) => button.onclick = () => showPage(button.dataset.page));
$("#start").onclick = async () => { try { await window.harness.server.start(); } catch (error) { appendLog({ time: new Date().toLocaleTimeString(), text: String(error), kind: "error" }); } };
$("#stop").onclick = () => window.harness.server.stop();
$("#send-chat").onclick = sendChat;
$("#chat-input").onkeydown = (event) => { if (event.key === "Enter") sendChat(); };
$("#workspace").onclick = async () => { const path = await window.harness.dialog.directory(); if (path) { config.workspace = path; await window.harness.config.save({ workspace: path }); renderConfig(); refreshFiles(); } };
$("#new-session").onclick = newSession;
$("#send-agent").onclick = sendAgent;
$("#stop-agent").onclick = () => window.harness.agent.stop();
$("#allow-writes").onchange = () => { config.allowWrites = $("#allow-writes").checked; window.harness.config.save({ allowWrites: config.allowWrites }); };
$("#clear-log").onclick = () => { logs = []; appendLog({ time: new Date().toLocaleTimeString(), text: "日志已清空", kind: "info" }); };
$("#test-route").onclick = async () => { const state = await window.harness.server.state(); $("#route-result").textContent = state.phase === "online" || state.phase === "external" ? "本地服务连接成功" : "本地服务未运行"; };
$("#open-browser").onclick = () => { const url = $("#browser-url").value.trim(); if (url) window.harness.open.browser(url); };
$("#run-command").onclick = async () => { $("#terminal-output").textContent = "运行中…"; const result = await window.harness.tools.run($("#terminal-command").value, config.workspace); $("#terminal-output").textContent = `${result.output}\nexit ${result.code}`; };
$$("[data-pick]").forEach((button) => button.onclick = () => chooseModel(button.dataset.pick));
$("#save-settings").onclick = saveSettings;

(async () => {
  config = await window.harness.config.get();
  sessions = await window.harness.sessions.load();
  currentSession = sessions[0];
  if (!currentSession) newSession();
  renderConfig(); renderSessions(); renderTranscript(); refreshFiles();
})();
