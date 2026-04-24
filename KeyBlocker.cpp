#define _WINSOCK_DEPRECATED_NO_WARNINGS
#define WINVER       0x0600
#define _WIN32_WINNT 0x0600
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <thread>
#include <atomic>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "kernel32.lib")

#define PORT 6741

static HHOOK            hookHandle     = NULL;
static std::atomic<bool> blockingEnabled(false);
static HWND             shutdownWindow = NULL;

// ── Logging ───────────────────────────────────────────────────────────────────

void Log(const char* message) {
    FILE* f = fopen("C:\\Windows\\Temp\\keyblocker.log", "a");
    if (f) {
        fprintf(f, "[%lu] %s\n", GetTickCount(), message);
        fclose(f);
    }
}

// ── Keyboard hook ─────────────────────────────────────────────────────────────

LRESULT CALLBACK KeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0 && blockingEnabled) {
        KBDLLHOOKSTRUCT* p = (KBDLLHOOKSTRUCT*)lParam;
        DWORD vk       = p->vkCode;
        bool  altHeld  = (p->flags & LLKHF_ALTDOWN) != 0;
        bool  ctrlHeld = (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0;

        bool isWinKey = (vk == 0x5B || vk == 0x5C);

        bool block =
            isWinKey                                               ||  // Left/Right Win
            (vk == VK_LMENU || vk == VK_RMENU || vk == VK_MENU)  ||  // Alt key itself
            altHeld                                                ||  // Alt+Tab, Alt+F4, etc.
            (ctrlHeld && vk == VK_ESCAPE)                         ||  // Ctrl+Esc (Start) & Ctrl+Shift+Esc (Task Mgr)
            (vk == VK_SNAPSHOT)                                   ||  // Print Screen
            (vk == VK_F11);                                           // F11 fullscreen toggle

        bool isDown = (wParam == WM_KEYDOWN   || wParam == WM_SYSKEYDOWN);
        bool isUp   = (wParam == WM_KEYUP     || wParam == WM_SYSKEYUP);

        if (block && (isDown || (isWinKey && isUp))) {
            Log("Blocked key");
            return 1;
        }
    }
    return CallNextHookEx(hookHandle, nCode, wParam, lParam);
}

bool InstallHook() {
    hookHandle = SetWindowsHookExA(WH_KEYBOARD_LL, KeyboardProc, GetModuleHandle(NULL), 0);
    if (!hookHandle) { Log("Failed to install keyboard hook"); return false; }
    Log("Keyboard hook installed");
    return true;
}

// ── Taskbar visibility ────────────────────────────────────────────────────────

void SetTaskbarVisibility(bool visible) {
    int cmd = visible ? SW_SHOW : SW_HIDE;

    HWND taskbar = FindWindowW(L"Shell_TrayWnd", NULL);
    if (taskbar) ShowWindow(taskbar, cmd);

    // Secondary taskbars on additional monitors
    HWND secondary = NULL;
    while ((secondary = FindWindowExW(NULL, secondary, L"Shell_SecondaryTrayWnd", NULL)) != NULL)
        ShowWindow(secondary, cmd);
}

// ── Shutdown/sleep blocker ────────────────────────────────────────────────────

LRESULT CALLBACK ShutdownWndProc(HWND hwnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (blockingEnabled) {
        if (msg == WM_QUERYENDSESSION) { Log("Blocked shutdown/logoff"); return 0; }
        if (msg == WM_ENDSESSION)      { return 0; }
    }
    return DefWindowProcW(hwnd, msg, wParam, lParam);
}

HWND CreateShutdownBlockerWindow() {
    WNDCLASSEXW wc = { sizeof(wc) };
    wc.lpfnWndProc   = ShutdownWndProc;
    wc.hInstance     = GetModuleHandle(NULL);
    wc.lpszClassName = L"KBShutdown";
    RegisterClassExW(&wc);
    // Hidden window — never shown, exists only to receive WM_QUERYENDSESSION
    return CreateWindowExW(0, L"KBShutdown", L"", WS_OVERLAPPED,
        0, 0, 1, 1, NULL, NULL, GetModuleHandle(NULL), NULL);
}

// ── TCP command listener ──────────────────────────────────────────────────────

void ListenThread() {
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { Log("Socket creation failed"); return; }

    int reuse = 1;
    setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, (const char*)&reuse, sizeof(reuse));

    struct sockaddr_in addr = {};
    addr.sin_family      = AF_INET;
    addr.sin_port        = htons(PORT);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        Log("Bind failed"); closesocket(sock); return;
    }
    if (listen(sock, SOMAXCONN) == SOCKET_ERROR) {
        Log("Listen failed"); closesocket(sock); return;
    }
    Log("TCP listener started on port 6741");

    while (true) {
        SOCKET client = accept(sock, NULL, NULL);
        if (client == INVALID_SOCKET) continue;

        char buf[512] = {};
        int bytes = recv(client, buf, sizeof(buf) - 1, 0);
        if (bytes > 0) {
            buf[bytes] = '\0';
            if (strcmp(buf, "BLOCK") == 0) {
                blockingEnabled = true;
                SetTaskbarVisibility(false);
                // Prevent display sleep and system sleep during exam
                SetThreadExecutionState(ES_CONTINUOUS | ES_DISPLAY_REQUIRED | ES_SYSTEM_REQUIRED);
                if (shutdownWindow) ShutdownBlockReasonCreate(shutdownWindow, L"Exam in progress");
                Log("BLOCK: locked");
                send(client, "OK", 2, 0);
            } else if (strcmp(buf, "UNBLOCK") == 0) {
                blockingEnabled = false;
                SetTaskbarVisibility(true);
                SetThreadExecutionState(ES_CONTINUOUS);
                if (shutdownWindow) ShutdownBlockReasonDestroy(shutdownWindow);
                Log("UNBLOCK: unlocked");
                send(client, "OK", 2, 0);
            }
        }
        closesocket(client);
    }

    closesocket(sock);
    WSACleanup();
}

// ── Entry point ───────────────────────────────────────────────────────────────

int main() {
    Log("KeyBlocker starting");

    if (!InstallHook()) return 1;

    shutdownWindow = CreateShutdownBlockerWindow();

    std::thread(ListenThread).detach();

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }
    return 0;
}
