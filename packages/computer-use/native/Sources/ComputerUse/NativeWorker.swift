import AppKit
import ApplicationServices
import CryptoKit
import ScreenCaptureKit
import Vision

// `ComputerUse worker`: the macOS native layer of the desktop's shared
// computer-use host (apps/server/src/computer-use/shared/portable-host.mjs,
// contract v2). Same operations and shapes as shared/native-worker.mjs
// (Windows/X11): list, window, screens, cursor, focus, state, capture, hit,
// act, start, watch, stop, input-source, shutdown; events ready, held,
// person-input. The tool surface, results, approvals and media spool live in
// the shared host; this process only reads windows and posts input.
//
// Transport: stdin JSON lines {id, method, params}; stdout JSON lines
// {id, result} | {id, error: {code, message}} | {event, ...}. A capture
// result header carries result.bytes and is followed by that many raw RGBA
// bytes (WorkerFrame).
//
// Coordinates: global screen points, origin top-left of the primary display
// (the CGWindow/CGEvent space). Captures are native pixels (points × backing
// scale, capped by max_long_side); secure/caret/text boxes are in pixels of
// the capture.

struct WorkerWindow {
    let id: CGWindowID
    let pid: pid_t
    let identity: String
    let executable: String
    let appId: String
    let appName: String
    let title: String
    let bounds: CGRect
    let scale: CGFloat
    let display: CGDirectDisplayID

    var json: [String: Any] {
        ["id": Int(id), "pid": Int(pid), "identity": identity, "executable": executable, "appId": appId, "appName": appName,
         "title": title, "bounds": ["x": Int(bounds.minX), "y": Int(bounds.minY), "width": Int(bounds.width), "height": Int(bounds.height)],
         "dpi": Int((72 * scale).rounded()), "scale": Double(scale), "monitor": String(display)]
    }
}

private struct HeldPointer {
    let pid: pid_t
    let point: CGPoint
    let window: CGWindowID
    let frame: CGRect
    let flags: CGEventFlags
}

@MainActor
final class NativeWorker {
    private var generation = 0
    private var busy = false
    private var interrupting = false
    private var monitors: [Any] = []
    private var observers: [NSObjectProtocol] = []
    private var anchor: CGPoint?
    private var lastInput: [String: Any] = ["synthetic": false, "at": 0, "kind": ""]
    private var held: HeldPointer?
    private var scCache: (at: TimeInterval, windows: [CGWindowID: SCWindow])?
    private var ocrCache: (digest: Data, lines: [[String: Any]]?)?
    private let ownPid = ProcessInfo.processInfo.processIdentifier

    // MARK: transport

    func start() {
        let ax = AXIsProcessTrusted(), capture = CGPreflightScreenCaptureAccess()
        if ax && capture { send(["event": "ready", "supported": true, "platform": "darwin"]) }
        else {
            send(["event": "ready", "supported": false, "platform": "darwin", "code": "permissions_required",
                  "error": "Grant Accessibility and Screen Recording to OmniRush.ai in System Settings, then restart computer use."])
        }
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.personInput(force: true) }
            })
        }
    }

    private func send(_ message: [String: Any], binary: Data? = nil) {
        guard let data = WorkerFrame.encode(message, binary: binary) else { return }
        do { try FileHandle.standardOutput.write(contentsOf: data) } catch { exit(0) }
    }

    func receive(_ bytes: Data) async {
        guard let object = try? JSONSerialization.jsonObject(with: bytes) as? [String: Any],
              let method = object["method"] as? String else { return }
        let id = object["id"] ?? NSNull()
        let params = object["params"] as? [String: Any] ?? [:]
        var owns = false
        do {
            switch method {
            case "shutdown":
                generation += 1; releaseHeld(); stopMonitoring()
                while busy { try? await Task.sleep(nanoseconds: 10_000_000) }
                send(["id": id, "result": [:]])
                exit(0)
            case "start", "watch":
                guard !busy else { throw UseError("busy", "Desktop operations must be sequential.") }
                startMonitoring(interrupt: method == "start")
                send(["id": id, "result": ["generation": generation]]); return
            case "stop":
                generation += 1; releaseHeld(); stopMonitoring()
                send(["id": id, "result": [:]]); return
            case "input-source":
                send(["id": id, "result": lastInput]); return
            default: break
            }
            guard !busy else { throw UseError("busy", "Desktop operations must be sequential.") }
            busy = true; owns = true
            defer { if owns { busy = false } }
            switch method {
            case "list": send(["id": id, "result": list().map(\.json)])
            case "window": send(["id": id, "result": try window(Self.windowID(params["id"])).json])
            case "screens": send(["id": id, "result": screens()])
            case "cursor":
                if let p = CGEvent(source: nil)?.location { send(["id": id, "result": ["x": Int(p.x.rounded()), "y": Int(p.y.rounded())]]) }
                else { send(["id": id, "result": NSNull()]) }
            case "state": send(["id": id, "result": ["generation": generation, "available": available()]])
            case "focus":
                try await focus(try expected(params["window"]))
                send(["id": id, "result": ["generation": generation]])
            case "hit":
                let w = try expected(params["window"])
                let points = (params["points"] as? [[String: Any]] ?? []).map { CGPoint(x: Self.number($0["x"]) ?? -1e9, y: Self.number($0["y"]) ?? -1e9) }
                send(["id": id, "result": ["inside": points.map { hit(w, $0) }]])
            case "check":
                _ = try check(try expected(params["window"]), generation: Self.int(params["generation"]) ?? -1, deadline: Self.number(params["deadline"]) ?? 0)
                send(["id": id, "result": [:]])
            case "capture":
                let maxLongSide = Self.int(params["max_long_side"]) ?? 3840
                let (header, pixels) = try await capture(try expected(params["window"]), maxLongSide: max(320, min(7680, maxLongSide)))
                send(["id": id, "result": header], binary: pixels)
            case "act":
                guard let action = params["action"] as? [String: Any] else { throw UseError("invalid_action", "An action object is required.") }
                try await act(try expected(params["window"]), generation: Self.int(params["generation"]) ?? -1, action: action, deadline: Self.number(params["deadline"]) ?? 0)
                send(["id": id, "result": ["generation": generation]])
            default: throw UseError("unknown_method", "Unknown native operation.")
            }
        } catch {
            let failure = (error as? UseError) ?? UseError("native_error", error.localizedDescription)
            send(["id": id, "error": ["code": failure.code, "message": failure.message]])
        }
    }

    // MARK: parameters

    static func number(_ value: Any?) -> Double? {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue.isFinite else { return nil }
        return n.doubleValue
    }
    static func int(_ value: Any?) -> Int? { number(value).flatMap { $0.rounded() == $0 && abs($0) < 9e15 ? Int($0) : nil } }
    static func windowID(_ value: Any?) throws -> CGWindowID {
        if let n = int(value), n > 0, n <= Int(UInt32.max) { return CGWindowID(n) }
        if let s = value as? String, let n = UInt32(s), n > 0 { return n }
        throw UseError("window_unavailable", "That window is not open.")
    }
    /// The window the shared host passed back ({id, identity, bounds}), checked against the live one.
    private func expected(_ value: Any?) throws -> WorkerWindow {
        guard let w = value as? [String: Any], let identity = w["identity"] as? String else { throw UseError("window_unavailable", "That window is not open.") }
        let current = try window(try Self.windowID(w["id"]))
        guard current.identity == identity else { throw UseError("window_changed", "The window changed. Observe again.") }
        return current
    }

    // MARK: windows

    private func appInfo(_ pid: pid_t) -> (NSRunningApplication, String, String, String)? {
        guard pid != ownPid, let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              app.activationPolicy == .regular, AppIdentity.isAllowed(app) || app.bundleIdentifier == nil,
              let exe = app.executableURL?.path else { return nil }
        return (app, exe, app.bundleIdentifier ?? exe, app.localizedName ?? (exe as NSString).lastPathComponent)
    }

    private func describe(_ info: [String: Any]) -> WorkerWindow? {
        guard let number = info[kCGWindowNumber as String] as? NSNumber,
              let pid = (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value,
              (info[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
              ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.01,
              let rawBounds = info[kCGWindowBounds as String] as? NSDictionary,
              let bounds = CGRect(dictionaryRepresentation: rawBounds as CFDictionary),
              bounds.width > 20, bounds.height > 20,
              let app = appInfo(pid), let start = AppIdentity.ProcessStart(pid: pid) else { return nil }
        let (_, exe, appId, appName) = app
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        let screen = screenContaining(center)
        let display = (screen?.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? CGMainDisplayID()
        return WorkerWindow(id: number.uint32Value, pid: pid, identity: "\(pid):\(start.seconds).\(start.microseconds):\(number.uint32Value)",
            executable: exe, appId: appId, appName: appName, title: info[kCGWindowName as String] as? String ?? "",
            bounds: bounds.integral, scale: screen?.backingScaleFactor ?? 2, display: display)
    }

    func list() -> [WorkerWindow] {
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return infos.compactMap(describe)
    }

    func window(_ id: CGWindowID) throws -> WorkerWindow {
        guard available(),
              let info = (CGWindowListCopyWindowInfo(.optionIncludingWindow, id) as? [[String: Any]])?.first,
              (info[kCGWindowIsOnscreen as String] as? Bool) == true,
              let w = describe(info), w.id == id else {
            throw UseError("window_unavailable", "Keep the approved app's window open and visible on an unlocked desktop.")
        }
        return w
    }

    private func primaryHeight() -> CGFloat { NSScreen.screens.first?.frame.height ?? 0 }

    /// The NSScreen holding a point of the top-left global space.
    private func screenContaining(_ point: CGPoint) -> NSScreen? {
        let h = primaryHeight()
        return NSScreen.screens.first { s in
            let f = s.frame
            return CGRect(x: f.minX, y: h - f.maxY, width: f.width, height: f.height).contains(point)
        } ?? NSScreen.main
    }

    func screens() -> [[String: Any]] {
        let h = primaryHeight()
        return NSScreen.screens.enumerated().map { index, s in
            let f = s.frame
            let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
            return ["id": String(id), "x": Int(f.minX), "y": Int(h - f.maxY), "width": Int(f.width), "height": Int(f.height),
                    "scale": Double(s.backingScaleFactor), "primary": index == 0]
        }
    }

    func available() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        if (session[kCGSessionOnConsoleKey as String] as? Bool) == false { return false }
        return (session["CGSSessionScreenIsLocked"] as? Bool) != true
    }

    // MARK: accessibility

    private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
        var value: CFTypeRef?
        return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
    }
    private func element(_ element: AXUIElement, _ name: String) -> AXUIElement? {
        guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return (value as! AXUIElement)
    }
    private func frame(_ element: AXUIElement) -> CGRect? {
        guard let p = attribute(element, kAXPositionAttribute), CFGetTypeID(p) == AXValueGetTypeID(),
              let s = attribute(element, kAXSizeAttribute), CFGetTypeID(s) == AXValueGetTypeID() else { return nil }
        var point = CGPoint.zero, size = CGSize.zero
        guard AXValueGetValue(p as! AXValue, .cgPoint, &point), AXValueGetValue(s as! AXValue, .cgSize, &size) else { return nil }
        return CGRect(origin: point, size: size)
    }
    private func isSecure(_ element: AXUIElement) -> Bool {
        (attribute(element, kAXSubroleAttribute) as? String) == "AXSecureTextField" || (attribute(element, "AXProtectedContent") as? Bool) == true
    }

    /// The AX window of a CGWindow: the one AX window of that app with the same frame (never a guess).
    private func axWindow(_ w: WorkerWindow) -> AXUIElement? {
        let root = AXUIElementCreateApplication(w.pid)
        AXUIElementSetMessagingTimeout(root, 0.25)
        if (attribute(root, "AXManualAccessibility") as? Bool) == false {
            // Electron apps expose their tree on request (an assistive-technology handshake, not a permission).
            AXUIElementSetAttributeValue(root, "AXManualAccessibility" as CFString, kCFBooleanTrue)
        }
        let windows = attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? []
        let matches = windows.filter { element in
            guard let f = frame(element) else { return false }
            return abs(f.minX - w.bounds.minX) < 2 && abs(f.minY - w.bounds.minY) < 2 && abs(f.width - w.bounds.width) < 2 && abs(f.height - w.bounds.height) < 2
        }
        guard matches.count == 1, let match = matches.first else { return nil }
        AXUIElementSetMessagingTimeout(match, 0.25)
        return match
    }

    /// Frames of password and protected fields in the window (values never read).
    private func secureFrames(_ root: AXUIElement) -> [CGRect] {
        var out: [CGRect] = []
        var seen = 0
        let started = ProcessInfo.processInfo.systemUptime
        func walk(_ element: AXUIElement, _ depth: Int) {
            guard depth < 28, seen < 2500, ProcessInfo.processInfo.systemUptime - started < 0.6 else { return }
            seen += 1
            if isSecure(element) { if let f = frame(element) { out.append(f) }; return }
            for child in attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
        }
        walk(root, 0)
        return out
    }

    /// The focused element of the app, when it is inside the approved window.
    private func focusedElement(_ w: WorkerWindow, _ ax: AXUIElement?) -> AXUIElement? {
        let root = AXUIElementCreateApplication(w.pid)
        guard let focused = element(root, kAXFocusedUIElementAttribute) else { return nil }
        if let ax, let owner = element(focused, kAXWindowAttribute), !CFEqual(owner, ax) { return nil }
        return focused
    }

    private func caret(_ w: WorkerWindow, _ ax: AXUIElement?) -> CGRect? {
        guard let focused = focusedElement(w, ax), let range = attribute(focused, kAXSelectedTextRangeAttribute) else { return nil }
        var bounds: CFTypeRef?
        guard AXUIElementCopyParameterizedAttributeValue(focused, kAXBoundsForRangeParameterizedAttribute as CFString, range, &bounds) == .success,
              let bounds, CFGetTypeID(bounds) == AXValueGetTypeID() else { return nil }
        var rect = CGRect.zero
        guard AXValueGetValue(bounds as! AXValue, .cgRect, &rect) else { return nil }
        return CGRect(x: rect.minX, y: rect.minY, width: max(2, rect.width), height: max(2, rect.height))
    }

    // MARK: capture

    private func scWindow(_ id: CGWindowID) async throws -> SCWindow {
        let now = ProcessInfo.processInfo.systemUptime
        if let cache = scCache, now - cache.at < 2, let window = cache.windows[id] { return window }
        let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
        var windows: [CGWindowID: SCWindow] = [:]
        for window in content.windows { windows[window.windowID] = window }
        scCache = (now, windows)
        guard let window = windows[id] else { throw UseError("capture_unavailable", "The window image is unavailable. Keep it visible and observe again.") }
        return window
    }

    func capture(_ w: WorkerWindow, maxLongSide: Int) async throws -> ([String: Any], Data) {
        let shareable = try await scWindow(w.id)
        guard shareable.owningApplication?.processID == w.pid else { throw UseError("window_changed", "The window changed. Observe again.") }
        let filter = SCContentFilter(desktopIndependentWindow: shareable)
        let size = WorkerGeometry.captureSize(points: w.bounds.size, scale: CGFloat(filter.pointPixelScale), maxLongSide: maxLongSide)
        let config = SCStreamConfiguration()
        config.width = size.width; config.height = size.height
        config.showsCursor = false
        config.ignoreShadowsSingleWindow = true
        let image: CGImage
        do { image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config) }
        catch { scCache = nil; throw UseError("capture_unavailable", "The window image is unavailable. Keep it visible and observe again.") }
        let width = image.width, height = image.height
        var pixels = Data(count: width * height * 4)
        let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                          space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            // Opaque: transparent window corners become white instead of black.
            context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard drawn else { throw UseError("capture_unavailable", "The window image could not be read.") }
        // The window must not have moved while it was captured.
        let after = try window(w.id)
        guard after.identity == w.identity, after.bounds == w.bounds else { throw UseError("window_changed", "The approved window moved or changed. Observe it again.") }
        let ax = axWindow(w)
        let secure = (ax.map(secureFrames) ?? []).compactMap { WorkerGeometry.pixels(of: $0, bounds: w.bounds, width: width, height: height, pad: 2) }
        let caretRect = caret(w, ax).flatMap { WorkerGeometry.pixels(of: $0, bounds: w.bounds, width: width, height: height, pad: 4) }
        let lines = await recognize(image, pixels: pixels)
        var header: [String: Any] = ["width": width, "height": height, "secure": secure.map(WorkerGeometry.json),
            "text_boxes": lines ?? [], "ocr": lines == nil ? "none" : "client", "source": "window", "secure_checked": ax != nil]
        if let caretRect { header["caret"] = WorkerGeometry.json(caretRect) } else { header["caret"] = NSNull() }
        return (header, pixels)
    }

    /// On-device text recognition (Vision, fast): lines and word boxes in pixels; reused while the pixels are unchanged.
    private func recognize(_ image: CGImage, pixels: Data) async -> [[String: Any]]? {
        let digest = Data(SHA256.hash(data: pixels))
        if let cache = ocrCache, cache.digest == digest { return cache.lines }
        let width = image.width, height = image.height
        let encoded: Data = await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .fast
            request.usesLanguageCorrection = false
            do { try VNImageRequestHandler(cgImage: image, options: [:]).perform([request]) } catch { return Data("null".utf8) }
            let lines: [[String: Any]] = (request.results ?? []).compactMap { observation -> [String: Any]? in
                guard let candidate = observation.topCandidates(1).first else { return nil }
                let text = candidate.string
                let words: [[String: Any]] = WorkerGeometry.words(text).compactMap { word, range in
                    guard let box = try? candidate.boundingBox(for: range)?.boundingBox else { return nil }
                    return ["text": word, "box": WorkerGeometry.json(WorkerGeometry.pixels(ofNormalized: box, width: width, height: height))]
                }
                return ["text": text, "box": WorkerGeometry.json(WorkerGeometry.pixels(ofNormalized: observation.boundingBox, width: width, height: height)), "words": words]
            }
            return (try? JSONSerialization.data(withJSONObject: lines)) ?? Data("[]".utf8)
        }.value
        let lines = (try? JSONSerialization.jsonObject(with: encoded, options: [.fragmentsAllowed])) as? [[String: Any]]
        ocrCache = (digest, lines)
        return lines
    }

    // MARK: hit test, focus, checks

    /// True when the topmost visible window at `point` (screen points) is the approved window.
    func hit(_ w: WorkerWindow, _ point: CGPoint) -> Bool {
        guard w.bounds.contains(point) else { return false }
        let infos = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for info in infos {
            guard ((info[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1) > 0.01,
                  let raw = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: raw as CFDictionary), bounds.contains(point) else { continue }
            return (info[kCGWindowNumber as String] as? NSNumber)?.uint32Value == w.id
        }
        return false
    }

    func focus(_ w: WorkerWindow) async throws {
        guard let app = NSRunningApplication(processIdentifier: w.pid) else { throw UseError("window_unavailable", "The approved app has closed.") }
        if let ax = axWindow(w) { AXUIElementPerformAction(ax, kAXRaiseAction as CFString) }
        app.activate(options: [])
        for _ in 0..<20 {
            if frontmost(w) { return }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        throw UseError("focus_changed", "Bring the approved app to the front, then choose Continue.")
    }

    private func frontmost(_ w: WorkerWindow) -> Bool {
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == w.pid else { return false }
        guard let ax = axWindow(w) else { return true }
        guard let focused = element(AXUIElementCreateApplication(w.pid), kAXFocusedWindowAttribute) else { return true }
        return CFEqual(focused, ax)
    }

    @discardableResult
    func check(_ w: WorkerWindow, generation expected: Int, deadline: Double) throws -> WorkerWindow {
        if deadline > 0 && Date().timeIntervalSince1970 * 1000 >= deadline { throw UseError("session_expired", "The approved session expired. Start a new session.") }
        if generation != expected { throw UseError("paused_by_person", "Your input paused computer use. Choose Continue when ready.") }
        let current = try window(w.id)
        guard current.identity == w.identity, current.bounds == w.bounds else { throw UseError("window_changed", "The approved window moved or changed. Observe it again.") }
        guard frontmost(current) else { throw UseError("focus_changed", "The approved window must stay in front. Choose Continue when ready.") }
        return current
    }

    // MARK: input

    private func mouse(_ type: NSEvent.EventType, _ point: CGPoint, _ w: WorkerWindow, clicks: Int, flags: CGEventFlags) throws {
        guard let setWindowLocation = MacInput.setWindowLocation else {
            throw UseError("unsupported_action", "This macOS version does not support window-scoped pointer input.")
        }
        let frame = w.bounds
        let pressed = type == .leftMouseDown || type == .rightMouseDown || type == .leftMouseDragged
        guard let native = NSEvent.mouseEvent(with: type, location: NSPoint(x: point.x - frame.minX, y: frame.maxY - point.y),
                modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(flags.rawValue)), timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: Int(w.id), context: nil, eventNumber: 0, clickCount: clicks, pressure: pressed ? 1 : 0),
              let event = native.cgEvent?.copy() else { throw UseError("input_interrupted", "Could not create a window-targeted mouse event.") }
        event.location = point
        event.flags = flags
        setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
        event.setIntegerValueField(.mouseEventButtonNumber, value: type == .rightMouseDown || type == .rightMouseUp ? 1 : 0)
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.id))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.id))
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clicks))
        post(event, w.pid)
    }

    /// Tracks a pressed button during a drag (reported, so the host can release it if this process dies).
    private func hold(_ point: CGPoint, _ w: WorkerWindow, _ flags: CGEventFlags) {
        let first = held == nil
        held = HeldPointer(pid: w.pid, point: point, window: w.id, frame: w.bounds, flags: flags)
        if first { reportHeld() }
    }

    private func post(_ event: CGEvent, _ pid: pid_t) {
        event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ownPid))
        event.postToPid(pid)
    }

    private func key(_ code: CGKeyCode, flags: CGEventFlags, text: String?, pid: pid_t) throws {
        guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else {
            throw UseError("input_interrupted", "Could not create a keyboard event.")
        }
        down.flags = flags; up.flags = flags
        if let text {
            let units = Array(text.utf16)
            units.withUnsafeBufferPointer { buffer in
                guard let base = buffer.baseAddress else { return }
                down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
                up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: base)
            }
        }
        // Down and up are posted together: a key is never left half sent.
        post(down, pid); post(up, pid)
    }

    private func reportHeld() {
        var message: [String: Any] = ["event": "held", "keys": [Int](), "buttons": held == nil ? [Int]() : [1]]
        if let held {
            message["release"] = ["pid": Int(held.pid), "window": Int(held.window), "x": Double(held.point.x), "y": Double(held.point.y),
                                  "frame": [Double(held.frame.minX), Double(held.frame.minY), Double(held.frame.width), Double(held.frame.height)]]
        }
        send(message)
    }

    private func releaseHeld() {
        guard let h = held else { return }
        held = nil
        let w = WorkerWindow(id: h.window, pid: h.pid, identity: "", executable: "", appId: "", appName: "", title: "", bounds: h.frame, scale: 1, display: 0)
        try? mouse(.leftMouseUp, h.point, w, clicks: 1, flags: h.flags)
        reportHeld()
    }

    private static func point(_ value: Any?) throws -> CGPoint {
        guard let p = value as? [String: Any], let x = number(p["x"]), let y = number(p["y"]) else { throw UseError("invalid_action", "A point needs x and y.") }
        return CGPoint(x: x, y: y)
    }

    func act(_ w: WorkerWindow, generation expected: Int, action: [String: Any], deadline: Double) async throws {
        let checked = { () throws -> Void in _ = try self.check(w, generation: expected, deadline: deadline) }
        let type = action["type"] as? String ?? ""
        let modifiers = action["modifiers"] as? [String] ?? []
        guard let flags = WorkerKeys.flags(modifiers) else { throw UseError("invalid_action", "Modifiers are ctrl, shift, alt and meta.") }
        defer { releaseHeld() }
        try checked()
        switch type {
        case "move":
            let p = try Self.point(action)
            try mouse(.mouseMoved, p, w, clicks: 0, flags: flags)
        case "click", "double_click", "right_click":
            let p = try Self.point(action)
            let (down, up): (NSEvent.EventType, NSEvent.EventType) = type == "right_click" ? (.rightMouseDown, .rightMouseUp) : (.leftMouseDown, .leftMouseUp)
            let clicks = type == "double_click" ? 2 : 1
            for click in 1...clicks {
                if click > 1 { try await Task.sleep(nanoseconds: 70_000_000); try checked() }
                try mouse(down, p, w, clicks: click, flags: flags)
                try mouse(up, p, w, clicks: click, flags: flags)
            }
        case "scroll":
            let p = try Self.point(action)
            guard let delta = Self.int(action["delta"]), delta != 0, abs(delta) <= 20 else { throw UseError("invalid_action", "Scroll needs delta: 1 to 20 steps.") }
            // Positive delta = down/right; one step ≈ three lines.
            let amount = Int32(-delta * 48)
            let horizontal = action["axis"] as? String == "horizontal"
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: horizontal ? 0 : amount, wheel2: horizontal ? amount : 0, wheel3: 0) else {
                throw UseError("input_interrupted", "Could not create a scroll event.")
            }
            event.location = p
            event.flags = flags
            event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(w.id))
            event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(w.id))
            post(event, w.pid)
        case "drag":
            let path = try (action["path"] as? [Any] ?? []).map(Self.point)
            guard path.count >= 2, path.count <= 64 else { throw UseError("invalid_action", "A drag needs 2 to 64 points.") }
            hold(path[0], w, flags)
            try mouse(.leftMouseDown, path[0], w, clicks: 1, flags: flags)
            for p in path.dropFirst() {
                try await Task.sleep(nanoseconds: 16_000_000)
                try checked()
                hold(p, w, flags)
                try mouse(.leftMouseDragged, p, w, clicks: 1, flags: flags)
            }
            try await Task.sleep(nanoseconds: 16_000_000)
            try mouse(.leftMouseUp, path[path.count - 1], w, clicks: 1, flags: flags)
            held = nil; reportHeld()
        case "type":
            guard let text = action["text"] as? String, !text.isEmpty else { throw UseError("invalid_action", "Text is required.") }
            let ax = axWindow(w)
            for character in text {
                try checked()
                if let focused = focusedElement(w, ax), isSecure(focused) {
                    throw UseError("protected_input", "This is a password field. Enter passwords yourself.")
                }
                try key(0, flags: [], text: String(character), pid: w.pid)
                try await Task.sleep(nanoseconds: 4_000_000)
            }
        case "key":
            guard let name = action["key"] as? String, let resolved = WorkerKeys.resolve(name) else { throw UseError("unsupported_action", "This key is not available on macOS.") }
            if WorkerKeys.blocked(name, modifiers) { throw UseError("unsupported_action", "System-wide shortcuts are unavailable.") }
            var keyFlags = flags
            if resolved.shift { keyFlags.insert(.maskShift) }
            // With ctrl/meta held, apps read the key code; plain keys also carry their text.
            let text = keyFlags.contains(.maskCommand) || keyFlags.contains(.maskControl) ? nil : resolved.text
            try key(resolved.code, flags: keyFlags, text: text, pid: w.pid)
        default:
            throw UseError("unsupported_action", "This action is unavailable.")
        }
    }

    // MARK: person input

    private func startMonitoring(interrupt: Bool) {
        interrupting = interrupt || interrupting
        if interrupt { anchor = CGEvent(source: nil)?.location }
        guard monitors.isEmpty else { return }
        let presses: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown, .scrollWheel, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged]
        if let monitor = NSEvent.addGlobalMonitorForEvents(matching: presses.union(.mouseMoved), handler: { [weak self] event in
            MainActor.assumeIsolated { self?.observe(event) }
        }) { monitors.append(monitor) }
    }

    private func stopMonitoring() {
        for monitor in monitors { NSEvent.removeMonitor(monitor) }
        monitors.removeAll(); interrupting = false; anchor = nil
    }

    private func observe(_ event: NSEvent) {
        let cg = event.cgEvent
        let sourcePid = cg?.getIntegerValueField(.eventSourceUnixProcessID) ?? 0
        if sourcePid == Int64(ownPid) { return } // our own window-targeted input
        if event.type == .mouseMoved {
            // Passive motion counts only when the pointer clearly leaves where it was when control started.
            guard interrupting, let anchor, let now = cg?.location, hypot(now.x - anchor.x, now.y - anchor.y) > 8 else { return }
            personInput(force: false); return
        }
        if [.leftMouseDown, .rightMouseDown, .otherMouseDown, .keyDown].contains(event.type) {
            let stateID = cg?.getIntegerValueField(.eventSourceStateID) ?? -1
            let synthetic = WorkerInputSource.isSynthetic(sourcePid: sourcePid, stateID: stateID, sourceIsWindowServer: Self.isWindowServer(pid_t(truncatingIfNeeded: sourcePid)))
            var entry: [String: Any] = ["synthetic": synthetic, "at": Int(Date().timeIntervalSince1970 * 1000), "kind": event.type == .keyDown ? "key" : "pointer"]
            // The app in front at the press, where the pointer was (global points, top-left origin) and the key as a terminal names it.
            entry["foreground_pid"] = NSWorkspace.shared.frontmostApplication.map { Int($0.processIdentifier) } ?? NSNull()
            if let at = cg?.location, event.type != .keyDown { entry["x"] = Double(at.x); entry["y"] = Double(at.y) }
            entry["key"] = event.type == .keyDown ? (Self.keyName(event) ?? NSNull()) : NSNull()
            lastInput = entry
        }
        personInput(force: false)
    }

    /** One lower-case letter or digit for printable keys, else Enter / Escape / Space / Tab / Backspace / arrows; nil otherwise. */
    static func keyName(_ event: NSEvent) -> String? {
        switch event.keyCode {
        case 36, 76: return "Enter"
        case 53: return "Escape"
        case 49: return "Space"
        case 48: return "Tab"
        case 51: return "Backspace"
        case 123: return "Left"
        case 124: return "Right"
        case 125: return "Down"
        case 126: return "Up"
        default:
            guard let chars = event.charactersIgnoringModifiers?.lowercased(), chars.count == 1, let c = chars.first, c.isLetter || c.isNumber else { return nil }
            return String(c)
        }
    }

    private static func isWindowServer(_ pid: pid_t) -> Bool {
        guard pid > 0 else { return false }
        var name = [CChar](repeating: 0, count: 256)
        guard proc_name(pid, &name, UInt32(name.count)) > 0 else { return false }
        return String(cString: name) == "WindowServer"
    }

    private func personInput(force: Bool) {
        guard interrupting || force else { return }
        generation += 1
        releaseHeld()
        anchor = CGEvent(source: nil)?.location
        send(["event": "person-input", "generation": generation])
    }

    // MARK: release after a crash

    /// `ComputerUse release '<held json>'`: lifts a mouse button a crashed worker left pressed.
    static func releaseOnly(_ json: String) -> Bool {
        guard let data = json.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let pid = int(value["pid"]), pid > 0, let window = int(value["window"]), let x = number(value["x"]), let y = number(value["y"]),
              let f = value["frame"] as? [NSNumber], f.count == 4, let setWindowLocation = MacInput.setWindowLocation else { return false }
        let frame = CGRect(x: f[0].doubleValue, y: f[1].doubleValue, width: f[2].doubleValue, height: f[3].doubleValue)
        let point = CGPoint(x: x, y: y)
        guard let native = NSEvent.mouseEvent(with: .leftMouseUp, location: NSPoint(x: point.x - frame.minX, y: frame.maxY - point.y), modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window, context: nil, eventNumber: 0, clickCount: 1, pressure: 0),
              let event = native.cgEvent?.copy() else { return false }
        event.location = point
        setWindowLocation(event, CGPoint(x: point.x - frame.minX, y: point.y - frame.minY))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(window))
        event.setIntegerValueField(.eventSourceUnixProcessID, value: Int64(ProcessInfo.processInfo.processIdentifier))
        event.postToPid(pid_t(pid))
        return true
    }
}
