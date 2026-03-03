import Foundation
import Cocoa

class KeyBlocker {
    private var isBlocking = false
    private var eventTap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private let serverPort = 6741
    private var serverSocket: CFSocket?
    
    func start() {
        print("KeyBlocker: Starting macOS version")
        startServer()
    }
    
    private func startServer() {
        DispatchQueue.global().async {
            var serverAddress = sockaddr_in(
                sin_len: __uint8_t(MemoryLayout<sockaddr_in>.size),
                sin_family: sa_family_t(AF_INET),
                sin_port: in_port_t(self.serverPort).bigEndian,
                sin_addr: in_addr(s_addr: inet_addr("127.0.0.1")),
                sin_zero: (0, 0, 0, 0, 0, 0, 0, 0)
            )
            
            var context = CFSocketContext(
                version: 0,
                info: UnsafeMutableRawPointer(Unmanaged.passRetained(self).toOpaque()),
                retain: nil,
                release: nil,
                copyDescription: nil
            )
            
            let socket = CFSocketCreate(
                kCFAllocatorDefault,
                PF_INET,
                SOCK_STREAM,
                IPPROTO_TCP,
                CFSocketCallBackType.acceptCallBack.rawValue,
                { (socket, type, address, data, info) in
                    if let info = info {
                        let blocker = Unmanaged<KeyBlocker>.fromOpaque(info).takeUnretainedValue()
                        blocker.handleConnection(socket: socket, data: data)
                    }
                },
                &context
            )
            
            guard let socket = socket else {
                print("KeyBlocker: Failed to create socket")
                return
            }
            
            var addressData = withUnsafeBytes(of: &serverAddress) { Data($0) }
            let address = CFDataCreate(kCFAllocatorDefault, (addressData as NSData).bytes.bindMemory(to: UInt8.self, capacity: addressData.count), addressData.count)
            
            if CFSocketSetAddress(socket, address) != .success {
                print("KeyBlocker: Failed to bind socket")
                CFSocketInvalidate(socket)
                return
            }
            
            let runLoopSource = CFSocketCreateRunLoopSource(kCFAllocatorDefault, socket, 0)
            CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
            
            self.serverSocket = socket
            self.runLoopSource = runLoopSource
            
            print("KeyBlocker: Server listening on 127.0.0.1:\(self.serverPort)")
            CFRunLoopRun()
        }
    }
    
    private func handleConnection(socket: CFSocket, data: UnsafeRawPointer?) {
        DispatchQueue.global().async {
            if let clientSocket = CFSocketCreateWithNative(
                kCFAllocatorDefault,
                CFSocketGetNative(socket),
                .dataCallBack,
                { (socket, type, address, data, info) in
                    if let data = data {
                        let dataRef = Unmanaged<CFData>.fromOpaque(data).takeUnretainedValue()
                        if let command = String(data: dataRef as Data, encoding: .utf8) {
                            if let info = info {
                                let blocker = Unmanaged<KeyBlocker>.fromOpaque(info).takeUnretainedValue()
                                blocker.processCommand(command.trimmingCharacters(in: .whitespaces))
                            }
                        }
                    }
                },
                nil
            ) {
                CFSocketInvalidate(clientSocket)
            }
        }
    }
    
    private func processCommand(_ command: String) {
        print("KeyBlocker: Received command: \(command)")
        if command == "BLOCK" {
            isBlocking = true
            enableKeyBlocker()
        } else if command == "UNBLOCK" {
            isBlocking = false
            disableKeyBlocker()
        }
    }
    
    private func enableKeyBlocker() {
        // On macOS, Command key blocking requires accessibility permissions
        // This is a simplified version that logs the block request
        print("KeyBlocker: Blocking Command key")
        
        let options: NSDictionary = [
            kAXTrustedCheckOptionPrompt.takeRetainedValue() as String: true
        ]
        let trusted = AXIsProcessTrustedWithOptions(options as CFDictionary? )
        
        if !trusted {
            print("KeyBlocker: Accessibility permissions required")
            return
        }
        
        setupEventTap()
    }
    
    private func disableKeyBlocker() {
        print("KeyBlocker: Unblocking Command key")
        if let eventTap = eventTap {
            CFMachPortInvalidate(eventTap)
            self.eventTap = nil
        }
    }
    
    private func setupEventTap() {
        let eventMask = (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
        
        guard let eventTap = CGEvent.tapCreate(
            tap: .cghidEventTap,
            place: .headInsertEventTap,
            options: .defaultTap,
            eventsOfInterest: CGEventMask(eventMask),
            callback: { (proxy, type, event, refcon) -> Unmanaged<CGEvent>? in
                if let refcon = refcon {
                    let blocker = Unmanaged<KeyBlocker>.fromOpaque(refcon).takeUnretainedValue()
                    if blocker.isBlocking {
                        let flags = event.flags
                        if flags.contains(.maskCommand) {
                            print("KeyBlocker: Blocked Command key")
                            return nil
                        }
                    }
                }
                return Unmanaged.passRetained(event)
            },
            userInfo: Unmanaged.passRetained(self).toOpaque()
        ) else {
            print("KeyBlocker: Failed to create event tap")
            return
        }
        
        let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        CFRunLoopAddSource(CFRunLoopGetCurrent(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: eventTap, enable: true)
        
        self.eventTap = eventTap
    }
}

let blocker = KeyBlocker()
blocker.start()
DispatchQueue.main.asyncAfter(deadline: .distantFuture) {}
RunLoop.main.run()
