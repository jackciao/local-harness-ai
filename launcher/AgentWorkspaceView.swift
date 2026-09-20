import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct AgentWorkspaceView: View {
    @EnvironmentObject private var store: LauncherStore
    @Binding var selection: DashboardSection
    @State private var sessionPendingDelete: String?
    @State private var collapsedProjects: Set<String> = []
    @State private var pasteMonitor: Any?
    @State private var renamingId: String?
    @State private var renameDraft = ""
    @State private var toolLauncherPresented = false

    var body: some View {
        VStack(spacing: 0) {
            toolbar
            Divider().overlay(Palette.border)
            HStack(spacing: 0) {
                taskSidebar.frame(width: 246)
                Divider().overlay(Palette.border)
                conversation.frame(maxWidth: .infinity, maxHeight: .infinity)
                if store.openToolPane != nil {
                    Divider().overlay(Palette.border)
                    ToolWorkspaceView(pane: store.openToolPane ?? .files) {
                        store.openToolPane = nil
                    }
                    .frame(width: 440)
                }
            }
        }
        .background(Palette.canvas)
        .onAppear { installPasteMonitor() }
        .onDisappear { removePasteMonitor() }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Image(systemName: "folder")
                .foregroundStyle(Palette.text)
            Text(store.currentDisplayTitle)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(Palette.text)
                .lineLimit(1)
            Spacer()
            WorkspacePill(text: store.usesCloud ? "云 API" : (store.isOnline ? "本机模型在线" : "模型未启动"), active: store.usesCloud || store.isOnline)
            Button { selection = .overview } label: {
                Label("模型状态", systemImage: "gauge.with.dots.needle.50percent")
            }
            .buttonStyle(WorkspaceButtonStyle(quiet: true))
            Button { toolLauncherPresented.toggle() } label: {
                Image(systemName: "sidebar.right")
            }
            .buttonStyle(WorkspaceButtonStyle(quiet: true))
            .help("工具面板")
            .popover(isPresented: $toolLauncherPresented, arrowEdge: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(ToolPane.allCases, id: \.self) { pane in
                        Button {
                            store.openToolPane = pane
                            toolLauncherPresented = false
                        } label: {
                            Label(pane.title, systemImage: pane.symbol)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal, 10)
                                .frame(height: 32)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(8)
                .frame(width: 170)
            }
        }
        .padding(.horizontal, 16)
        .frame(height: 46)
        .background(Palette.sidebar)
    }

    private var taskSidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("local-harness-ai")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Palette.text)
                Spacer()
                Image(systemName: "bell")
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.muted)
            }
            .padding(.horizontal, 15)
            .padding(.top, 18)

            Button {
                store.newAgentSession()
            } label: {
                Label("新对话", systemImage: "square.and.pencil")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(WorkspaceButtonStyle(quiet: true))
            .padding(.horizontal, 10)
            .padding(.top, 15)

            VStack(alignment: .leading, spacing: 7) {
                Text("项目")
                    .workspaceLabel()
                ScrollView {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(store.sessionsByProject, id: \.path) { group in
                            projectGroup(group)
                        }
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 20)
            .confirmationDialog("删除这个会话？工作区里的文件不会被删。", isPresented: Binding(
                get: { sessionPendingDelete != nil },
                set: { if !$0 { sessionPendingDelete = nil } }
            )) {
                Button("删除", role: .destructive) {
                    if let id = sessionPendingDelete { store.deleteSession(id) }
                    sessionPendingDelete = nil
                }
                Button("取消", role: .cancel) { sessionPendingDelete = nil }
            }

            Spacer()
            Divider().overlay(Palette.border)
            Button { selection = .overview } label: {
                Label("本地模型运行状态", systemImage: "chart.xyaxis.line")
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(WorkspaceButtonStyle(quiet: true))
            .padding(10)
        }
        .background(Palette.sidebar)
    }

    private func projectGroup(_ group: (path: String, name: String, items: [AgentSession])) -> some View {
        let collapsed = collapsedProjects.contains(group.path)
        return VStack(alignment: .leading, spacing: 2) {
            Button {
                if collapsed { collapsedProjects.remove(group.path) } else { collapsedProjects.insert(group.path) }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "folder")
                    Text(group.name.isEmpty ? group.path : group.name)
                        .lineLimit(1)
                    Spacer()
                }
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(Palette.text)
                .padding(.horizontal, 11)
                .padding(.vertical, 6)
            }
            .buttonStyle(.plain)
            if !collapsed {
                ForEach(group.items) { session in
                    sessionRow(session)
                }
            }
        }
    }

    private func sessionRow(_ session: AgentSession) -> some View {
        HStack(spacing: 0) {
            if renamingId == session.id {
                TextField("会话名称", text: $renameDraft)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Palette.text)
                    .padding(.leading, 22)
                    .padding(.trailing, 8)
                    .padding(.vertical, 7)
                    .onSubmit { commitRename() }
                    .onExitCommand { renamingId = nil }
            } else {
                Text(store.displayTitle(session))
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(session.id == store.currentSessionId ? Palette.accentSoft : Palette.text)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.leading, 22)
                    .padding(.trailing, 8)
                    .padding(.vertical, 7)
                    .contentShape(Rectangle())
                    .onTapGesture { store.selectSession(session.id) }
                    .highPriorityGesture(TapGesture(count: 2).onEnded { beginRename(session) })
                    .contextMenu {
                        Button("重命名") { beginRename(session) }
                        Button("删除", role: .destructive) { sessionPendingDelete = session.id }
                    }
            }
            Button {
                sessionPendingDelete = session.id
            } label: {
                Image(systemName: "trash")
                    .font(.system(size: 10))
                    .foregroundStyle(Palette.muted)
                    .frame(width: 28, height: 28)
            }
            .buttonStyle(.plain)
        }
        .background(session.id == store.currentSessionId ? Palette.panelRaised : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 18) {
                        ForEach(store.agentBlocks) { block in
                            TranscriptBlock(block: block).id(block.id)
                        }
                        if store.agentIsRunning {
                            SystemEvent(icon: "ellipsis", title: "正在推理", detail: "已发送，正在等待模型思考或调用工具。")
                                .id("running")
                        }
                    }
                }
                .padding(.horizontal, 28)
                .padding(.vertical, 26)
                .onChange(of: store.agentBlocks) { _ in
                    proxy.scrollTo(store.agentBlocks.last?.id ?? "ready", anchor: .bottom)
                }
            }
            Divider().overlay(Palette.border)
            composer
        }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !store.draftImages.isEmpty || !store.draftFiles.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(store.draftImages, id: \.self) { path in
                            ZStack(alignment: .topTrailing) {
                                DraftThumb(path: path)
                                Button { store.removeDraftImage(path) } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 12))
                                        .foregroundStyle(Palette.text)
                                }
                                .buttonStyle(.plain)
                                .offset(x: 4, y: -4)
                            }
                        }
                        ForEach(store.draftFiles, id: \.self) { path in
                            AttachmentChip(path: path) { store.removeDraftFile(path) }
                        }
                    }
                    .padding(.horizontal, 2)
                }
            }
            TextEditor(text: $store.agentDraft)
                .font(.system(size: 13))
                .foregroundStyle(Palette.text)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 72, maxHeight: 102)
                .padding(7)
                .background(Palette.input)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onDrop(of: [UTType.fileURL.identifier], isTargeted: nil) { providers in
                    for provider in providers {
                        _ = provider.loadObject(ofClass: URL.self) { url, _ in
                            guard let url else { return }
                            Task { @MainActor in _ = store.addDroppedAttachments([url]) }
                        }
                    }
                    return !providers.isEmpty
                }
            HStack(spacing: 9) {
                Button { store.chooseAgentWorkspace() } label: {
                    Image(systemName: "folder.badge.plus")
                }
                .buttonStyle(WorkspaceButtonStyle(quiet: true))
                .help("选择项目并开始对话")
                Button { store.chooseAttachments() } label: {
                    Image(systemName: "paperclip")
                }
                .buttonStyle(WorkspaceButtonStyle(quiet: true))
                .help("添加图片或文件")
                Toggle(isOn: $store.agentAllowWrites) {
                    Text(store.agentAllowWrites ? "可写 · 工具已开" : "只读")
                        .font(.system(size: 11, weight: .medium))
                }
                .toggleStyle(.switch)
                .controlSize(.small)
                .tint(Palette.accent)
                .onChange(of: store.agentAllowWrites) { _ in store.persistCurrentSession() }
                Spacer()
                Menu {
                    if store.savedLocalAvailable {
                        Button {
                            store.selectInferenceSource(.local)
                        } label: {
                            Text(store.usesCloud ? "本地 · \(store.localModelFileName)" : "✓ 本地 · \(store.localModelFileName)")
                        }
                    }
                    ForEach(store.cloudProfiles.filter(store.cloudProfileAvailable)) { profile in
                        Button {
                            store.selectCloudProfile(profile.id)
                        } label: {
                            Text(store.usesCloud && store.cloudProfileID == profile.id ? "✓ \(profile.label)" : profile.label)
                        }
                    }
                } label: {
                    Text(store.displayModelName)
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(Palette.text)
                        .lineLimit(1)
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                Button {
                    store.agentIsRunning ? store.stopDeveloperAgent() : store.launchDeveloperAgent()
                } label: {
                    Image(systemName: store.agentIsRunning ? "stop.fill" : "arrow.up")
                }
                .buttonStyle(WorkspaceButtonStyle())
                .disabled(!store.agentIsRunning && !store.agentCanSend)
            }
        }
        .padding(14)
        .background(Palette.panel)
    }

    private func beginRename(_ session: AgentSession) {
        renamingId = session.id
        renameDraft = store.displayTitle(session)
    }

    private func commitRename() {
        guard let id = renamingId else { return }
        store.renameSession(id, to: renameDraft)
        renamingId = nil
    }

    private func installPasteMonitor() {
        removePasteMonitor()
        pasteMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            let command = event.modifierFlags.contains(.command)
            let v = event.charactersIgnoringModifiers?.lowercased() == "v"
            if command, v, store.pasteAttachmentsFromClipboard() { return nil }
            return event
        }
    }

    private func removePasteMonitor() {
        if let pasteMonitor { NSEvent.removeMonitor(pasteMonitor) }
        pasteMonitor = nil
    }
}

private struct TranscriptBlock: View {
    let block: AgentBlock
    @State private var expanded = false

    var body: some View {
        switch block.kind {
        case .user:
            PromptBubble(block: block)
        case .thinking:
            VStack(alignment: .leading, spacing: 8) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "brain.head.profile")
                        Text(block.done ? "思考过程" : "正在思考")
                            .textSelection(.enabled)
                        Spacer()
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.muted)
                }
                .buttonStyle(.plain)
                if expanded {
                    Text(block.text.isEmpty ? "…" : block.text)
                        .font(.system(size: 12))
                        .foregroundStyle(Palette.muted)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .leading) { Rectangle().fill(Palette.border).frame(width: 2) }
        case .reply:
            VStack(alignment: .leading, spacing: 7) {
                Text(block.title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.green)
                    .textSelection(.enabled)
                Text(block.text.isEmpty ? "…" : block.text)
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .tool:
            VStack(alignment: .leading, spacing: 8) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "wrench.and.screwdriver")
                            .frame(width: 16)
                        Text(block.done ? "工具 · \(block.title)" : "调用 \(block.title)")
                        Spacer()
                        Image(systemName: expanded ? "chevron.down" : "chevron.right")
                    }
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Palette.accentSoft)
                }
                .buttonStyle(.plain)
                if expanded, !block.text.isEmpty {
                    Text(block.text)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(Palette.muted)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Palette.panelRaised)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        case .status:
            SystemEvent(icon: "checkmark.shield", title: block.title, detail: block.text)
        case .error:
            SystemEvent(icon: "exclamationmark.triangle.fill", title: block.title, detail: block.text)
        }
    }
}

private struct SystemEvent: View {
    let icon: String
    let title: String
    let detail: String
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon).foregroundStyle(Palette.muted).frame(width: 16)
            VStack(alignment: .leading, spacing: 5) {
                Text(title).font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text).textSelection(.enabled)
                Text(detail).font(.system(size: 12)).foregroundStyle(Palette.muted).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

private struct PromptBubble: View {
    let block: AgentBlock
    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("你")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Palette.accentSoft)
                .textSelection(.enabled)
            if !block.imagePaths.isEmpty {
                HStack(spacing: 8) {
                    ForEach(block.imagePaths, id: \.self) { path in
                        DraftThumb(path: path, size: 88)
                    }
                }
            }
            if !block.filePaths.isEmpty {
                HStack(spacing: 8) {
                    ForEach(block.filePaths, id: \.self) { path in
                        AttachmentChip(path: path)
                    }
                }
            }
            if !block.text.isEmpty {
                Text(block.text)
                    .font(.system(size: 13))
                    .foregroundStyle(Palette.text)
                    .textSelection(.enabled)
            }
        }
        .padding(14)
        .background(Palette.panelRaised)
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

private struct AttachmentChip: View {
    let path: String
    var remove: (() -> Void)? = nil

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "doc")
                .foregroundStyle(Palette.accentSoft)
            Text(URL(fileURLWithPath: path).lastPathComponent)
                .lineLimit(1)
            if let remove {
                Button(action: remove) {
                    Image(systemName: "xmark.circle.fill")
                }
                .buttonStyle(.plain)
            }
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 9)
        .frame(height: 34)
        .background(Palette.panelRaised)
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(Palette.border))
        .clipShape(RoundedRectangle(cornerRadius: 7))
        .help(path)
    }
}

private struct DraftThumb: View {
    let path: String
    var size: CGFloat = 56
    var body: some View {
        Group {
            if let image = NSImage(contentsOfFile: path) {
                Image(nsImage: image)
                    .resizable()
                    .aspectRatio(contentMode: .fill)
            } else {
                RoundedRectangle(cornerRadius: 6).fill(Palette.panelRaised)
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Palette.border))
    }
}

private struct WorkspacePill: View {
    let text: String
    let active: Bool
    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(active ? Palette.green : Palette.muted)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background((active ? Palette.green : Palette.muted).opacity(0.09))
            .clipShape(Capsule())
    }
}

private struct WorkspaceButtonStyle: ButtonStyle {
    var quiet = false
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(quiet ? Palette.text : Palette.canvas)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(quiet ? (configuration.isPressed ? Palette.panelRaised : Color.clear) : Palette.accent)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

private extension View {
    func workspaceLabel() -> some View {
        font(.system(size: 10, weight: .semibold))
            .foregroundStyle(Palette.muted)
            .textCase(.uppercase)
    }
}
