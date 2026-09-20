const { app, BrowserWindow, clipboard, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, openSync, readSync, closeSync } = require("node:fs");
const { totalmem } = require("node:os");
const { extname, isAbsolute, join, relative, resolve, sep } = require("node:path");

const defaultProfile = { id: "openai-default", preset: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o", apiKey: "" };
const defaults = {
  source: "local", model: "", mmproj: "", chatTemplate: "", context: 8192, kv: "q4_0",
  compatibility: false, ngram: false, reasoning: false, cloudProfileId: defaultProfile.id,
  cloudProfiles: [defaultProfile], workspace: "", allowWrites: true,
};

let config = structuredClone(defaults);
let server;
let agent;
let agentKey = "";
let agentBuffer = "";
let toolProcess;
let window;
let startedAt;
const metrics = { generationTPS: 0, promptTPS: 0, ttft: 0, contextUsed: 0, contextSize: 8192, ngramAcceptance: null };

const dataDir = () => join(app.getPath("userData"), "local-harness-ai");
const configPath = () => join(dataDir(), "settings.json");
const sessionsPath = () => join(dataDir(), "sessions.json");
const runtimeRoot = () => app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "runtime");
const serverPath = () => join(runtimeRoot(), process.platform === "win32" ? "llama-server.exe" : "llama-server");
const agentPath = () => join(runtimeRoot(), "agent", "local-harness-agent.mjs");
const endpoint = "http://127.0.0.1:7890";
const emit = (channel, value) => window?.webContents.send(channel, value);

function decrypt(value) {
  if (!value?.encrypted || !safeStorage.isEncryptionAvailable()) return "";
  try { return safeStorage.decryptString(Buffer.from(value.encrypted, "base64")); } catch { return ""; }
}

function encrypt(value) {
  return value && safeStorage.isEncryptionAvailable()
    ? { encrypted: safeStorage.encryptString(value).toString("base64") }
    : undefined;
}

function normalizeProfiles(items, previous = []) {
  const old = new Map(previous.map((profile) => [profile.id, profile]));
  return (Array.isArray(items) && items.length ? items : [defaultProfile]).map((profile) => ({
    id: String(profile.id || randomUUID()),
    preset: ["openai", "anthropic", "deepseek", "openrouter", "custom"].includes(profile.preset) ? profile.preset : "custom",
    baseUrl: String(profile.baseUrl || "").replace(/\/$/, ""),
    model: String(profile.model || ""),
    apiKey: profile.apiKey && profile.apiKey !== "configured" ? String(profile.apiKey) : old.get(profile.id)?.apiKey || "",
  }));
}

function loadConfig() {
  try {
    const stored = JSON.parse(readFileSync(configPath(), "utf8"));
    const profiles = (stored.cloudProfiles || []).map((profile) => ({ ...profile, apiKey: decrypt(profile.apiKey) }));
    config = { ...structuredClone(defaults), ...stored, cloudProfiles: normalizeProfiles(profiles) };
  } catch { config = structuredClone(defaults); }
  if (!config.workspace) config.workspace = app.getPath("home");
  if (!config.cloudProfiles.some((profile) => profile.id === config.cloudProfileId)) config.cloudProfileId = config.cloudProfiles[0].id;
}

function publicConfig() {
  return { ...config, cloudProfiles: config.cloudProfiles.map((profile) => ({ ...profile, apiKey: "", keyConfigured: Boolean(profile.apiKey) })) };
}

function validateGGUF(path) {
  if (!path || extname(path).toLowerCase() !== ".gguf") throw new Error("请选择 .gguf 模型文件。");
  if (!existsSync(path) || statSync(path).isDirectory()) throw new Error(`找不到模型文件：${path}`);
  const buffer = Buffer.alloc(4);
  const fd = openSync(path, "r");
  try { readSync(fd, buffer, 0, 4, 0); } finally { closeSync(fd); }
  if (!buffer.equals(Buffer.from("GGUF"))) throw new Error("该文件不是有效的 GGUF 模型。");
}

function saveConfig(next) {
  const validate = next.validate === true;
  const previousKey = agentReuseKey();
  const profiles = normalizeProfiles(next.cloudProfiles ?? config.cloudProfiles, config.cloudProfiles);
  const candidate = { ...config, ...next, cloudProfiles: profiles };
  delete candidate.validate;
  candidate.context = Number(candidate.context);
  if (validate && (!Number.isInteger(candidate.context) || candidate.context < 512 || candidate.context > 131072)) throw new Error("上下文需在 512–131072 token 之间。");
  if (validate && candidate.source === "local") {
    validateGGUF(candidate.model);
    if (candidate.mmproj) validateGGUF(candidate.mmproj);
  }
  if (!profiles.some((profile) => profile.id === candidate.cloudProfileId)) candidate.cloudProfileId = profiles[0].id;
  config = candidate;
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({ ...config, cloudProfiles: config.cloudProfiles.map((profile) => ({ ...profile, apiKey: encrypt(profile.apiKey) })) }, null, 2));
  metrics.contextSize = runtimeContext();
  if (previousKey !== agentReuseKey()) stopAgent();
  return publicConfig();
}

function activeProfile() {
  return config.cloudProfiles.find((profile) => profile.id === config.cloudProfileId) || config.cloudProfiles[0];
}

function runtimeContext() {
  return config.compatibility ? Math.min(config.context, 4096) : config.context;
}

function emitLog(text, kind = "info") {
  emit("server-log", { id: randomUUID(), text, kind, time: new Date().toLocaleTimeString() });
}

function parseLog(line) {
  if (!line || line.includes("srv          stop: cancel task")) return;
  let match = line.match(/prompt eval time.*?([0-9.]+) tokens per second/i);
  if (match) metrics.promptTPS = Number(match[1]);
  match = line.match(/(?:eval time.*?|tg_3s\s*=\s*)([0-9.]+)(?: tokens per second| t\/s)/i);
  if (match) metrics.generationTPS = Number(match[1]);
  match = line.match(/draft acceptance\s*=\s*([0-9.]+)/i);
  if (match) metrics.ngramAcceptance = Number(match[1]) * 100;
  emitLog(line, /error|failed|not found/i.test(line) ? "error" : "info");
}

function splitLines(data) {
  for (const line of String(data).split(/\r?\n/)) parseLog(line);
}

async function api(path, options = {}, base = endpoint) {
  const response = await fetch(`${base}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}

async function proxyOnline() {
  try { return (await api("/health", {}, "http://127.0.0.1:15721")).status === "healthy"; } catch { return false; }
}

async function state() {
  try {
    const [health, models, slots] = await Promise.all([api("/health"), api("/v1/models"), api("/slots")]);
    const slot = slots?.[0] || {};
    metrics.contextSize = slot.n_ctx || models?.data?.[0]?.meta?.n_ctx || metrics.contextSize;
    metrics.contextUsed = slot.n_prompt_tokens ?? slot.n_prompt_tokens_processed ?? metrics.contextUsed;
    return { phase: server ? "online" : "external", canControlServer: Boolean(server), health, models, slots, metrics, uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0, memoryGB: Math.round(totalmem() / 1073741824), ccSwitch: await proxyOnline() };
  } catch {
    return { phase: server ? "starting" : "offline", canControlServer: Boolean(server), metrics, uptime: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0, memoryGB: Math.round(totalmem() / 1073741824), ccSwitch: false };
  }
}

function stopServer() {
  const active = server;
  server = undefined;
  startedAt = undefined;
  if (active && !active.killed) active.kill();
}

async function startServer() {
  if (config.source === "cloud") return state();
  validateGGUF(config.model);
  if (config.mmproj) validateGGUF(config.mmproj);
  try {
    const existing = await api("/health");
    if (existing.status === "ok") { emitLog("发现已有 llama.cpp 服务", "success"); return state(); }
  } catch {}
  stopServer();
  const compatible = Boolean(config.compatibility);
  const args = [
    "-m", config.model, "-ngl", compatible ? "auto" : "99", "-c", String(runtimeContext()), "-fa", compatible ? "auto" : "on",
    "-ctk", config.kv, "-ctv", config.kv, "-t", "1", "-tb", "8", "-b", "512", "-ub", "512",
    "--load-mode", compatible ? "auto" : "none", "--fit", "on", "--fit-ctx", compatible ? "1024" : "4096",
    "--cache-ram", compatible ? "256" : "1024", "-np", "1", "--host", "127.0.0.1", "--port", "7890",
    "-a", "qwen", "--jinja", "--reasoning", config.reasoning ? "auto" : "off", "--temp", "1.0", "--top-k", "20", "--top-p", "0.95",
  ];
  if (config.mmproj) args.push("-mm", config.mmproj);
  if (config.chatTemplate) args.push("--chat-template", config.chatTemplate);
  if (config.ngram) args.push("--spec-type", "ngram-mod", "--spec-ngram-mod-n-min", "2", "--spec-ngram-mod-n-max", "4", "--spec-ngram-mod-n-match", "16");
  const child = spawn(serverPath(), args, { cwd: runtimeRoot(), windowsHide: true });
  server = child;
  startedAt = Date.now();
  child.stdout.on("data", splitLines);
  child.stderr.on("data", splitLines);
  child.on("error", (error) => emitLog(`llama.cpp 启动失败：${error.message}`, "error"));
  child.on("exit", (code) => {
    emitLog(`llama.cpp 已退出（code ${code ?? "signal"}）`, code ? "error" : "info");
    if (server === child) { server = undefined; startedAt = undefined; }
  });
  emitLog(`启动 llama.cpp · ${runtimeContext() / 1024}K context · KV ${config.kv} · ${compatible ? "兼容模式" : "高速模式"}`, "success");
  return state();
}

function stopAgent() {
  const active = agent;
  agent = undefined;
  agentKey = "";
  agentBuffer = "";
  if (active && !active.killed) active.kill();
}

function agentReuseKey(payload = {}) {
  const profile = activeProfile();
  return [payload.sessionId || "", payload.workspace || config.workspace, payload.allowWrites ?? config.allowWrites, config.source, profile?.id, profile?.model, profile?.baseUrl, profile?.apiKey, runtimeContext()].join("|");
}

function startAgent(payload) {
  const workspace = payload.workspace || config.workspace;
  if (!workspace || !existsSync(workspace)) throw new Error("请选择有效工作区。");
  const profile = activeProfile();
  if (config.source === "cloud" && (!profile?.apiKey || !profile.model || !profile.baseUrl)) throw new Error("云配置缺少 API Key、模型或 Base URL。");
  const key = agentReuseKey(payload);
  if (!agent || agent.killed || agentKey !== key) {
    stopAgent();
    const env = {
      ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1",
      HARNESS_PROVIDER: config.source === "cloud" && profile.preset === "anthropic" ? "anthropic" : "openai-compatible",
      HARNESS_MODEL: config.source === "cloud" ? profile.model : "qwen",
      HARNESS_BASE_URL: config.source === "cloud" ? profile.baseUrl : `${endpoint}/v1`,
      HARNESS_API_KEY: config.source === "cloud" ? profile.apiKey : "local-harness",
      HARNESS_CTX: String(config.source === "cloud" ? 128000 : runtimeContext()),
    };
    const child = spawn(process.execPath, [agentPath(), "--workspace", workspace, ...(payload.allowWrites ? ["--allow-writes"] : [])], { cwd: join(runtimeRoot(), "agent"), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    agent = child;
    agentKey = key;
    child.stdout.on("data", (data) => {
      if (agent !== child) return;
      agentBuffer += data;
      const lines = agentBuffer.split(/\r?\n/);
      agentBuffer = lines.pop();
      for (const line of lines) try { emit("agent-event", JSON.parse(line)); } catch {}
    });
    child.stderr.on("data", (data) => { if (agent === child) emit("agent-event", { type: "error", text: String(data) }); });
    child.on("exit", (code) => {
      if (agent !== child) return;
      if (code) emit("agent-event", { type: "error", text: `代理异常退出（${code}）` });
      emit("agent-event", { type: "done", text: code ? "异常退出" : "完成" });
      agent = undefined;
      agentKey = "";
    });
  }
  agent.stdin.write(`${JSON.stringify({ type: "prompt", prompt: payload.prompt, history: payload.history || [], images: payload.images || [], contextSize: config.source === "cloud" ? 128000 : runtimeContext() })}\n`);
}

async function sendChat(message) {
  const profile = activeProfile();
  const local = config.source === "local";
  if (!local && (!profile?.apiKey || !profile.model || !profile.baseUrl)) throw new Error("云配置不完整。");
  const images = (message.images || []).filter(existsSync);
  const content = images.length
    ? [{ type: "text", text: message.text }, ...images.map((image) => ({ type: "image_url", image_url: { url: `data:image/${extname(image).slice(1) || "png"};base64,${readFileSync(image).toString("base64")}` } }))]
    : message.text;
  const started = Date.now();
  if (!local && profile.preset === "anthropic") {
    const response = await fetch(`${profile.baseUrl.replace(/\/$/, "")}/v1/messages`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-api-key": profile.apiKey, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: profile.model, max_tokens: 1024, messages: [{ role: "user", content: message.text }] }),
    });
    if (!response.ok) throw new Error(await response.text());
    const body = await response.json();
    metrics.ttft = Date.now() - started;
    return body.content?.map((item) => item.text || "").join("") || "";
  }
  const baseUrl = local ? `${endpoint}/v1` : profile.baseUrl;
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${local ? "local-harness" : profile.apiKey}` },
    body: JSON.stringify({ model: local ? "qwen" : profile.model, messages: [{ role: "user", content }], stream: false, temperature: 0.7, top_p: 0.95, max_tokens: 1024 }),
  });
  if (!response.ok) throw new Error(await response.text());
  const body = await response.json();
  metrics.ttft = Date.now() - started;
  return body.choices?.[0]?.message?.content || "";
}

function withinWorkspace(path) {
  const root = resolve(config.workspace || app.getPath("home"));
  const candidate = resolve(path || root);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("只能访问当前工作区内的文件。");
  return candidate;
}

function listDirectory(path) {
  const safe = withinWorkspace(path);
  return readdirSync(safe, { withFileTypes: true }).map((entry) => ({ name: entry.name, path: join(safe, entry.name), directory: entry.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

app.whenReady().then(() => {
  loadConfig();
  metrics.contextSize = runtimeContext();
  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 720, webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false, webviewTag: true } });
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    if (params.src !== "about:blank" && !/^https?:\/\//i.test(params.src)) event.preventDefault();
  });
  window.loadFile(join(__dirname, "index.html"));
  setInterval(() => state().then((value) => emit("server-state", value)), 2000);
  if (config.source === "local" && config.model && existsSync(config.model)) startServer().catch((error) => emitLog(error.message, "error"));
});

app.on("before-quit", () => { stopAgent(); stopServer(); if (toolProcess && !toolProcess.killed) toolProcess.kill(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

ipcMain.handle("config:get", () => publicConfig());
ipcMain.handle("config:save", (_, value) => saveConfig(value));
ipcMain.handle("dialog:file", async (_, kind) => {
  const filters = kind === "image" ? [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }]
    : kind === "attachment" ? [{ name: "All files", extensions: ["*"] }]
      : [{ name: "GGUF", extensions: ["gguf"] }];
  const result = await dialog.showOpenDialog(window, { properties: ["openFile", ...(kind === "attachment" || kind === "image" ? ["multiSelections"] : [])], filters });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("dialog:directory", async () => { const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] }); return result.canceled ? "" : result.filePaths[0]; });
ipcMain.handle("server:start", () => startServer());
ipcMain.handle("server:restart", async () => { stopServer(); return startServer(); });
ipcMain.handle("server:stop", () => stopServer());
ipcMain.handle("server:state", () => state());
ipcMain.handle("route:test", async () => {
  const lines = [];
  try {
    await api("/health"); lines.push("llama.cpp /health 通过");
    try { await api("/v1/messages/count_tokens", { method: "POST", body: JSON.stringify({ model: "qwen", messages: [{ role: "user", content: "ping" }], tools: [{ name: "ping", description: "Return pong.", input_schema: { type: "object", properties: {} } }] }) }); lines.push("Anthropic 工具端点通过"); }
    catch { lines.push("Anthropic 工具端点失败（OpenAI /v1 对话不受影响）"); }
  } catch (error) { lines.push(`llama.cpp 离线：${error.message}`); }
  lines.push(await proxyOnline() ? "CC Switch :15721 在线" : "CC Switch 未运行（仅 Claude Desktop 需要）");
  return lines;
});
ipcMain.handle("chat:send", (_, message) => sendChat(message));
ipcMain.handle("agent:send", (_, payload) => startAgent(payload));
ipcMain.handle("agent:stop", () => agent?.stdin?.write('{"type":"stop"}\n'));
ipcMain.handle("files:list", (_, path) => listDirectory(path));
ipcMain.handle("files:read", (_, path) => {
  const data = readFileSync(withinWorkspace(path));
  if (data.length > 1000000 || data.subarray(0, 1024).includes(0)) throw new Error("二进制文件或超过 1 MB，无法预览。");
  return data.toString("utf8");
});
ipcMain.handle("workspace:open", (_, path) => shell.openPath(withinWorkspace(path || config.workspace)));
ipcMain.handle("browser:open", (_, url) => /^https?:\/\//i.test(url) ? shell.openExternal(url) : Promise.reject(new Error("仅支持 http/https 地址。")));
ipcMain.handle("clipboard:write", (_, text) => clipboard.writeText(String(text)));
ipcMain.handle("clipboard:image", () => {
  const image = clipboard.readImage();
  if (image.isEmpty()) return "";
  const dir = join(dataDir(), "pastes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.png`);
  writeFileSync(path, image.toPNG());
  return path;
});
ipcMain.handle("tools:run", (_, command, cwd) => new Promise((resolveRun) => {
  if (toolProcess && !toolProcess.killed) throw new Error("已有命令正在运行。");
  toolProcess = spawn("powershell.exe", ["-NoProfile", "-Command", command], { cwd: withinWorkspace(cwd || config.workspace), windowsHide: true });
  let output = "";
  toolProcess.stdout.on("data", (data) => { output = (output + data).slice(-100000); emit("tool-output", String(data)); });
  toolProcess.stderr.on("data", (data) => { output = (output + data).slice(-100000); emit("tool-output", String(data)); });
  toolProcess.on("exit", (code) => { toolProcess = undefined; resolveRun({ code, output }); });
}));
ipcMain.handle("tools:stop", () => { if (toolProcess && !toolProcess.killed) toolProcess.kill(); });
ipcMain.handle("sessions:load", () => { try { return JSON.parse(readFileSync(sessionsPath(), "utf8")); } catch { return []; } });
ipcMain.handle("sessions:save", (_, sessions) => { mkdirSync(dataDir(), { recursive: true }); writeFileSync(sessionsPath(), JSON.stringify((Array.isArray(sessions) ? sessions : []).slice(0, 40), null, 2)); });
