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
const speedHistory = Array(28).fill(0);
const promptHistory = Array(28).fill(0);
// 对应 Swift 的 draft.contextTag：自定义是一个独立状态，不能从数值反推，
// 否则用户选“自定义”后填的数刚好等于预设值时输入框会消失。
let contextCustom = false;
const collapsedProjects = new Set();
const expandedBlocks = new Set();
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

// 与 Swift LogsContent 一致：时间 + 按等级着色的圆点 + 正文。
function appendLog(item) {
  logs = [...logs.slice(-499), item];
  const html = logs.map((line) => `<div class="logline"><time>${escape(line.time)}</time><span class="dot ${escape(line.kind || "info")}"></span><span>${escape(line.text)}</span></div>`).join("");
  for (const target of ["#overview-log", "#all-log"]) {
    const node = $(target);
    node.innerHTML = html;
    node.scrollTop = node.scrollHeight;
  }
}

function localLog(text, kind = "info") {
  appendLog({ time: new Date().toLocaleTimeString("zh-CN", { hour12: false }), text, kind });
}

// 开发代理页是全幅布局，其余页面右侧常驻路由检查器（对应 Swift 的 RouteInspector）。
function showPage(page) {
  $$(".page").forEach((element) => element.classList.toggle("active", element.id === page));
  $$("nav button").forEach((element) => element.classList.toggle("active", element.dataset.page === page));
  // 开发代理页是全幅工作区：左侧换成任务栏，右侧检查器让位（与 Swift DashboardView 一致）。
  $("#inspector").classList.toggle("hidden", page === "agent");
  $(".sidebar").classList.toggle("hidden", page === "agent");
  if (page === "settings") {
    settingsDraft = structuredClone(config);
    contextCustom = ![4096, 8192, 16384, 24576, 32768, 65536].includes(config.context);
    renderSettings();
  }
}

// parity: cloudProfileAvailable
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
  $("#allow-writes").checked = currentSession?.allowWrites ?? config.allowWrites;
  $("#writes-label").textContent = $("#allow-writes").checked ? "可写 · 工具已开" : "只读";
  renderAgentModels();
  renderInspectorConfig();
  renderSourcePill();
}

// 工具栏胶囊：云 API / 本机模型在线 / 模型未启动，与 Swift WorkspacePill 一致。
function renderSourcePill() {
  const online = ["online", "external"].includes(lastState.phase);
  const cloud = config.source === "cloud";
  $("#source-pill").textContent = cloud ? "云 API" : online ? "本机模型在线" : "模型未启动";
  $("#source-pill").classList.toggle("on", cloud || online);
}

// parity: draft reloadDraft setDraftContextTag selectInferenceSource
function renderSettings() {
  const form = $("#settings-form");
  form.elements.source.value = settingsDraft.source;
  form.elements.model.value = settingsDraft.model || "";
  form.elements.mmproj.value = settingsDraft.mmproj || "";
  form.elements.chatTemplate.value = settingsDraft.chatTemplate || "";
  form.elements.kv.value = settingsDraft.kv;
  for (const key of ["compatibility", "ngram", "reasoning"]) form.elements[key].checked = Boolean(settingsDraft[key]);
  $("#model-path").textContent = settingsDraft.model || "未选择 .gguf";
  $("#mmproj-path").textContent = settingsDraft.mmproj || "文本模型无需选择；视觉模型请选择对应的 mmproj .gguf";
  $("#remove-mmproj").classList.toggle("hidden", !settingsDraft.mmproj);

  const presets = [4096, 8192, 16384, 24576, 32768, 65536];
  const custom = contextCustom || !presets.includes(settingsDraft.context);
  form.elements.context.value = custom ? "-1" : String(settingsDraft.context);
  $("#custom-context-row").classList.toggle("hidden", !custom);
  $("#custom-context").value = settingsDraft.context;
  $("#context-warning").classList.toggle("hidden", settingsDraft.context <= 16384);

  $("#local-settings").classList.toggle("hidden", settingsDraft.source !== "local");
  $("#llama-settings").classList.toggle("hidden", settingsDraft.source !== "local");
  $("#cloud-settings").classList.toggle("hidden", settingsDraft.source !== "cloud");
  renderCloudProfiles();
  renderDirty();
}

function renderDirty() {
  const dirty = JSON.stringify(settingsDraft) !== JSON.stringify(config);
  $("#save-settings").textContent = dirty ? "保存" : "已保存";
  $("#save-settings").disabled = !dirty;
  $("#apply-settings").textContent = lastState.phase === "online" ? "重启并应用" : "启动并应用";
  $("#apply-settings").disabled = dirty;
  $("#dirty-hint").classList.toggle("hidden", !dirty);
}

function profileLabel(profile) {
  const name = { openai: "OpenAI", anthropic: "Anthropic", deepseek: "DeepSeek", openrouter: "OpenRouter", custom: "自定义" }[profile.preset] || "自定义";
  return `${name} · ${profile.model || "未设置模型"}`;
}

// parity: cloudPreset cloudBaseURL cloudModelId cloudApiKey selectCloudProfile selectDraftCloudProfile
function renderCloudProfiles() {
  $("#cloud-profile").innerHTML = settingsDraft.cloudProfiles.map((profile) => `<option value="${escape(profile.id)}">${escape(profileLabel(profile))}</option>`).join("");
  $("#cloud-profile").value = settingsDraft.cloudProfileId;
  const profile = settingsDraft.cloudProfiles.find((item) => item.id === settingsDraft.cloudProfileId) || settingsDraft.cloudProfiles[0];
  $("#settings-form").elements.preset.value = profile.preset;
  $("#cloud-url").value = profile.baseUrl;
  $("#cloud-model").value = profile.model;
  $("#cloud-key").value = "";
  $("#cloud-key").placeholder = profile.keyConfigured ? "已安全保存；留空保持不变" : "sk-…";
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

// 与 Swift taskSidebar 一致：按项目分组、可折叠，会话行双击改名、右键菜单、行尾删除。
function renderSessions() {
  const groups = new Map();
  for (const session of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const key = session.workspace || "未选择项目";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(session);
  }
  $("#sessions").innerHTML = [...groups].map(([path, items]) => {
    const collapsed = collapsedProjects.has(path);
    const rows = collapsed ? "" : items.map((session) => `<div class="session-row ${session.id === currentSession?.id ? "selected" : ""}" data-session="${escape(session.id)}"><span class="session" title="${escape(session.title)}">${escape(displayTitle(session))}</span><button class="trash" data-delete="${escape(session.id)}" title="删除">🗑</button></div>`).join("");
    return `<div class="project"><button class="project-head" data-project="${escape(path)}"><span class="ico">📁</span><span>${escape(fileName(path) || path)}</span></button>${rows}</div>`;
  }).join("");

  $$(".project-head").forEach((button) => button.onclick = () => {
    const path = button.dataset.project;
    collapsedProjects.has(path) ? collapsedProjects.delete(path) : collapsedProjects.add(path);
    renderSessions();
  });
  $$(".session-row").forEach((row) => {
    const id = row.dataset.session;
    row.querySelector(".session").onclick = () => selectSession(id);
    row.querySelector(".session").ondblclick = () => beginRename(id);
    row.querySelector(".trash").onclick = (event) => { event.stopPropagation(); deleteSession(id); };
    row.oncontextmenu = (event) => { event.preventDefault(); showSessionMenu(event, id); };
  });
  $("#agent-title").textContent = currentSession ? displayTitle(currentSession) : "开发代理";
}

// parity: displayTitle
function displayTitle(session) {
  return session.customTitle || session.title || "新会话";
}

function showSessionMenu(event, id) {
  $("#session-menu")?.remove();
  const menu = document.createElement("div");
  menu.id = "session-menu";
  menu.className = "popover";
  menu.innerHTML = `<button data-act="rename">重命名</button><button data-act="delete">删除</button>`;
  document.body.append(menu);
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;
  menu.querySelector("[data-act=rename]").onclick = () => { menu.remove(); beginRename(id); };
  menu.querySelector("[data-act=delete]").onclick = () => { menu.remove(); deleteSession(id); };
  setTimeout(() => document.addEventListener("click", () => menu.remove(), { once: true }));
}

// 对应 Swift TranscriptBlock 的五种形态：思考与工具默认折叠，点标题展开。
// parity: agentBlocks agentIsRunning
function renderTranscript() {
  const blocks = currentSession?.blocks || [];
  $("#agent-transcript").innerHTML = blocks.map((block) => {
    const open = expandedBlocks.has(block.id);
    const chevron = open ? "⌄" : "›";
    const body = escape(block.text || "…");
    if (block.kind === "thinking") {
      return `<div class="block thinking"><button class="fold" data-fold="${escape(block.id)}"><span class="ico">🧠</span><span>${block.done ? "思考过程" : "正在思考"}</span><span class="spacer"></span><span>${chevron}</span></button>${open ? `<div class="fold-body">${body}</div>` : ""}</div>`;
    }
    if (block.kind === "tool") {
      const title = block.done ? `工具 · ${block.title}` : `调用 ${block.title}`;
      return `<div class="block tool"><button class="fold" data-fold="${escape(block.id)}"><span class="ico">🔧</span><span>${escape(title)}</span><span class="spacer"></span><span>${chevron}</span></button>${open && block.text ? `<div class="fold-body mono">${body}</div>` : ""}</div>`;
    }
    if (block.kind === "user") {
      const images = (block.imagePaths || []).map((path) => `<img class="thumb" src="file://${encodeURI(path)}" alt="${escape(fileName(path))}">`).join("");
      const files = (block.filePaths || []).map((path) => `<span class="chip" title="${escape(path)}">📄 ${escape(fileName(path))}</span>`).join("");
      return `<div class="block user"><b>你</b>${images ? `<div class="thumbs">${images}</div>` : ""}${files ? `<div class="chips">${files}</div>` : ""}${block.text ? `<div>${body}</div>` : ""}</div>`;
    }
    if (block.kind === "error" || block.kind === "status") {
      return `<div class="system-event ${escape(block.kind)}"><span class="ico">${block.kind === "error" ? "⚠" : "✔"}</span><div><b>${escape(block.title || (block.kind === "error" ? "错误" : "状态"))}</b><small>${body}</small></div></div>`;
    }
    return `<div class="block reply"><b>${escape(block.title || "代理")}</b><div>${body}</div></div>`;
  }).join("");
  $$("[data-fold]").forEach((button) => button.onclick = () => {
    const id = button.dataset.fold;
    expandedBlocks.has(id) ? expandedBlocks.delete(id) : expandedBlocks.add(id);
    renderTranscript();
  });
  $("#agent-transcript").scrollTop = $("#agent-transcript").scrollHeight;
}

// parity: persistCurrentSession
function persistCurrentSession() {
  if (!currentSession) return;
  const firstUser = currentSession.blocks.find((block) => block.kind === "user");
  if (!currentSession.customTitle && firstUser) currentSession.title = (firstUser.text.trim() || "附件").slice(0, 40);
  currentSession.updatedAt = Date.now();
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);
  window.harness.sessions.save(sessions);
}

// parity: newAgentSession resetAgentConversation sessions
function newSession(workspace = currentSession?.workspace || config.workspace || "") {
  persistCurrentSession();
  currentSession = normalizeSession({ id: crypto.randomUUID(), title: "新会话", workspace, allowWrites: config.allowWrites, blocks: [], updatedAt: Date.now() });
  sessions.unshift(currentSession);
  streamAliases.clear();
  renderSessions(); renderTranscript(); renderConfig(); window.harness.sessions.save(sessions);
}

// parity: selectSession currentSessionId
async function selectSession(id) {
  if (id === currentSession?.id) return;
  persistCurrentSession();
  currentSession = sessions.find((item) => item.id === id);
  if (!currentSession) return;
  streamAliases.clear();
  config = await window.harness.config.save({ workspace: currentSession.workspace, allowWrites: currentSession.allowWrites });
  renderSessions(); renderTranscript(); renderConfig(); refreshFiles(currentSession.workspace);
}

// 会话改名在行内进行，和 Swift sessionRow 的 TextField 一致（双击或右键菜单触发）。
// Electron 不实现 window.prompt，行内编辑正好绕开这点。
// parity: renameSession
function beginRename(id) {
  const row = $(`.session-row[data-session="${id}"]`);
  const session = sessions.find((item) => item.id === id);
  if (!row || !session) return;
  const input = document.createElement("input");
  input.className = "session-rename";
  input.placeholder = "会话名称";
  input.value = displayTitle(session);
  row.replaceChild(input, row.querySelector(".session"));
  input.focus();
  input.select();
  const commit = () => {
    session.customTitle = input.value.trim();
    if (session.customTitle) session.title = session.customTitle;
    persistCurrentSession(); renderSessions();
  };
  input.onkeydown = (event) => {
    if (event.key === "Enter") { event.preventDefault(); commit(); }
    if (event.key === "Escape") { event.preventDefault(); renderSessions(); }
  };
  input.onblur = commit;
}

// parity: deleteSession
async function deleteSession(id) {
  const dialog = $("#confirm-dialog");
  dialog.showModal();
  await new Promise((resolve) => { dialog.onclose = resolve; });
  if (dialog.returnValue !== "ok") return;
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

// 与 Swift 一致：一个按钮在发送 ↑ 和停止 ■ 之间切换。
function updateAgentButtons() {
  $("#send-agent").textContent = agentRunning ? "■" : "↑";
  $("#agent-running").classList.toggle("hidden", !agentRunning);
}

// parity: draftImages draftFiles addDroppedAttachments removeDraftImage removeDraftFile
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

// 图片显示缩略图、文件显示胶囊，与 Swift DraftThumb / AttachmentChip 对应。
function renderAttachments() {
  $("#attachments").innerHTML = attachments.map((item, index) => item.image
    ? `<span class="thumb-wrap"><img class="thumb" src="file://${encodeURI(item.path)}" alt="${escape(fileName(item.path))}"><button data-remove="${index}" class="thumb-x">×</button></span>`
    : `<span class="chip" title="${escape(item.path)}">📄 ${escape(fileName(item.path))}<button data-remove="${index}">×</button></span>`).join("");
  $$("[data-remove]").forEach((button) => button.onclick = () => { attachments.splice(Number(button.dataset.remove), 1); renderAttachments(); });
}

// parity: agentDraft chatInput
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
  $("#file-path").textContent = fileName(currentDirectory) || currentDirectory;
  $("#file-browser").innerHTML = directoryEntries.filter((entry) => entry.name.toLowerCase().includes(filter)).map((entry) => `<button data-path="${escape(entry.path)}" data-dir="${entry.directory}">${entry.directory ? "📁" : "📄"} ${escape(entry.name)}</button>`).join("");
  $$("#file-browser button").forEach((button) => button.onclick = async () => {
    if (button.dataset.dir === "true") return refreshFiles(button.dataset.path);
    try { $("#file-preview").textContent = await window.harness.files.read(button.dataset.path); }
    catch (error) { $("#file-preview").textContent = errorText(error); }
  });
}

// parity: openToolPane toggleToolPane
function showTool(tool) {
  $("#tool-pane").classList.remove("hidden"); $(".agent-layout").classList.add("has-tool");
  $$(".tool-view").forEach((view) => view.classList.add("hidden"));
  $(`#${tool}-tool`).classList.remove("hidden"); $("#tool-title").textContent = { files: "文件", browser: "浏览器", terminal: "终端" }[tool];
  $("#tool-menu").classList.add("hidden");
  if (tool === "files") refreshFiles(currentDirectory || currentSession?.workspace);
}

async function chooseModel(kind) {
  const path = (await window.harness.dialog.file(kind))[0];
  if (!path) return;
  settingsDraft[kind === "model" ? "model" : "mmproj"] = path;
  renderSettings();
}

// 与 Swift roleName / roleColor 一致的角色名。
const roleName = (role) => ({ user: "你", assistant: "Harness", system: "系统" })[role] || role;

function addBubble(role, text) {
  $("#chat").insertAdjacentHTML("beforeend", `<div class="bubble ${role}"><b>${roleName(role)}</b>${escape(text)}</div>`);
}

async function sendChat() {
  const input = $("#chat-input");
  const text = input.value.trim() || (chatImages.length ? "请描述图片。" : "");
  if (!text) return;
  addBubble("user", text);
  input.value = "";
  const images = [...chatImages]; chatImages = []; $("#chat-files").textContent = "";
  try { addBubble("assistant", await window.harness.chat({ text, images })); }
  catch (error) { addBubble("system", errorText(error)); }
  $("#chat").scrollTop = $("#chat").scrollHeight;
}

// parity: applyCloudPreset addDraftCloudProfile
function syncCloudEditor() {
  const profile = settingsDraft.cloudProfiles.find((item) => item.id === settingsDraft.cloudProfileId) || settingsDraft.cloudProfiles[0];
  if (!profile) return;
  profile.preset = $("#settings-form").elements.preset.value;
  profile.baseUrl = $("#cloud-url").value.trim();
  profile.model = $("#cloud-model").value.trim();
  const key = $("#cloud-key").value.trim();
  if (key) { profile.apiKey = key; profile.keyConfigured = true; }
}

function readForm() {
  syncCloudEditor();
  const form = $("#settings-form");
  const selected = Number(form.elements.context.value);
  contextCustom = selected === -1;
  settingsDraft.source = form.elements.source.value;
  settingsDraft.chatTemplate = form.elements.chatTemplate.value.trim();
  settingsDraft.context = contextCustom ? Number($("#custom-context").value) : selected;
  settingsDraft.kv = form.elements.kv.value;
  for (const key of ["compatibility", "ngram", "reasoning"]) settingsDraft[key] = form.elements[key].checked;
}

async function saveSettings() {
  readForm();
  try {
    config = await window.harness.config.save({ ...settingsDraft, validate: true });
    settingsDraft = structuredClone(config);
    renderConfig(); renderSettings(); localLog("设置已保存。", "success");
  } catch (error) { localLog(errorText(error), "error"); alert(errorText(error)); }
}

async function applySettings() {
  try {
    if (config.source === "cloud") return window.harness.server.stop();
    await window.harness.server.restart();
  } catch (error) { localLog(errorText(error), "error"); }
}

// parity: routeTestRunning
async function runRouteTest() {
  const buttons = [$("#test-route"), $("#test-route-top"), $("#insp-test-route")];
  buttons.forEach((button) => { button.disabled = true; button.textContent = "测试中…"; });
  $("#route-result").classList.remove("hidden");
  $("#route-result").innerHTML = "<p>测试中…</p>";
  try {
    const lines = await window.harness.route.test();
    const html = lines.map((line) => `<p>${escape(line)}</p>`).join("");
    $("#route-result").innerHTML = html;
    $("#insp-route-result").innerHTML = html;
    lines.forEach((line) => localLog(line, line.includes("通过") || line.includes("在线") ? "success" : "warning"));
  } finally {
    $("#test-route").textContent = "运行完整路由测试";
    $("#test-route-top").textContent = "测试链路";
    $("#insp-test-route").textContent = "测试路由";
    buttons.forEach((button) => { button.disabled = false; });
  }
}

// 对应 Swift MetricCard 里的 Charts 迷你折线：保留最近 28 个采样点。
// parity: speedHistory promptHistory
function pushHistory(history, value) {
  history.push(Number(value) || 0);
  if (history.length > 28) history.shift();
  return history;
}

function drawSpark(selector, history) {
  const peak = Math.max(...history, 1);
  const step = 108 / (history.length - 1);
  const points = history.map((point, index) => `${(index * step).toFixed(1)},${(27 - (point / peak) * 25).toFixed(1)}`);
  $(`${selector} polyline`).setAttribute("points", points.join(" "));
}

// 右栏运行配置（对应 Swift RouteInspector 的 CodeLine 块与加速状态行）。
function renderInspectorConfig() {
  const context = config.compatibility ? Math.min(config.context, 4096) : config.context;
  $("#cfg-ctx").textContent = `CTX=${context}`;
  $("#cfg-kv").textContent = `KV=${config.kv}`;
  $("#cfg-spec").textContent = `SPEC=${config.ngram ? 1 : 0}`;
  $("#opt-kv-detail").textContent = `${config.kv} K/V Cache`;
}

function renderState(value) {
  lastState = value;
  const metrics = value.metrics || {};
  const online = value.phase === "online" || value.phase === "external";
  const starting = value.phase === "starting";
  const label = online ? (value.phase === "external" ? "在线 · 外部服务" : "在线") : starting ? "正在加载模型" : "离线";

  $("#status").textContent = label;
  $("#status").className = online ? "online" : starting ? "starting" : "";
  $("#status-dot").className = `dot ${online ? "on" : starting ? "warn" : ""}`;
  $("#server-desc").textContent = online ? "llama.cpp 已连接并可处理请求。" : "本地模型尚未就绪。";
  $("#start").textContent = online ? (value.canControlServer ? "重启" : "外部服务") : "启动";
  $("#start").disabled = starting || (online && !value.canControlServer);
  $("#stop").disabled = !online || !value.canControlServer;

  $("#uptime").textContent = formatUptime(value.uptime);
  $("#info-backend").textContent = `llama.cpp · ${value.system?.backend || "CUDA"}`;
  $("#sys-state").textContent = online ? "Online" : "Offline";
  $("#sys-state").classList.toggle("on", online);
  $("#sys-os").textContent = value.system?.os || "—";
  $("#sys-chip").textContent = value.system?.chip || "—";
  $("#sys-memory").textContent = value.system?.memory || "—";
  $("#sys-backend").textContent = value.system?.backend || "CUDA";

  const size = metrics.contextSize || config.context;
  const used = metrics.contextUsed || 0;
  $("#context-label").textContent = `${Math.round(size / 1024)}K`;
  $("#ctx-used").textContent = used.toLocaleString();
  $("#ctx-free").textContent = Math.max(size - used, 0).toLocaleString();
  $("#ctx-progress").value = Math.min(used / Math.max(size, 1), 1);
  const circumference = 2 * Math.PI * 38;
  $("#ctx-gauge").setAttribute("stroke-dasharray", `${(Math.min(used / Math.max(size, 1), 1) * circumference).toFixed(1)} ${circumference.toFixed(1)}`);

  $("#generation-tps").textContent = Number(metrics.generationTPS || 0).toFixed(1);
  $("#prompt-tps").textContent = Number(metrics.promptTPS || 0).toFixed(1);
  $("#ttft").textContent = metrics.ttft > 0 ? Math.round(metrics.ttft) : "—";
  drawSpark("#speed-chart", pushHistory(speedHistory, metrics.generationTPS));
  drawSpark("#prompt-chart", pushHistory(promptHistory, metrics.promptTPS));
  $("#generation-note").textContent = value.generating ? "实时 slot" : "最近一次生成";
  $("#bar-tps").textContent = Number(metrics.generationTPS || 0).toFixed(1);
  $("#bar-state").textContent = online ? "All systems operational" : "llama.cpp offline";
  $("#phase-dot").classList.toggle("online", online);

  renderSourcePill();
  $("#cc-pill").textContent = value.ccSwitch ? "Connected" : "Offline";
  $("#cc-pill").classList.toggle("on", Boolean(value.ccSwitch));
  $("#cc-status").textContent = value.ccSwitch ? "路由已连接到本地模型。" : "等待 CC Switch 代理。";
  $("#proxy-health").textContent = value.ccSwitch ? "代理健康" : "代理未检测到";
  $("#upstream-health").textContent = online ? "上游健康" : "上游离线";

  const acceptance = metrics.ngramAcceptance == null ? "等待" : `${metrics.ngramAcceptance.toFixed(1)}%`;
  $("#opt-ngram-state").textContent = config.ngram ? "连续对话" : "关闭";
  $("#opt-ngram-detail").textContent = config.ngram ? `2–4 token · 接受率 ${acceptance}` : "低接受率时会拖慢生成";
  $("#opt-ngram-dot").classList.toggle("warn", Boolean(config.ngram));
  renderDirty();
}

window.harness.on("server-log", appendLog);
window.harness.on("server-state", renderState);
window.harness.on("agent-event", addBlock);
window.harness.on("tool-output", (text) => { $("#terminal-output").textContent = ($("#terminal-output").textContent + text).slice(-100000); });

$$("nav button").forEach((button) => button.onclick = () => showPage(button.dataset.page));
$("#show-overview").onclick = () => showPage("overview");
// parity: startServer stopServer restartServer
$("#start").onclick = async () => {
  try { await (lastState.phase === "online" ? window.harness.server.restart() : window.harness.server.start()); }
  catch (error) { localLog(errorText(error), "error"); }
};
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
// parity: launchDeveloperAgent stopDeveloperAgent
$("#send-agent").onclick = () => (agentRunning ? window.harness.agent.stop() : sendAgent());
$("#agent-input").onkeydown = (event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); sendAgent(); } };
$("#agent-attach").onclick = () => $("#agent-files").click();
$("#show-overview-foot").onclick = () => showPage("overview");
$("#tool-toggle").onclick = (event) => { event.stopPropagation(); $("#tool-menu").classList.toggle("hidden"); };
document.addEventListener("click", (event) => { if (!event.target.closest("#tool-menu,#tool-toggle")) $("#tool-menu").classList.add("hidden"); });
$("#agent-files").onchange = (event) => { addAttachments([...event.target.files].map(window.harness.pathForFile)); event.target.value = ""; };
$("#allow-writes").onchange = async () => { currentSession.allowWrites = $("#allow-writes").checked; config = await window.harness.config.save({ allowWrites: currentSession.allowWrites }); persistCurrentSession(); renderConfig(); };
$("#agent-model").onchange = async () => {
  const value = $("#agent-model").value;
  try { config = await window.harness.config.save(value === "local" ? { validate: true, source: "local" } : { validate: true, source: "cloud", cloudProfileId: value.slice(6) }); renderConfig(); }
  catch (error) { alert(errorText(error)); renderConfig(); }
};
$$("#tool-menu button").forEach((button) => button.onclick = () => showTool(button.dataset.tool));
$("#close-tool").onclick = () => { $("#tool-pane").classList.add("hidden"); $(".agent-layout").classList.remove("has-tool"); };
$("#file-filter").oninput = renderFileEntries; $("#file-refresh").onclick = () => refreshFiles(currentDirectory);
$("#file-up").onclick = () => { const root = currentSession?.workspace || ""; const parent = currentDirectory.replace(/[\\/][^\\/]+[\\/]?$/, ""); refreshFiles(parent.length >= root.length ? parent : root); };
$("#browser-go").onclick = () => { let url = $("#browser-url").value.trim(); if (!url.includes("://")) url = `https://${url}`; if (/^https?:\/\//i.test(url)) { $("#browser-url").value = url; $("#browser-view").src = url; } };
$("#browser-url").onkeydown = (event) => { if (event.key === "Enter") $("#browser-go").click(); };
$("#browser-back").onclick = () => { if ($("#browser-view").canGoBack()) $("#browser-view").goBack(); }; $("#browser-forward").onclick = () => { if ($("#browser-view").canGoForward()) $("#browser-view").goForward(); }; $("#browser-reload").onclick = () => $("#browser-view").reload();
// 与 Swift 一致：同一个按钮在 执行 / 停止 间切换。
$("#run-command").onclick = async () => {
  if (commandRunning) return window.harness.tools.stop();
  const command = $("#terminal-command").value.trim(); if (!command) return;
  commandRunning = true; $("#run-command").textContent = "停止";
  $("#terminal-output").textContent += `\n$ ${command}\n`; $("#terminal-command").value = "";
  try { const result = await window.harness.tools.run(command, currentSession?.workspace); $("#terminal-output").textContent += `\n[退出码 ${result.code}]\n`; }
  catch (error) { $("#terminal-output").textContent += `\n${errorText(error)}\n`; }
  commandRunning = false;
  $("#run-command").textContent = "执行";
};
// parity: clearLogs copyEndpoint copyRouteConfig
$("#clear-log").onclick = $("#clear-overview-log").onclick = () => { logs = []; $("#overview-log").innerHTML = ""; $("#all-log").innerHTML = ""; };
$("#test-route").onclick = $("#test-route-top").onclick = $("#insp-test-route").onclick = runRouteTest;
$("#copy-route").onclick = () => window.harness.clipboard.write("ANTHROPIC_BASE_URL=http://127.0.0.1:15721\nUPSTREAM=http://127.0.0.1:7890/v1\nMODEL=qwen");
$("#copy-endpoint").onclick = () => window.harness.clipboard.write("http://127.0.0.1:7890/v1");
$$("[data-pick]").forEach((button) => button.onclick = () => chooseModel(button.dataset.pick));
$("#remove-mmproj").onclick = () => { settingsDraft.mmproj = ""; renderSettings(); };
$("#settings-form").oninput = () => { readForm(); renderSettings(); };
$("#cloud-profile").onchange = (event) => { syncCloudEditor(); settingsDraft.cloudProfileId = event.target.value; renderSettings(); };
$("#settings-form").elements.preset.forEach?.((radio) => radio.addEventListener("change", () => {
  const [baseUrl, model] = presetDefaults[$("#settings-form").elements.preset.value];
  if ($("#settings-form").elements.preset.value !== "custom") { $("#cloud-url").value = baseUrl; $("#cloud-model").value = model; }
  syncCloudEditor(); renderSettings();
}));
$("#add-cloud").onclick = () => { syncCloudEditor(); const profile = { id: crypto.randomUUID(), preset: "openai", baseUrl: presetDefaults.openai[0], model: presetDefaults.openai[1], apiKey: "", keyConfigured: false }; settingsDraft.cloudProfiles.push(profile); settingsDraft.cloudProfileId = profile.id; renderSettings(); };
$("#delete-cloud").onclick = () => { if (settingsDraft.cloudProfiles.length === 1) return; settingsDraft.cloudProfiles = settingsDraft.cloudProfiles.filter((profile) => profile.id !== settingsDraft.cloudProfileId); settingsDraft.cloudProfileId = settingsDraft.cloudProfiles[0].id; renderSettings(); };
// parity: saveSettings persistSettings
$("#save-settings").onclick = saveSettings;
$("#apply-settings").onclick = applySettings;

document.addEventListener("paste", async (event) => {
  if (!$("#agent").classList.contains("active") || ["INPUT", "TEXTAREA"].includes(event.target.tagName)) return;
  const paths = [...(event.clipboardData?.files || [])].map(window.harness.pathForFile).filter(Boolean);
  if (paths.length) addAttachments(paths); else { const image = await window.harness.clipboard.image(); if (image) addAttachments([image]); }
});
$("#agent").ondragover = (event) => event.preventDefault();
$("#agent").ondrop = (event) => { event.preventDefault(); addAttachments([...event.dataTransfer.files].map(window.harness.pathForFile)); };

// parity: bootstrap
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
