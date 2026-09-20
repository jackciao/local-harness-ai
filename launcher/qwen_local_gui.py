#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Qwen Local - a small local llama.cpp launcher and diagnostics console."""

from __future__ import annotations

import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk


SCRIPT_DIR = Path(__file__).resolve().parent


def _resolve_paths() -> tuple[Path, Path]:
    """Return the model directory and the launcher resource directory."""
    if SCRIPT_DIR.name == "Resources" and (SCRIPT_DIR.parent / "MacOS").exists():
        return SCRIPT_DIR.parent.parent.parent, SCRIPT_DIR
    if SCRIPT_DIR.name == "MacOS":
        return SCRIPT_DIR.parent.parent.parent, SCRIPT_DIR.parent / "Resources"
    if SCRIPT_DIR.name == "launcher":
        return SCRIPT_DIR.parent, SCRIPT_DIR
    return SCRIPT_DIR, SCRIPT_DIR / "launcher"


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default


ROOT, RES = _resolve_paths()
MODEL = ROOT / "Ternary-Bonsai-2-27B-PTQ1_0.gguf"
LLAMA_SERVER = ROOT / "llama_cpp_bonsai" / "build" / "bin" / "llama-server"
LOG_PATH = Path("/tmp/qwen_local_server.log")

HOST = os.environ.get("QWEN_HOST", "127.0.0.1")
PORT = _env_int("QWEN_PORT", 7890)
CC_SWITCH_PORT = _env_int("QWEN_CC_SWITCH_PORT", 15721)
BASE = f"http://{HOST}:{PORT}"
CC_SWITCH_BASE = f"http://127.0.0.1:{CC_SWITCH_PORT}"

# 32K fixes the observed 18,434-token Claude request while keeping 64K opt-in
# on a 16 GB Mac. The model advertises a 262,144-token training window.
DEFAULT_CTX = _env_int("CTX", 32768)
MIN_CTX = 4096
MAX_CTX = 262144
CONTEXT_OPTIONS = (8192, 16384, 24576, 32768, 65536)

# Deep graphite with a restrained cyan signal color.
BG = "#08111C"
SURFACE = "#0D1927"
SURFACE_2 = "#111F30"
SURFACE_3 = "#15263A"
BORDER = "#23364B"
FG = "#EEF5FF"
MUTED = "#93A6BC"
ACCENT = "#25B7F3"
ACCENT_2 = "#7DD3FC"
OK = "#35D07F"
WARN = "#F5BD4F"
ERR = "#FF6D78"
INPUT_BG = "#091522"

TIMING_RE = re.compile(
    r"(prompt eval time|eval time)\s*=\s*[0-9.]+\s*ms\s*/\s*(\d+)\s+tokens?\s*"
    r"\([^)]*?([0-9.]+)\s+tokens per second\)",
    re.I,
)


def parse_context(value: str | int) -> int:
    """Validate a context value before it reaches llama-server."""
    try:
        context = int(value)
    except (TypeError, ValueError) as error:
        raise ValueError("上下文必须是整数") from error
    if context < MIN_CTX or context > MAX_CTX or context % 1024:
        raise ValueError(f"上下文必须在 {MIN_CTX:,} 到 {MAX_CTX:,} 之间，且为 1024 的倍数")
    return context


def parse_timing_line(line: str) -> list[tuple[str, int, float]]:
    """Extract reliable server timing results; ignore one-token warm-up noise."""
    timings: list[tuple[str, int, float]] = []
    for match in TIMING_RE.finditer(line):
        kind, tokens, tps = match.group(1).lower(), int(match.group(2)), float(match.group(3))
        if tokens > 1 and 0 < tps < 10000:
            timings.append(("prompt" if "prompt" in kind else "generation", tokens, tps))
    return timings


def error_message(error: Exception) -> str:
    """Turn transport/API errors into a specific, useful status line."""
    if isinstance(error, urllib.error.HTTPError):
        body = error.read().decode("utf-8", errors="replace").strip()
        if "exceeds the available context size" in body:
            return "上下文不足：重启服务后选择更大的上下文，或缩短当前会话。"
        if "tools param requires --jinja" in body:
            return "服务未启用 Jinja 工具兼容模式。"
        return f"HTTP {error.code}{': ' + body if body else ''}"
    if isinstance(error, urllib.error.URLError):
        reason = error.reason
        if isinstance(reason, socket.timeout):
            return "连接超时：服务可能正在加载、排队或未运行。"
        if isinstance(reason, ConnectionRefusedError):
            return "连接被拒绝：llama.cpp 服务未运行。"
        return f"连接失败：{reason}"
    if isinstance(error, (TimeoutError, socket.timeout)):
        return "连接超时：服务可能正在加载、排队或未运行。"
    return str(error)


def http_json(method: str, url: str, body: dict | None = None, timeout: float = 8.0):
    data = None if body is None else json.dumps(body).encode("utf-8")
    headers = {"Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


class QwenLauncher(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Qwen Local")
        self.geometry("1120x760")
        self.minsize(920, 640)
        self.configure(bg=BG)

        self._server_proc: subprocess.Popen | None = None
        self._server_log = None
        self._owns_server = False
        self._log_thread: threading.Thread | None = None
        self._stop_log = threading.Event()
        self._ui_q: queue.Queue = queue.Queue()
        self._busy = False
        self._health_in_flight = False
        self._last_slot_sample: tuple[int, int, float] | None = None
        self._requested_context = parse_context(DEFAULT_CTX)
        self._context_ratio = 0.0
        self.last_prompt_tps = 0.0
        self.last_gen_tps = 0.0

        self.context_var = tk.StringVar(value=str(self._requested_context))
        self._build_ui()
        self._set_icon()
        self.after(80, self._poll_ui)
        self.after(300, self._bootstrap)
        self.after(700, self._tick_health)
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    def _set_icon(self):
        icon = RES / "icon.png"
        if icon.exists():
            try:
                self._icon_img = tk.PhotoImage(file=str(icon))
                self.iconphoto(True, self._icon_img)
            except tk.TclError:
                pass

    def _configure_style(self):
        style = ttk.Style(self)
        try:
            style.theme_use("clam")
        except tk.TclError:
            pass
        style.configure(
            "Context.TCombobox",
            fieldbackground=SURFACE_2,
            background=SURFACE_2,
            foreground=FG,
            arrowcolor=FG,
            bordercolor=BORDER,
            lightcolor=SURFACE_2,
            darkcolor=SURFACE_2,
            padding=(8, 5),
        )
        style.map("Context.TCombobox", fieldbackground=[("readonly", SURFACE_2)])

    def _build_ui(self):
        self._configure_style()
        shell = tk.Frame(self, bg=BG)
        shell.pack(fill="both", expand=True, padx=20, pady=18)

        header = tk.Frame(shell, bg=BG)
        header.pack(fill="x", pady=(0, 12))
        mark = tk.Canvas(header, width=34, height=34, bg=BG, highlightthickness=0)
        mark.pack(side="left", padx=(0, 10))
        mark.create_oval(2, 2, 32, 32, fill=ACCENT, outline="")
        mark.create_text(17, 17, text="Q", fill=BG, font=("SF Pro Display", 16, "bold"))
        title = tk.Frame(header, bg=BG)
        title.pack(side="left")
        tk.Label(title, text="Qwen Local", bg=BG, fg=FG, font=("SF Pro Display", 21, "bold")).pack(anchor="w")
        tk.Label(
            title,
            text="llama.cpp 本地推理控制台",
            bg=BG,
            fg=MUTED,
            font=("SF Pro Text", 10),
        ).pack(anchor="w", pady=(1, 0))

        self.status_pill = tk.Frame(header, bg=SURFACE_2, highlightthickness=1, highlightbackground=BORDER)
        self.status_pill.pack(side="right", pady=3)
        self.status_dot = tk.Canvas(self.status_pill, width=14, height=14, bg=SURFACE_2, highlightthickness=0)
        self.status_dot.pack(side="left", padx=(10, 4), pady=7)
        self._dot = self.status_dot.create_oval(3, 3, 11, 11, fill=MUTED, outline="")
        self.status_lbl = tk.Label(
            self.status_pill, text="检查服务中", bg=SURFACE_2, fg=MUTED, font=("SF Pro Text", 10, "bold")
        )
        self.status_lbl.pack(side="left", padx=(0, 10), pady=7)

        control = tk.Frame(shell, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
        control.pack(fill="x", pady=(0, 12))
        control.grid_columnconfigure(1, weight=1)
        control.grid_columnconfigure(4, weight=1)
        tk.Label(control, text="服务", bg=SURFACE, fg=MUTED, font=("SF Pro Text", 10)).grid(
            row=0, column=0, padx=(14, 6), pady=12, sticky="w"
        )
        self.server_summary = tk.Label(
            control, text=f"{BASE} · 等待启动", bg=SURFACE, fg=FG, font=("SF Pro Text", 11, "bold")
        )
        self.server_summary.grid(row=0, column=1, pady=12, sticky="w")
        tk.Label(control, text="上下文", bg=SURFACE, fg=MUTED, font=("SF Pro Text", 10)).grid(
            row=0, column=2, padx=(14, 6), pady=8
        )
        self.context_menu = ttk.Combobox(
            control,
            style="Context.TCombobox",
            width=8,
            state="readonly",
            textvariable=self.context_var,
            values=[str(value) for value in CONTEXT_OPTIONS],
        )
        self.context_menu.grid(row=0, column=3, pady=8)
        tk.Label(control, text="tokens", bg=SURFACE, fg=MUTED, font=("SF Pro Text", 10)).grid(
            row=0, column=4, padx=(6, 12), pady=8, sticky="w"
        )

        self.btn_test = self._button(control, "测试链路", self.test_connection, secondary=True)
        self.btn_test.grid(row=0, column=5, padx=(0, 8), pady=8)
        self.btn_start = self._button(control, "启动模型", self.start_server)
        self.btn_start.grid(row=0, column=6, padx=(0, 8), pady=8)
        self.btn_stop = self._button(control, "停止", self.stop_server, secondary=True)
        self.btn_stop.grid(row=0, column=7, padx=(0, 12), pady=8)
        self.btn_stop.configure(state="disabled")

        cards = tk.Frame(shell, bg=BG)
        cards.pack(fill="x", pady=(0, 12))
        for column in range(4):
            cards.grid_columnconfigure(column, weight=1, uniform="metrics")
        self.gen_card = self._metric_card(cards, "输出速度", "—", "tok/s · 等待生成", ACCENT)
        self.gen_card["frame"].grid(row=0, column=0, padx=(0, 6), sticky="nsew")
        self.prompt_card = self._metric_card(cards, "提示词吞吐", "—", "tok/s · 服务器计时", ACCENT_2)
        self.prompt_card["frame"].grid(row=0, column=1, padx=6, sticky="nsew")
        self.context_card = self._metric_card(cards, "上下文使用", "—", "启动后显示", WARN)
        self.context_card["frame"].grid(row=0, column=2, padx=6, sticky="nsew")
        self.ttft_card = self._metric_card(cards, "首 token", "—", "TTFT", OK)
        self.ttft_card["frame"].grid(row=0, column=3, padx=(6, 0), sticky="nsew")

        health = tk.Frame(shell, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
        health.pack(fill="x", pady=(0, 12))
        health.grid_columnconfigure(1, weight=1)
        health.grid_columnconfigure(3, weight=1)
        tk.Label(health, text="兼容性", bg=SURFACE, fg=MUTED, font=("SF Pro Text", 10)).grid(
            row=0, column=0, padx=(14, 8), pady=(11, 2), sticky="w"
        )
        self.compat_lbl = tk.Label(health, text="正在检查 llama.cpp 与 CC Switch", bg=SURFACE, fg=FG, font=("SF Pro Text", 11, "bold"))
        self.compat_lbl.grid(row=0, column=1, pady=(11, 2), sticky="w")
        self.copy_endpoint = self._button(health, "复制 OpenAI 地址", self.copy_endpoint, secondary=True)
        self.copy_endpoint.grid(row=0, column=2, rowspan=2, padx=(8, 12), pady=10)
        self.context_progress = tk.Canvas(health, height=6, bg=SURFACE, highlightthickness=0)
        self.context_progress.grid(row=1, column=0, columnspan=2, padx=14, pady=(0, 11), sticky="ew")
        self.context_progress.bind("<Configure>", lambda _event: self._draw_context_progress())

        content = tk.Frame(shell, bg=BG)
        content.pack(fill="both", expand=True)
        content.grid_columnconfigure(0, weight=4)
        content.grid_columnconfigure(1, weight=6)
        content.grid_rowconfigure(0, weight=1)

        activity_frame = tk.Frame(content, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
        activity_frame.grid(row=0, column=0, padx=(0, 6), sticky="nsew")
        self._panel_title(activity_frame, "活动与诊断", "服务可达、协议与错误原因")
        self.activity = scrolledtext.ScrolledText(
            activity_frame,
            wrap="word",
            bg=SURFACE,
            fg=MUTED,
            insertbackground=FG,
            relief="flat",
            font=("SF Mono", 10),
            padx=13,
            pady=7,
            highlightthickness=0,
        )
        self.activity.pack(fill="both", expand=True, padx=1, pady=(0, 1))
        self.activity.tag_configure("ok", foreground=OK)
        self.activity.tag_configure("warn", foreground=WARN)
        self.activity.tag_configure("error", foreground=ERR)
        self.activity.tag_configure("info", foreground=MUTED)
        self.activity.configure(state="disabled")

        chat_frame = tk.Frame(content, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
        chat_frame.grid(row=0, column=1, padx=(6, 0), sticky="nsew")
        self._panel_title(chat_frame, "本地对话", "⌘↵ 发送 · 输出速度在生成时实时更新")
        self.chat = scrolledtext.ScrolledText(
            chat_frame,
            wrap="word",
            bg=SURFACE,
            fg=FG,
            insertbackground=FG,
            relief="flat",
            font=("SF Pro Text", 12),
            padx=14,
            pady=9,
            highlightthickness=0,
        )
        self.chat.pack(fill="both", expand=True, padx=1)
        self.chat.tag_configure("user", foreground=ACCENT_2, font=("SF Pro Text", 12, "bold"))
        self.chat.tag_configure("assistant", foreground=FG)
        self.chat.tag_configure("meta", foreground=MUTED, font=("SF Mono", 10))
        self.chat.tag_configure("sys", foreground=MUTED)
        self.chat.configure(state="disabled")

        composer = tk.Frame(chat_frame, bg=SURFACE)
        composer.pack(fill="x", padx=10, pady=10)
        self.input = tk.Text(
            composer,
            height=3,
            wrap="word",
            bg=INPUT_BG,
            fg=FG,
            insertbackground=FG,
            relief="flat",
            font=("SF Pro Text", 12),
            padx=10,
            pady=8,
            highlightthickness=1,
            highlightbackground=BORDER,
            highlightcolor=ACCENT,
        )
        self.input.pack(side="left", fill="both", expand=True)
        self.input.bind("<Command-Return>", lambda _event: self.send_message())
        self.btn_send = self._button(composer, "发送\n⌘↵", self.send_message)
        self.btn_send.pack(side="left", fill="y", padx=(8, 0))
        self.btn_send.configure(state="disabled")

    def _button(self, parent, text: str, command, secondary: bool = False):
        return tk.Button(
            parent,
            text=text,
            command=command,
            bg=SURFACE_3 if secondary else ACCENT,
            fg=FG if secondary else BG,
            activebackground="#1D344B" if secondary else ACCENT_2,
            activeforeground=FG if secondary else BG,
            disabledforeground="#60758C",
            relief="flat",
            bd=0,
            padx=12,
            pady=7,
            font=("SF Pro Text", 10, "bold"),
            cursor="hand2",
        )

    def _metric_card(self, parent, title: str, value: str, foot: str, color: str):
        frame = tk.Frame(parent, bg=SURFACE, highlightthickness=1, highlightbackground=BORDER)
        tk.Label(frame, text=title, bg=SURFACE, fg=MUTED, font=("SF Pro Text", 10)).pack(
            anchor="w", padx=14, pady=(12, 0)
        )
        value_label = tk.Label(frame, text=value, bg=SURFACE, fg=color, font=("SF Mono", 23, "bold"))
        value_label.pack(anchor="w", padx=14, pady=(6, 0))
        foot_label = tk.Label(frame, text=foot, bg=SURFACE, fg=MUTED, font=("SF Pro Text", 9))
        foot_label.pack(anchor="w", padx=14, pady=(2, 12))
        return {"frame": frame, "value": value_label, "foot": foot_label, "color": color}

    def _panel_title(self, parent, title: str, subtitle: str):
        heading = tk.Frame(parent, bg=SURFACE)
        heading.pack(fill="x", padx=14, pady=(12, 8))
        tk.Label(heading, text=title, bg=SURFACE, fg=FG, font=("SF Pro Text", 12, "bold")).pack(anchor="w")
        tk.Label(heading, text=subtitle, bg=SURFACE, fg=MUTED, font=("SF Pro Text", 9)).pack(anchor="w", pady=(2, 0))

    def _bootstrap(self):
        missing = []
        if not LLAMA_SERVER.exists():
            missing.append(f"llama-server 不存在：{LLAMA_SERVER}")
        if not MODEL.exists():
            missing.append(f"模型不存在：{MODEL}")
        if missing:
            message = "\n\n".join(missing)
            self._append_chat(f"[配置错误]\n{message}\n", "sys")
            self._activity_log(message, "error")
            messagebox.showerror("启动检查失败", message)
            return
        self._append_chat("启动模型后即可在这里测试本地推理。\n", "sys")
        self._activity_log(f"就绪 · 模型 {MODEL.name}", "ok")
        self._activity_log("默认上下文 32K；可在启动前选择 8K-64K。", "info")
        if "--autostart" in sys.argv or os.environ.get("QWEN_AUTOSTART") == "1":
            self.after(350, self.start_server)

    def _server_command(self, context: int) -> list[str]:
        return [
            str(LLAMA_SERVER),
            "-m",
            str(MODEL),
            "-ngl",
            "99",
            "-c",
            str(context),
            "-fa",
            "on",
            "-ctk",
            "q4_0",
            "-ctv",
            "q4_0",
            "-t",
            "4",
            "-tb",
            "4",
            "-b",
            "512",
            "-ub",
            "128",
            "--mmap",
            "--fit",
            "off",
            "-np",
            "1",
            "--host",
            HOST,
            "--port",
            str(PORT),
            "-a",
            "qwen",
            "--jinja",
            "--reasoning",
            "auto",
            "--temp",
            "1.0",
            "--top-k",
            "20",
            "--top-p",
            "0.95",
            "--spec-type",
            "ngram-mod",
            "--spec-draft-n-max",
            "8",
        ]

    def _server_is_ready(self) -> bool:
        try:
            response = http_json("GET", f"{BASE}/health", timeout=0.5)
            return response.get("status") == "ok"
        except Exception:
            return False

    def start_server(self):
        if self._server_proc and self._server_proc.poll() is None:
            return
        if not LLAMA_SERVER.exists() or not MODEL.exists():
            messagebox.showerror("缺少组件", "找不到 llama-server 或模型文件，请查看活动面板。")
            return
        try:
            context = parse_context(self.context_var.get())
        except ValueError as error:
            messagebox.showerror("上下文无效", str(error))
            return

        if self._server_is_ready():
            self._owns_server = False
            self._set_status("已连接外部服务", OK)
            self.server_summary.configure(text=f"{BASE} · 外部服务运行中")
            self.btn_start.configure(state="disabled")
            self.btn_stop.configure(state="disabled")
            self.btn_send.configure(state="normal")
            self.context_menu.configure(state="disabled")
            self._activity_log("发现已有 llama.cpp 服务；不会终止外部进程。", "ok")
            return

        self._requested_context = context
        self._stop_log.set()
        LOG_PATH.write_text("", encoding="utf-8")
        try:
            self._server_log = open(LOG_PATH, "a", encoding="utf-8", buffering=1)
            self._server_proc = subprocess.Popen(
                self._server_command(context),
                cwd=str(ROOT),
                stdout=self._server_log,
                stderr=subprocess.STDOUT,
                start_new_session=True,
            )
        except Exception as error:
            if self._server_log:
                self._server_log.close()
                self._server_log = None
            messagebox.showerror("启动失败", error_message(error))
            return

        self._owns_server = True
        self._stop_log.clear()
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.context_menu.configure(state="disabled")
        self._set_status("正在加载模型", ACCENT)
        self.server_summary.configure(text=f"{BASE} · 正在加载 {context // 1024}K 上下文")
        self._activity_log(f"启动 llama.cpp · context={context:,} · 不会杀死其他实例。", "info")
        self._log_thread = threading.Thread(target=self._follow_log, daemon=True)
        self._log_thread.start()
        threading.Thread(target=self._wait_ready, daemon=True).start()

    def _wait_ready(self):
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self._server_proc and self._server_proc.poll() is not None:
                self._ui_q.put(("launch_failed", self._server_proc.returncode))
                return
            try:
                if http_json("GET", f"{BASE}/health", timeout=1.2).get("status") == "ok":
                    self._ui_q.put(("server_ready",))
                    return
            except Exception:
                time.sleep(0.8)
        self._ui_q.put(("launch_timeout",))

    def _follow_log(self):
        while not LOG_PATH.exists() and not self._stop_log.is_set():
            time.sleep(0.1)
        try:
            with open(LOG_PATH, "r", encoding="utf-8", errors="replace") as log:
                log.seek(0, os.SEEK_END)
                while not self._stop_log.is_set():
                    line = log.readline()
                    if not line:
                        time.sleep(0.12)
                        continue
                    for kind, _tokens, tps in parse_timing_line(line):
                        self._ui_q.put(("speed_prompt" if kind == "prompt" else "speed_gen", tps, "服务器计时"))
                    lowered = line.lower()
                    if "error:" in lowered or "failed" in lowered:
                        clean = re.sub(r"^.*?(?:error:|failed)\s*", "", line, flags=re.I).strip()
                        if clean:
                            self._ui_q.put(("activity", f"服务：{clean[:180]}", "error"))
        except OSError:
            pass

    def stop_server(self):
        if not self._owns_server:
            self._activity_log("未停止外部服务；它不由此启动器管理。", "warn")
            return
        self._stop_log.set()
        proc = self._server_proc
        if proc and proc.poll() is None:
            try:
                os.killpg(proc.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except OSError:
                proc.terminate()
            try:
                proc.wait(timeout=6)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except OSError:
                    pass
        self._server_proc = None
        self._owns_server = False
        if self._server_log:
            self._server_log.close()
            self._server_log = None
        self.btn_start.configure(state="normal")
        self.btn_stop.configure(state="disabled")
        self.btn_send.configure(state="disabled")
        self.context_menu.configure(state="readonly")
        self._set_status("已停止", MUTED)
        self.server_summary.configure(text=f"{BASE} · 已停止")
        self._activity_log("已停止本启动器创建的 llama.cpp 进程。", "info")

    def test_connection(self):
        if str(self.btn_test.cget("state")) == "disabled":
            return
        self.btn_test.configure(state="disabled")
        self._activity_log("正在测试服务、Anthropic 兼容端点与 CC Switch…", "info")
        threading.Thread(target=self._connection_worker, daemon=True).start()

    def _connection_worker(self):
        try:
            health = http_json("GET", f"{BASE}/health", timeout=3)
            models = http_json("GET", f"{BASE}/v1/models", timeout=3)
            model = ((models.get("data") or [{}])[0]).get("meta") or {}
            count = http_json(
                "POST",
                f"{BASE}/v1/messages/count_tokens",
                {
                    "model": "qwen",
                    "messages": [{"role": "user", "content": "ping"}],
                    "tools": [
                        {
                            "name": "ping",
                            "description": "Return pong.",
                            "input_schema": {"type": "object", "properties": {}},
                        }
                    ],
                },
                timeout=8,
            )
            cc_status = None
            try:
                cc_status = http_json("GET", f"{CC_SWITCH_BASE}/health", timeout=2).get("status")
            except Exception:
                pass
            self._ui_q.put(("diagnostic_ok", health, model, count, cc_status))
        except Exception as error:
            self._ui_q.put(("diagnostic_error", error_message(error)))
        finally:
            self._ui_q.put(("diagnostic_done",))

    def copy_endpoint(self):
        endpoint = f"{BASE}/v1"
        self.clipboard_clear()
        self.clipboard_append(endpoint)
        self._activity_log(f"已复制 OpenAI 地址：{endpoint}", "ok")

    def send_message(self):
        if self._busy:
            return
        text = self.input.get("1.0", "end").strip()
        if not text:
            return
        self.input.delete("1.0", "end")
        self._append_chat(f"\n你：{text}\n", "user")
        self._append_chat("助手：", "assistant")
        self._busy = True
        self._last_slot_sample = None
        self.btn_send.configure(state="disabled")
        threading.Thread(target=self._chat_worker, args=(text,), daemon=True).start()

    def _chat_worker(self, text: str):
        body = {
            "model": "qwen",
            "messages": [{"role": "user", "content": text}],
            "temperature": 0.7,
            "top_k": 20,
            "top_p": 0.95,
            "max_tokens": 512,
        }
        started = time.monotonic()
        first_token_at: float | None = None
        completion_tokens = 0
        try:
            request = urllib.request.Request(
                f"{BASE}/v1/chat/completions",
                data=json.dumps({**body, "stream": True}).encode("utf-8"),
                headers={"Content-Type": "application/json", "Accept": "text/event-stream"},
                method="POST",
            )
            with urllib.request.urlopen(request, timeout=600) as response:
                for raw in response:
                    line = raw.decode("utf-8", errors="replace").strip()
                    if not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    usage = chunk.get("usage") or {}
                    if usage.get("completion_tokens") is not None:
                        completion_tokens = int(usage["completion_tokens"])
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    piece = (choices[0].get("delta") or {}).get("content") or ""
                    if piece:
                        if first_token_at is None:
                            first_token_at = time.monotonic()
                            self._ui_q.put(("ttft", first_token_at - started))
                        self._ui_q.put(("stream", piece))
            elapsed = time.monotonic() - started
            if completion_tokens and first_token_at is not None:
                generation_time = max(time.monotonic() - first_token_at, 1e-6)
                self._ui_q.put(("speed_gen", completion_tokens / generation_time, "流式 usage"))
            self._ui_q.put(("chat", f"\n—— 完成 · {elapsed:.1f}s\n", "meta"))
        except Exception as error:
            self._ui_q.put(("chat", f"\n[错误] {error_message(error)}\n", "sys"))
            self._ui_q.put(("activity", f"生成失败：{error_message(error)}", "error"))
        finally:
            self._ui_q.put(("busy_done",))

    def _tick_health(self):
        if not self._health_in_flight:
            self._health_in_flight = True
            threading.Thread(target=self._health_worker, daemon=True).start()
        self.after(1300, self._tick_health)

    def _health_worker(self):
        try:
            health = http_json("GET", f"{BASE}/health", timeout=0.9)
            props = http_json("GET", f"{BASE}/props", timeout=1.2)
            slots = http_json("GET", f"{BASE}/slots", timeout=1.2)
            cc_alive = False
            try:
                cc_alive = http_json("GET", f"{CC_SWITCH_BASE}/health", timeout=0.6).get("status") == "healthy"
            except Exception:
                pass
            self._ui_q.put(("health", health, props, slots, cc_alive))
        except Exception as error:
            self._ui_q.put(("health_error", error_message(error)))
        finally:
            self._ui_q.put(("health_done",))

    def _apply_health(self, health: dict, props: dict, slots: list, cc_alive: bool):
        if health.get("status") != "ok":
            return
        runtime_context = int((props.get("default_generation_settings") or {}).get("n_ctx") or 0)
        model_path = props.get("model_path", "")
        model_name = Path(model_path).name if model_path else "qwen"
        short_model = model_name.replace("Ternary-Bonsai-2-27B-", "Bonsai 2 · ")
        self._set_status("服务运行中", OK)
        self.server_summary.configure(text=f"{BASE} · {short_model[:52]}")
        self.btn_send.configure(state="normal" if not self._busy else "disabled")
        self.context_menu.configure(state="disabled")
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal" if self._owns_server else "disabled")
        self._update_compatibility(runtime_context, cc_alive)
        self._update_slot_metrics(slots, runtime_context)

    def _update_compatibility(self, runtime_context: int, cc_alive: bool):
        pieces = ["Anthropic 端点可用"]
        if cc_alive:
            pieces.append("CC Switch 在线")
        else:
            pieces.append("CC Switch 未检测到")
        if runtime_context:
            pieces.append(f"运行时 {runtime_context // 1024}K")
        self.compat_lbl.configure(text=" · ".join(pieces), fg=OK if cc_alive else WARN)

    def _update_slot_metrics(self, slots: list, runtime_context: int):
        slot = slots[0] if slots else {}
        slot_context = int(slot.get("n_ctx") or runtime_context or self._requested_context)
        used = int(slot.get("n_prompt_tokens") or slot.get("n_prompt_tokens_processed") or 0)
        self._context_ratio = min(1.0, used / slot_context) if slot_context else 0.0
        color = ERR if self._context_ratio >= 0.9 else WARN if self._context_ratio >= 0.75 else self.context_card["color"]
        self.context_card["value"].configure(
            text=f"{used / 1024:.1f}K / {slot_context // 1024}K" if slot_context else "—", fg=color
        )
        self.context_card["foot"].configure(text=f"剩余 {max(slot_context - used, 0):,} tokens")
        self._draw_context_progress()

        if not self._busy or not slot.get("is_processing"):
            return
        task_id = int(slot.get("id_task") or -1)
        decoded = 0
        next_token = slot.get("next_token") or []
        if next_token:
            decoded = int((next_token[0] or {}).get("n_decoded") or 0)
        now = time.monotonic()
        if self._last_slot_sample and self._last_slot_sample[0] == task_id:
            delta = decoded - self._last_slot_sample[1]
            elapsed = now - self._last_slot_sample[2]
            if delta > 0 and elapsed > 0:
                self._set_speed(generation=delta / elapsed, source="实时 slot")
        self._last_slot_sample = (task_id, decoded, now)

    def _draw_context_progress(self):
        canvas = self.context_progress
        width = canvas.winfo_width()
        if width <= 1:
            return
        canvas.delete("all")
        canvas.create_rectangle(0, 0, width, 6, fill=SURFACE_3, outline="")
        color = ERR if self._context_ratio >= 0.9 else WARN if self._context_ratio >= 0.75 else ACCENT
        canvas.create_rectangle(0, 0, max(2, int(width * self._context_ratio)), 6, fill=color, outline="")

    def _set_speed(self, generation: float | None = None, prompt: float | None = None, source: str = "服务器计时"):
        if generation is not None and generation > 0:
            self.last_gen_tps = generation
            self.gen_card["value"].configure(text=f"{generation:.2f}")
            self.gen_card["foot"].configure(text=f"tok/s · {source}")
        if prompt is not None and prompt > 0:
            self.last_prompt_tps = prompt
            self.prompt_card["value"].configure(text=f"{prompt:.2f}")
            self.prompt_card["foot"].configure(text="tok/s · 服务器计时")

    def _set_status(self, text: str, color: str):
        self.status_lbl.configure(text=text, fg=color)
        self.status_dot.itemconfigure(self._dot, fill=color)

    def _append_chat(self, text: str, tag: str = "assistant"):
        self.chat.configure(state="normal")
        self.chat.insert("end", text, tag)
        self.chat.see("end")
        self.chat.configure(state="disabled")

    def _activity_log(self, text: str, tag: str = "info"):
        stamp = time.strftime("%H:%M:%S")
        self.activity.configure(state="normal")
        self.activity.insert("end", f"{stamp}  {text}\n", tag)
        self.activity.see("end")
        self.activity.configure(state="disabled")

    def _poll_ui(self):
        try:
            while True:
                item = self._ui_q.get_nowait()
                kind = item[0]
                if kind == "server_ready":
                    self._set_status("服务运行中", OK)
                    self._append_chat("\n系统：模型已就绪，可以开始对话。\n", "sys")
                    self._activity_log("模型加载完成。", "ok")
                elif kind == "launch_failed":
                    self._set_status("启动失败", ERR)
                    self.btn_start.configure(state="normal")
                    self.btn_stop.configure(state="disabled")
                    self.context_menu.configure(state="readonly")
                    self._activity_log(f"llama.cpp 异常退出（code {item[1]}）。", "error")
                elif kind == "launch_timeout":
                    self._set_status("启动超时", ERR)
                    self.btn_start.configure(state="normal")
                    self._activity_log("服务 180 秒内未就绪；请查看活动面板。", "error")
                elif kind == "speed_gen":
                    self._set_speed(generation=float(item[1]), source=item[2])
                elif kind == "speed_prompt":
                    self._set_speed(prompt=float(item[1]))
                elif kind == "ttft":
                    self.ttft_card["value"].configure(text=f"{item[1] * 1000:.0f} ms")
                    self.ttft_card["foot"].configure(text="本次请求首 token")
                elif kind == "stream":
                    self._append_chat(item[1], "assistant")
                elif kind == "chat":
                    self._append_chat(item[1], item[2])
                elif kind == "activity":
                    self._activity_log(item[1], item[2])
                elif kind == "busy_done":
                    self._busy = False
                    self.btn_send.configure(state="normal")
                elif kind == "health":
                    self._apply_health(item[1], item[2], item[3], item[4])
                elif kind == "health_error":
                    if self._owns_server and self._server_proc and self._server_proc.poll() is not None:
                        self._set_status("服务意外退出", ERR)
                        self.btn_start.configure(state="normal")
                        self.btn_stop.configure(state="disabled")
                        self.context_menu.configure(state="readonly")
                    elif not self._owns_server:
                        self._set_status("服务未运行", MUTED)
                        self.server_summary.configure(text=f"{BASE} · 等待启动")
                        self.btn_start.configure(state="normal")
                        self.btn_stop.configure(state="disabled")
                        self.btn_send.configure(state="disabled")
                        self.context_menu.configure(state="readonly")
                elif kind == "health_done":
                    self._health_in_flight = False
                elif kind == "diagnostic_ok":
                    _health, model, count, cc_status = item[1:]
                    context = int(model.get("n_ctx") or 0)
                    cc_text = "CC Switch 在线" if cc_status == "healthy" else "CC Switch 未检测到"
                    self._activity_log(
                        f"链路通过 · Anthropic count_tokens={count.get('input_tokens', '—')} · {cc_text} · n_ctx={context:,}",
                        "ok",
                    )
                    self.compat_lbl.configure(text=f"Anthropic 协议通过 · {cc_text} · 运行时 {context // 1024}K", fg=OK)
                elif kind == "diagnostic_error":
                    self._activity_log(f"链路失败：{item[1]}", "error")
                elif kind == "diagnostic_done":
                    self.btn_test.configure(state="normal")
        except queue.Empty:
            pass
        self.after(80, self._poll_ui)

    def _on_close(self):
        if self._owns_server:
            question = "退出并停止此启动器创建的本地模型服务？"
        else:
            question = "退出启动器？外部 llama.cpp 服务不会被停止。"
        if messagebox.askyesno("退出 Qwen Local", question):
            if self._owns_server:
                self.stop_server()
            self.destroy()


def main():
    QwenLauncher().mainloop()


if __name__ == "__main__":
    main()
