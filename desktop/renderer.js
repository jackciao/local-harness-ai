const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const presetDefaults = {
  openai: ["https://api.openai.com/v1", "gpt-4o"], anthropic: ["https://api.anthropic.com", "claude-sonnet-4-5"],
  deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"], openrouter: ["https://openrouter.ai/api/v1", "anthropic/claude-sonnet-4.5"], custom: ["", ""],
};
let config;
let settingsDraft;
let logs = [];
let sessions = [];
let currentSession;
let currentDirectory = "";
let directoryEntries = [];
let attachments = [];
let chatImages = [];
let agentRunning = false;
let commandRunning = false;
let lastState = { phase: "offline", metrics: {} };
const streamAliases = new Map();

function escape(text) {
  const element = document.createElement("span");
  element.textContent = text ?? "";
  return element.innerHTML;
}

function errorText(error) {
  return String(error?.message || error).replace(/^Error invoking remote method '[^']+': Error: /, "");
}

function fileName(path) {
  return String(path || "").split(/[\\/]/).filter(Boolean).pop() || path;
}

function formatUptime(seconds) {
  if (!seconds) return "—";
  const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor(seconds / 60) % 60).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${secs}`;
}

function appendLog(item) {
  logs = [...logs.slice(-499), item];
  const text = logs.map((line) => `[${line.time}] ${line.text}`).join("\n");
  $("#overview-log").textContent = text;
  $("#all-log").textContent = text;
  $("#overview-log").scrollTop = $("#overview-log").scrollHeight;
}

function localLog(text, kind = "info") {
  appendLog({ time: new Date().toLocaleTimeString(), text, kind });
}

function showPage(page) {
  $$(".page").forEach((element) => element.classList.toggle("active", element.id === page));
  $$("nav button").forEach((element) => element.classList.toggle("active", element.dataset.page === page));
  if (page === "settings") { settingsDraft = structuredClone(config); renderSettings(); }
}

function activeProfile() {
  return config.cloudProfiles.find((profile) => profile.id === config.cloudProfileId) || config.cloudProfiles[0];
}

function displayModel() {
  return config.source === "cloud" ? activeProfile()?.model || "未设置云模型" : fileName(config.model) || "未选择模型";
}

function supportsVision() {
  if (config.source === "local") return Boolean(config.mmproj) || /vl|vision|mmproj/i.test(fileName(config.model));
  return /vl|vision|gpt-4|gpt-5|claude|gemini|grok/i.test(activeProfile()?.model || "");
}

function renderConfig() {
  $("#model-label").textContent = displayModel();
  $("#source-label").textContent = config.source === "cloud" ? "云 API" : "本地模型";
  $("#context-label").textContent = `${Math.round(config.context / 1024)}K`;
  $("#workspace-label").textContent = currentSession?.workspace || config.workspace || "未选择工作区";
  $("#allow-writes").checked = currentSession?.allowWrites ?? config.allowWrites;
  $("#allow-writes").nextElementSibling.textContent = $("#allow-writes").checked ? "可写 · 工具已开" : "只读";
  $("#agent-endpoint").textContent = config.source === "cloud" ? activeProfile()?.baseUrl || "云 API" : "127.0.0.1:7890/v1";
  renderAgentModels();
}

function renderSettings() {
  const form = $("#settings-form");
  for (const key of ["source", "model", "mmproj", "chatTemplate", "kv"]) form.elements[key].value = settingsDraft[key] ?? "";
  for (const key of ["compatibility", "ngram", "reasoning"]) form.elements[key].checked = Boolean(settingsDraft[key]);
  const presetContexts = [4096, 8192, 16384, 24576, 32768, 65536, 102400];
  form.elements.context.value = presetContexts.includes(settingsDraft.context) ? String(settingsDraft.context) : "custom";
  $("#custom-context").value = settingsDraft.context;
  $("#custom-context").classList.toggle("hidden", form.elements.context.value !== "custom");
  $("#local-settings").classList.toggle("hidden", settingsDraft.source !== "local");
  $("#cloud-settings").classList.toggle("hidden", settingsDraft.source !== "cloud");
  renderCloudProfiles();
}

function profileLabel(profile) {
  const name = { openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", openrouter: "OpenRouter", custom: "自定义" }[profile.preset] || "自定义";
  return `${name} · ${profile.model || "未设置模型"}`;
}

function renderCloudProfiles() {
  $("#cloud-profile").innerHTML = settingsDraft.cloudProfiles.map((profile) => `<option value="${escape(profile.id)}">${escape(profileLabel(profile))}</option>`).join("");
  $("#cloud-profile").value = settingsDraft.cloudProfileId;
  const profile = settingsDraft.cloudProfiles.find((item) => item.id === settingsDraft.cloudProfileId) || settingsDraft.cloudProfiles[0];
  $("#cloud-preset").value = profile.preset;
  $("#cloud-url").value = profile.baseUrl;
  $("#cloud-model").value = profile.model;
  $("#cloud-key").value = "";
  $("#cloud-key").placeholder = profile.keyConfigured ? "已安全保存；留空保持不变" : "输入 API Key";
  $("#delete-cloud").disabled = settingsDraft.cloudProfiles.length === 1;
}

function renderAgentModels() {
  const options = [];
  if (config.model) options.push(`<option value="local">本地 · ${escape(fileName(config.model))}</option>`);
  for (const profile of config.cloudProfiles.filter((item) => item.keyConfigured)) options.push(`<option value="cloud:${escape(profile.id)}">${escape(profileLabel(profile))}</option>`);
  $("#agent-model").innerHTML = options.join("") || '<option value="">请先配置模型</option>';
  $("#agent-model").value = config.source === "cloud" ? `cloud:${config.cloudProfileId}` : "local";
}

function normalizeSession(session) {
  return {
    id: session.id || crypto.randomUUID(), title: session.title || "新会话", customTitle: session.customTitle || "",
    workspace: session.workspace || config.workspace || "", allowWrites: session.allowWrites !== false,
    blocks: (session.blocks || []).filter((block) => block.kind !== "status" && block.type !== "status").map((block) => ({ ...block, kind: block.kind || block.type || "reply" })),
    updatedAt: Number(session.updatedAt) || Date.now(),
  };
}

function renderSessions() {
  const groups = new Map();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = session.workspace || "未选择项目";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  $("#sessions").innerHTML = [...groups].map(([path, items]) => `<div class="project-label" title="${escape(path)}">${escape(fileName(path) || path)}</div>${items.map((session) => `<div class="session-row"><button class="session ${session.id === currentSession?.id ? "selected" : ""}" data-session="${session.id}" title="${escape(session.title)}">${escape(session.customTitle || session.title)}</button><button class="icon rename-session" data-id="${session.id}" title="重命名">✎</button><button class="icon delete-session" data-id="${session.id}" title="删除">×</button></div>`).join("")}`).join("");
  $$(".session").forEach((button) => button.onclick = () => selectSession(button.dataset.session));
  $$(".rename-session").forEach((button) => button.onclick = () => renameSession(button.dataset.id));
  $$(".delete-session").forEach((button) => button.onclick = () => deleteSession(button.dataset.id));
  $("#agent-title").textContent = currentSession?.customTitle || currentSession?.title || "开发代理";
}

function renderTranscript() {
  const blocks = currentSession?.blocks || [];
  $("#agent-transcript").innerHTML = blocks.map((block) => {
    const title = block.title || ({ user: "你", reply: "代理", thinking: block.done ? "思考过程" : "正在思考", tool: "工具", error: "错误" }[block.kind] || block.kind);
    const attached = [...(block.imagePaths || []), ...(block.filePaths || [])].map((path) => `\n📎 ${fileName(path)}`).join("");
    return `<div class="block ${escape(block.kind)}"><b>${escape(title)}</b>${escape(block.text || "…")}${escape(attached)}</div>`;
  }).join("");
  $("#agent-transcript").scrollTop = $("#agent-transcript").scrollHeight;
}

function persistCurrentSession() {
  if (!currentSession) return;
  const firstUser = currentSession.blocks.find((block) => block.kind === "user");
  if (!currentSession.customTitle && firstUser) currentSession.title = (firstUser.text.trim() || "附件").slice(0, 40);
  currentSession.updatedAt = Date.now();
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  window.harness.sessions.save(sessions);
}

function newSession(workspace = currentSession?.workspace || config.workspace || "") {
  persistCurrentSession();
  currentSession = normalizeSession({ id: crypto.randomUUID(), title: "新会话", workspace, allowWrites: config.allowWrites, blocks: [], updatedAt: Date.now() });
  sessions.unshift(currentSession);
  streamAliases.clear();
  renderSessions(); renderTranscript(); renderConfig(); window.harness.sessions.save(sessions);
}

async function selectSession(id) {
  if (id === currentSession?.id) return;
  persistCurrentSession();
  currentSession = sessions.find((item) => item.id === id);
  if (!currentSession) return;
  streamAliases.clear();
  config = await window.harness.config.save({ workspace: currentSession.workspace, allowWrites: currentSession.allowWrites });
  renderSessions(); renderTranscript(); renderConfig(); refreshFiles(currentSession.workspace);
}

function renameSession(id) {
  const session = sessions.find((item) => item.id === id);
  if (!session) return;
  const name = prompt("会话名称", session.customTitle || session.title);
  if (name === null) return;
  session.customTitle = name.trim();
  if (session.customTitle) session.title = session.customTitle;
  persistCurrentSession(); renderSessions();
}

async function deleteSession(id) {
  if (!confirm("删除这个会话？此操作无法撤销。")) return;
  sessions = sessions.filter((item) => item.id !== id);
  if (!sessions.length) return newSession();
  if (currentSession?.id === id) currentSession = sessions[0];
  streamAliases.clear();
  config = await window.harness.config.save({ workspace: currentSession.workspace, allowWrites: currentSession.allowWrites });
  window.harness.sessions.save(sessions); renderSessions(); renderTranscript(); renderConfig();
}

function addBlock(block) {
  if (!currentSession) newSession();
  if (block.type === "status") return;
  if (block.type === "done" || block.type === "ready") {
    agentRunning = false;
    for (const item of currentSession.blocks) if (["thinking", "reply", "tool"].includes(item.kind)) item.done = true;
    persistCurrentSession(); renderTranscript(); updateAgentButtons(); return;
  }
  const kind = block.type || block.kind || "reply";
  const baseId = `${kind}-${block.id || crypto.randomUUID()}`;
  let id = streamAliases.get(baseId) || baseId;
  let existing = currentSession.blocks.find((item) => item.id === id);
  if (existing?.done && !block.done) { id = `${baseId}-${crypto.randomUUID()}`; streamAliases.set(baseId, id); existing = undefined; }
  if (existing) {
    if (block.text) existing.text = block.append ? existing.text + block.text : block.text;
    existing.done = block.done ?? existing.done; existing.title = block.name || existing.title;
  } else currentSession.blocks.push({ id, kind, title: block.name || kind, text: block.text || "", done: block.done ?? true, imagePaths: [], filePaths: [] });
  renderTranscript(); persistCurrentSession();
}

function updateAgentButtons() {
  $("#send-agent").disabled = agentRunning;
  $("#stop-agent").disabled = !agentRunning;
}

function addAttachments(paths) {
  for (const path of paths.filter(Boolean)) {
    if (attachments.some((item) => item.path === path)) continue;
    const image = /\.(png|jpe?g|gif|webp|bmp|tiff?|heic)$/i.test(path);
    const imageCount = attachments.filter((item) => item.image).length;
    const fileCount = attachments.filter((item) => !item.image).length;
    if (image && supportsVision() && imageCount < 4) attachments.push({ path, image: true });
    else if (fileCount < 8) attachments.push({ path, image: false });
  }
  renderAttachments();
}

function renderAttachments() {
  $("#attachments").innerHTML = attachments.map((item, index) => `<span class="attachment">${item.image ? "▣" : "▤"} ${escape(fileName(item.path))}<button data-remove="${index}">×</button></span>`).join("");
  $$("[data-remove]").forEach((button) => button.onclick = () => { attachments.splice(Number(button.dataset.remove), 1); renderAttachments(); });
}

async function sendAgent() {
  const typed = $("#agent-input").value.trim();
  if (!typed && !attachments.length) return;
  if (!currentSession?.workspace) { addBlock({ type: "error", text: "请选择有效工作区。" }); return; }
  if (config.source === "local" && !["online", "external"].includes(lastState.phase)) { addBlock({ type: "error", text: "本地模型未启动。可在设置中改用云 API。" }); return; }
  const images = attachments.filter((item) => item.image).map((item) => item.path);
  const files = attachments.filter((item) => !item.image).map((item) => item.path);
  const prompt = typed || (images.length ? "请查看图片。" : "请检查附件。");
  const agentPrompt = files.length ? `${prompt}\n\n已附加文件（请先读取文件内容）：\n${files.map((path) => `- ${path}`).join("\n")}` : prompt;
  const history = currentSession.blocks.filter((block) => ["user", "reply", "tool"].includes(block.kind) && block.text).map((block) => ({ role: block.kind === "user" ? "user" : "assistant", content: block.kind === "tool" ? `[tool ${block.title}] ${block.text.slice(0, 400)}` : block.text.slice(0, 8000) }));
  currentSession.blocks.push({ id: crypto.randomUUID(), kind: "user", title: "你", text: prompt, done: true, imagePaths: images, filePaths: files });
  $("#agent-input").value = ""; attachments = []; renderAttachments(); renderTranscript(); persistCurrentSession(); renderSessions();
  agentRunning = true; updateAgentButtons();
  try { await window.harness.agent.send({ sessionId: currentSession.id, prompt: agentPrompt, images, history, workspace: currentSession.workspace, allowWrites: currentSession.allowWrites }); }
  catch (error) { agentRunning = false; addBlock({ type: "error", text: errorText(error) }); updateAgentButtons(); }
}

async function refreshFiles(path = currentSession?.workspace) {
  if (!path) return;
  currentDirectory = path;
  try { directoryEntries = await window.harness.files.list(path); renderFileEntries(); }
  catch (error) { $("#file-browser").textContent = errorText(error); }
}

function renderFileEntries() {
  const filter = $("#file-filter").value.toLowerCase();
  $("#file-path").textContent = currentDirectory;
  $("#file-browser").innerHTML = directoryEntries.filter((entry) => entry.name.toLowerCase().includes(filter)).map((entry) => `<button data-path="${escape(entry.path)}" data-dir="${entry.directory}">${entry.directory ? "📁" : "📄"} ${escape(entry.name)}</button>`).join("");
  $$("#file-browser button").forEach((button) => button.onclick = async () => {
    if (button.dataset.dir === "true") return refreshFiles(button.dataset.path);
    try { $("#file-preview").textContent = await window.harness.files.read(button.dataset.path); }
    catch (error) { $("#file-preview").textContent = errorText(error); }
  });
}

function showTool(tool) {
  $("#tool-pane").classList.remove("hidden"); $(".agent-layout").classList.add("has-tool");
  $$(".tool-tabs button").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
  $$(".tool-view").forEach((view) => view.classList.add("hidden"));
  $(`#${tool}-tool`).classList.remove("hidden"); $("#tool-title").textContent = { files: "文件", browser: "浏览器", terminal: "终端" }[tool];
  if (tool === "files") refreshFiles(currentDirectory || currentSession?.workspace);
}

async function chooseModel(kind) {
  const path = (await window.harness.dialog.file(kind))[0];
  if (!path) return;
  settingsDraft[kind === "model" ? "model" : "mmproj"] = path;
  $(kind === "model" ? "#settings-form [name=model]" : "#settings-form [name=mmproj]").value = path;
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim() || (chatImages.length ? "请描述图片。" : "");
  if (!text) return;
  $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble user">${escape(text)}</div>`);
  input.value = "";
  const images = [...chatImages]; chatImages = []; $("#chat-files").textContent = "";
  try {
    const reply = await window.harness.chat({ text, images });
    $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble">${escape(reply)}</div>`);
  } catch (error) { $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble error">${escape(errorText(error))}</div>`); }
  $("#chat").scrollTop = $("#chat").scrollHeight;
}

function syncCloudEditor() {
  const profile = settingsDraft.cloudProfiles.find((item) => item.id === settingsDraft.cloudProfileId) || settingsDraft.cloudProfiles[0];
  if (!profile) return;
  profile.preset = $("#cloud-preset").value;
  profile.baseUrl = $("#cloud-url").value.trim();
  profile.model = $("#cloud-model").value.trim();
  const key = $("#cloud-key").value.trim();
  if (key) { profile.apiKey = key; profile.keyConfigured = true; }
}

async function saveSettings(restart = false) {
  syncCloudEditor();
  const form = $("#settings-form");
  const context = form.elements.context.value === "custom" ? Number($("#custom-context").value) : Number(form.elements.context.value);
  const next = {
    validate: true, source: form.elements.source.value, model: form.elements.model.value, mmproj: form.elements.mmproj.value,
    chatTemplate: form.elements.chatTemplate.value.trim(), context, kv: form.elements.kv.value,
    compatibility: form.elements.compatibility.checked, ngram: form.elements.ngram.checked, reasoning: form.elements.reasoning.checked,
    cloudProfileId: settingsDraft.cloudProfileId, cloudProfiles: settingsDraft.cloudProfiles,
  };
  try {
    config = await window.harness.config.save(next); settingsDraft = structuredClone(config); renderConfig(); renderSettings(); localLog("设置已保存。", "success");
    if (restart && config.source === "local") await window.harness.server.restart();
    if (restart && config.source === "cloud") window.harness.server.stop();
  } catch (error) { localLog(errorText(error), "error"); alert(errorText(error)); }
}

async function runRouteTest() {
  $("#route-result").innerHTML = "<p>正在测试路由…</p>";
  const lines = await window.harness.route.test();
  $("#route-result").innerHTML = lines.map((line) => `<p>${escape(line)}</p>`).join("");
  lines.forEach((line) => localLog(line, line.includes("通过") || line.includes("在线") ? "success" : "warning"));
}

function renderState(value) {
  lastState = value;
  const online = value.phase === "online" || value.phase === "external";
  const label = online ? (value.phase === "external" ? "在线 · 外部服务" : "在线") : value.phase === "starting" ? "正在加载模型" : "离线";
  $("#status").textContent = label; $("#status").classList.toggle("online", online);
  $("#phase").textContent = label; $("#phase-dot").classList.toggle("online", online);
  $("#start").disabled = online || value.phase === "starting";
  $("#restart").disabled = !value.canControlServer;
  $("#stop").disabled = !value.canControlServer;
  $("#uptime").textContent = formatUptime(value.uptime); $("#memory").textContent = `${value.memoryGB || "—"} GB RAM`;
  const metrics = value.metrics || {};
  $("#generation-tps").textContent = Number(metrics.generationTPS || 0).toFixed(1);
  $("#prompt-tps").textContent = Number(metrics.promptTPS || 0).toFixed(1);
  $("#ttft").textContent = Math.round(metrics.ttft || 0);
  $("#ngram-acceptance").textContent = metrics.ngramAcceptance == null ? (config.ngram ? "等待样本" : "关闭") : `${metrics.ngramAcceptance.toFixed(1)}%`;
  $("#context-used").textContent = `已用 ${(metrics.contextUsed || 0).toLocaleString()} · 可用 ${Math.max((metrics.contextSize || config.context) - (metrics.contextUsed || 0), 0).toLocaleString()}`;
  $("#cc-status").textContent = value.ccSwitch ? "路由已连接到本地模型。" : "等待 CC Switch 代理。";
}

window.harness.on("server-log", appendLog);
window.harness.on("server-state", renderState);
window.harness.on("agent-event", addBlock);
window.harness.on("tool-output", (text) => { $("#terminal-output").textContent = ($("#terminal-output").textContent + text).slice(-100000); });

$$("nav button").forEach((button) => button.onclick = () => showPage(button.dataset.page));
$("#show-overview").onclick = () => showPage("overview");
$("#start").onclick = async () => { try { await window.harness.server.start(); } catch (error) { localLog(errorText(error), "error"); } };
$("#restart").onclick = async () => { try { await window.harness.server.restart(); } catch (error) { localLog(errorText(error), "error"); } };
$("#stop").onclick = () => window.harness.server.stop();
$("#send-chat").onclick = sendChat;
$("#chat-input").onkeydown = (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendChat(); } };
$("#chat-attach").onclick = () => $("#chat-images").click();
$("#chat-images").onchange = (event) => { chatImages = [...event.target.files].slice(0, 4).map(window.harness.pathForFile); $("#chat-files").textContent = chatImages.map(fileName).join(" · "); event.target.value = ""; };
$("#workspace").onclick = async () => {
  const path = await window.harness.dialog.directory();
  if (!path) return;
  config = await window.harness.config.save({ workspace: path });
  if (currentSession?.blocks.length) newSession(path); else { currentSession.workspace = path; persistCurrentSession(); renderConfig(); }
  refreshFiles(path);
};
$("#new-session").onclick = () => newSession();
$("#send-agent").onclick = sendAgent;
$("#agent-input").onkeydown = (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendAgent(); } };
$("#stop-agent").onclick = () => window.harness.agent.stop();
$("#agent-attach").onclick = () => $("#agent-files").click();
$("#agent-files").onchange = (event) => { addAttachments([...event.target.files].map(window.harness.pathForFile)); event.target.value = ""; };
$("#allow-writes").onchange = async () => { currentSession.allowWrites = $("#allow-writes").checked; config = await window.harness.config.save({ allowWrites: currentSession.allowWrites }); persistCurrentSession(); renderConfig(); };
$("#agent-model").onchange = async () => {
  const value = $("#agent-model").value;
  try { config = await window.harness.config.save(value === "local" ? { validate: true, source: "local" } : { validate: true, source: "cloud", cloudProfileId: value.slice(6) }); renderConfig(); }
  catch (error) { alert(errorText(error)); renderConfig(); }
};
$$(".tool-tabs button").forEach((button) => button.onclick = () => showTool(button.dataset.tool));
$("#close-tool").onclick = () => { $("#tool-pane").classList.add("hidden"); $(".agent-layout").classList.remove("has-tool"); $$(".tool-tabs button").forEach((button) => button.classList.remove("active")); };
$("#file-filter").oninput = renderFileEntries; $("#file-refresh").onclick = () => refreshFiles(currentDirectory);
$("#file-up").onclick = () => { const root = currentSession?.workspace || ""; const parent = currentDirectory.replace(/[\\/][^\\/]+[\\/]?$/, ""); refreshFiles(parent.length >= root.length ? parent : root); };
$("#browser-go").onclick = () => { let url = $("#browser-url").value.trim(); if (!url.includes("://")) url = `https://${url}`; if (/^https?:\/\//i.test(url)) { $("#browser-url").value = url; $("#browser-view").src = url; } };
$("#browser-url").onkeydown = (event) => { if (event.key === "Enter") $("#browser-go").click(); };
$("#browser-back").onclick = () => { if ($("#browser-view").canGoBack()) $("#browser-view").goBack(); }; $("#browser-forward").onclick = () => { if ($("#browser-view").canGoForward()) $("#browser-view").goForward(); }; $("#browser-reload").onclick = () => $("#browser-view").reload();
$("#run-command").onclick = async () => {
  const command = $("#terminal-command").value.trim(); if (!command || commandRunning) return;
  commandRunning = true; $("#terminal-output").textContent += `\nPS> ${command}\n`; $("#terminal-command").value = "";
  try { const result = await window.harness.tools.run(command, currentSession?.workspace); $("#terminal-output").textContent += `\n[退出码 ${result.code}]\n`; }
  catch (error) { $("#terminal-output").textContent += `\n${errorText(error)}\n`; }
  commandRunning = false;
};
$("#stop-command").onclick = () => window.harness.tools.stop();
$("#clear-log").onclick = $("#clear-overview-log").onclick = () => { logs = []; $("#overview-log").textContent = ""; $("#all-log").textContent = ""; };
$("#test-route").onclick = $("#test-route-top").onclick = runRouteTest;
$("#copy-route").onclick = () => window.harness.clipboard.write("ANTHROPIC_BASE_URL=http://127.0.0.1:15721\nUPSTREAM=http://127.0.0.1:7890/v1\nMODEL=qwen");
$("#copy-endpoint").onclick = () => window.harness.clipboard.write("http://127.0.0.1:7890/v1");
$$("[data-pick]").forEach((button) => button.onclick = () => chooseModel(button.dataset.pick));
$("#remove-mmproj").onclick = () => { settingsDraft.mmproj = ""; $("#settings-form [name=mmproj]").value = ""; };
$("#settings-form [name=source]").onchange = (event) => { settingsDraft.source = event.target.value; $("#local-settings").classList.toggle("hidden", settingsDraft.source !== "local"); $("#cloud-settings").classList.toggle("hidden", settingsDraft.source !== "cloud"); };
$("#settings-form [name=context]").onchange = (event) => $("#custom-context").classList.toggle("hidden", event.target.value !== "custom");
$("#cloud-profile").onchange = (event) => { syncCloudEditor(); settingsDraft.cloudProfileId = event.target.value; renderCloudProfiles(); };
$("#cloud-preset").onchange = (event) => { const [baseUrl, model] = presetDefaults[event.target.value]; if (event.target.value !== "custom") { $("#cloud-url").value = baseUrl; $("#cloud-model").value = model; } };
$("#add-cloud").onclick = () => { syncCloudEditor(); const profile = { id: crypto.randomUUID(), preset: "openai", baseUrl: presetDefaults.openai[0], model: presetDefaults.openai[1], apiKey: "", keyConfigured: false }; settingsDraft.cloudProfiles.push(profile); settingsDraft.cloudProfileId = profile.id; renderCloudProfiles(); };
$("#delete-cloud").onclick = () => { if (settingsDraft.cloudProfiles.length === 1) return; settingsDraft.cloudProfiles = settingsDraft.cloudProfiles.filter((profile) => profile.id !== settingsDraft.cloudProfileId); settingsDraft.cloudProfileId = settingsDraft.cloudProfiles[0].id; renderCloudProfiles(); };
$("#save-settings").onclick = () => saveSettings(false); $("#apply-settings").onclick = () => saveSettings(true);

document.addEventListener("paste", async (event) => {
  if (!$("#agent").classList.contains("active") || ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
  const paths = [...(event.clipboardData?.files || [])].map(window.harness.pathForFile).filter(Boolean);
  if (paths.length) addAttachments(paths); else { const image = await window.harness.clipboard.image(); if (image) addAttachments([image]); }
});
$("#agent").ondragover = (event) => event.preventDefault();
$("#agent").ondrop = (event) => { event.preventDefault(); addAttachments([...event.dataTransfer.files].map(window.harness.pathForFile)); };

(async () => {
  config = await window.harness.config.get();
  settingsDraft = structuredClone(config);
  sessions = (await window.harness.sessions.load()).map(normalizeSession);
  if (!sessions.length) newSession(config.workspace); else currentSession = sessions[0];
  if (currentSession?.workspace) config = await window.harness.config.save({ workspace: currentSession.workspace, allowWrites: currentSession.allowWrites });
  renderConfig(); renderSettings(); renderSessions(); renderTranscript(); renderAttachments(); updateAgentButtons();
  if (currentSession?.workspace) refreshFiles(currentSession.workspace);
  renderState(await window.harness.server.state());
})();
