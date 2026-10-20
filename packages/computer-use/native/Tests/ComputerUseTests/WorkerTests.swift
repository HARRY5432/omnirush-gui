import Foundation
import CoreGraphics
import Testing
@testable import ComputerUse

// The native worker's pure parts: contract v2 key names and modifiers, the
// coordinate spaces, the stdout framing and the synthetic-input rule.

@Test func everyContractKeyMapsToAKeyCode() {
    let named = ["Enter", "Tab", "Escape", "Backspace", "Delete", "Insert", "Space", "Left", "Up", "Right", "Down",
                 "Home", "End", "PageUp", "PageDown", "CapsLock", "ContextMenu", "PrintScreen"]
    for key in named { #expect(WorkerKeys.resolve(key) != nil, "\(key)") }
    for n in 1...20 { #expect(WorkerKeys.resolve("F\(n)") != nil) }
    for key in ["F21", "F24", "F0", "Fx", "enter", "ab", ""] { #expect(WorkerKeys.resolve(key) == nil, "\(key)") }
    for char in "abcdefghijklmnopqrstuvwxyz0123456789`-=[]\\;',./" { #expect(WorkerKeys.resolve(String(char))?.shift == false, "\(char)") }
    for char in "~!@#$%^&*()_+{}|:\"<>?" { #expect(WorkerKeys.resolve(String(char))?.shift == true, "\(char)") }
    #expect(WorkerKeys.resolve("a") == .init(code: 0, shift: false, text: "a"))
    #expect(WorkerKeys.resolve("!") == .init(code: 18, shift: true, text: "!"))
    #expect(WorkerKeys.resolve("Space")?.text == " ")
    #expect(WorkerKeys.resolve("Enter")?.text == nil)
}

@Test func modifiersAndBlockedChords() {
    #expect(WorkerKeys.flags([]) == [])
    #expect(WorkerKeys.flags(["ctrl", "shift", "alt", "meta"]) == [.maskControl, .maskShift, .maskAlternate, .maskCommand])
    #expect(WorkerKeys.flags(["cmd"]) == nil)
    #expect(WorkerKeys.blocked("Tab", ["meta"]))
    #expect(WorkerKeys.blocked("Space", ["meta"]))
    #expect(WorkerKeys.blocked("Escape", ["meta", "alt"]))
    #expect(WorkerKeys.blocked("q", ["ctrl", "meta"]))
    #expect(WorkerKeys.blocked("q", ["shift", "meta"]))
    #expect(!WorkerKeys.blocked("s", ["meta"]))
    #expect(!WorkerKeys.blocked("q", ["meta"])) // quit asks the person first (policy.mjs), it is not refused here
    #expect(!WorkerKeys.blocked("Enter", []))
}

@Test func screenRectsMapToCapturePixels() throws {
    // A 600×400 pt window at (-1440, 200) captured at 2× = 1200×800 px.
    let bounds = CGRect(x: -1440, y: 200, width: 600, height: 400)
    let field = CGRect(x: -1400, y: 250, width: 100, height: 20)
    let px = try #require(WorkerGeometry.pixels(of: field, bounds: bounds, width: 1200, height: 800))
    #expect(px == CGRect(x: 80, y: 100, width: 200, height: 40))
    let padded = try #require(WorkerGeometry.pixels(of: field, bounds: bounds, width: 1200, height: 800, pad: 2))
    #expect(padded == CGRect(x: 78, y: 98, width: 204, height: 44))
    // Partly outside: clipped to the window and the image.
    let edge = try #require(WorkerGeometry.pixels(of: CGRect(x: -1450, y: 190, width: 20, height: 20), bounds: bounds, width: 1200, height: 800, pad: 4))
    #expect(edge == CGRect(x: 0, y: 0, width: 24, height: 24))
    #expect(WorkerGeometry.pixels(of: CGRect(x: 0, y: 0, width: 5, height: 5), bounds: bounds, width: 1200, height: 800) == nil)
}

@Test func visionBoxesAreFlippedToTopLeftPixels() {
    let box = WorkerGeometry.pixels(ofNormalized: CGRect(x: 0.25, y: 0.5, width: 0.5, height: 0.25), width: 1000, height: 800)
    #expect(box == CGRect(x: 250, y: 200, width: 500, height: 200))
}

@Test func captureSizeIsNativeButCapped() {
    #expect(WorkerGeometry.captureSize(points: CGSize(width: 1440, height: 900), scale: 2, maxLongSide: 3840) == (2880, 1800))
    #expect(WorkerGeometry.captureSize(points: CGSize(width: 2560, height: 1440), scale: 2, maxLongSide: 3840) == (3840, 2160))
    #expect(WorkerGeometry.captureSize(points: CGSize(width: 800, height: 600), scale: 1, maxLongSide: 3840) == (800, 600))
}

@Test func wordsKeepTheirRanges() {
    let text = "password:  hunter2 x"
    let words = WorkerGeometry.words(text)
    #expect(words.map(\.0) == ["password:", "hunter2", "x"])
    #expect(String(text[words[1].1]) == "hunter2")
    #expect(WorkerGeometry.words("   ").isEmpty)
}

@Test func syntheticInputRule() {
    let hid = Int64(CGEventSourceStateID.hidSystemState.rawValue)
    #expect(!WorkerInputSource.isSynthetic(sourcePid: 0, stateID: hid, sourceIsWindowServer: false))
    #expect(!WorkerInputSource.isSynthetic(sourcePid: 123, stateID: hid, sourceIsWindowServer: true))
    #expect(WorkerInputSource.isSynthetic(sourcePid: 4567, stateID: hid, sourceIsWindowServer: false))
    #expect(WorkerInputSource.isSynthetic(sourcePid: 0, stateID: Int64(CGEventSourceStateID.combinedSessionState.rawValue), sourceIsWindowServer: false))
    #expect(WorkerInputSource.isSynthetic(sourcePid: 0, stateID: 987_654, sourceIsWindowServer: false))
}

@Test func framesCarryTheirBinaryLength() throws {
    let pixels = Data([1, 2, 3, 4, 5, 6, 7, 8])
    let data = try #require(WorkerFrame.encode(["id": 3, "result": ["width": 2, "height": 1]], binary: pixels))
    let newline = try #require(data.firstIndex(of: 10))
    let header = try #require(try JSONSerialization.jsonObject(with: data[..<newline]) as? [String: Any])
    let result = try #require(header["result"] as? [String: Any])
    #expect(result["bytes"] as? Int == 8)
    #expect(result["width"] as? Int == 2)
    #expect(Data(data[(newline + 1)...]) == pixels)
    let plain = try #require(WorkerFrame.encode(["event": "person-input", "generation": 2]))
    #expect(plain.last == 10)
    #expect(plain.filter { $0 == 10 }.count == 1)
}

@MainActor
@Test func workerParametersAreStrict() throws {
    #expect(NativeWorker.int(NSNumber(value: 3)) == 3)
    #expect(NativeWorker.int(NSNumber(value: 3.5)) == nil)
    #expect(NativeWorker.int(kCFBooleanTrue) == nil)
    #expect(NativeWorker.number("1") == nil)
    #expect(try NativeWorker.windowID(NSNumber(value: 42)) == 42)
    #expect(try NativeWorker.windowID("42") == 42)
    #expect(throws: (any Error).self) { try NativeWorker.windowID(NSNumber(value: 0)) }
    #expect(throws: (any Error).self) { try NativeWorker.windowID("-1") }
    #expect(!NativeWorker.releaseOnly("not json"))
    #expect(!NativeWorker.releaseOnly(#"{"pid":0,"window":1,"x":0,"y":0,"frame":[0,0,10,10]}"#))
}
