import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { bundleWindowsDeps, listRuntimeDlls } from "./win-deps.mjs";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(import.meta.dirname, "runtime");
const serverName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const server = process.env.LH_SERVER_PATH || resolve(root, "llama_cpp_bonsai", "build", "bin", serverName);

if (!existsSync(server)) throw new Error(`未找到 llama-server：${server}`);
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
cpSync(server, resolve(runtime, serverName));

// 先带走编译产物旁边的 DLL，再按 PE 导入表把非系统依赖收齐。
// 新机器没有 Git、CUDA Toolkit 或 VC 目录时，只能看到 exe 自己的目录。
const dlls = readdirSync(dirname(server)).filter((name) => name.toLowerCase().endsWith(".dll"));
for (const dll of dlls) cpSync(resolve(dirname(server), dll), resolve(runtime, dll));
if (process.platform === "win32") {
  const searchDirs = [
    resolve(root, "vendor", "win-deps"),
    dirname(server),
    process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "bin") : "",
    process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "lib") : "",
    process.env.CUDA_PATH ? join(process.env.CUDA_PATH, "bin", "x64") : "",
    join(process.env.ProgramFiles || "C:\\Program Files", "Git", "mingw64", "bin"),
    join(process.env.ProgramFiles || "C:\\Program Files", "OpenSSL-Win64", "bin"),
  ].filter(Boolean);
  const { copied, missing } = bundleWindowsDeps(runtime, searchDirs);
  if (copied.length) console.log(`closed runtime deps: ${copied.join(", ")}`);
  if (missing.length) throw new Error(`llama-server 仍缺少非系统 DLL：${missing.join(", ")}。这些文件必须打进安装包，不能指望目标机器的 PATH。`);
  const required = ["cudart64_13.dll", "cublas64_13.dll", "cublasLt64_13.dll", "libssl-3-x64.dll", "libcrypto-3-x64.dll"];
  const present = new Set(listRuntimeDlls(runtime).map((name) => name.toLowerCase()));
  const absent = required.filter((name) => !present.has(name.toLowerCase()));
  if (absent.length) throw new Error(`llama-server 运行库不完整：${absent.join(", ")}`);
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const probe = spawnSync(resolve(runtime, serverName), ["--version"], {
    cwd: runtime,
    env: { PATH: `${systemRoot}\\System32;${systemRoot}`, SYSTEMROOT: systemRoot, WINDIR: systemRoot },
    encoding: "utf8",
  });
  if (probe.status !== 0) {
    const detail = `${probe.stderr || ""}${probe.stdout || ""}`.trim();
    throw new Error(`llama-server 在独立运行目录下无法启动（status ${probe.status}）。${detail}`);
  }
  if (probe.stdout) process.stdout.write(probe.stdout);
  if (probe.stderr) process.stderr.write(probe.stderr);
}
const packaged = existsSync(runtime) ? listRuntimeDlls(runtime) : [];
if (packaged.length) console.log(`runtime dlls: ${packaged.join(", ")}`);

const agentNodeModules = resolve(root, "agent", "node_modules");
if (!existsSync(agentNodeModules)) throw new Error("agent 依赖未安装。打包前请先在 agent 目录执行 npm ci，否则新机器上开发代理无法启动。");
cpSync(resolve(root, "agent"), resolve(runtime, "agent"), {
  recursive: true,
  filter: (source) => !source.includes(".git") && !source.includes("npm-cache"),
});
if (!existsSync(resolve(runtime, "agent", "node_modules", "@cline", "sdk"))) {
  throw new Error("安装包未包含 @cline/sdk。agent/node_modules 必须随应用一起发布。");
}
console.log(`runtime ready: ${runtime}`);
