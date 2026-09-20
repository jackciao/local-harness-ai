import AppKit
import SwiftUI
import WebKit

struct ToolWorkspaceView: View {
    @EnvironmentObject private var store: LauncherStore
    let pane: ToolPane
    let close: () -> Void

    @State private var fileDirectoryPath = ""
    @State private var fileFilter = ""
    @State private var selectedFilePath = ""
    @State private var filePreview = ""
    @State private var browserAddress = ""
    @State private var browserRequest: URL?
    @State private var browserCommand = BrowserCommand.none
    @State private var canGoBack = false
    @State private var canGoForward = false
    @State private var terminalCommand = ""
    @State private var terminalOutput = ""
    @State private var terminalProcess: Process?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Palette.border)
            switch pane {
            case .files: files
            case .browser: browser
            case .terminal: terminal
            }
        }
        .background(Palette.sidebar)
        .onAppear { resetDirectoryIfNeeded() }
        .onChange(of: store.agentWorkspace) { _ in resetDirectoryIfNeeded() }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: pane.symbol)
            Text(pane.title).font(.system(size: 13, weight: .semibold))
            Spacer()
            Button(action: close) {
                Image(systemName: "rectangle.split.2x1")
                    .font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .help("隐藏")
        }
        .foregroundStyle(Palette.text)
        .padding(.horizontal, 14)
        .frame(height: 42)
    }

    private var files: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { goUp() } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain)
                    .disabled(activeDirectory.path == workspaceURL.path)
                Text(activeDirectory.lastPathComponent)
                    .font(.system(size: 12, weight: .medium))
                    .lineLimit(1)
                Spacer()
                Button { resetDirectoryIfNeeded(force: true) } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
            }
            .foregroundStyle(Palette.muted)
            .padding(.horizontal, 12)
            .frame(height: 36)
            TextField("筛选文件…", text: $fileFilter)
                .textFieldStyle(.roundedBorder)
                .padding(.horizontal, 12)
                .padding(.bottom, 8)
            HSplitView {
                List(fileEntries, id: \.self) { url in
                    Button { open(url) } label: {
                        Label(url.lastPathComponent, systemImage: isDirectory(url) ? "folder" : "doc")
                            .lineLimit(1)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(url.path == selectedFilePath ? Palette.accentSoft : Palette.text)
                }
                .listStyle(.sidebar)
                ScrollView {
                    if filePreview.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "folder")
                            Text("从工作区目录选择文件")
                        }
                        .foregroundStyle(Palette.muted)
                        .frame(maxWidth: .infinity, minHeight: 180)
                    } else {
                        Text(filePreview)
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundStyle(Palette.text)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(12)
                    }
                }
                .background(Palette.canvas)
            }
        }
    }

    private var browser: some View {
        VStack(spacing: 0) {
            HStack(spacing: 7) {
                Button { browserCommand = .back } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.plain)
                    .disabled(!canGoBack)
                Button { browserCommand = .forward } label: { Image(systemName: "chevron.right") }
                    .buttonStyle(.plain)
                    .disabled(!canGoForward)
                Button { browserCommand = .reload } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.plain)
                TextField("https://example.com", text: $browserAddress)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { openBrowserAddress() }
                Button("前往", action: openBrowserAddress)
                    .buttonStyle(.bordered)
            }
            .padding(10)
            BrowserWebView(requestURL: browserRequest, command: $browserCommand, address: $browserAddress, canGoBack: $canGoBack, canGoForward: $canGoForward)
                .background(Color(nsColor: .textBackgroundColor))
        }
    }

    private var terminal: some View {
        VStack(spacing: 0) {
            ScrollView {
                Text(terminalOutput.isEmpty ? "在工作区中执行 shell 命令。" : terminalOutput)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(terminalOutput.isEmpty ? Palette.muted : Palette.text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
            }
            .background(Palette.canvas)
            Divider().overlay(Palette.border)
            HStack(spacing: 8) {
                TextField("输入命令", text: $terminalCommand)
                    .textFieldStyle(.roundedBorder)
                    .font(.system(size: 12, design: .monospaced))
                    .onSubmit { runTerminal() }
                Button(terminalProcess == nil ? "执行" : "停止") {
                    terminalProcess == nil ? runTerminal() : terminalProcess?.terminate()
                }
                .buttonStyle(.borderedProminent)
                .disabled(terminalProcess == nil && terminalCommand.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(10)
        }
    }

    private var workspaceURL: URL {
        let path = store.agentWorkspace.isEmpty ? Bundle.main.bundleURL.deletingLastPathComponent().path : store.agentWorkspace
        return URL(fileURLWithPath: path, isDirectory: true)
    }

    private var activeDirectory: URL {
        let candidate = fileDirectoryPath.isEmpty ? workspaceURL : URL(fileURLWithPath: fileDirectoryPath, isDirectory: true)
        return FileManager.default.fileExists(atPath: candidate.path) ? candidate : workspaceURL
    }

    private var fileEntries: [URL] {
        let keys: Set<URLResourceKey> = [.isDirectoryKey]
        let entries = (try? FileManager.default.contentsOfDirectory(at: activeDirectory, includingPropertiesForKeys: Array(keys), options: [.skipsHiddenFiles])) ?? []
        return entries.filter { fileFilter.isEmpty || $0.lastPathComponent.localizedCaseInsensitiveContains(fileFilter) }
            .sorted {
                let leftDirectory = isDirectory($0)
                let rightDirectory = isDirectory($1)
                return leftDirectory == rightDirectory ? $0.lastPathComponent.localizedCompare($1.lastPathComponent) == .orderedAscending : leftDirectory
            }
    }

    private func resetDirectoryIfNeeded(force: Bool = false) {
        if force || !FileManager.default.fileExists(atPath: fileDirectoryPath) {
            fileDirectoryPath = workspaceURL.path
            selectedFilePath = ""
            filePreview = ""
        }
    }

    private func goUp() {
        guard activeDirectory.path != workspaceURL.path else { return }
        fileDirectoryPath = activeDirectory.deletingLastPathComponent().path
        selectedFilePath = ""
        filePreview = ""
    }

    private func isDirectory(_ url: URL) -> Bool {
        (try? url.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
    }

    private func open(_ url: URL) {
        if isDirectory(url) {
            fileDirectoryPath = url.path
            selectedFilePath = ""
            filePreview = ""
            return
        }
        selectedFilePath = url.path
        guard let data = try? Data(contentsOf: url, options: .mappedIfSafe) else {
            filePreview = "无法读取 \(url.lastPathComponent)。"
            return
        }
        guard data.count <= 1_000_000, !data.prefix(1024).contains(0) else {
            filePreview = "\(url.lastPathComponent) 是二进制文件或超过 1 MB，无法在此预览。"
            return
        }
        filePreview = String(decoding: data, as: UTF8.self)
    }

    private func openBrowserAddress() {
        var value = browserAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return }
        if !value.contains("://") { value = "https://\(value)" }
        guard let url = URL(string: value), let scheme = url.scheme, ["http", "https"].contains(scheme) else { return }
        browserAddress = url.absoluteString
        browserRequest = url
    }

    private func runTerminal() {
        let command = terminalCommand.trimmingCharacters(in: .whitespacesAndNewlines)
        guard terminalProcess == nil, !command.isEmpty else { return }
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-lc", command]
        process.currentDirectoryURL = workspaceURL
        process.standardOutput = output
        process.standardError = output
        terminalOutput += "\n$ \(command)\n"
        output.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async {
                terminalOutput = String((terminalOutput + text).suffix(100_000))
            }
        }
        process.terminationHandler = { finished in
            output.fileHandleForReading.readabilityHandler = nil
            DispatchQueue.main.async {
                terminalOutput += "\n[退出码 \(finished.terminationStatus)]\n"
                terminalProcess = nil
            }
        }
        do {
            try process.run()
            terminalProcess = process
            terminalCommand = ""
        } catch {
            output.fileHandleForReading.readabilityHandler = nil
            terminalOutput += "无法启动终端：\(error.localizedDescription)\n"
        }
    }
}

private enum BrowserCommand: Equatable { case none, back, forward, reload }

private struct BrowserWebView: NSViewRepresentable {
    var requestURL: URL?
    @Binding var command: BrowserCommand
    @Binding var address: String
    @Binding var canGoBack: Bool
    @Binding var canGoForward: Bool

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView()
        webView.navigationDelegate = context.coordinator
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        context.coordinator.parent = self
        if let requestURL, context.coordinator.loadedURL != requestURL {
            context.coordinator.loadedURL = requestURL
            webView.load(URLRequest(url: requestURL))
        }
        switch command {
        case .back: webView.goBack()
        case .forward: webView.goForward()
        case .reload: webView.reload()
        case .none: return
        }
        DispatchQueue.main.async { command = .none }
    }

    final class Coordinator: NSObject, WKNavigationDelegate {
        var parent: BrowserWebView
        var loadedURL: URL?

        init(_ parent: BrowserWebView) { self.parent = parent }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            DispatchQueue.main.async {
                self.parent.address = webView.url?.absoluteString ?? self.parent.address
                self.parent.canGoBack = webView.canGoBack
                self.parent.canGoForward = webView.canGoForward
            }
        }
    }
}
