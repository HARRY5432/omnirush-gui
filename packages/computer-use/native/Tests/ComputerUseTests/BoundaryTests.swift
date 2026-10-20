import Foundation
import CoreGraphics
import Testing
@testable import ComputerUse

// Swift Testing (ships with the Command Line Tools as well as Xcode).

@Test func malformedInputNeverBecomesAnAction() throws {
    let invalid: [[String: Any]] = [
        ["type": "click", "x": true, "y": 1],
        ["type": "click", "x": Double.nan, "y": 1],
        ["type": "click", "x": -1, "y": 1],
        ["type": "click", "x": 1, "y": 1, "strict": false],
        ["type": "click", "x": 1],
        ["type": "scroll", "x": 1, "y": 1, "delta_x": 1.5, "delta_y": 1],
        ["type": "key", "key": "command+space"],
        ["type": "key", "key": "paste"],
        ["type": "type", "text": "hello\0world"],
        ["type": "type", "text": String(repeating: "x", count: 8001)],
        ["type": "drag", "path": [["x": 1, "y": 1]]],
        ["type": "shell", "text": "ignored"],
    ]
    for candidate in invalid { #expect(throws: (any Error).self) { try Action(candidate) } }
    _ = try Action(["type": "set_value", "ref": "e1", "text": ""])
    _ = try Action(["type": "type", "text": "Hello 👋🏽 café 日本語"])
    #expect(throws: (any Error).self) { try Arguments(values: ["pid": true]).integer("pid", min: 1, max: 999) }
    #expect(throws: (any Error).self) { try Arguments(values: ["include_image": "false"]).bool("include_image", default: true) }
}

@Test func observationCannotCrossWindowGenerationTimeOrImageBoundary() throws {
    let frame = CGRect(x: -1440, y: 200, width: 1200, height: 800)
    let observation = ObservationLease(id: "observed", createdAt: 100, generation: 7, frame: frame, imageWidth: 600, imageHeight: 400)
    try observation.validate(id: "observed", generation: 7, frame: frame, now: 101)
    #expect(throws: (any Error).self) { try observation.validate(id: "other-session", generation: 7, frame: frame, now: 101) }
    #expect(throws: (any Error).self) { try observation.validate(id: "observed", generation: 8, frame: frame, now: 101) }
    #expect(throws: (any Error).self) { try observation.validate(id: "observed", generation: 7, frame: frame, now: 116) }
    #expect(throws: (any Error).self) { try observation.validate(id: "observed", generation: 7, frame: frame.offsetBy(dx: 1, dy: 0), now: 101) }
    #expect(try observation.screenPoint(CGPoint(x: 300, y: 200)) == CGPoint(x: -840, y: 600))
    #expect(throws: (any Error).self) { try observation.screenPoint(CGPoint(x: 600, y: 0)) }
    #expect(throws: (any Error).self) { try observation.screenPoint(CGPoint(x: 0, y: 400)) }
    #expect(throws: (any Error).self) { try observation.screenPoint(CGPoint(x: Double.infinity, y: 0)) }
}

@MainActor
@Test func noSessionMeansNoContentOrInput() async throws {
    let runtime = SessionRuntime()
    let calls: [(String, [String: Any])] = [
        ("computer_observe", ["session_id": "invented"]),
        ("computer_act", ["session_id": "invented", "observation_id": "invented", "request_id": "one", "action": ["type": "click", "x": 10, "y": 20]]),
        ("computer_session_status", ["session_id": "invented"]),
        ("computer_close_session", ["session_id": "invented"]),
    ]
    for (name, args) in calls {
        do { _ = try await runtime.call(name, args); Issue.record("Unapproved access succeeded") }
        catch let error as UseError { #expect(error.code == "session_unavailable") }
    }
}

@MainActor
@Test func legacyEscapeHatchesAreNotTools() async throws {
    let runtime = SessionRuntime()
    for name in ["snapshot", "set_strict_mode", "cua_screenshot", "cua_click", "clipboard_read", "clipboard_write", "open_url", "launch_app"] {
        do { _ = try await runtime.call(name, [:]); Issue.record("Legacy tool succeeded") }
        catch let error as UseError { #expect(error.code == "unknown_tool") }
    }
    let names = Set(MCPServer.schemas().compactMap { $0["name"] as? String })
    #expect(names == ["computer_discover", "computer_open_session", "computer_observe", "computer_act", "computer_session_status", "computer_close_session"])
}
