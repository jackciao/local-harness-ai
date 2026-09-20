import Charts
import SwiftUI

enum Palette {
    static let canvas = Color(hex: 0x07111D)
    static let sidebar = Color(hex: 0x091522)
    static let panel = Color(hex: 0x0D1A29)
    static let panelRaised = Color(hex: 0x122235)
    static let input = Color(hex: 0x081521)
    static let border = Color(hex: 0x21354A)
    static let text = Color(hex: 0xEDF6FF)
    static let muted = Color(hex: 0x91A5BA)
    static let accent = Color(hex: 0x1EB9F3)
    static let accentSoft = Color(hex: 0x78D7FA)
    static let green = Color(hex: 0x42D67D)
    static let amber = Color(hex: 0xF6BD4A)
    static let red = Color(hex: 0xFF6D78)
}

enum DashboardSection: String, CaseIterable, Identifiable {
    case agent = "开发代理"
    case overview = "概览"
    case routes = "路由"
    case logs = "日志"
    case settings = "设置"

    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .agent: return "terminal.badge.gearshape"
        case .overview: return "rectangle.3.group"
        case .routes: return "point.3.connected.trianglepath.dotted"
        case .logs: return "list.bullet.rectangle"
        case .settings: return "gearshape"
        }
    }
}

struct DashboardView: View {
    @EnvironmentObject private var store: LauncherStore
    @State private var section = DashboardSection.agent

    var body: some View {
        VStack(spacing: 0) {
            TitleBar()
            Divider().overlay(Palette.border)

            if section == .agent {
                AgentWorkspaceView(selection: $section)
            } else {
                HStack(spacing: 0) {
                    Sidebar(selection: $section)
                        .frame(width: 188)
                    Divider().overlay(Palette.border)

                    Group {
                        switch section {
                        case .agent: EmptyView()
                        case .overview: OverviewContent()
                        case .routes: RoutesContent()
                        case .logs: LogsContent(expanded: true)
                        case .settings: SettingsContent()
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)

                    Divider().overlay(Palette.border)
                    RouteInspector()
                        .frame(width: 292)
                }
            }

            Divider().overlay(Palette.border)
            StatusBar()
        }
        .frame(minWidth: 1120, minHeight: 740)
        .background(Palette.canvas)
        .preferredColorScheme(.dark)
    }
}

private struct TitleBar: View {
    var body: some View {
        ZStack {
            Palette.sidebar
            Text("local-harness-ai")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.text)
        }
        .frame(height: 44)
    }
}

private struct Sidebar: View {
    @EnvironmentObject private var store: LauncherStore
    @Binding var selection: DashboardSection

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 11) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8).fill(Palette.accent.opacity(0.18))
                    Text("H")
                        .font(.system(size: 22, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.accent)
                }
                .frame(width: 38, height: 38)

                VStack(alignment: .leading, spacing: 2) {
                    Text("local-harness-ai")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Palette.text)
                    Text("Local model harness")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(Palette.muted)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 18)

            VStack(spacing: 5) {
                ForEach(DashboardSection.allCases) { item in
                    Button {
                        selection = item
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: item.symbol)
                                .frame(width: 18)
                            Text(item.rawValue)
                            Spacer()
                        }
                        .font(.system(size: 13, weight: selection == item ? .semibold : .regular))
                        .foregroundStyle(selection == item ? Palette.accentSoft : Palette.muted)
                        .padding(.horizontal, 12)
                        .frame(height: 38)
                        .background(selection == item ? Palette.panelRaised : Color.clear)
                        .overlay(alignment: .leading) {
                            if selection == item {
                                Rectangle().fill(Palette.accent).frame(width: 2)
                            }
                        }
                        .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)

            Spacer(minLength: 14)

            VStack(alignment: .leading, spacing: 10) {
                Label(store.isOnline ? "Online" : "Offline", systemImage: "circle.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(store.isOnline ? Palette.green : Palette.muted)
                Divider().overlay(Palette.border)
                SystemRow(label: "macOS", value: ProcessInfo.processInfo.operatingSystemVersionString.replacingOccurrences(of: "Version ", with: ""))
                SystemRow(label: "芯片", value: "Apple M4")
                SystemRow(label: "内存", value: store.memoryText)
                SystemRow(label: "后端", value: "Metal")
            }
            .padding(12)
            .background(Palette.panel)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .padding(10)
        }
        .background(Palette.sidebar)
    }
}

private struct SystemRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(spacing: 6) {
            Text(label).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).foregroundStyle(Palette.text).lineLimit(1)
        }
        .font(.system(size: 10))
    }
}

private struct OverviewContent: View {
    var body: some View {
        ScrollView {
            VStack(spacing: 12) {
                ServerStatusCard()
                ServerInfoStrip()
                PerformanceGrid()
                HStack(alignment: .top, spacing: 12) {
                    LogsContent(expanded: false)
                    ChatConsole()
                }
            }
            .padding(14)
        }
        .background(Palette.canvas)
    }
}

private struct ServerStatusCard: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        HStack(spacing: 14) {
            Circle()
                .fill(store.isOnline ? Palette.green : store.phase == .starting ? Palette.amber : Palette.muted)
                .frame(width: 14, height: 14)
                .shadow(color: store.isOnline ? Palette.green.opacity(0.45) : .clear, radius: 6)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    Text("Server Status:").fontWeight(.semibold)
                    Text(store.statusTitle).foregroundStyle(store.isOnline ? Palette.green : Palette.amber)
                }
                .font(.system(size: 15))
                Text(store.isOnline ? "llama.cpp 已连接并可处理请求。" : "本地模型尚未就绪。")
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.muted)
            }
            Spacer()
            Button {
                store.isOnline ? store.restartServer() : store.startServer()
            } label: {
                Label(store.isOnline ? (store.canControlServer ? "重启" : "外部服务") : "启动", systemImage: store.isOnline ? "arrow.clockwise" : "play.fill")
            }
            .buttonStyle(DashboardButtonStyle())
            .disabled(store.phase == .starting || (store.isOnline && !store.canControlServer))

            Button { store.stopServer() } label: {
                Label("停止", systemImage: "stop.fill")
            }
            .buttonStyle(DashboardButtonStyle(secondary: true))
            .disabled(!store.isOnline || !store.canControlServer)

            Button { store.testConnection() } label: {
                Label("测试链路", systemImage: "waveform.path.ecg")
            }
            .buttonStyle(DashboardButtonStyle(secondary: true))
        }
        .foregroundStyle(Palette.text)
        .panel()
    }
}

private struct ServerInfoStrip: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        HStack(spacing: 0) {
            InfoCell(title: "模型", value: store.localModelFileName, symbol: "cube")
            Separator()
            InfoCell(title: "地址", value: "127.0.0.1:7890", symbol: "network")
            Separator()
            InfoCell(title: "后端", value: "llama.cpp · Metal", symbol: "cpu")
            Separator()
            InfoCell(title: "运行时间", value: store.uptime, symbol: "clock")
        }
        .frame(height: 66)
        .background(Palette.panel)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private struct Separator: View {
    var body: some View { Rectangle().fill(Palette.border).frame(width: 1).padding(.vertical, 12) }
}

private struct InfoCell: View {
    let title: String
    let value: String
    let symbol: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: symbol).foregroundStyle(Palette.accent)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.system(size: 10)).foregroundStyle(Palette.muted)
                Text(value).font(.system(size: 12, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
            }
            Spacer(minLength: 4)
        }
        .padding(.horizontal, 12)
        .frame(maxWidth: .infinity)
    }
}

private struct PerformanceGrid: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        HStack(spacing: 12) {
            ContextCard().frame(minWidth: 245, maxWidth: 285)
            MetricCard(
                title: "输出速度",
                value: String(format: "%.1f", store.generationTPS),
                unit: "tok/s",
                subtitle: store.isGenerating ? "实时 slot" : "最近一次生成",
                color: Palette.accent,
                values: store.speedHistory
            )
            MetricCard(
                title: "提示词吞吐",
                value: String(format: "%.1f", store.promptTPS),
                unit: "tok/s",
                subtitle: "服务端计时",
                color: Palette.accentSoft,
                values: store.promptHistory
            )
            MetricCard(
                title: "首 token",
                value: store.ttftMilliseconds > 0 ? String(format: "%.0f", store.ttftMilliseconds) : "—",
                unit: "ms",
                subtitle: "TTFT",
                color: Palette.green,
                values: []
            )
        }
        .frame(minHeight: 188)
    }
}

private struct ContextCard: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("上下文容量", systemImage: "gauge.with.dots.needle.50percent")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.text)
            HStack(spacing: 16) {
                Gauge(value: Double(store.contextUsed), in: 0...Double(max(store.contextSize, 1))) {
                    EmptyView()
                } currentValueLabel: {
                    Text("\(store.contextSize / 1024)K")
                        .font(.system(size: 20, weight: .bold, design: .rounded))
                        .foregroundStyle(Palette.accent)
                }
                .gaugeStyle(.accessoryCircularCapacity)
                .tint(Palette.accent)
                .frame(width: 92, height: 92)

                VStack(alignment: .leading, spacing: 9) {
                    HStack {
                        Text("已用").foregroundStyle(Palette.muted)
                        Spacer()
                        Text("\(store.contextUsed.formatted())").foregroundStyle(Palette.text)
                    }
                    HStack {
                        Text("可用").foregroundStyle(Palette.muted)
                        Spacer()
                        Text("\(max(store.contextSize - store.contextUsed, 0).formatted())").foregroundStyle(Palette.text)
                    }
                    ProgressView(value: Double(store.contextUsed), total: Double(max(store.contextSize, 1)))
                        .tint(Palette.accent)
                }
                .font(.system(size: 10, design: .monospaced))
            }
            Text("默认 8K。超过 16K 在 16GB 机器上容易换页。")
                .font(.system(size: 9))
                .foregroundStyle(Palette.muted)
        }
        .panel()
    }
}

private struct MetricCard: View {
    let title: String
    let value: String
    let unit: String
    let subtitle: String
    let color: Color
    let values: [Double]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.text)
                Spacer()
                Image(systemName: "info.circle").foregroundStyle(Palette.muted)
            }
            Spacer(minLength: 2)
            Text(value)
                .font(.system(size: 28, weight: .medium, design: .rounded))
                .foregroundStyle(color)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            Text(unit).font(.system(size: 13)).foregroundStyle(Palette.text)
            Spacer(minLength: 2)
            if values.isEmpty {
                Rectangle().fill(Palette.border).frame(height: 1)
            } else {
                Sparkline(values: values, color: color).frame(height: 28)
            }
            Text(subtitle).font(.system(size: 9)).foregroundStyle(Palette.muted)
        }
        .frame(maxWidth: .infinity)
        .panel()
    }
}

private struct Sparkline: View {
    let values: [Double]
    let color: Color

    var body: some View {
        Chart(Array(values.enumerated()), id: \.offset) { index, value in
            LineMark(x: .value("sample", index), y: .value("tok/s", value))
                .foregroundStyle(color)
                .interpolationMethod(.catmullRom)
        }
        .chartXAxis(.hidden)
        .chartYAxis(.hidden)
        .chartLegend(.hidden)
    }
}

private struct LogsContent: View {
    @EnvironmentObject private var store: LauncherStore
    let expanded: Bool

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "活动日志", subtitle: "服务、速度与诊断") {
                Button("清空") { store.clearLogs() }.buttonStyle(.plain)
            }
            Divider().overlay(Palette.border)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(store.logs) { line in
                            HStack(alignment: .firstTextBaseline, spacing: 8) {
                                Text(Self.timeFormatter.string(from: line.date))
                                    .foregroundStyle(Palette.accentSoft)
                                Circle().fill(color(for: line.kind)).frame(width: 6, height: 6)
                                Text(line.text).foregroundStyle(Palette.text)
                            }
                            .font(.system(size: 10, design: .monospaced))
                            .id(line.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: store.logs.count) { _ in
                    if let id = store.logs.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
        }
        .frame(minHeight: expanded ? 560 : 260, maxHeight: expanded ? .infinity : 300)
        .background(Palette.panel)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .frame(maxWidth: .infinity)
        .padding(expanded ? 14 : 0)
        .background(expanded ? Palette.canvas : Color.clear)
    }

    private func color(for kind: ConsoleLine.Kind) -> Color {
        switch kind {
        case .info: return Palette.accent
        case .success: return Palette.green
        case .warning: return Palette.amber
        case .error: return Palette.red
        }
    }

    private static let timeFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()
}

private struct ChatConsole: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        VStack(spacing: 0) {
            PanelHeader(title: "Chat Console", subtitle: "本地流式验证") { EmptyView() }
            Divider().overlay(Palette.border)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(store.messages) { message in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(roleName(message.role))
                                    .font(.system(size: 10, weight: .semibold))
                                    .foregroundStyle(roleColor(message.role))
                                Text(message.content.isEmpty ? "…" : message.content)
                                    .font(.system(size: 11))
                                    .foregroundStyle(Palette.text)
                                    .textSelection(.enabled)
                            }
                            .id(message.id)
                        }
                    }
                    .padding(12)
                }
                .onChange(of: store.messages) { _ in
                    if let id = store.messages.last?.id { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            Divider().overlay(Palette.border)
            HStack(alignment: .bottom, spacing: 8) {
                TextEditor(text: $store.chatInput)
                    .font(.system(size: 11))
                    .foregroundStyle(Palette.text)
                    .scrollContentBackground(.hidden)
                    .background(Palette.input)
                    .frame(minHeight: 44, maxHeight: 62)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                Button { store.sendMessage() } label: {
                    Label("发送", systemImage: "paperplane.fill")
                }
                .buttonStyle(DashboardButtonStyle())
                .disabled(!store.isOnline || store.chatInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || store.isGenerating)
            }
            .padding(10)
        }
        .frame(minHeight: 260, maxHeight: 300)
        .background(Palette.panel)
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .frame(maxWidth: .infinity)
    }

    private func roleName(_ role: ChatMessage.Role) -> String {
        switch role { case .user: return "你"; case .assistant: return "Harness"; case .system: return "系统" }
    }

    private func roleColor(_ role: ChatMessage.Role) -> Color {
        switch role { case .user: return Palette.accentSoft; case .assistant: return Palette.green; case .system: return Palette.muted }
    }
}

private struct RouteInspector: View {
    @EnvironmentObject private var store: LauncherStore

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text("Claude Desktop / CC Switch")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Palette.text)
                    Spacer()
                    StatusPill(text: store.ccSwitchConnected ? "Connected" : "Offline", ok: store.ccSwitchConnected)
                }
                Text(store.ccSwitchConnected ? "路由已连接到本地模型。" : "等待 CC Switch 代理。")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.muted)

                VStack(spacing: 9) {
                    RouteRow(label: "Client", value: "Claude Desktop")
                    RouteRow(label: "Proxy", value: "127.0.0.1:15721")
                    RouteRow(label: "Upstream", value: "127.0.0.1:7890")
                    RouteRow(label: "Model", value: "qwen")
                }

                HStack(spacing: 8) {
                    Button { store.testConnection() } label: { Label(store.routeTestRunning ? "测试中…" : "测试路由", systemImage: "waveform.path.ecg") }
                        .buttonStyle(DashboardButtonStyle(secondary: true))
                        .disabled(store.routeTestRunning)
                    Button { store.copyRouteConfig() } label: { Label("复制", systemImage: "doc.on.doc") }
                        .buttonStyle(DashboardButtonStyle(secondary: true))
                }
                if !store.routeTestLines.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(store.routeTestLines, id: \.self) { line in
                            Text(line).font(.system(size: 10)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }

                Divider().overlay(Palette.border)
                Text("加速状态")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Palette.text)

                OptimizationRow(title: "Turbo KV", detail: "\(store.kvType) K/V Cache", state: "启用", color: Palette.green)
                OptimizationRow(
                    title: "N-gram Speculative",
                    detail: store.ngramEnabled ? "2–4 token · 接受率 \(store.ngramAcceptance.map { String(format: "%.1f%%", $0) } ?? "等待")" : "低接受率时会拖慢生成",
                    state: store.ngramEnabled ? "连续对话" : "关闭",
                    color: store.ngramEnabled ? Palette.amber : Palette.muted
                )

                Divider().overlay(Palette.border)
                VStack(alignment: .leading, spacing: 8) {
                    Text("运行配置").font(.system(size: 11, weight: .semibold)).foregroundStyle(Palette.text)
                    CodeLine("CTX=\(store.contextSize)")
                    CodeLine("KV=\(store.kvType)")
                    CodeLine("FLASH_ATTN=on")
                    CodeLine("SPEC=\(store.ngramEnabled ? 1 : 0)")
                    CodeLine("BATCH=512 · UBATCH=512")
                }
                .padding(12)
                .background(Palette.input)
                .overlay(RoundedRectangle(cornerRadius: 7).stroke(Palette.border))
                .clipShape(RoundedRectangle(cornerRadius: 7))

                Button { store.copyEndpoint() } label: {
                    Label("复制 OpenAI 地址", systemImage: "doc.on.clipboard")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(DashboardButtonStyle(secondary: true))
            }
            .padding(14)
        }
        .background(Palette.sidebar)
    }
}

private struct RouteRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack {
            Text(label).foregroundStyle(Palette.muted)
            Spacer()
            Text(value).foregroundStyle(Palette.text).textSelection(.enabled)
        }
        .font(.system(size: 10, design: .monospaced))
    }
}

private struct OptimizationRow: View {
    let title: String
    let detail: String
    let state: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Circle().fill(color).frame(width: 7, height: 7)
                Text(title).font(.system(size: 11, weight: .medium)).foregroundStyle(Palette.text)
                Spacer()
                Text(state).font(.system(size: 9, weight: .semibold)).foregroundStyle(color)
            }
            Text(detail).font(.system(size: 9)).foregroundStyle(Palette.muted).fixedSize(horizontal: false, vertical: true)
        }
        .padding(10)
        .background(Palette.panel)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 7))
    }
}

private struct CodeLine: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.system(size: 10, design: .monospaced)).foregroundStyle(Palette.accentSoft) }
}

private struct StatusBar: View {
    @EnvironmentObject private var store: LauncherStore
    var body: some View {
        HStack(spacing: 8) {
            Circle().fill(store.isOnline ? Palette.green : Palette.muted).frame(width: 8, height: 8)
            Text(store.isOnline ? "All systems operational" : "llama.cpp offline")
            Spacer()
            Text("输出速度 \(String(format: "%.1f", store.generationTPS)) tok/s")
            Text("·")
            Text("日志自动滚动")
        }
        .font(.system(size: 10))
        .foregroundStyle(Palette.muted)
        .padding(.horizontal, 16)
        .frame(height: 34)
        .background(Palette.sidebar)
    }
}

private struct RoutesContent: View {
    @EnvironmentObject private var store: LauncherStore
    var body: some View {
        Page(title: "路由", subtitle: "Claude Desktop → CC Switch → llama.cpp") {
            HStack(spacing: 12) {
                DetailCard(title: "Claude Desktop", value: "127.0.0.1:15721", detail: store.ccSwitchConnected ? "代理健康" : "代理未检测到", symbol: "desktopcomputer")
                DetailCard(title: "llama.cpp", value: "127.0.0.1:7890", detail: store.isOnline ? "上游健康" : "上游离线", symbol: "server.rack")
            }
            Button { store.testConnection() } label: { Label(store.routeTestRunning ? "测试中…" : "运行完整路由测试", systemImage: "waveform.path.ecg") }
                .buttonStyle(DashboardButtonStyle())
                .disabled(store.routeTestRunning)
            if !store.routeTestLines.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(store.routeTestLines, id: \.self) { line in
                        Text(line).font(.system(size: 11)).foregroundStyle(Palette.text)
                    }
                }
                .panel()
            }
        }
    }
}

private struct SettingsContent: View {
    @EnvironmentObject private var store: LauncherStore
    var body: some View {
        Page(title: "设置", subtitle: "先保存，再重启本地服务。未保存的更改在离开后会还原。") {
            VStack(alignment: .leading, spacing: 18) {
                Text("推理来源").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                Picker("推理来源", selection: $store.draft.inferenceSource) {
                    ForEach(InferenceSource.allCases) { item in
                        Text(item.rawValue).tag(item)
                    }
                }
                .pickerStyle(.segmented)

                if store.draft.inferenceSource == .local {
                    Text("本地模型文件").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                    HStack(spacing: 8) {
                        Text(store.draft.localModelPath.isEmpty ? "未选择 .gguf" : store.draft.localModelPath)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Palette.text)
                            .lineLimit(2)
                            .textSelection(.enabled)
                        Spacer()
                        Button("选择 GGUF") { store.chooseLocalModel() }
                            .buttonStyle(DashboardButtonStyle(secondary: true))
                    }
                    Toggle(isOn: $store.draft.localCompatibilityMode) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("兼容模式")
                            Text("自动选择加载方式、GPU 层和 Flash Attention；运行上下文上限为 4K，降低内存压力。")
                                .font(.system(size: 10))
                                .foregroundStyle(Palette.muted)
                        }
                    }
                    .toggleStyle(.switch)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("视觉投影 MMProj（可选）").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                        HStack(spacing: 8) {
                            Text(store.draft.localMMProjPath.isEmpty ? "文本模型无需选择；视觉模型请选择对应的 mmproj .gguf" : store.draft.localMMProjPath)
                                .font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(Palette.text)
                                .lineLimit(2)
                                .textSelection(.enabled)
                            Spacer()
                            if !store.draft.localMMProjPath.isEmpty {
                                Button("移除") { store.draft.localMMProjPath = "" }
                                    .buttonStyle(DashboardButtonStyle(secondary: true))
                            }
                            Button("选择 MMProj") { store.chooseMMProj() }
                                .buttonStyle(DashboardButtonStyle(secondary: true))
                        }
                    }
                    labeledField("聊天模板（可选）", text: $store.draft.localChatTemplate)
                    Text("仅在模型内置模板缺失或回复格式异常时填写，例如 llama3、chatml、mistral-v3。")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.muted)
                } else {
                    HStack {
                        Text("云配置").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                        Spacer()
                        Button { store.addDraftCloudProfile() } label: {
                            Label("添加配置", systemImage: "plus")
                        }
                        .buttonStyle(DashboardButtonStyle(secondary: true))
                    }
                    Picker("云配置", selection: Binding(
                        get: { store.draft.cloudProfileID },
                        set: { store.selectDraftCloudProfile($0) }
                    )) {
                        ForEach(store.draft.cloudProfiles) { profile in
                            Text(profile.label).tag(profile.id)
                        }
                    }
                    .pickerStyle(.menu)

                    Text("云厂商").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                    Picker("云厂商", selection: $store.draft.cloudPreset) {
                        ForEach(CloudPreset.allCases) { item in
                            Text(item.rawValue).tag(item)
                        }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: store.draft.cloudPreset) { preset in store.applyCloudPreset(preset) }

                    labeledField("Base URL", text: $store.draft.cloudBaseURL)
                    labeledField("模型 ID", text: $store.draft.cloudModelId)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("API Key").font(.system(size: 10)).foregroundStyle(Palette.muted)
                        SecureField("sk-…", text: $store.draft.cloudApiKey)
                            .textFieldStyle(.plain)
                            .padding(8)
                            .background(Palette.input)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                }

                if store.draft.inferenceSource == .local {
                    Divider().overlay(Palette.border)
                    Text("本地 llama.cpp").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                    Picker("上下文", selection: Binding(
                        get: { store.draft.contextTag },
                        set: { store.setDraftContextTag($0) }
                    )) {
                        ForEach(SettingsDraft.contextPresets, id: \.size) { item in
                            Text(item.size == 8_192 ? "\(item.label) · 推荐" : item.label).tag(item.size)
                        }
                        Text("自定义").tag(-1)
                    }
                    .pickerStyle(.menu)
                    if store.draft.contextTag == -1 {
                        labeledField("自定义 token 数", text: $store.draft.customContextText)
                    }
                    if store.draft.selectedContextSize > 16_384 || (Int(store.draft.customContextText) ?? 0) > 16_384 {
                        Text("16GB 统一内存上超过 16K 容易换页，生成会掉到 6 tok/s 左右。")
                            .font(.system(size: 10))
                            .foregroundStyle(Palette.amber)
                    }
                    Picker("KV Cache", selection: $store.draft.kvType) {
                        Text("q4_0 · 推荐").tag("q4_0")
                        Text("q8_0").tag("q8_0")
                    }
                    .pickerStyle(.segmented)
                    Toggle(isOn: $store.draft.ngramEnabled) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("N-gram 连续对话模式")
                            Text("只建议重复度高的多轮对话；此前 1.6–4.7% 接受率会负优化。")
                                .font(.system(size: 10))
                                .foregroundStyle(Palette.muted)
                        }
                    }
                    .toggleStyle(.switch)
                    Toggle(isOn: $store.draft.reasoningEnabled) {
                        VStack(alignment: .leading, spacing: 3) {
                            Text("深度思考")
                            Text("默认关闭。27B PTQ1_0 在 M4 上约 9 tok/s，思考链会把一次回复拖成几十秒。")
                                .font(.system(size: 10))
                                .foregroundStyle(Palette.muted)
                        }
                    }
                    .toggleStyle(.switch)
                }

                HStack(spacing: 8) {
                    Button {
                        _ = store.saveSettings()
                    } label: {
                        Label(store.settingsDirty ? "保存" : "已保存", systemImage: "square.and.arrow.down")
                    }
                    .buttonStyle(DashboardButtonStyle())
                    .disabled(!store.settingsDirty)
                    if store.draft.inferenceSource == .local || store.inferenceSource == .local {
                        Button { store.isOnline ? store.restartServer() : store.startServer() } label: {
                            Label(store.isOnline ? "重启并应用" : "启动并应用", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(DashboardButtonStyle(secondary: true))
                        .disabled(store.settingsDirty || (store.isOnline && !store.canControlServer))
                    }
                }
                if store.settingsDirty {
                    Text("有未保存的更改。保存后才会写入设置；本地服务再点重启才生效。")
                        .font(.system(size: 10))
                        .foregroundStyle(Palette.amber)
                }
            }
            .panel()
        }
        .onAppear { store.reloadDraft() }
    }

    private func labeledField(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 10)).foregroundStyle(Palette.muted)
            TextField(title, text: text)
                .textFieldStyle(.plain)
                .padding(8)
                .background(Palette.input)
                .clipShape(RoundedRectangle(cornerRadius: 6))
        }
    }
}

private struct Page<Content: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let content: Content

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title).font(.system(size: 22, weight: .semibold)).foregroundStyle(Palette.text)
                    Text(subtitle).font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                content
            }
            .padding(18)
        }
        .background(Palette.canvas)
    }
}

private struct DetailCard: View {
    let title: String
    let value: String
    let detail: String
    let symbol: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.system(size: 22))
                .foregroundStyle(Palette.accent)
                .frame(width: 38)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 10)).foregroundStyle(Palette.muted)
                Text(value).font(.system(size: 15, weight: .semibold)).foregroundStyle(Palette.text).lineLimit(1)
                Text(detail).font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            Spacer()
        }
        .panel()
        .frame(maxWidth: .infinity)
    }
}

private struct PanelHeader<Trailing: View>: View {
    let title: String
    let subtitle: String
    @ViewBuilder let trailing: Trailing

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                Text(subtitle).font(.system(size: 9)).foregroundStyle(Palette.muted)
            }
            Spacer()
            trailing.foregroundStyle(Palette.muted).font(.system(size: 10))
        }
        .padding(.horizontal, 12)
        .frame(height: 48)
    }
}

private struct StatusPill: View {
    let text: String
    let ok: Bool
    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ok ? Palette.green : Palette.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background((ok ? Palette.green : Palette.muted).opacity(0.08))
            .overlay(Capsule().stroke((ok ? Palette.green : Palette.muted).opacity(0.45)))
            .clipShape(Capsule())
    }
}

private struct DashboardButtonStyle: ButtonStyle {
    var secondary = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(secondary ? Palette.text : Palette.canvas)
            .padding(.horizontal, 12)
            .frame(height: 32)
            .background(secondary ? Palette.panelRaised : Palette.accent)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(secondary ? Palette.border : Palette.accent))
            .clipShape(RoundedRectangle(cornerRadius: 6))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

private extension View {
    func panel() -> some View {
        padding(14)
            .background(Palette.panel)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }
}

private extension Color {
    init(hex: UInt32) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255
        )
    }
}
