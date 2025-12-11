#define _WINSOCK_DEPRECATED_NO_WARNINGS
#include <winsock2.h>
#include <windows.h>
#include <stdio.h>
#include <thread>
#include <atomic>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "user32.lib")
#pragma comment(lib, "kernel32.lib")

#define PORT 6741
#define BUFLEN 512

static HHOOK hookHandle = NULL;
static std::atomic<bool> blockingEnabled(false);
static HANDLE hStdinRead = NULL;
static HANDLE hStdinWrite = NULL;

void Log(const char* message) {
    FILE* f = fopen("C:\\Windows\\Temp\\keyblocker.log", "a");
    if (f) {
        fprintf(f, "[%lu] %s\n", GetTickCount(), message);
        fclose(f);
    }
}

LRESULT CALLBACK KeyboardProc(int nCode, WPARAM wParam, LPARAM lParam) {
    if (nCode >= 0 && blockingEnabled) {
        KBDLLHOOKSTRUCT* pKbdStruct = (KBDLLHOOKSTRUCT*)lParam;
        
        if ((pKbdStruct->vkCode == 0x5B || pKbdStruct->vkCode == 0x5C) &&
            (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
            Log("Blocked Windows key");
            return 1;
        }
    }
    
    return CallNextHookEx(hookHandle, nCode, wParam, lParam);
}

bool InstallHook() {
    hookHandle = SetWindowsHookExA(WH_KEYBOARD_LL, KeyboardProc, GetModuleHandle(NULL), 0);
    if (hookHandle == NULL) {
        Log("Failed to install keyboard hook");
        return false;
    }
    Log("Keyboard hook installed successfully");
    return true;
}

void ListenThread() {
    WSADATA wsaData;
    WSAStartup(MAKEWORD(2, 2), &wsaData);

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) {
        Log("Socket creation failed");
        return;
    }

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(6741);
    addr.sin_addr.s_addr = inet_addr("127.0.0.1");

    if (bind(sock, (struct sockaddr*)&addr, sizeof(addr)) == SOCKET_ERROR) {
        Log("Bind failed");
        closesocket(sock);
        return;
    }

    if (listen(sock, SOMAXCONN) == SOCKET_ERROR) {
        Log("Listen failed");
        closesocket(sock);
        return;
    }

    Log("TCP listener started on port 6741");

    while (true) {
        SOCKET client = accept(sock, NULL, NULL);
        if (client == INVALID_SOCKET) continue;

        char buffer[512] = {0};
        int bytes = recv(client, buffer, sizeof(buffer) - 1, 0);
        if (bytes > 0) {
            buffer[bytes] = '\0';
            if (strcmp(buffer, "BLOCK") == 0) {
                blockingEnabled = true;
                Log("Windows key blocking ENABLED");
                send(client, "OK", 2, 0);
            } else if (strcmp(buffer, "UNBLOCK") == 0) {
                blockingEnabled = false;
                Log("Windows key blocking DISABLED");
                send(client, "OK", 2, 0);
            }
        }
        closesocket(client);
    }

    closesocket(sock);
    WSACleanup();
}

int main() {
    Log("KeyBlocker starting");

    if (!InstallHook()) {
        return 1;
    }

    std::thread listener(ListenThread);
    listener.detach();

    MSG msg;
    while (GetMessage(&msg, NULL, 0, 0)) {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    return 0;
}
