import { openSync, readSync, closeSync, readdirSync, existsSync, cpSync } from "node:fs";
import { join } from "node:path";

const systemRoot = process.env.SystemRoot || "C:\\Windows";
const systemDirs = [join(systemRoot, "System32"), join(systemRoot, "SysWOW64")];

function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  const n = readSync(fd, buf, 0, len, pos);
  return buf.subarray(0, n);
}

function cstring(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end < 0 ? buf.length : end).toString("ascii");
}

// 普通导入表和延迟导入表。延迟导入缺失同样会在第一次调用时变成 0xC0000135。
export function peImportedDlls(path) {
  const fd = openSync(path, "r");
  try {
    const dos = readAt(fd, 0, 64);
    if (dos.length < 64 || dos.readUInt16LE(0) !== 0x5a4d) return [];
    const peOff = dos.readUInt32LE(0x3c);
    const pe = readAt(fd, peOff, 512);
    if (pe.length < 264 || pe.readUInt32LE(0) !== 0x4550) return [];
    const sections = pe.readUInt16LE(6);
    const optSize = pe.readUInt16LE(20);
    const magic = pe.readUInt16LE(24);
    const is64 = magic === 0x20b;
    const dataDir = 24 + (is64 ? 112 : 96);
    const secTable = peOff + 24 + optSize;
    const secBuf = readAt(fd, secTable, sections * 40);
    const secs = [];
    for (let i = 0; i < sections; i++) {
      const o = i * 40;
      secs.push({
        va: secBuf.readUInt32LE(o + 12),
        raw: secBuf.readUInt32LE(o + 20),
        span: Math.max(secBuf.readUInt32LE(o + 8), secBuf.readUInt32LE(o + 16)),
      });
    }
    const rvaToOff = (rva) => {
      for (const s of secs) {
        if (rva >= s.va && rva < s.va + s.span) return s.raw + (rva - s.va);
      }
      return -1;
    };
    const readName = (rva) => {
      const off = rvaToOff(rva);
      if (off < 0) return "";
      return cstring(readAt(fd, off, 260));
    };
    const names = [];
    const take = (dirIndex, nameOffset, stride) => {
      const rva = pe.readUInt32LE(dataDir + dirIndex * 8);
      if (!rva) return;
      let off = rvaToOff(rva);
      if (off < 0) return;
      for (;;) {
        const ent = readAt(fd, off, stride);
        if (ent.length < stride) break;
        const nameRva = ent.readUInt32LE(nameOffset);
        if (!nameRva) break;
        const name = readName(nameRva);
        if (name) names.push(name);
        off += stride;
      }
    };
    take(1, 12, 20);
    take(13, 4, 32);
    return names;
  } finally {
    closeSync(fd);
  }
}

function isApiSet(name) {
  const lower = name.toLowerCase();
  return lower.startsWith("api-ms-") || lower.startsWith("ext-ms-");
}

function findOnDisk(name, dirs) {
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    const direct = join(dir, name);
    if (existsSync(direct)) return direct;
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    const match = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (match) return join(dir, match);
  }
  return "";
}

export function isWindowsSystemDll(name) {
  if (isApiSet(name)) return true;
  return Boolean(findOnDisk(name, systemDirs));
}

// 从 exe 出发把非系统 DLL 收齐到 runtimeDir。searchDirs 只作为构建机上的查找位置，打进包里的是副本。
export function bundleWindowsDeps(runtimeDir, searchDirs) {
  const copied = [];
  const missing = [];
  const seen = new Set();
  const queue = readdirSync(runtimeDir).filter((name) => /\.(exe|dll)$/i.test(name));
  while (queue.length) {
    const name = queue.pop();
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const path = join(runtimeDir, name);
    if (!existsSync(path)) continue;
    let imports = [];
    try { imports = peImportedDlls(path); } catch { continue; }
    for (const dep of imports) {
      const depKey = dep.toLowerCase();
      if (seen.has(depKey) || isApiSet(dep)) continue;
      if (findOnDisk(dep, [runtimeDir])) {
        queue.push(dep);
        continue;
      }
      if (isWindowsSystemDll(dep)) continue;
      const src = findOnDisk(dep, searchDirs);
      if (!src) {
        missing.push(dep);
        continue;
      }
      cpSync(src, join(runtimeDir, dep));
      copied.push(dep);
      queue.push(dep);
    }
  }
  return { copied, missing: [...new Set(missing)] };
}

export function listRuntimeDlls(runtimeDir) {
  return readdirSync(runtimeDir).filter((name) => name.toLowerCase().endsWith(".dll")).sort((a, b) => a.localeCompare(b));
}

const isDirect = process.argv[1] && /win-deps\.mjs$/i.test(process.argv[1].replaceAll("/", "\\"));
if (isDirect) {
  const runtimeDir = process.argv[2];
  if (!runtimeDir) {
    console.error("usage: node win-deps.mjs <runtime-dir> [search-dir...]");
    process.exit(1);
  }
  const { copied, missing } = bundleWindowsDeps(runtimeDir, process.argv.slice(3));
  console.log(`copied: ${copied.join(", ") || "(none)"}`);
  console.log(`dlls: ${listRuntimeDlls(runtimeDir).join(", ")}`);
  if (missing.length) {
    console.error(`missing: ${missing.join(", ")}`);
    process.exit(1);
  }
}
