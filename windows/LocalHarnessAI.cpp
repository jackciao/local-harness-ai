#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <wininet.h>

#include <string>

static std::wstring executableDirectory() {
    wchar_t path[MAX_PATH];
    GetModuleFileNameW(nullptr, path, MAX_PATH);
    std::wstring directory(path);
    return directory.substr(0, directory.find_last_of(L"\\/"));
}

static bool serverReady() {
    HINTERNET internet = InternetOpenW(L"local-harness-ai", INTERNET_OPEN_TYPE_PRECONFIG, nullptr, nullptr, 0);
    if (!internet) return false;
    HINTERNET request = InternetOpenUrlW(internet, L"http://127.0.0.1:7890/health", nullptr, 0, INTERNET_FLAG_RELOAD, 0);
    if (request) InternetCloseHandle(request);
    InternetCloseHandle(internet);
    return request != nullptr;
}

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
    wchar_t model[MAX_PATH] = {};
    OPENFILENAMEW dialog = {};
    dialog.lStructSize = sizeof(dialog);
    dialog.lpstrFilter = L"GGUF 模型 (*.gguf)\0*.gguf\0所有文件\0*.*\0";
    dialog.lpstrFile = model;
    dialog.nMaxFile = MAX_PATH;
    dialog.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST;
    dialog.lpstrTitle = L"选择本地 GGUF 模型";
    if (!GetOpenFileNameW(&dialog)) return 0;

    const std::wstring server = executableDirectory() + L"\\local-harness-ai-server.exe";
    const std::wstring command = L"\"" + server + L"\" -m \"" + model
        + L"\" -ngl 0 -c 8192 --host 127.0.0.1 --port 7890 -a qwen --jinja";
    STARTUPINFOW startup = { .cb = sizeof(startup) };
    PROCESS_INFORMATION process = {};
    if (!CreateProcessW(nullptr, const_cast<wchar_t *>(command.c_str()), nullptr, nullptr, FALSE,
                        CREATE_NO_WINDOW, nullptr, executableDirectory().c_str(), &startup, &process)) {
        MessageBoxW(nullptr, L"无法启动本地推理服务。", L"local-harness-ai", MB_ICONERROR);
        return 1;
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);

    for (int attempt = 0; attempt < 120 && !serverReady(); ++attempt) Sleep(500);
    ShellExecuteW(nullptr, L"open", L"http://127.0.0.1:7890", nullptr, nullptr, SW_SHOWNORMAL);
    return 0;
}
