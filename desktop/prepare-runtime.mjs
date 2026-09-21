import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(import.meta.dirname, "runtime");
const server = process.env.LH_SERVER_PATH || resolve(root, "llama_cpp_bonsai", "build", "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");

if (!existsSync(server)) throw new Error(`未找到 Windows llama-server：${server}`);
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
cpSync(server, resolve(runtime, process.platform === "win32" ? "llama-server.exe" : "llama-server"));

// CUDA 运行库必须与 llama-server.exe 同目录，否则无 NVIDIA 环境下进程根本起不来。
const dlls = readdirSync(dirname(server)).filter((name) => name.toLowerCase().endsWith(".dll"));
for (const dll of dlls) cpSync(resolve(dirname(server), dll), resolve(runtime, dll));
if (dlls.length) console.log(`runtime dlls: ${dlls.join(", ")}`);

cpSync(resolve(root, "agent"), resolve(runtime, "agent"), {
  recursive: true,
  filter: (source) => !source.includes(".git") && !source.includes("npm-cache"),
});
console.log(`runtime ready: ${runtime}`);
