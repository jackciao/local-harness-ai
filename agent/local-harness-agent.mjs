#!/usr/bin/env node
import { existsSync, readFileSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { ClineCore } from "@cline/sdk";

const args = process.argv.slice(2);
const valueFor = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const brief = (value) => {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  if (!text) return "";
  return text.length > 1200 ? `${text.slice(0, 1200)}…` : text;
};

const projectEvent = (event) => {
  const out = [];
  if (!event || typeof event !== "object") return out;
  if (event.type === "chunk") {
    const chunk = event.payload?.chunk;
    if (event.payload?.stream === "stderr" && chunk) out.push({ type: "status", text: String(chunk) });
    return out;
  }
  if (event.type === "hook") {
    const payload = event.payload || {};
    if (payload.toolName && (payload.hookEventName === "tool_call" || payload.hookEventName === "tool_result")) {
      out.push({
        type: "tool",
        id: payload.toolName,
        name: payload.toolName,
        text: payload.hookEventName === "tool_result" ? "完成" : "已请求",
        done: payload.hookEventName === "tool_result",
      });
    }
    return out;
  }
  if (event.type === "status" && event.payload?.status) {
    const status = String(event.payload.status);
    if (!["pending", "running", "completed", "starting", "failed", "error", "cancelled", "canceled"].includes(status)) {
      out.push({ type: "status", text: /compact/i.test(status) ? "上下文过长，正在压缩…" : status });
    }
    return out;
  }
  if (event.type === "ended") {
    const reason = String(event.payload?.reason || "完成");
    if (!["failed", "error", "cancelled", "canceled"].includes(reason.toLowerCase())) {
      out.push({ type: "done", text: reason });
    }
    return out;
  }
  if (event.type !== "agent_event") return out;
  const inner = event.payload?.event;
  if (!inner || typeof inner !== "object") return out;
  if (inner.type === "content_start" || inner.type === "content_end") {
    const done = inner.type === "content_end";
    if (inner.contentType === "reasoning") {
      const accumulated = inner.accumulated || "";
      const chunk = inner.reasoning || inner.text || "";
      out.push({
        type: "thinking",
        id: inner.agentId || "thinking",
        text: accumulated || chunk,
        done,
        append: !done && !accumulated && !!chunk,
      });
    } else if (inner.contentType === "text") {
      const accumulated = inner.accumulated || "";
      const chunk = inner.text || "";
      out.push({
        type: "reply",
        id: inner.agentId || "reply",
        text: accumulated || chunk,
        done,
        append: !done && !accumulated && !!chunk,
      });
    } else if (inner.contentType === "tool") {
      out.push({
        type: "tool",
        id: inner.toolCallId || inner.toolName || "tool",
        name: inner.toolName || "tool",
        text: brief(done ? inner.output ?? inner.error : inner.input),
        done,
      });
    }
    return out;
  }
  if (inner.type === "notice") {
    const raw = String(inner.message || inner.noticeType || "状态更新");
    const text = /compact/i.test(raw) ? "上下文过长，正在压缩…" : raw;
    out.push({ type: "status", text });
  }
  if (inner.type === "error") {
    const message = inner.error?.message || String(inner.error || "代理出错");
    if (!isTruncatedError(message)) out.push({ type: "error", text: message });
  }
  if (inner.type === "done") out.push({ type: "done", text: inner.text || inner.reason || "完成" });
  return out;
};

const isTruncatedError = (error) => String(error?.message || error || "").includes("maximum output token limit");

const MAX_CONTINUES = 4; // ponytail: 4 hops, raise if 32k still truncates

const parseInput = (raw) => {
  const text = String(raw || "").trim();
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj.prompt === "string") {
        return {
          prompt: obj.prompt.trim(),
          history: Array.isArray(obj.history) ? obj.history : [],
          contextSize: Number(obj.contextSize) > 0 ? Math.floor(Number(obj.contextSize)) : 0,
        };
      }
    } catch {}
  }
  return { prompt: text, history: [], contextSize: 0 };
};

const parseCommand = (raw) => {
  const text = String(raw || "").trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    try {
      const obj = JSON.parse(text);
      if (obj && typeof obj === "object") {
        if (obj.type === "stop" || obj.type === "exit") {
          return { type: obj.type, prompt: "", history: [], contextSize: 0, images: [] };
        }
        const parsed = parseInput(text);
        const images = Array.isArray(obj.images) ? obj.images.map(String).filter(Boolean) : [];
        return { type: "prompt", ...parsed, images };
      }
    } catch {}
  }
  return { type: "prompt", prompt: text, history: [], contextSize: 0, images: [] };
};

const toMessages = (history) => {
  const out = [];
  for (const item of history) {
    if (!item || (item.role !== "user" && item.role !== "assistant")) continue;
    const content = typeof item.content === "string" ? item.content.trim() : "";
    if (content) out.push({ role: item.role, content });
  }
  return out;
};

const buildContinuePrompt = (reply, hasHistory) => {
  if (hasHistory) {
    return "Your previous assistant message was cut off at the output token limit. Continue exactly where you stopped. Do not restart the task. Finish remaining files, edits, and commands.";
  }
  const tail = String(reply || "").trim().slice(-3000);
  if (!tail) {
    return "Your previous reply hit the output token limit and was cut off. Continue exactly where you left off. Do not restart. Finish remaining files, edits, and commands.";
  }
  return `Your previous reply hit the output token limit and was cut off. Continue exactly where you left off. Do not repeat the already written part. Last output was:\n\n${tail}\n\nFinish remaining files, edits, and commands.`;
};

const emit = (obj) => {
  writeSync(1, `${JSON.stringify(obj)}\n`);
};

const makeStamper = () => {
  const open = Object.create(null);
  let n = 0;
  return (item) => {
    if (item.type !== "thinking" && item.type !== "reply" && item.type !== "tool") return item;
    const key = item.type === "tool" ? `tool:${item.name || item.id}` : item.type;
    if (!open[key]) open[key] = `${item.type}-${++n}`;
    const next = { ...item, id: open[key] };
    if (item.done) delete open[key];
    return next;
  };
};

const collectImages = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--image" && argv[i + 1]) out.push(argv[++i]);
  }
  return out;
};

const toDataUrl = (path) => {
  const buf = readFileSync(path);
  const ext = path.split(".").pop()?.toLowerCase();
  const mime = { jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" }[ext] || "image/png";
  return `data:${mime};base64,${buf.toString("base64")}`;
};

if (args.includes("--self-check")) {
  const projected = [
    { type: "agent_event", payload: { event: { type: "content_start", contentType: "reasoning", reasoning: "plan" } } },
    { type: "agent_event", payload: { event: { type: "content_end", contentType: "text", text: "hello" } } },
    { type: "agent_event", payload: { event: { type: "content_start", contentType: "tool", toolName: "read_files", input: { path: "a" } } } },
    { type: "ended", payload: { reason: "completed" } },
  ].flatMap(projectEvent);
  if (!projected.some((item) => item.type === "thinking" && item.text === "plan")) throw new Error("thinking");
  if (!projected.some((item) => item.type === "reply" && item.text === "hello" && item.done)) throw new Error("reply");
  const delta = projectEvent({ type: "agent_event", payload: { event: { type: "content_start", contentType: "text", text: "hel" } } })[0];
  if (!delta?.append) throw new Error("append");
  const stamp = makeStamper();
  const first = stamp({ type: "thinking", id: "thinking", text: "a", done: true });
  const second = stamp({ type: "thinking", id: "thinking", text: "b", done: false });
  if (first.id === second.id) throw new Error("turn-id");
  if (!projected.some((item) => item.type === "tool" && item.name === "read_files")) throw new Error("tool");
  if (!projected.some((item) => item.type === "done")) throw new Error("done");
  if (projectEvent({ type: "status", payload: { status: "failed" } }).length) throw new Error("status-noise");
  if (projectEvent({ type: "ended", payload: { reason: "failed" } }).length) throw new Error("ended-noise");
  if (!isTruncatedError("Model reached the maximum output token limit before completing the turn")) throw new Error("truncated");
  if (isTruncatedError("other")) throw new Error("truncated-false");
  if (!buildContinuePrompt("hello world", true).includes("Continue exactly")) throw new Error("continue-history");
  if (!buildContinuePrompt("cut-off-tail", false).includes("cut-off-tail")) throw new Error("continue-tail");
  const parsed = parseInput('{"prompt":"hi","history":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}],"contextSize":8192}');
  if (parsed.prompt !== "hi" || parsed.history.length !== 2 || parsed.contextSize !== 8192) throw new Error("parse-json");
  if (parseInput("plain").prompt !== "plain") throw new Error("parse-text");
  if (toMessages(parsed.history)[1].role !== "assistant") throw new Error("history-msg");
  if (parseCommand('{"type":"stop"}')?.type !== "stop") throw new Error("cmd-stop");
  if (parseCommand('{"type":"prompt","prompt":"x","images":["/a.png"]}')?.images[0] !== "/a.png") throw new Error("cmd-image");
  if (projectEvent({ type: "status", payload: { status: "auto-compacting" } })[0]?.text !== "上下文过长，正在压缩…") throw new Error("compact-status");
  if (projectEvent({ type: "agent_event", payload: { event: { type: "error", error: { message: "Model reached the maximum output token limit before completing the turn" } } } }).length) throw new Error("truncate-noise");
  if (collectImages(["x", "--image", "/a.png", "--image", "/b.jpg"]).join() !== "/a.png,/b.jpg") throw new Error("image-arg");
  const tmp = resolve(tmpdir(), "lh-img-check.bin");
  writeFileSync(tmp, Buffer.from("hi"));
  if (!toDataUrl(tmp).startsWith("data:image/png;base64,")) throw new Error("data-url");
  unlinkSync(tmp);
  emit({ type: "status", text: "self-check ok" });
  process.exit(0);
}

const workspace = resolve(valueFor("--workspace") || process.cwd());
const allowWrites = args.includes("--allow-writes");
const providerId = process.env.HARNESS_PROVIDER || "openai-compatible";
const modelId = process.env.HARNESS_MODEL || "qwen";
const baseUrl = process.env.HARNESS_BASE_URL || "http://127.0.0.1:7890/v1";
const apiKey = process.env.HARNESS_API_KEY || "local-harness";
const contextSize = Number(process.env.HARNESS_CTX) || 0;
let leftoverImages = collectImages(args);

if (!existsSync(workspace)) throw new Error(`工作区不存在：${workspace}`);

emit({ type: "status", text: `启动开发代理 · ${modelId}` });

const cline = await ClineCore.create({
  clientName: "local-harness-ai",
  backendMode: "local",
  capabilities: {
    requestToolApproval: async (request) => {
      emit({ type: "tool", id: request.toolName, name: request.toolName, text: brief(request.input), done: false });
      return { approved: allowWrites || ["read_files", "search_codebase", "fetch_web_content"].includes(request.toolName) };
    },
  },
});

const config = {
  providerId,
  modelId,
  apiKey,
  baseUrl,
  cwd: workspace,
  workspaceRoot: workspace,
  enableTools: true,
  enableSpawnAgent: false,
  enableAgentTeams: false,
  yolo: allowWrites,
  thinking: true,
  maxTokensPerTurn: 8192,
  systemPrompt: "You are a local software-development agent. The workspace is already cwd. Create and edit files with the editor tool using workspace-relative paths only (never Windows paths like C:\\\\). Use run_commands when you need the shell. After writing a file, report the exact path.",
  compaction: {
    enabled: true,
    strategy: "agentic",
    summarizer: { providerId, modelId, apiKey, baseUrl },
  },
  ...(contextSize > 0
    ? {
        knownModels: {
          [modelId]: {
            id: modelId,
            contextWindow: contextSize,
            maxInputTokens: contextSize,
            maxTokens: 8192,
          },
        },
      }
    : {}),
};
const toolPolicies = {
  read_files: { autoApprove: true },
  search_codebase: { autoApprove: true },
  fetch_web_content: { autoApprove: false },
  run_commands: { autoApprove: allowWrites },
  editor: { autoApprove: allowWrites },
  apply_patch: { autoApprove: allowWrites },
};

let stamp = makeStamper();
let sawReply = false;
let sessionId = "";
let lastReply = "";
let alive = false;
let busy = false;

cline.subscribe((event) => {
  if (event.type === "ended") return;
  const sid = event?.payload?.sessionId;
  if (typeof sid === "string" && sid) sessionId = sid;
  for (const item of projectEvent(event)) {
    if (item.type === "reply") {
      sawReply = true;
      if (item.append) lastReply += item.text || "";
      else if (item.text) lastReply = item.text;
    }
    emit(stamp(item));
  }
});

const readSeed = async () => {
  if (!sessionId) return undefined;
  const live = await cline.readLiveMessages(sessionId).catch(() => []);
  if (live?.length) return live;
  const disk = await cline.readMessages(sessionId).catch(() => []);
  return disk?.length ? disk : undefined;
};

const imageUrls = (paths) => paths.map((path) => resolve(path)).filter((path) => existsSync(path)).map(toDataUrl);

const runUserTurn = async ({ prompt, history, images }) => {
  let hop = 0;
  let nextPrompt = prompt;
  let seed = history.length ? history : undefined;
  let imgs = images;
  let useSend = alive && Boolean(sessionId);
  while (true) {
    stamp = makeStamper();
    sawReply = false;
    lastReply = "";
    try {
      if (useSend) {
        await cline.send({
          sessionId,
          prompt: nextPrompt,
          userImages: imgs.length ? imgs : undefined,
        });
      } else {
        const session = await cline.start({
          prompt: nextPrompt,
          initialMessages: seed,
          userImages: imgs.length ? imgs : undefined,
          interactive: true,
          config,
          toolPolicies,
        });
        sessionId = session.sessionId;
        if (session.result?.text && !sawReply) emit({ type: "reply", id: "reply", text: session.result.text, done: true });
      }
      alive = true;
      emit({ type: "done", text: "完成" });
      return;
    } catch (error) {
      alive = false;
      const message = error?.message || String(error);
      if (/abort|cancel/i.test(message)) {
        emit({ type: "status", text: "已停止" });
        return;
      }
      if (!isTruncatedError(error) || hop >= MAX_CONTINUES) {
        emit({ type: "error", text: message });
        return;
      }
      hop += 1;
      emit({ type: "status", text: `输出被截断，正在自动续写（${hop}/${MAX_CONTINUES}）…` });
      seed = await readSeed();
      nextPrompt = buildContinuePrompt(lastReply, Boolean(seed?.length));
      imgs = [];
      useSend = false;
    }
  }
};

const handleStop = async () => {
  if (sessionId) {
    try {
      await cline.abort(sessionId);
    } catch {}
  }
  emit({ type: "status", text: "已停止" });
  emit({ type: "ready" });
};

try {
  const rl = createInterface({ input: process.stdin });
  await new Promise((resolve) => {
    const onLine = (line) => {
      void (async () => {
        const cmd = parseCommand(line);
        if (!cmd) return;
        if (cmd.type === "exit") {
          rl.off("line", onLine);
          rl.close();
          resolve();
          return;
        }
        if (cmd.type === "stop") {
          await handleStop();
          return;
        }
        if (cmd.type !== "prompt") return;
        let prompt = cmd.prompt;
        const images = imageUrls([...leftoverImages, ...cmd.images]);
        leftoverImages = [];
        if (!prompt && images.length) prompt = "请查看图片。";
        if (!prompt) {
          emit({ type: "error", text: "缺少 prompt" });
          emit({ type: "ready" });
          return;
        }
        if (busy) return;
        busy = true;
        try {
          await runUserTurn({ prompt, history: toMessages(cmd.history), images });
        } finally {
          busy = false;
          emit({ type: "ready" });
        }
      })();
    };
    rl.on("line", onLine);
    rl.on("close", resolve);
  });
} finally {
  try {
    await cline.dispose("local-harness-ai complete");
  } catch {}
}
