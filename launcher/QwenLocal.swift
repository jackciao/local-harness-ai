import AppKit
import Darwin
import SwiftUI

@main
struct LocalHarnessAIApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            DashboardView()
                .environmentObject(appDelegate.store)
        }
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 1360, height: 880)
        .commands {
            CommandGroup(after: .appInfo) {
                Button(appDelegate.store.isOnline ? "重新启动模型" : "启动模型") {
                    appDelegate.store.isOnline ? appDelegate.store.restartServer() : appDelegate.store.startServer()
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])

                Button("测试完整链路") { appDelegate.store.testConnection() }
                    .keyboardShortcut("t", modifiers: [.command, .shift])
            }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let store = LauncherStore()
    private var terminationSignal: DispatchSourceSignal?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Darwin.signal(SIGTERM, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        source.setEventHandler { NSApp.terminate(nil) }
        source.resume()
        terminationSignal = source
        store.bootstrap()
        NSApp.setActivationPolicy(.regular)
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        terminationSignal?.cancel()
        store.shutdown()
    }
}
