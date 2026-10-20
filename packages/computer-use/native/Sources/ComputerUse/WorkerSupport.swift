import Foundation
import CoreGraphics

// Pure helpers of the native worker (contract v2): key names, modifier flags,
// coordinate conversion, the stdout framing and the synthetic-input rule.
// No AppKit state, so they are unit tested directly.

enum WorkerKeys {
    /// Canonical key names of contract.mjs (canonicalKey) → macOS virtual key codes.
    static let named: [String: CGKeyCode] = [
        "Enter": 36, "Tab": 48, "Escape": 53, "Backspace": 51, "Delete": 117, "Insert": 114, "Space": 49,
        "Left": 123, "Up": 126, "Right": 124, "Down": 125, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
        "CapsLock": 57, "ContextMenu": 110, "PrintScreen": 105,
    ]
    /// ANSI layout codes of unshifted characters.
    static let characters: [Character: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
        "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
        "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
        "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    ]
    /// Shifted punctuation → its unshifted key.
    static let shifted: [Character: Character] = [
        "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
        "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`",
    ]
    static let function: [CGKeyCode] = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90]

    struct Key: Equatable {
        let code: CGKeyCode
        let shift: Bool
        let text: String?
    }

    /// A canonical key name (Enter, a, !, F5 ...) → key code, implied shift and the text it types.
    static func resolve(_ key: String) -> Key? {
        if let code = named[key] { return Key(code: code, shift: false, text: key == "Space" ? " " : nil) }
        if key.count > 1, key.first == "F", let n = Int(key.dropFirst()), n >= 1 {
            return n <= function.count ? Key(code: function[n - 1], shift: false, text: nil) : nil
        }
        guard key.count == 1, let char = key.first else { return nil }
        if let code = characters[char] { return Key(code: code, shift: false, text: key) }
        if let base = shifted[char], let code = characters[base] { return Key(code: code, shift: true, text: key) }
        return nil
    }

    /// Contract modifiers (ctrl, shift, alt, meta) → event flags, nil for an unknown one.
    static func flags(_ modifiers: [String]) -> CGEventFlags? {
        var flags: CGEventFlags = []
        for modifier in modifiers {
            switch modifier {
            case "ctrl": flags.insert(.maskControl)
            case "shift": flags.insert(.maskShift)
            case "alt": flags.insert(.maskAlternate)
            case "meta": flags.insert(.maskCommand)
            default: return nil
            }
        }
        return flags
    }

    /// Chords that act on the whole desktop (app switcher, Spotlight, force quit, lock, log out) are refused.
    static func blocked(_ key: String, _ modifiers: [String]) -> Bool {
        let m = Set(modifiers)
        if m.contains("meta") && (key == "Tab" || key == "Space" || key == "`") { return true }
        if m.contains("ctrl") && key == "Space" { return true }
        if m.contains("meta") && m.contains("alt") && key == "Escape" { return true }
        if m.contains("meta") && m.contains("ctrl") && (key == "q" || key == "f") { return true }
        if m.contains("meta") && m.contains("shift") && (key == "q" || key == "3" || key == "4" || key == "5") { return true }
        if m.contains("ctrl") && ["Left", "Right", "Up", "Down"].contains(key) { return true }
        return false
    }
}

enum WorkerGeometry {
    /// A rectangle in global screen points → pixels of a window image (`bounds` in points, image `width`×`height`).
    static func pixels(of rect: CGRect, bounds: CGRect, width: Int, height: Int, pad: CGFloat = 0) -> CGRect? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let clipped = rect.intersection(bounds)
        guard !clipped.isNull, !clipped.isEmpty else { return nil }
        let sx = CGFloat(width) / bounds.width, sy = CGFloat(height) / bounds.height
        let out = CGRect(x: (clipped.minX - bounds.minX) * sx - pad, y: (clipped.minY - bounds.minY) * sy - pad,
                         width: clipped.width * sx + pad * 2, height: clipped.height * sy + pad * 2)
        return out.intersection(CGRect(x: 0, y: 0, width: width, height: height))
    }

    /// A Vision box (normalized, origin bottom-left) → image pixels (origin top-left).
    static func pixels(ofNormalized box: CGRect, width: Int, height: Int) -> CGRect {
        CGRect(x: box.minX * CGFloat(width), y: (1 - box.maxY) * CGFloat(height),
               width: box.width * CGFloat(width), height: box.height * CGFloat(height))
    }

    /// The pixel size of a window capture: native (points × scale), long side at most `maxLongSide`.
    static func captureSize(points: CGSize, scale: CGFloat, maxLongSide: Int) -> (width: Int, height: Int) {
        let w = max(1, points.width * scale), h = max(1, points.height * scale)
        let ratio = min(1, CGFloat(max(1, maxLongSide)) / max(w, h))
        return (max(1, Int((w * ratio).rounded())), max(1, Int((h * ratio).rounded())))
    }

    static func json(_ rect: CGRect) -> [String: Any] {
        ["x": Double(rect.minX), "y": Double(rect.minY), "width": Double(rect.width), "height": Double(rect.height)]
    }

    /// Whitespace-separated words of `text` with their ranges.
    static func words(_ text: String) -> [(String, Range<String.Index>)] {
        var out: [(String, Range<String.Index>)] = []
        var start: String.Index?
        var index = text.startIndex
        while index < text.endIndex {
            if text[index].isWhitespace {
                if let s = start { out.append((String(text[s..<index]), s..<index)); start = nil }
            } else if start == nil { start = index }
            index = text.index(after: index)
        }
        if let s = start { out.append((String(text[s..<text.endIndex]), s..<text.endIndex)) }
        return out
    }
}

enum WorkerInputSource {
    /// Whether a person-facing press was injected by a program rather than the keyboard or mouse:
    /// hardware events carry the HID system state and no posting process (other than the window server).
    static func isSynthetic(sourcePid: Int64, stateID: Int64, sourceIsWindowServer: Bool) -> Bool {
        if stateID != Int64(CGEventSourceStateID.hidSystemState.rawValue) { return true }
        return sourcePid > 0 && !sourceIsWindowServer
    }
}

enum WorkerFrame {
    /// One stdout message: a JSON line, followed by `binary` raw bytes when given (the header carries
    /// `result.bytes` = its length; the reader takes exactly that many bytes after the newline).
    static func encode(_ message: [String: Any], binary: Data? = nil) -> Data? {
        var value = message
        if let binary {
            var result = value["result"] as? [String: Any] ?? [:]
            result["bytes"] = binary.count
            value["result"] = result
        }
        guard JSONSerialization.isValidJSONObject(value),
              var data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
        data.append(10)
        if let binary { data.append(binary) }
        return data
    }
}
