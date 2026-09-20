import AppKit
import Combine
import Darwin
import Foundation
import Security
import UniformTypeIdentifiers

enum ServicePhase: Equatable {
    case offline
    case starting
    case online
    case external
    case failed(String)
}

struct ConsoleLine: Identifiable, Equatable {
    let id = UUID()
    let date: Date
    let text: String
    let kind: Kind

    enum Kind { case info, success, warning, error }
}

struct ChatMessage: Identifiable, Equatable {
    let id = UUID()
    let role: Role
    var content: String

    enum Role { case user, assistant, system }
}

struct AgentBlock: Identifiable, Equatable, Codable {
    let id: String
    var kind: Kind
    var title: String
    var text: String
    var done: Bool
    var imagePaths: [String]
    var filePaths: [String]

    enum Kind: String, Codable { case user, thinking, reply, tool, status, error }

    init(id: String, kind: Kind, title: String, text: String, done: Bool, imagePaths: [String] = [], filePaths: [String] = []) {
        self.id = id
        self.kind = kind
        self.title = title
        self.text = text
        self.done = done
        self.imagePaths = imagePaths
        self.filePaths = filePaths
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decode(Kind.self, forKey: .kind)
        title = try c.decode(String.self, forKey: .title)
        text = try c.decode(String.self, forKey: .text)
        done = try c.decode(Bool.self, forKey: .done)
        imagePaths = try c.decodeIfPresent([String].self, forKey: .imagePaths) ?? []
        filePaths = try c.decodeIfPresent([String].self, forKey: .filePaths) ?? []
    }
}

enum ToolPane: String, CaseIterable, Hashable {
    case files, browser, terminal
    var title: String {
        switch self {
        case .files: return "文件"
        case .browser: return "浏览器"
        case .terminal: return "终端"
        }
    }
    var symbol: String {
        switch self {
        case .files: return "folder"
        case .browser: return "globe"
        case .terminal: return "terminal"
        }
    }
}

struct AgentSession: Identifiable, Equatable, Codable {
    var id: String
    var title: String
    var customTitle: String? = nil
    var workspace: String
    var allowWrites: Bool
    var blocks: [AgentBlock]
    var updatedAt: Double
}

struct SettingsDraft: Equatable {
    var inferenceSource: InferenceSource = .local
    var localModelPath = ""
    var localMMProjPath = ""
    var localChatTemplate = ""
    var localCompatibilityMode = false
    var cloudProfileID = ""
    var cloudProfiles: [CloudProfile] = []
    var cloudPreset: CloudPreset = .openai
    var cloudBaseURL = CloudPreset.openai.baseURL
    var cloudModelId = CloudPreset.openai.defaultModel
    var cloudApiKey = ""
    var selectedContextSize = 8_192
    var kvType = "q4_0"
    var ngramEnabled = false
    var reasoningEnabled = false
    var customContextText = ""

    static let contextPresets: [(label: String, size: Int)] = [
        ("4K", 4_096),
        ("8K", 8_192),
        ("16K", 16_384),
        ("24K", 24_576),
        ("32K", 32_768),
        ("64K", 65_536),
        ("100K", 102_400),
    ]

    var contextTag: Int {
        Self.contextPresets.contains(where: { $0.size == selectedContextSize }) ? selectedContextSize : -1
    }
}

enum InferenceSource: String, CaseIterable, Identifiable {
    case local = "本地模型"
    case cloud = "云 API"
    var id: String { rawValue }
}

enum CloudPreset: String, CaseIterable, Identifiable, Codable {
    case openai = "OpenAI"
    case anthropic = "Anthropic"
    case deepseek = "DeepSeek"
    case openrouter = "OpenRouter"
    case custom = "自定义"
    var id: String { rawValue }
    var providerId: String { self == .anthropic ? "anthropic" : "openai-compatible" }
    var baseURL: String {
        switch self {
        case .openai: return "https://api.openai.com/v1"
        case .anthropic: return "https://api.anthropic.com"
        case .deepseek: return "https://api.deepseek.com/v1"
        case .openrouter: return "https://openrouter.ai/api/v1"
        case .custom: return ""
        }
    }
    var defaultModel: String {
        switch self {
        case .openai: return "gpt-4o"
        case .anthropic: return "claude-sonnet-4-5"
        case .deepseek: return "deepseek-chat"
        case .openrouter: return "anthropic/claude-sonnet-4.5"
        case .custom: return ""
        }
    }
}

struct CloudProfile: Identifiable, Codable, Equatable {
    var id = UUID().uuidString
    var preset: CloudPreset
    var baseURL: String
    var modelId: String

    init(preset: CloudPreset, baseURL: String? = nil, modelId: String? = nil) {
        self.preset = preset
        self.baseURL = baseURL ?? preset.baseURL
        self.modelId = modelId ?? preset.defaultModel
    }

    var label: String {
        "\(preset.rawValue) · \(modelId.isEmpty ? "未设置模型" : modelId)"
    }
}

@MainActor
final class LauncherStore: ObservableObject {
    @Published var phase: ServicePhase = .offline
    @Published var modelName = "Ternary Bonsai 2 · 27B PTQ1_0"
    @Published var contextSize = 8_192
    @Published var selectedContextSize = 8_192
    @Published var contextUsed = 0
    @Published var generationTPS = 0.0
    @Published var promptTPS = 0.0
    @Published var ttftMilliseconds = 0.0
    @Published var speedHistory = Array(repeating: 0.0, count: 28)
    @Published var promptHistory = Array(repeating: 0.0, count: 28)
    @Published var ccSwitchConnected = false
    @Published var isGenerating = false
    @Published var logs: [ConsoleLine] = []
    @Published var messages: [ChatMessage] = [
        ChatMessage(role: .system, content: "local-harness-ai 已就绪。启动模型后可在这里验证推理速度。")
    ]
    @Published var chatInput = ""
    @Published var kvType = "q4_0"
    @Published var ngramEnabled = false
    @Published var reasoningEnabled = false
    @Published var ngramAcceptance: Double?
    @Published var lastError = ""
    @Published var agentWorkspace = ""
    @Published var agentDraft = ""
    @Published var agentAllowWrites = true
    @Published var agentIsRunning = false
    @Published var draftImages: [String] = []
    @Published var draftFiles: [String] = []
    @Published var openToolPane: ToolPane?
    @Published var agentBlocks: [AgentBlock] = []
    @Published var sessions: [AgentSession] = []
    @Published var currentSessionId = ""
    @Published var draft = SettingsDraft()
    @Published var routeTestRunning = false
    @Published var routeTestLines: [String] = []
    @Published var inferenceSource: InferenceSource = .local
    @Published var localModelPath = ""
    @Published var localMMProjPath = ""
    @Published var localChatTemplate = ""
    @Published var localCompatibilityMode = false
    @Published var cloudProfiles: [CloudProfile] = []
    @Published var cloudProfileID = ""
    @Published var cloudPreset: CloudPreset = .openai
    @Published var cloudBaseURL = CloudPreset.openai.baseURL
    @Published var cloudModelId = CloudPreset.openai.defaultModel
    @Published var cloudApiKey = ""

    let endpoint = "http://127.0.0.1:7890"
    let proxyEndpoint = "http://127.0.0.1:15721"

    private var process: Process?
    private var ownsProcess = false
    private var adoptedPID: pid_t?
    private var isLaunching = false
    private var bootstrapped = false
    private var monitorTask: Task<Void, Never>?
    private var logBuffer = ""
    private var logHandle: FileHandle?
    private var launchDate: Date?
    private var lastSlotSample: (task: Int, decoded: Int, date: Date)?
    private var agentProcess: Process?
    private var agentStdin: FileHandle?
    private var agentBoundKey = ""
    private var agentBuffer = ""
    private var streamAlias: [String: String] = [:]

    var isOnline: Bool {
        phase == .online || phase == .external
    }

    var canControlServer: Bool {
        ownsProcess || adoptedPID != nil
    }

    var statusTitle: String {
        switch phase {
        case .offline: return "离线"
        case .starting: return "正在加载模型"
        case .online: return "在线"
        case .external: return "在线 · 外部服务"
        case .failed: return "启动失败"
        }
    }

    var uptime: String {
        guard let launchDate else { return "—" }
        let seconds = Int(Date().timeIntervalSince(launchDate))
        return String(format: "%02d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60)
    }

    var memoryText: String {
        String(format: "%.0f GB", Double(ProcessInfo.processInfo.physicalMemory) / 1_073_741_824)
    }

    var agentStatus: String {
        agentIsRunning ? "运行中" : "待命"
    }

    var usesCloud: Bool { inferenceSource == .cloud }

    private var localRuntimeContextSize: Int {
        localCompatibilityMode ? min(selectedContextSize, 4_096) : selectedContextSize
    }

    var localModelFileName: String {
        let name = URL(fileURLWithPath: localModelPath).lastPathComponent
        return name.isEmpty ? "未选择模型" : name
    }

    var displayModelName: String {
        usesCloud ? (cloudModelId.isEmpty ? cloudPreset.rawValue : cloudModelId) : localModelFileName
    }

    var agentEndpointLabel: String {
        usesCloud ? (cloudBaseURL.isEmpty ? cloudPreset.rawValue : cloudBaseURL) : "127.0.0.1:7890/v1"
    }

    var agentCanSend: Bool {
        let hasText = !agentDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (hasText || !draftImages.isEmpty || !draftFiles.isEmpty) && (usesCloud || isOnline)
    }

    var modelSupportsVision: Bool {
        if usesCloud {
            let id = cloudModelId.lowercased()
            return ["vl", "vision", "gpt-4", "gpt-5", "claude", "gemini", "grok"].contains(where: { id.contains($0) })
        }
        if !localMMProjPath.isEmpty { return true }
        let name = localModelFileName.lowercased()
        return name.contains("vl") || name.contains("vision") || name.contains("mmproj")
    }

    var sessionsByProject: [(path: String, name: String, items: [AgentSession])] {
        let groups = Dictionary(grouping: sessions, by: \.workspace)
        return groups.keys.sorted { URL(fileURLWithPath: $0).lastPathComponent.localizedCompare(URL(fileURLWithPath: $1).lastPathComponent) == .orderedAscending }
            .map { path in
                let items = (groups[path] ?? []).sorted { $0.updatedAt > $1.updatedAt }
                return (path, URL(fileURLWithPath: path).lastPathComponent, items)
            }
    }

    var savedLocalAvailable: Bool { localModelError(localModelPath) == nil }
    var savedCloudAvailable: Bool { !cloudApiKey.isEmpty && !cloudModelId.isEmpty }

    func cloudProfileAvailable(_ profile: CloudProfile) -> Bool {
        !profile.modelId.isEmpty && !KeychainStore.get(key: cloudKey(profile.id)).isEmpty
    }

    func displayTitle(_ session: AgentSession) -> String {
        let name = (session.customTitle ?? session.title).trimmingCharacters(in: .whitespacesAndNewlines)
        return name.isEmpty ? "新会话" : name
    }

    var currentDisplayTitle: String {
        sessions.first(where: { $0.id == currentSessionId }).map(displayTitle) ?? "开发代理"
    }

    func renameSession(_ id: String, to name: String) {
        guard let index = sessions.firstIndex(where: { $0.id == id }) else { return }
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            sessions[index].customTitle = nil
        } else {
            sessions[index].customTitle = trimmed
            sessions[index].title = trimmed
        }
        persistSessions()
    }

    var settingsDirty: Bool {
        draft.inferenceSource != inferenceSource
            || draft.localModelPath != localModelPath
            || draft.localMMProjPath != localMMProjPath
            || draft.localChatTemplate != localChatTemplate
            || draft.localCompatibilityMode != localCompatibilityMode
            || draft.cloudProfileID != cloudProfileID
            || draft.cloudProfiles != cloudProfiles
            || draft.cloudPreset != cloudPreset
            || draft.cloudBaseURL != cloudBaseURL
            || draft.cloudModelId != cloudModelId
            || draft.cloudApiKey != cloudApiKey
            || draft.selectedContextSize != selectedContextSize
            || draft.kvType != kvType
            || draft.ngramEnabled != ngramEnabled
            || draft.reasoningEnabled != reasoningEnabled
            || draft.customContextText != String(selectedContextSize)
    }

    func bootstrap() {
        guard !bootstrapped else { return }
        bootstrapped = true
        loadSettings()
        loadSessions()
        reloadDraft()
        appendLog("原生 SwiftUI 监控台已启动", .success)
        appendLog("高速模式：q4_0 KV · Flash Attention · N-gram 默认关闭", .info)
        monitorTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshStatus()
                try? await Task.sleep(for: .seconds(self?.isGenerating == true ? 2 : 5))
            }
        }
        Task { await reconcileServerOnLaunch() }
    }

    func startServer() {
        guard !isLaunching, process?.isRunning != true else { return }
        if let error = localModelError(localModelPath) {
            phase = .failed(error)
            lastError = error
            appendLog(error, .error)
            return
        }
        if !localMMProjPath.isEmpty, let error = localModelError(localMMProjPath) {
            let message = "视觉投影无效：\(error)"
            phase = .failed(message)
            lastError = message
            appendLog(message, .error)
            return
        }
        isLaunching = true
        Task {
            defer { isLaunching = false }
            if await healthIsReady() {
                ownsProcess = false
                phase = .external
                appendLog("发现已有 llama.cpp 服务", .success)
                return
            }

            let root = Bundle.main.bundleURL.deletingLastPathComponent()
            let script = root.appendingPathComponent("run_server.sh")
            guard FileManager.default.isExecutableFile(atPath: script.path) else {
                phase = .failed("缺少 run_server.sh")
                lastError = "缺少启动脚本：\(script.path)"
                appendLog(lastError, .error)
                return
            }

            prepareLogFile()
            let pipe = Pipe()
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/bin/zsh")
            task.arguments = [script.path]
            task.currentDirectoryURL = root
            var environment = ProcessInfo.processInfo.environment
            environment["CTX"] = String(localRuntimeContextSize)
            environment["KV"] = kvType
            environment["SPEC"] = ngramEnabled ? "1" : "0"
            environment["NGRAM_MIN"] = "2"
            environment["NGRAM_MAX"] = "4"
            environment["NGRAM_MATCH"] = "16"
            environment["QWEN_HOST"] = "127.0.0.1"
            environment["QWEN_PORT"] = "7890"
            environment["MODEL"] = localModelPath
            environment["MMPROJ"] = localMMProjPath
            environment["CHAT_TEMPLATE"] = localChatTemplate
            environment["LOAD_MODE"] = localCompatibilityMode ? "auto" : "none"
            environment["FLASH_ATTN"] = localCompatibilityMode ? "auto" : "on"
            environment["NGL"] = localCompatibilityMode ? "auto" : "99"
            environment["FIT_CTX"] = localCompatibilityMode ? "1024" : "4096"
            environment["CACHE_RAM"] = localCompatibilityMode ? "256" : "1024"
            environment["THREADS"] = "1"
            environment["THREADS_BATCH"] = "8"
            environment["REASONING"] = reasoningEnabled ? "auto" : "off"
            task.environment = environment
            task.standardOutput = pipe
            task.standardError = pipe
            pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard !data.isEmpty else { return }
                Task { @MainActor in self?.consumeLogData(data) }
            }
            task.terminationHandler = { [weak self] terminated in
                Task { @MainActor in
                    guard let self else { return }
                    guard self.process === terminated else { return }
                    pipe.fileHandleForReading.readabilityHandler = nil
                    self.process = nil
                    self.ownsProcess = false
                    if self.phase != .offline {
                        self.phase = terminated.terminationStatus == 0 ? .offline : .failed("退出码 \(terminated.terminationStatus)")
                    }
                    self.appendLog("llama.cpp 已退出（code \(terminated.terminationStatus)）", terminated.terminationStatus == 0 ? .info : .error)
                }
            }

            do {
                try task.run()
                process = task
                ownsProcess = true
                phase = .starting
                launchDate = Date()
                appendLog("启动 llama.cpp · \(localRuntimeContextSize / 1024)K context · KV \(kvType) · \(localCompatibilityMode ? "兼容模式" : "高速模式") · 思考 \(reasoningEnabled ? "开" : "关")", .info)
                appendLog(ngramEnabled ? "N-gram 连续对话模式已启用（2–4 token 草稿）" : "N-gram 已关闭：避免低接受率拖慢生成", .info)
            } catch {
                phase = .failed(error.localizedDescription)
                lastError = error.localizedDescription
                appendLog("启动失败：\(error.localizedDescription)", .error)
            }
        }
    }

    func stopServer() {
        if ownsProcess, let process, process.isRunning {
            phase = .offline
            process.terminate()
            appendLog("正在停止本启动器创建的 llama.cpp", .info)
        } else if let pid = adoptedPID, workspaceServer(pid: pid) != nil {
            phase = .offline
            Darwin.kill(pid, SIGTERM)
            adoptedPID = nil
            appendLog("正在停止本工作区的 llama.cpp（PID \(pid)）", .info)
        } else {
            appendLog("端口由其他程序占用，未执行停止", .warning)
        }
    }

    func restartServer() {
        guard ownsProcess || adoptedPID != nil else {
            appendLog("外部服务不属于本工作区，未执行重启", .warning)
            return
        }
        stopServer()
        Task {
            await waitUntilOffline()
            startServer()
        }
    }

    func testConnection() {
        guard !routeTestRunning else { return }
        routeTestRunning = true
        routeTestLines = ["正在测试路由…"]
        Task {
            var lines: [String] = []
            do {
                _ = try await json(path: "/health", timeout: 4)
                lines.append("llama.cpp /health 通过")
                do {
                    let countBody: [String: Any] = [
                        "model": "qwen",
                        "messages": [["role": "user", "content": "ping"]],
                        "tools": [[
                            "name": "ping",
                            "description": "Return pong.",
                            "input_schema": ["type": "object", "properties": [:]]
                        ]]
                    ]
                    _ = try await json(path: "/v1/messages/count_tokens", method: "POST", body: countBody, timeout: 20)
                    lines.append("Anthropic 工具端点通过")
                } catch {
                    lines.append("Anthropic 工具端点失败（OpenAI /v1 对话不受影响）")
                }
            } catch {
                lines.append("llama.cpp 离线：\(error.localizedDescription)")
            }
            do {
                let cc = try await json(url: URL(string: "\(proxyEndpoint)/health")!, timeout: 2) as? [String: Any]
                if cc?["status"] as? String == "healthy" {
                    ccSwitchConnected = true
                    lines.append("CC Switch :15721 在线")
                } else {
                    ccSwitchConnected = false
                    lines.append("CC Switch 未就绪")
                }
            } catch {
                ccSwitchConnected = false
                lines.append("CC Switch 未运行（仅 Claude Desktop 需要）")
            }
            routeTestLines = lines
            for line in lines {
                appendLog(line, line.contains("通过") || line.contains("在线") ? .success : (line.contains("离线") ? .error : .warning))
            }
            routeTestRunning = false
        }
    }

    func sendMessage() {
        let prompt = chatInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, isOnline, !isGenerating else { return }
        chatInput = ""
        messages.append(ChatMessage(role: .user, content: prompt))
        messages.append(ChatMessage(role: .assistant, content: ""))
        isGenerating = true

        Task {
            let started = Date()
            var firstToken: Date?
            var completionTokens = 0
            do {
                var request = URLRequest(url: URL(string: "\(endpoint)/v1/chat/completions")!)
                request.httpMethod = "POST"
                request.timeoutInterval = 600
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: [
                    "model": "qwen",
                    "messages": [["role": "user", "content": prompt]],
                    "temperature": 0.7,
                    "top_k": 20,
                    "top_p": 0.95,
                    "max_tokens": 512,
                    "stream": true,
                    "stream_options": ["include_usage": true]
                ])
                let (bytes, response) = try await URLSession.shared.bytes(for: request)
                guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                    throw URLError(.badServerResponse)
                }
                for try await line in bytes.lines {
                    guard line.hasPrefix("data:") else { continue }
                    let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                    if payload == "[DONE]" { break }
                    guard let data = payload.data(using: .utf8),
                          let chunk = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }
                    if let usage = chunk["usage"] as? [String: Any], let tokens = usage["completion_tokens"] as? Int {
                        completionTokens = tokens
                    }
                    let choices = chunk["choices"] as? [[String: Any]]
                    let delta = choices?.first?["delta"] as? [String: Any]
                    guard let piece = delta?["content"] as? String, !piece.isEmpty else { continue }
                    if firstToken == nil {
                        firstToken = Date()
                        ttftMilliseconds = Date().timeIntervalSince(started) * 1000
                    }
                    messages[messages.count - 1].content += piece
                }
                if completionTokens > 0, let firstToken {
                    let seconds = max(Date().timeIntervalSince(firstToken), 0.001)
                    updateGenerationSpeed(Double(max(completionTokens - 1, 1)) / seconds)
                }
                appendLog("本地对话完成 · \(String(format: "%.1f", Date().timeIntervalSince(started)))s", .success)
            } catch {
                messages[messages.count - 1].content = "[错误] \(error.localizedDescription)"
                appendLog("生成失败：\(error.localizedDescription)", .error)
            }
            isGenerating = false
        }
    }

    func chooseAgentWorkspace() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: agentWorkspace)
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if agentBlocks.isEmpty, let index = sessions.firstIndex(where: { $0.id == currentSessionId }) {
            sessions[index].workspace = url.path
            agentWorkspace = url.path
            persistSessions()
            return
        }
        newAgentSession(in: url.path)
    }

    func selectInferenceSource(_ source: InferenceSource) {
        guard source != inferenceSource else { return }
        if source == .cloud, !savedCloudAvailable { return }
        if source == .local, !savedLocalAvailable { return }
        inferenceSource = source
        persistSettings()
        reloadDraft()
        teardownAgent()
        if !modelSupportsVision { draftImages = [] }
    }

    func selectCloudProfile(_ id: String) {
        guard let profile = cloudProfiles.first(where: { $0.id == id }), cloudProfileAvailable(profile) else { return }
        cloudProfileID = profile.id
        cloudPreset = profile.preset
        cloudBaseURL = profile.baseURL
        cloudModelId = profile.modelId
        cloudApiKey = KeychainStore.get(key: cloudKey(profile.id))
        inferenceSource = .cloud
        persistSettings()
        reloadDraft()
        teardownAgent()
        if !modelSupportsVision { draftImages = [] }
    }

    func toggleToolPane(_ pane: ToolPane) {
        openToolPane = openToolPane == pane ? nil : pane
    }

    func pasteAttachmentsFromClipboard() -> Bool {
        let board = NSPasteboard.general
        var added = false
        if let urls = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] {
            added = addDraftAttachments(urls)
        }
        if !added, let data = pngFromPasteboard(board) {
            if let path = writePasteData(data) {
                if modelSupportsVision, draftImages.count < 4 {
                    draftImages.append(path)
                } else {
                    draftFiles.append(path)
                }
                added = true
            }
        }
        return added
    }

    func addDroppedAttachments(_ urls: [URL]) -> Bool { addDraftAttachments(urls) }

    func chooseAttachments() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = true
        guard panel.runModal() == .OK else { return }
        _ = addDraftAttachments(panel.urls)
    }

    func removeDraftImage(_ path: String) {
        draftImages.removeAll { $0 == path }
    }

    func removeDraftFile(_ path: String) {
        draftFiles.removeAll { $0 == path }
    }

    func chooseLocalModel() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "gguf") ?? .data]
        panel.directoryURL = URL(fileURLWithPath: localModelPath).deletingLastPathComponent()
        if panel.runModal() == .OK, let url = panel.url {
            if let error = localModelError(url.path) {
                showModelError(error)
            } else {
                draft.localModelPath = url.path
            }
        }
    }

    func chooseMMProj() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [UTType(filenameExtension: "gguf") ?? .data]
        panel.directoryURL = URL(fileURLWithPath: draft.localMMProjPath.isEmpty ? draft.localModelPath : draft.localMMProjPath).deletingLastPathComponent()
        if panel.runModal() == .OK, let url = panel.url {
            if let error = localModelError(url.path) {
                showModelError("视觉投影无效：\(error)")
            } else {
                draft.localMMProjPath = url.path
            }
        }
    }

    func applyCloudPreset(_ preset: CloudPreset) {
        draft.cloudPreset = preset
        if preset != .custom {
            draft.cloudBaseURL = preset.baseURL
            draft.cloudModelId = preset.defaultModel
        }
    }

    func addDraftCloudProfile() {
        syncDraftCloudProfile()
        let profile = CloudProfile(preset: .openai)
        draft.cloudProfiles.append(profile)
        loadDraftCloudProfile(profile.id)
    }

    func selectDraftCloudProfile(_ id: String) {
        guard id != draft.cloudProfileID else { return }
        syncDraftCloudProfile()
        loadDraftCloudProfile(id)
    }

    func resetAgentConversation() {
        newAgentSession()
    }

    func newAgentSession(in workspace: String? = nil) {
        persistCurrentSession()
        teardownAgent()
        let bound = workspace
            ?? sessions.first(where: { $0.id == currentSessionId })?.workspace
            ?? agentWorkspace
        let session = AgentSession(
            id: UUID().uuidString,
            title: "新会话",
            workspace: bound.isEmpty ? Bundle.main.bundleURL.deletingLastPathComponent().path : bound,
            allowWrites: agentAllowWrites,
            blocks: [],
            updatedAt: Date().timeIntervalSince1970
        )
        sessions.insert(session, at: 0)
        applySession(session)
        persistSessions()
    }

    func selectSession(_ id: String) {
        guard id != currentSessionId else { return }
        persistCurrentSession()
        teardownAgent()
        guard let session = sessions.first(where: { $0.id == id }) else { return }
        applySession(session)
    }

    func deleteSession(_ id: String) {
        if id == currentSessionId {
            persistCurrentSession()
            teardownAgent()
        }
        sessions.removeAll { $0.id == id }
        if sessions.isEmpty {
            newAgentSession()
            return
        }
        if currentSessionId == id, let next = sessions.first {
            applySession(next)
        }
        persistSessions()
    }

    func launchDeveloperAgent() {
        guard !agentIsRunning else { return }
        let images = modelSupportsVision ? draftImages : []
        let files = draftFiles
        let typed = agentDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !typed.isEmpty || !images.isEmpty || !files.isEmpty else { return }
        let prompt = typed.isEmpty ? (images.isEmpty ? "请检查附件。" : "请查看图片。") : typed
        let agentPrompt = files.isEmpty ? prompt : "\(prompt)\n\n已附加文件（请先读取文件内容）：\n\(files.map { "- \($0)" }.joined(separator: "\n"))"
        let workspace = agentWorkspace.trimmingCharacters(in: .whitespacesAndNewlines)
        guard FileManager.default.fileExists(atPath: workspace) else {
            upsertAgentBlock(id: "error", kind: .error, title: "错误", text: "请选择有效工作区。", done: true)
            return
        }
        guard usesCloud || isOnline else {
            upsertAgentBlock(id: "error", kind: .error, title: "错误", text: "本地模型未启动。可在设置中改用云 API。", done: true)
            return
        }

        let root = Bundle.main.bundleURL.deletingLastPathComponent()
        let script = root.appendingPathComponent("agent/local-harness-agent.mjs")
        guard FileManager.default.fileExists(atPath: script.path) else {
            upsertAgentBlock(id: "error", kind: .error, title: "错误", text: "缺少 Cline 代理脚本：\(script.path)", done: true)
            return
        }
        guard let node = resolvedNode() else {
            upsertAgentBlock(id: "error", kind: .error, title: "错误", text: "找不到 node。请安装 Node.js，或把 node 放到 /opt/homebrew/bin。", done: true)
            return
        }

        persistCurrentSession()
        agentDraft = ""
        draftImages = []
        draftFiles = []
        agentBlocks.append(AgentBlock(id: UUID().uuidString, kind: .user, title: "你", text: prompt, done: true, imagePaths: images, filePaths: files))
        persistCurrentSession()

        let key = agentReuseKey
        if agentProcess?.isRunning == true, agentStdin != nil, agentBoundKey == key {
            agentIsRunning = true
            writeAgentCommand(prompt: agentPrompt, images: images, includeHistory: false)
            return
        }
        teardownAgent()

        let stdout = Pipe()
        let stdin = Pipe()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: node)
        var arguments = [script.path, "--workspace", workspace]
        if agentAllowWrites { arguments.append("--allow-writes") }
        task.arguments = arguments
        task.currentDirectoryURL = root.appendingPathComponent("agent")
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + (environment["PATH"] ?? "")
        environment["NODE_NO_WARNINGS"] = "1"
        environment["HARNESS_PROVIDER"] = usesCloud ? cloudPreset.providerId : "openai-compatible"
        environment["HARNESS_MODEL"] = usesCloud ? cloudModelId : "qwen"
        environment["HARNESS_BASE_URL"] = usesCloud ? cloudBaseURL : "http://127.0.0.1:7890/v1"
        environment["HARNESS_API_KEY"] = usesCloud ? cloudApiKey : "local-harness"
        environment["HARNESS_CTX"] = String(usesCloud ? 128_000 : localRuntimeContextSize)
        task.environment = environment
        task.standardOutput = stdout
        task.standardError = FileHandle.nullDevice
        task.standardInput = stdin
        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor in self?.consumeAgentData(text) }
        }
        task.terminationHandler = { [weak self] process in
            Task { @MainActor in
                guard let self, self.agentProcess === process else { return }
                stdout.fileHandleForReading.readabilityHandler = nil
                self.agentStdin = nil
                self.agentBoundKey = ""
                self.agentProcess = nil
                self.agentIsRunning = false
                self.persistCurrentSession()
                if process.terminationStatus != 0 {
                    self.upsertAgentBlock(id: "exit", kind: .error, title: "错误", text: "代理异常退出（code \(process.terminationStatus)）。", done: true)
                }
            }
        }
        do {
            try task.run()
            agentProcess = task
            agentStdin = stdin.fileHandleForWriting
            agentBoundKey = key
            agentIsRunning = true
            writeAgentCommand(prompt: agentPrompt, images: images, includeHistory: true)
        } catch {
            upsertAgentBlock(id: "error", kind: .error, title: "错误", text: "代理启动失败：\(error.localizedDescription)", done: true)
        }
    }

    func stopDeveloperAgent() {
        if agentIsRunning, agentProcess?.isRunning == true, agentStdin != nil {
            writeAgentRaw(["type": "stop"])
            return
        }
        teardownAgent()
    }

    func copyEndpoint() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("\(endpoint)/v1", forType: .string)
        appendLog("已复制 OpenAI 地址", .success)
    }

    func copyRouteConfig() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("ANTHROPIC_BASE_URL=http://127.0.0.1:15721\nUPSTREAM=http://127.0.0.1:7890/v1\nMODEL=qwen", forType: .string)
        appendLog("已复制 CC Switch 路由摘要", .success)
    }

    func clearLogs() {
        logs.removeAll()
    }

    func shutdown() {
        monitorTask?.cancel()
        monitorTask = nil
        if ownsProcess, process?.isRunning == true { process?.terminate() }
        persistCurrentSession()
        teardownAgent()
        logHandle?.closeFile()
        logHandle = nil
    }

    private func refreshStatus() async {
        do {
            let health = try await json(path: "/health") as? [String: Any]
            guard health?["status"] as? String == "ok" else { return }
            if phase == .offline || phase == .starting {
                phase = ownsProcess ? .online : .external
                appendLog("llama.cpp 已就绪", .success)
            }
            if let models = try? await json(path: "/v1/models") as? [String: Any],
               let data = models["data"] as? [[String: Any]],
               let first = data.first {
                if let id = first["id"] as? String { modelName = id == "qwen" ? localModelFileName : id }
                if let meta = first["meta"] as? [String: Any], let context = meta["n_ctx"] as? Int { contextSize = context }
            }
            if let slots = try? await json(path: "/slots") as? [[String: Any]], let slot = slots.first {
                applySlot(slot)
            }
            let cc = try? await json(url: URL(string: "\(proxyEndpoint)/health")!) as? [String: Any]
            ccSwitchConnected = cc?["status"] as? String == "healthy"
        } catch {
            if process?.isRunning != true {
                phase = .offline
                ccSwitchConnected = false
            }
        }
    }

    private func applySlot(_ slot: [String: Any]) {
        let slotContext = slot["n_ctx"] as? Int ?? contextSize
        contextSize = slotContext
        contextUsed = slot["n_prompt_tokens"] as? Int
            ?? slot["n_prompt_tokens_processed"] as? Int
            ?? contextUsed
        guard slot["is_processing"] as? Bool == true else {
            lastSlotSample = nil
            return
        }
        let task = slot["id_task"] as? Int ?? -1
        let next = slot["next_token"] as? [[String: Any]]
        let decoded = next?.first?["n_decoded"] as? Int ?? 0
        let now = Date()
        if let previous = lastSlotSample, previous.task == task, decoded > previous.decoded {
            let seconds = now.timeIntervalSince(previous.date)
            if seconds > 0 { updateGenerationSpeed(Double(decoded - previous.decoded) / seconds) }
        }
        lastSlotSample = (task, decoded, now)
    }

    private func healthIsReady() async -> Bool {
        guard let health = try? await json(path: "/health") as? [String: Any] else { return false }
        return health["status"] as? String == "ok"
    }

    private func reconcileServerOnLaunch() async {
        guard await healthIsReady() else {
            startServer()
            return
        }
        guard let existing = workspaceServer() else {
            phase = .external
            appendLog("7890 端口已有非本工作区服务；仅监控，不会终止", .warning)
            return
        }
        adoptedPID = existing.pid
        launchDate = Date()
        if configurationMatches(existing.command) {
            phase = .external
            appendLog("已接管本工作区 llama.cpp（PID \(existing.pid)）", .success)
            return
        }
        phase = .starting
        appendLog("检测到旧版慢速参数，正在自动替换（PID \(existing.pid)）", .warning)
        Darwin.kill(existing.pid, SIGTERM)
        adoptedPID = nil
        await waitUntilOffline()
        startServer()
    }

    private func waitUntilOffline() async {
        for _ in 0..<40 {
            if !(await healthIsReady()) { return }
            try? await Task.sleep(for: .milliseconds(250))
        }
    }

    private func configurationMatches(_ command: String) -> Bool {
        let required = [
            " -c \(localRuntimeContextSize) ",
            " -ctk \(kvType) ",
            " -ctv \(kvType) ",
            " --host 127.0.0.1 ",
            " --port 7890",
            " -t 1 ",
            " -ngl \(localCompatibilityMode ? "auto" : "99") ",
            "--load-mode \(localCompatibilityMode ? "auto" : "none")",
            "--cache-ram \(localCompatibilityMode ? "256" : "1024")"
        ]
        guard required.allSatisfy(command.contains) else { return false }
        if reasoningEnabled {
            guard command.contains(" --reasoning auto") || command.contains(" --reasoning on") else { return false }
        } else {
            guard command.contains(" --reasoning off") else { return false }
        }
        if ngramEnabled {
            guard command.contains(" --spec-type ngram-mod ")
                && command.contains(" --spec-ngram-mod-n-min 2 ")
                && command.contains(" --spec-ngram-mod-n-max 4 ")
                && command.contains(" --spec-ngram-mod-n-match 16") else { return false }
        } else if command.contains(" --spec-type ") {
            return false
        }
        if localMMProjPath.isEmpty {
            guard !command.contains(" -mm ") else { return false }
        } else if !command.contains(localMMProjPath) {
            return false
        }
        return localChatTemplate.isEmpty ? !command.contains(" --chat-template ") : command.contains(" --chat-template \(localChatTemplate)")
    }

    private func workspaceServer(pid: pid_t? = nil) -> (pid: pid_t, command: String)? {
        let resolvedPID: pid_t
        if let pid {
            resolvedPID = pid
        } else {
            guard let value = commandOutput(
                executable: "/usr/sbin/lsof",
                arguments: ["-nP", "-tiTCP:7890", "-sTCP:LISTEN"]
            )?.split(separator: "\n").first,
            let parsed = pid_t(value) else { return nil }
            resolvedPID = parsed
        }
        guard let command = commandOutput(
            executable: "/bin/ps",
            arguments: ["-p", String(resolvedPID), "-o", "command="]
        ) else { return nil }
        let root = Bundle.main.bundleURL.deletingLastPathComponent().path
        let expectedBinary = root + "/llama_cpp_bonsai/build/bin/llama-server"
        guard command.contains(expectedBinary), command.contains(localModelPath) else { return nil }
        return (resolvedPID, command)
    }

    private func commandOutput(executable: String, arguments: [String]) -> String? {
        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: executable)
        task.arguments = arguments
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0 else { return nil }
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            return nil
        }
    }

    private func json(path: String, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 4) async throws -> Any {
        try await json(url: URL(string: endpoint + path)!, method: method, body: body, timeout: timeout)
    }

    private func json(url: URL, method: String = "GET", body: [String: Any]? = nil, timeout: TimeInterval = 4) async throws -> Any {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let status = (response as? HTTPURLResponse)?.statusCode, (200..<300).contains(status) else {
            throw URLError(.badServerResponse)
        }
        return try JSONSerialization.jsonObject(with: data)
    }

    private func prepareLogFile() {
        let path = "/tmp/qwen_local_server.log"
        FileManager.default.createFile(atPath: path, contents: nil)
        logHandle?.closeFile()
        logHandle = try? FileHandle(forWritingTo: URL(fileURLWithPath: path))
    }

    private func consumeLogData(_ data: Data) {
        logHandle?.write(data)
        guard let text = String(data: data, encoding: .utf8) else { return }
        logBuffer += text
        let parts = logBuffer.components(separatedBy: .newlines)
        logBuffer = parts.last ?? ""
        for line in parts.dropLast() { parseLogLine(line) }
    }

    private func parseLogLine(_ line: String) {
        guard !line.isEmpty, !line.contains("srv          stop: cancel task") else { return }
        if let value = capture(#"prompt eval time.*?([0-9.]+) tokens per second"#, in: line) {
            promptTPS = value
            push(value, into: &promptHistory)
            appendLog("Prompt \(String(format: "%.1f", value)) tok/s", .info)
        } else if let value = capture(#"eval time.*?([0-9.]+) tokens per second"#, in: line) {
            updateGenerationSpeed(value)
            appendLog("生成 \(String(format: "%.1f", value)) tok/s", .success)
        } else if let value = capture(#"tg_3s\s*=\s*([0-9.]+) t/s"#, in: line) {
            updateGenerationSpeed(value)
        } else if let value = capture(#"draft acceptance\s*=\s*([0-9.]+)"#, in: line) {
            ngramAcceptance = value * 100
            appendLog("N-gram 接受率 \(String(format: "%.1f", value * 100))%", value < 0.15 ? .warning : .success)
        } else if line.localizedCaseInsensitiveContains("error") || line.localizedCaseInsensitiveContains("failed") {
            appendLog(String(line.suffix(180)), .error)
        }
    }

    private func capture(_ pattern: String, in text: String) -> Double? {
        guard let expression = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]),
              let match = expression.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              match.numberOfRanges > 1,
              let range = Range(match.range(at: 1), in: text) else { return nil }
        return Double(text[range])
    }

    private func updateGenerationSpeed(_ value: Double) {
        guard value.isFinite, value > 0, value < 1_000 else { return }
        generationTPS = value
        push(value, into: &speedHistory)
    }

    private func push(_ value: Double, into history: inout [Double]) {
        history.append(value)
        if history.count > 28 { history.removeFirst(history.count - 28) }
    }

    private func appendLog(_ text: String, _ kind: ConsoleLine.Kind) {
        logs.append(ConsoleLine(date: Date(), text: text, kind: kind))
        NSLog("[local-harness-ai] %@", text)
        if logs.count > 250 { logs.removeFirst(logs.count - 250) }
    }

    func persistSettings() {
        let defaults = UserDefaults.standard
        defaults.set(localModelPath, forKey: "harness.model")
        defaults.set(localMMProjPath, forKey: "harness.mmproj")
        defaults.set(localChatTemplate, forKey: "harness.chatTemplate")
        defaults.set(localCompatibilityMode, forKey: "harness.compatibilityMode")
        defaults.set(inferenceSource.rawValue, forKey: "harness.source")
        if let data = try? JSONEncoder().encode(cloudProfiles) {
            defaults.set(data, forKey: "harness.cloudProfiles")
        }
        defaults.set(cloudProfileID, forKey: "harness.cloudProfileID")
        defaults.set(selectedContextSize, forKey: "harness.ctx")
        defaults.set(kvType, forKey: "harness.kv")
        defaults.set(ngramEnabled, forKey: "harness.ngram")
        defaults.set(reasoningEnabled, forKey: "harness.reasoning")
        KeychainStore.set(cloudApiKey, key: cloudKey(cloudProfileID))
    }

    private func loadSettings() {
        let defaults = UserDefaults.standard
        let root = Bundle.main.bundleURL.deletingLastPathComponent()
        localModelPath = defaults.string(forKey: "harness.model")
            ?? root.appendingPathComponent("Ternary-Bonsai-2-27B-PTQ1_0.gguf").path
        localMMProjPath = defaults.string(forKey: "harness.mmproj") ?? ""
        localChatTemplate = defaults.string(forKey: "harness.chatTemplate") ?? ""
        localCompatibilityMode = defaults.bool(forKey: "harness.compatibilityMode")
        if let raw = defaults.string(forKey: "harness.source"), let source = InferenceSource(rawValue: raw) {
            inferenceSource = source
        }
        let legacyPreset = defaults.string(forKey: "harness.cloudPreset").flatMap(CloudPreset.init(rawValue:)) ?? .openai
        let legacyURL = defaults.string(forKey: "harness.cloudURL") ?? legacyPreset.baseURL
        let legacyModel = defaults.string(forKey: "harness.cloudModel") ?? legacyPreset.defaultModel
        if let data = defaults.data(forKey: "harness.cloudProfiles"),
           let decoded = try? JSONDecoder().decode([CloudProfile].self, from: data),
           !decoded.isEmpty {
            cloudProfiles = decoded
            cloudProfileID = defaults.string(forKey: "harness.cloudProfileID") ?? decoded[0].id
        } else {
            let profile = CloudProfile(preset: legacyPreset, baseURL: legacyURL, modelId: legacyModel)
            cloudProfiles = [profile]
            cloudProfileID = profile.id
            let legacyKey = KeychainStore.get(key: "api")
            if !legacyKey.isEmpty { KeychainStore.set(legacyKey, key: cloudKey(profile.id)) }
        }
        if !cloudProfiles.contains(where: { $0.id == cloudProfileID }) {
            cloudProfileID = cloudProfiles[0].id
        }
        if let profile = cloudProfiles.first(where: { $0.id == cloudProfileID }) {
            cloudPreset = profile.preset
            cloudBaseURL = profile.baseURL
            cloudModelId = profile.modelId
            cloudApiKey = KeychainStore.get(key: cloudKey(profile.id))
        }
        if let data = try? JSONEncoder().encode(cloudProfiles) {
            defaults.set(data, forKey: "harness.cloudProfiles")
            defaults.set(cloudProfileID, forKey: "harness.cloudProfileID")
        }
        if defaults.object(forKey: "harness.ctx") != nil {
            selectedContextSize = defaults.integer(forKey: "harness.ctx")
        }
        kvType = defaults.string(forKey: "harness.kv") ?? kvType
        ngramEnabled = defaults.bool(forKey: "harness.ngram")
        reasoningEnabled = defaults.bool(forKey: "harness.reasoning")
    }

    func reloadDraft() {
        draft = SettingsDraft(
            inferenceSource: inferenceSource,
            localModelPath: localModelPath,
            localMMProjPath: localMMProjPath,
            localChatTemplate: localChatTemplate,
            localCompatibilityMode: localCompatibilityMode,
            cloudProfileID: cloudProfileID,
            cloudProfiles: cloudProfiles,
            cloudPreset: cloudPreset,
            cloudBaseURL: cloudBaseURL,
            cloudModelId: cloudModelId,
            cloudApiKey: cloudApiKey,
            selectedContextSize: selectedContextSize,
            kvType: kvType,
            ngramEnabled: ngramEnabled,
            reasoningEnabled: reasoningEnabled,
            customContextText: String(selectedContextSize)
        )
    }

    func saveSettings() -> Bool {
        syncDraftCloudProfile()
        if draft.contextTag == -1 {
            let parsed = Int(draft.customContextText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0
            guard parsed >= 512, parsed <= 131_072 else {
                appendLog("自定义上下文需在 512–131072 token 之间", .error)
                return false
            }
            draft.selectedContextSize = parsed
        }
        if draft.inferenceSource == .local, let error = localModelError(draft.localModelPath) {
            appendLog(error, .error)
            showModelError(error)
            return false
        }
        if draft.inferenceSource == .local, !draft.localMMProjPath.isEmpty, let error = localModelError(draft.localMMProjPath) {
            let message = "视觉投影无效：\(error)"
            appendLog(message, .error)
            showModelError(message)
            return false
        }
        guard draft.cloudProfiles.contains(where: { $0.id == draft.cloudProfileID }) else {
            appendLog("请先添加或选择云配置", .error)
            return false
        }
        inferenceSource = draft.inferenceSource
        localModelPath = draft.localModelPath
        localMMProjPath = draft.localMMProjPath
        localChatTemplate = draft.localChatTemplate
        localCompatibilityMode = draft.localCompatibilityMode
        cloudProfiles = draft.cloudProfiles
        cloudProfileID = draft.cloudProfileID
        cloudPreset = draft.cloudPreset
        cloudBaseURL = draft.cloudBaseURL
        cloudModelId = draft.cloudModelId
        cloudApiKey = draft.cloudApiKey
        selectedContextSize = draft.selectedContextSize
        kvType = draft.kvType
        ngramEnabled = draft.ngramEnabled
        reasoningEnabled = draft.reasoningEnabled
        persistSettings()
        appendLog("设置已保存。本地 llama.cpp 需点「重启并应用」后生效。", .success)
        return true
    }

    func setDraftContextTag(_ tag: Int) {
        if tag == -1 {
            draft.customContextText = String(draft.selectedContextSize)
        } else {
            draft.selectedContextSize = tag
            draft.customContextText = String(tag)
        }
    }

    private func syncDraftCloudProfile() {
        guard let index = draft.cloudProfiles.firstIndex(where: { $0.id == draft.cloudProfileID }) else { return }
        draft.cloudProfiles[index].preset = draft.cloudPreset
        draft.cloudProfiles[index].baseURL = draft.cloudBaseURL
        draft.cloudProfiles[index].modelId = draft.cloudModelId
    }

    private func loadDraftCloudProfile(_ id: String) {
        guard let profile = draft.cloudProfiles.first(where: { $0.id == id }) else { return }
        draft.cloudProfileID = profile.id
        draft.cloudPreset = profile.preset
        draft.cloudBaseURL = profile.baseURL
        draft.cloudModelId = profile.modelId
        draft.cloudApiKey = KeychainStore.get(key: cloudKey(profile.id))
    }

    private func cloudKey(_ id: String) -> String { "api.\(id)" }

    private func localModelError(_ path: String) -> String? {
        let url = URL(fileURLWithPath: path)
        guard url.pathExtension.lowercased() == "gguf" else { return "请选择 .gguf 模型文件。" }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
            return "找不到模型文件：\(path)"
        }
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            guard try handle.read(upToCount: 4) == Data([0x47, 0x47, 0x55, 0x46]) else {
                return "该文件不是有效的 GGUF 模型。"
            }
        } catch {
            return "无法读取模型文件：\(error.localizedDescription)"
        }
        return nil
    }

    private func showModelError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "无法使用本地模型"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }

    private func sessionsURL() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("local-harness-ai", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root.appendingPathComponent("sessions.json")
    }

    private func loadSessions() {
        let url = sessionsURL()
        if let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([AgentSession].self, from: data),
           !decoded.isEmpty {
            sessions = decoded.map { session in
                var cleaned = session
                cleaned.blocks.removeAll { $0.kind == .status }
                return cleaned
            }.sorted { $0.updatedAt > $1.updatedAt }
            applySession(sessions[0])
            persistSessions()
            return
        }
        let root = Bundle.main.bundleURL.deletingLastPathComponent().path
        let session = AgentSession(
            id: UUID().uuidString,
            title: "新会话",
            workspace: root,
            allowWrites: true,
            blocks: [],
            updatedAt: Date().timeIntervalSince1970
        )
        sessions = [session]
        applySession(session)
        persistSessions()
    }

    private func applySession(_ session: AgentSession) {
        currentSessionId = session.id
        agentWorkspace = session.workspace
        agentAllowWrites = session.allowWrites
        agentBlocks = session.blocks
        agentDraft = ""
        draftImages = []
        draftFiles = []
        agentBuffer = ""
        streamAlias = [:]
        openToolPane = nil
    }

    func persistCurrentSession() {
        guard let index = sessions.firstIndex(where: { $0.id == currentSessionId }) else { return }
        let user = agentBlocks.first(where: { $0.kind == .user })
        let raw = user?.text.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if sessions[index].customTitle == nil {
            let hasAttachment = !(user?.imagePaths.isEmpty ?? true) || !(user?.filePaths.isEmpty ?? true)
            let title = raw.isEmpty && hasAttachment ? "附件" : (raw.isEmpty ? sessions[index].title : raw)
            sessions[index].title = String(title.prefix(40))
        }
        sessions[index].allowWrites = agentAllowWrites
        sessions[index].blocks = agentBlocks
        sessions[index].updatedAt = Date().timeIntervalSince1970
        sessions.sort { $0.updatedAt > $1.updatedAt }
        persistSessions()
    }

    private func persistSessions() {
        if sessions.count > 40 { sessions = Array(sessions.prefix(40)) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(sessions) else { return }
        try? data.write(to: sessionsURL(), options: .atomic)
    }

    private func resolvedNode() -> String? {
        let bundledNode = Bundle.main.bundleURL
            .deletingLastPathComponent()
            .appendingPathComponent("node/bin/node")
            .path
        let candidates = [
            bundledNode,
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node"
        ]
        if let found = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return found
        }
        return commandOutput(executable: "/bin/zsh", arguments: ["-lc", "command -v node"])
    }

    private func consumeAgentData(_ text: String) {
        agentBuffer += text
        let parts = agentBuffer.components(separatedBy: "\n")
        agentBuffer = parts.last ?? ""
        for line in parts.dropLast() {
            applyAgentLine(line)
        }
    }

    private func applyAgentLine(_ line: String) {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard let data = trimmed.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else { return }
        let text = object["text"] as? String ?? ""
        let id = object["id"] as? String ?? type
        let done = object["done"] as? Bool ?? true
        let append = object["append"] as? Bool ?? false
        switch type {
        case "thinking":
            upsertAgentBlock(id: "thinking-\(id)", kind: .thinking, title: "思考过程", text: text, done: done, replaceText: !append)
        case "reply":
            upsertAgentBlock(id: "reply-\(id)", kind: .reply, title: "代理", text: text, done: done, replaceText: !append)
        case "tool":
            let name = object["name"] as? String ?? "工具"
            upsertAgentBlock(id: "tool-\(id)", kind: .tool, title: name, text: text, done: done, replaceText: !text.isEmpty)
        case "error":
            if isNoiseStatus(text) { return }
            upsertAgentBlock(id: "error-\(UUID().uuidString)", kind: .error, title: "错误", text: text, done: true)
        case "done":
            finalizeAgentTurn()
        case "ready":
            finalizeAgentTurn()
        default:
            if text == "已停止" {
                finalizeAgentTurn()
            }
        }
    }

    private func upsertAgentBlock(id: String, kind: AgentBlock.Kind, title: String, text: String, done: Bool, replaceText: Bool = true) {
        if let current = streamAlias[id],
           let existing = agentBlocks.first(where: { $0.id == current }),
           existing.done, !done {
            streamAlias[id] = "\(id)-\(UUID().uuidString)"
        } else if streamAlias[id] == nil {
            streamAlias[id] = id
        }
        let resolved = streamAlias[id] ?? id
        if let index = agentBlocks.firstIndex(where: { $0.id == resolved }) {
            if replaceText, !text.isEmpty { agentBlocks[index].text = text }
            else if !replaceText, !text.isEmpty { agentBlocks[index].text += text }
            agentBlocks[index].done = done
            agentBlocks[index].title = title
        } else {
            agentBlocks.append(AgentBlock(id: resolved, kind: kind, title: title, text: text, done: done))
        }
        if agentBlocks.count > 2000 { agentBlocks.removeFirst(agentBlocks.count - 2000) } // ponytail: UI transcript cap; model context is compacted
    }

    private func finalizeAgentTurn() {
        for index in agentBlocks.indices where !agentBlocks[index].done && (agentBlocks[index].kind == .thinking || agentBlocks[index].kind == .reply || agentBlocks[index].kind == .tool) {
            agentBlocks[index].done = true
        }
        agentIsRunning = false
        persistCurrentSession()
    }

    private var agentReuseKey: String {
        "\(currentSessionId)|\(agentWorkspace)|\(agentAllowWrites)|\(inferenceSource.rawValue)|\(displayModelName)|\(cloudBaseURL)|\(selectedContextSize)"
    }

    private func teardownAgent() {
        agentStdin = nil
        agentBoundKey = ""
        agentIsRunning = false
        agentBuffer = ""
        streamAlias = [:]
        guard let process = agentProcess else { return }
        agentProcess = nil
        if process.isRunning { process.terminate() }
    }

    private func writeAgentRaw(_ payload: [String: Any]) {
        guard let stdin = agentStdin, let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
        var line = data
        line.append(0x0A)
        stdin.write(line)
    }

    private func writeAgentCommand(prompt: String, images: [String], includeHistory: Bool) {
        writeAgentRaw(agentPayload(prompt: prompt, images: images, includeHistory: includeHistory))
    }

    private func agentPayload(prompt: String, images: [String], includeHistory: Bool) -> [String: Any] {
        var history: [[String: String]] = []
        if includeHistory {
            for block in agentBlocks.dropLast() {
                let text = block.text.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let clipped = String(text.prefix(8000))
                switch block.kind {
                case .user:
                    let attachments = block.filePaths.map { "\n[附件: \($0)]" }.joined()
                    history.append(["role": "user", "content": clipped + attachments])
                case .reply:
                    history.append(["role": "assistant", "content": clipped])
                case .tool:
                    history.append(["role": "assistant", "content": "[tool \(block.title)] \(String(clipped.prefix(400)))"])
                default:
                    break
                }
            }
        }
        return [
            "type": "prompt",
            "prompt": prompt,
            "history": history,
            "images": images,
            "contextSize": usesCloud ? 128_000 : localRuntimeContextSize
        ]
    }

    private func isNoiseStatus(_ text: String) -> Bool {
        ["pending", "running", "completed", "starting", "failed", "error", "cancelled", "canceled", "success"].contains(text.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
    }

    private func isImageFile(_ url: URL) -> Bool {
        ["png", "jpg", "jpeg", "gif", "webp", "tif", "tiff", "bmp", "heic"].contains(url.pathExtension.lowercased())
    }

    private func addDraftImage(from url: URL) -> Bool {
        guard draftImages.count < 4 else { return false }
        let ext = url.pathExtension.isEmpty ? "png" : url.pathExtension
        let dest = pastesDirectory().appendingPathComponent("\(UUID().uuidString).\(ext)")
        do {
            try FileManager.default.copyItem(at: url, to: dest)
            draftImages.append(dest.path)
            return true
        } catch {
            return false
        }
    }

    private func addDraftAttachments(_ urls: [URL]) -> Bool {
        var added = false
        for url in urls where url.isFileURL {
            if isImageFile(url), modelSupportsVision, draftImages.count < 4 {
                added = addDraftImage(from: url) || added
            } else if FileManager.default.fileExists(atPath: url.path), !draftFiles.contains(url.path), draftFiles.count < 8 {
                draftFiles.append(url.path)
                added = true
            }
        }
        return added
    }

    private func pngFromPasteboard(_ board: NSPasteboard) -> Data? {
        if let png = board.data(forType: .png) { return png }
        if let tiff = board.data(forType: .tiff) ?? NSImage(pasteboard: board)?.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiff) {
            return rep.representation(using: .png, properties: [:])
        }
        return nil
    }

    private func writePasteData(_ data: Data) -> String? {
        let dest = pastesDirectory().appendingPathComponent("\(UUID().uuidString).png")
        do {
            try data.write(to: dest, options: .atomic)
            return dest.path
        } catch {
            return nil
        }
    }

    private func pastesDirectory() -> URL {
        let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("local-harness-ai/pastes", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
}

private enum KeychainStore {
    static let service = "local.harness.ai"

    static func set(_ value: String, key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty, let data = value.data(using: .utf8) else { return }
        var add = query
        add[kSecValueData as String] = data
        SecItemAdd(add as CFDictionary, nil)
    }

    static func get(key: String) -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
}
