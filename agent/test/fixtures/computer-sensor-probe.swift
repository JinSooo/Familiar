// OS boundaries are inert: this probe never posts events or opens applications.
import AppKit
import ApplicationServices

typealias AXUIElement = ProbeElement
final class ProbeElement: NSObject {
  var pid: pid_t
  var attrs: [String: AnyObject] = [:]
  init(_ role: String, pid: pid_t = 42) {
    self.pid = pid
    super.init()
    attrs[kAXRoleAttribute] = role as NSString
  }
}
final class ProbeApp: Equatable {
  static func == (a: ProbeApp, b: ProbeApp) -> Bool { a === b }
  static var apps: [pid_t: ProbeApp] = [:]
  let processIdentifier: pid_t
  var bundleIdentifier: String?
  var localizedName: String? = "Editor"
  var bundleURL: URL?
  var activationPolicy: NSApplication.ActivationPolicy = .regular
  var isHidden = false
  var isTerminated = false
  init(_ pid: pid_t, _ bundle: String) { processIdentifier = pid; bundleIdentifier = bundle }
  convenience init?(processIdentifier: pid_t) {
    guard let app = Self.apps[processIdentifier] else { return nil }
    self.init(app.processIdentifier, app.bundleIdentifier ?? "")
  }
  func unhide() {}
}
final class ProbeWorkspace {
  static let shared = ProbeWorkspace()
  var runningApplications: [ProbeApp] { Array(ProbeApp.apps.values) }
  var frontmostApplication: ProbeApp? { ProbeApp.apps[frontPID] }
  func urlForApplication(withBundleIdentifier name: String) -> URL? { resolvedURL }
  func fullPath(forApplication name: String) -> String? { resolvedURL?.path }
}
final class ProbeBundle {
  let bundleIdentifier: String?
  init?(url: URL) { bundleIdentifier = resolvedBundle }
}
final class ProbeProcess {
  var executableURL: URL?
  var arguments: [String]?
  var standardError: Any?
  var terminationStatus: Int32 = 0
  var isRunning = false
  func run() throws { launches += 1 }
  func waitUntilExit() {}
  func terminate() {}
}
final class ProbeCursor {
  var isPlaced = true
  func pulse() {}
  @discardableResult func glide(to: CGPoint) -> Double { 0 }
}
final class ProbeEvent {
  var flags = CGEventFlags()
  var location = CGPoint.zero
  let down: Bool
  var type: CGEventType { down ? .keyDown : .keyUp }
  var units: [UniChar] = []
  init?(keyboardEventSource: Any?, virtualKey: CGKeyCode, keyDown: Bool) { down = keyDown }
  init?(source: Any?) { down = false }
  init?(mouseEventSource: Any?, mouseType: CGEventType, mouseCursorPosition: CGPoint, mouseButton: CGMouseButton) {
    down = false; location = mouseCursorPosition
  }
  init?(scrollWheelEvent2Source: Any?, units: CGScrollEventUnit, wheelCount: UInt32, wheel1: Int32, wheel2: Int32, wheel3: Int32) { down = false }
  func keyboardSetUnicodeString(stringLength: Int, unicodeString: [UniChar]) { units = unicodeString }
  func setIntegerValueField(_ field: CGEventField, value: Int64) {}
  func post(tap: CGEventTapLocation) { record() }
  func postToPid(_ pid: pid_t) { record() }
  func record() {
    posted += 1
    if down { chunks.append(units); afterKey?() }
  }
}
var roots: [pid_t: ProbeElement] = [:]
var frontPID: pid_t = 42
var overlayHit = false
var hit: ProbeElement?
var hitAt: ((CGPoint) -> ProbeElement?)?
var probeWindows: [[String: Any]] = []
var resolvedURL: URL?
var resolvedBundle: String?
var launches = 0
var posted = 0
var writes = 0
var chunks: [[UniChar]] = []
var afterKey: (() -> Void)?
var reads: [String] = []
let cursor = ProbeCursor()
let ourEvents: Int64 = 0
func axAttribute(_ e: AXUIElement, _ name: String) -> AnyObject? { reads.append(name); return e.attrs[name] }
func axString(_ e: AXUIElement, _ name: String) -> String? { axAttribute(e, name) as? String }
func axElement(_ e: AXUIElement, _ name: String) -> AXUIElement? { axAttribute(e, name) as? AXUIElement }
func axChildren(_ e: AXUIElement) -> [AXUIElement] { (axAttribute(e, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func axActions(_ e: AXUIElement) -> [String] { ["AXPress"] }
func axFrame(_ e: AXUIElement) -> CGRect? { CGRect(x: 0, y: 0, width: 100, height: 100) }
func AXUIElementCreateApplication(_ pid: pid_t) -> AXUIElement { roots[pid]! }
func AXUIElementCreateSystemWide() -> AXUIElement { ProbeElement("AXSystemWide", pid: 0) }
@discardableResult func AXUIElementSetMessagingTimeout(_ e: AXUIElement, _ timeout: Float) -> AXError { .success }
func AXUIElementGetPid(_ e: AXUIElement, _ pid: UnsafeMutablePointer<pid_t>) -> AXError { pid.pointee = e.pid; return .success }
func AXUIElementCopyElementAtPosition(_ e: AXUIElement, _ x: Float, _ y: Float, _ out: UnsafeMutablePointer<AXUIElement?>) -> AXError {
  if overlayHit && e.pid == 0 { out.pointee = ProbeElement("AXWindow", pid: getpid()); return .success }
  out.pointee = hitAt?(CGPoint(x: Double(x), y: Double(y))) ?? hit
  return out.pointee == nil ? .failure : .success
}
@discardableResult func AXUIElementSetAttributeValue(_ e: AXUIElement, _ name: CFString, _ value: CFTypeRef) -> AXError { writes += 1; return .success }
@discardableResult func AXUIElementPerformAction(_ e: AXUIElement, _ name: CFString) -> AXError { writes += 1; return .success }
func CGWindowListCopyWindowInfo(_ option: CGWindowListOption, _ window: CGWindowID) -> CFArray? { probeWindows as CFArray }
func arrive(_ point: CGPoint?) throws {}
func bringForward(_ target: Target, window: AXUIElement? = nil) throws {}
func probeSleep(_ n: UInt32) {}
func attribute(_ e: AXUIElement, _ name: String) -> AnyObject? { axAttribute(e, name) }
func string(_ e: AXUIElement, _ name: String) -> String? { axString(e, name) }
func child(_ e: AXUIElement, _ name: String) -> AXUIElement? { axElement(e, name) }

// PRODUCTION

func denied(_ body: () throws -> Void) -> Bool {
  do { try body(); return false } catch { return true }
}
let appRoot = ProbeElement("AXApplication")
let testWindow = ProbeElement("AXWindow")
let field = ProbeElement("AXTextField")
appRoot.attrs[kAXWindowsAttribute] = [testWindow] as NSArray
appRoot.attrs[kAXFocusedUIElementAttribute] = field
appRoot.attrs[kAXFocusedWindowAttribute] = testWindow
testWindow.attrs[kAXChildrenAttribute] = [field] as NSArray
field.attrs[kAXParentAttribute] = testWindow
field.attrs[kAXWindowAttribute] = testWindow
field.attrs[kAXValueAttribute] = "ordinary text" as NSString
roots[42] = appRoot
ProbeApp.apps[42] = ProbeApp(42, "test.editor")
let target = Target(app: ProbeApp.apps[42]!, element: appRoot)
let scenario = CommandLine.arguments[1]
var result: [String: Any] = [:]
switch scenario {
case "read-secure":
  field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString
  field.attrs[kAXTitleAttribute] = "SECRET_LABEL" as NSString
  let nested = ProbeElement("AXStaticText")
  nested.attrs[kAXValueAttribute] = "SECRET_CHILD" as NSString
  nested.attrs[kAXParentAttribute] = field
  field.attrs[kAXChildrenAttribute] = [nested] as NSArray
  result = readWindow(target, testWindow, limit: 100)
case "registered":
  registry.elements[1] = (field, 42, "field")
  result["ordinary"] = !denied { _ = try registered(1) }
  field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString
  result["secure"] = denied { _ = try registered(1) }
  field.attrs.removeValue(forKey: kAXSubroleAttribute)
  for bundle in ["com.apple.keychainaccess", "com.apple.Passwords", "com.allinpet.familiar"] {
    ProbeApp.apps[42]?.bundleIdentifier = bundle
    result[bundle] = denied { _ = try registered(1) }
  }
  ProbeApp.apps[42]?.bundleIdentifier = "test.editor"
  let secureWindow = ProbeElement("AXSecureTextField")
  field.attrs[kAXParentAttribute] = secureWindow
  result["reparented"] = denied { _ = try registered(1) }
case "point":
  hit = field
  probeWindows = [[kCGWindowOwnerPID as String: Int32(42), kCGWindowBounds as String: CGRect(x: 0, y: 0, width: 100, height: 100).dictionaryRepresentation]]
  result["ordinary"] = !denied { try allowPoint(CGPoint(x: 10, y: 10)) }
  overlayHit = true
  result["overlay"] = !denied { try allowPoint(CGPoint(x: 10, y: 10)) }
  overlayHit = false
  field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString
  result["secure"] = denied { try allowPoint(CGPoint(x: 10, y: 10)) }
  field.attrs.removeValue(forKey: kAXSubroleAttribute)
  ProbeApp.apps[42]?.bundleIdentifier = "com.apple.Passwords"
  result["blocked"] = denied { try allowPoint(CGPoint(x: 10, y: 10)) }
case "keys":
  result["ordinary"] = !denied { _ = try pressKeys(["keys": "cmd+a", "app": "test.editor"]) }
  field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString
  let before = posted
  for keys in ["cmd+a", "shift+a", "return", "delete", "a"] {
    result[keys] = denied { _ = try pressKeys(["keys": keys, "app": "test.editor"]) }
  }
  result["posted"] = posted - before
case "focus-change":
  afterKey = { field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString }
  result["denied"] = denied { try keystrokes(String(repeating: "a", count: 32), 42) }
  result["chunks"] = chunks.count
case "global-target":
  roots[43] = ProbeElement("AXApplication", pid: 43)
  ProbeApp.apps[43] = ProbeApp(43, "com.apple.Passwords")
  frontPID = 43
  mode.global = true
  result["denied"] = denied { _ = try pressKeys(["keys": "cmd+a", "app": "test.editor"]) }
  result["posted"] = posted
case "open":
  result["unresolved"] = denied { _ = try openApp(["app": "not-resolvable-by-probe"]) }
  result["unresolvedLaunches"] = launches
  resolvedURL = URL(fileURLWithPath: "/tmp/probe.app")
  resolvedBundle = "com.apple.Passwords"
  result["blocked"] = denied { _ = try openApp(["app": "com.apple.Passwords"]) }
  result["blockedLaunches"] = launches
  resolvedBundle = "test.editor"
  result["ordinary"] = !denied { _ = try openApp(["app": "test.editor"]) }
case "unicode-type":
  try keystrokes(String(repeating: "a", count: 15) + "😀b", 42)
  result["text"] = chunks.map { String(decoding: $0, as: UTF16.self) }.joined()
case "unicode-context":
  let value = String(repeating: "😀", count: 20) + "HERE" + String(repeating: "z", count: 80)
  field.attrs[kAXValueAttribute] = value as NSString
  var range = CFRange(location: 42, length: 0)
  field.attrs[kAXSelectedTextRangeAttribute] = AXValueCreate(.cfRange, &range)
  result["text"] = textContext(field, limit: 10)
case "collector-secure":
  result["ordinary"] = textContext(field)
  let secure = ProbeElement("AXSecureTextField")
  field.attrs[kAXParentAttribute] = secure
  reads.removeAll()
  result["secure"] = textContext(field) == nil
  result["valueReads"] = reads.filter { $0 == kAXValueAttribute || $0 == kAXSelectedTextAttribute }.count
case "element-actions":
  registry.elements[1] = (field, 42, "field")
  result["ordinary"] = !denied { _ = try click(["element": 1]) }
  writes = 0; posted = 0
  let actions: [(String, () throws -> Void)] = [
    ("click", { _ = try click(["element": 1]) }),
    ("type", { _ = try typeText(["element": 1, "text": "hello"]) }),
    ("set", { _ = try setValue(["element": 1, "value": "hello"]) }),
    ("scroll", { _ = try scroll(["element": 1]) }),
    ("drag", { mode.global = true; _ = try drag(["fromElement": 1, "toElement": 1]) }),
  ]
  field.attrs[kAXSubroleAttribute] = "AXSecureTextField" as NSString
  for (name, action) in actions { mode.global = false; result[name] = denied(action) }
  field.attrs.removeValue(forKey: kAXSubroleAttribute)
  ProbeApp.apps[42]?.bundleIdentifier = "com.apple.Passwords"
  for (name, action) in actions {
    mode.global = false
    result["blocked" + name.prefix(1).uppercased() + name.dropFirst()] = denied(action)
  }
  result["writes"] = writes; result["posted"] = posted
case "coordinate-actions":
  mode.global = true
  registry.elements[1] = (field, 42, "field")
  registry.screenshot = (0, CGRect(x: 0, y: 0, width: 100, height: 100), 1)
  probeWindows = [[kCGWindowOwnerPID as String: Int32(42), kCGWindowBounds as String: CGRect(x: 0, y: 0, width: 100, height: 100).dictionaryRepresentation]]
  let secure = ProbeElement("AXSecureTextField")
  hit = secure
  result["click"] = denied { _ = try click(["x": 20.0, "y": 20.0]) }
  result["scroll"] = denied { _ = try scroll(["element": 1]) }
  hitAt = { $0.x < 50 ? secure : field }
  result["dragStart"] = denied { _ = try drag(["fromX": 20.0, "fromY": 20.0, "toX": 80.0, "toY": 80.0]) }
  hitAt = { $0.x > 50 ? secure : field }
  result["dragEnd"] = denied { _ = try drag(["fromX": 20.0, "fromY": 20.0, "toX": 80.0, "toY": 80.0]) }
  result["posted"] = posted
case "cancel-boundary":
  cancellation.receive(1); cancellation.begin(1); cancellation.cancel(1)
  result["old"] = denied { try cancellation.check() }
  cancellation.receive(2); cancellation.begin(2); cancellation.cancel(1)
  result["next"] = !denied { try cancellation.check() }
default: fatalError("Unknown scenario")
}
let output = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: output, encoding: .utf8)!)
