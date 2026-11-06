// `familiar-sensor --control`: Computer Use for the agent (docs/design.md §10 Computer Use).
//
// Long-lived: stdin takes one JSON request per line, {"id":1,"op":"read","app":"Safari"}, and
// stdout answers each with {"id":1,"ok":true,"result":{...}} or {"id":1,"ok":false,"error":"..."}.
// Requests run one at a time, in order.
//
// The Accessibility tree comes first: `read` numbers the elements of a window, and actions name
// an element by that number. Numbers only grow, and only the latest `read` is kept, so a stale
// number fails instead of hitting something else. `screenshot` is the fallback for what the
// tree cannot show; it needs Screen Recording and also returns the text Vision finds in it.
//
// Single-app control (default) acts in the background; global control uses the real pointer and
// keyboard and only after the user approved it (see "Acting"). The pet cursor is cursor.swift.
//
// Hard limits, in every permission mode: Keychain Access, Passwords and Familiar itself are not
// touched, and secure text fields are never read, typed into or set.
import AppKit
import ApplicationServices
import ScreenCaptureKit
import Vision

private let blockedApps: Set<String> = [
  "com.apple.keychainaccess", "com.apple.Passwords", "com.allinpet.familiar",
]

private struct ControlError: Error { let message: String }
private func fail(_ message: String) -> ControlError { ControlError(message: message) }

private func reply(_ fields: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: fields),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}

private func axAttribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
private func axString(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = axAttribute(element, name) else { return nil }
  if let s = value as? String { return s }
  if let n = value as? NSNumber { return n.stringValue }
  return nil
}
private func axElement(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = axAttribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  return (value as! AXUIElement)
}
private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
  (axAttribute(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
}
private func axActions(_ element: AXUIElement) -> [String] {
  var names: CFArray?
  return AXUIElementCopyActionNames(element, &names) == .success ? (names as? [String]) ?? [] : []
}
private func axFrame(_ element: AXUIElement) -> CGRect? {
  guard let p = axAttribute(element, kAXPositionAttribute), let s = axAttribute(element, kAXSizeAttribute),
    CFGetTypeID(p) == AXValueGetTypeID(), CFGetTypeID(s) == AXValueGetTypeID()
  else { return nil }
  var point = CGPoint.zero
  var size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}
private func isSecure(_ element: AXUIElement) -> Bool {
  axString(element, kAXRoleAttribute) == "AXSecureTextField"
    || axString(element, kAXSubroleAttribute) == "AXSecureTextField"
}

private struct Target {
  let app: NSRunningApplication
  let element: AXUIElement
  var name: String { app.localizedName ?? app.bundleIdentifier ?? "应用" }
}

private func runningApps() -> [NSRunningApplication] {
  NSWorkspace.shared.runningApplications.filter {
    $0.activationPolicy == .regular && $0.processIdentifier != getpid()
      && !blockedApps.contains($0.bundleIdentifier ?? "")
  }
}

/// An app by name or bundle id, as `apps` lists them.
private func findApp(_ query: String?) throws -> Target {
  let all = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
  let app: NSRunningApplication?
  if let query, !query.isEmpty {
    let q = query.lowercased()
    app =
      all.first { $0.bundleIdentifier?.lowercased() == q || $0.localizedName?.lowercased() == q }
      ?? all.first { ($0.localizedName?.lowercased() ?? "").contains(q) }
  } else {
    app = NSWorkspace.shared.frontmostApplication
  }
  guard let app else { throw fail("没有在运行的「\(query ?? "")」，先用 open_app 打开它") }
  if blockedApps.contains(app.bundleIdentifier ?? "") {
    throw fail("「\(app.localizedName ?? "这个应用")」不能操作（钥匙串、密码和 Familiar 自己永远不碰）")
  }
  let element = AXUIElementCreateApplication(app.processIdentifier)
  AXUIElementSetMessagingTimeout(element, 3)
  // Chromium and Electron apps only build their tree when asked.
  AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
  return Target(app: app, element: element)
}

private func windows(of target: Target) -> [AXUIElement] {
  (axAttribute(target.element, kAXWindowsAttribute) as? [AXUIElement]) ?? []
}
private func window(of target: Target, index: Int?) throws -> AXUIElement {
  let list = windows(of: target)
  if let index {
    guard index >= 0 && index < list.count else { throw fail("「\(target.name)」没有第 \(index) 个窗口") }
    return list[index]
  }
  if let w = axElement(target.element, kAXFocusedWindowAttribute) ?? axElement(target.element, kAXMainWindowAttribute)
    ?? list.first
  {
    return w
  }
  throw fail("「\(target.name)」现在没有打开的窗口")
}

/// Brings the app forward through Accessibility (works from a background helper, unlike activate()).
private func bringForward(_ target: Target, window: AXUIElement? = nil) {
  if target.app.isHidden { target.app.unhide() }
  AXUIElementSetAttributeValue(target.element, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
  if let window {
    AXUIElementPerformAction(window, kAXRaiseAction as CFString)
  }
  for _ in 0..<20 where NSWorkspace.shared.frontmostApplication != target.app {
    usleep(50_000)
  }
}

// MARK: - Reading

private final class Registry {
  var next = 1
  var elements: [Int: (AXUIElement, pid_t, String)] = [:]
  var screenshot: (pid: pid_t, frame: CGRect, scale: CGFloat)?
}
private let registry = Registry()

private let skippedRoles: Set<String> = [
  "AXScrollBar", "AXValueIndicator", "AXGrowArea", "AXRuler", "AXRulerMarker", "AXSplitter",
]
private let inputRoles: Set<String> = [
  "AXTextField", "AXTextArea", "AXComboBox", "AXSearchField", "AXSecureTextField",
]

private func label(_ element: AXUIElement) -> String {
  for name in [kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", kAXHelpAttribute] {
    if let s = axString(element, name)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
      return s
    }
  }
  if let title = axElement(element, kAXTitleUIElementAttribute), let s = axString(title, kAXValueAttribute),
    !s.isEmpty
  {
    return s
  }
  return ""
}
private func clip(_ s: String, _ limit: Int) -> String {
  let one = s.replacingOccurrences(of: "\n", with: " ⏎ ")
  return one.count > limit ? String(one.prefix(limit - 1)) + "…" : one
}

/// The window's elements worth naming, depth-first, within a budget.
private func readWindow(_ target: Target, _ window: AXUIElement, limit: Int) -> [String: Any] {
  registry.elements.removeAll()
  registry.screenshot = nil
  var nodes: [[String: Any]] = []
  var visited = 0
  var truncated = false
  let focused = axElement(target.element, kAXFocusedUIElementAttribute)
  func walk(_ element: AXUIElement, depth: Int) {
    if visited >= 6000 || nodes.count >= limit {
      truncated = true
      return
    }
    visited += 1
    let role = axString(element, kAXRoleAttribute) ?? ""
    if skippedRoles.contains(role) { return }
    if let hidden = axAttribute(element, "AXHidden") as? Bool, hidden { return }
    let name = label(element)
    let secure = isSecure(element)
    let actions = axActions(element).filter { $0 != "AXScrollToVisible" && $0 != "AXShowAlternateUI" }
    let input = inputRoles.contains(role)
    var value = secure ? nil : axString(element, kAXValueAttribute)?.trimmingCharacters(in: .whitespacesAndNewlines)
    if value == name { value = nil }
    // A bare number with nothing to press is layout (ruler markers, splitters), not content.
    if name.isEmpty && actions.isEmpty && !input && role != "AXStaticText", let v = value, Double(v) != nil {
      value = nil
    }
    let useful =
      !name.isEmpty || !(value ?? "").isEmpty || input || secure
      || (!actions.isEmpty && role != "AXGroup" && role != "AXScrollArea" && role != "AXSplitGroup")
    var childDepth = depth
    if useful && role != "AXWindow" {
      let id = registry.next
      registry.next += 1
      registry.elements[id] = (element, target.app.processIdentifier, name.isEmpty ? role : name)
      var node: [String: Any] = ["i": id, "role": String(role.dropFirst(2)), "depth": depth]
      if let sub = axString(element, kAXSubroleAttribute), sub != "AXStandardWindow" {
        node["subrole"] = String(sub.dropFirst(2))
      }
      if !name.isEmpty { node["label"] = clip(name, 120) }
      if let value, !value.isEmpty { node["value"] = clip(value, role == "AXStaticText" ? 300 : 200) }
      if secure { node["secure"] = true }
      if let enabled = axAttribute(element, kAXEnabledAttribute) as? Bool, !enabled { node["disabled"] = true }
      if let selected = axAttribute(element, kAXSelectedAttribute) as? Bool, selected { node["selected"] = true }
      if let focused, CFEqual(focused, element) { node["focused"] = true }
      nodes.append(node)
      childDepth = depth + 1
    }
    for child in axChildren(element) { walk(child, depth: childDepth) }
  }
  walk(window, depth: 0)
  var result: [String: Any] = [
    "app": target.name, "bundleId": target.app.bundleIdentifier ?? "",
    "window": axString(window, kAXTitleAttribute) ?? "", "elements": nodes,
  ]
  if truncated { result["truncated"] = true }
  return result
}

private func appList() -> [[String: Any]] {
  let front = NSWorkspace.shared.frontmostApplication
  return runningApps().map { app in
    let element = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(element, 1)
    let titles = ((axAttribute(element, kAXWindowsAttribute) as? [AXUIElement]) ?? []).prefix(8).map {
      axString($0, kAXTitleAttribute) ?? ""
    }
    var entry: [String: Any] = [
      "name": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "", "windows": titles,
    ]
    if app == front { entry["active"] = true }
    if app.isHidden { entry["hidden"] = true }
    return entry
  }
}

// MARK: - Acting
//
// Two ways to act (docs/design.md §10, user's rule 2026-11-06). Single-app control is the
// default and works in the background: the app is not brought forward and the user's pointer and
// keyboard are never touched. Clicks use the element's Accessibility action, typing goes in
// through Accessibility or as keystrokes posted to that app's process only. What the background
// cannot reach (an element with nothing to press, a screen coordinate, a drag) asks for global
// control, which the user approves: then the app comes forward and the real pointer and keyboard
// are used, and Esc stops it.

private final class Mode { var global = false }
private let mode = Mode()
/// Marks the events we post, so the Esc watch in global control ignores our own keys.
let ourEvents: Int64 = 0x4641_4D49
private let cursor = CursorOverlay.shared

private func registered(_ id: Int) throws -> (Target, AXUIElement) {
  guard let (element, pid, _) = registry.elements[id] else {
    throw fail("元素 \(id) 已过期或不存在，先用 read_window 重新读一次")
  }
  guard let app = NSRunningApplication(processIdentifier: pid) else { throw fail("那个应用已经退出了") }
  let appElement = AXUIElementCreateApplication(pid)
  AXUIElementSetMessagingTimeout(appElement, 3)
  return (Target(app: app, element: appElement), element)
}

private func center(_ element: AXUIElement) -> CGPoint? {
  guard let f = axFrame(element), f.width > 0, f.height > 0 else { return nil }
  return CGPoint(x: f.midX, y: f.midY)
}
private func windowCenter(_ target: Target) -> CGPoint? {
  (try? window(of: target, index: nil)).flatMap(center)
}

/// Glides the pet cursor there and waits until it arrives.
private func arrive(_ point: CGPoint?) {
  guard let point else { return }
  let duration = cursor.glide(to: point)
  if mode.global {
    // The real pointer travels with it.
    let from = CGEvent(source: nil)?.location ?? point
    let steps = max(1, Int(duration * 60))
    for n in 1...steps {
      let t = Double(n) / Double(steps)
      let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
      let p = CGPoint(x: from.x + (point.x - from.x) * eased, y: from.y + (point.y - from.y) * eased)
      hid(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
      usleep(UInt32(1_000_000 * duration / Double(steps)))
    }
  } else if duration > 0 {
    usleep(UInt32(duration * 1_000_000))
  }
}

private func hid(_ event: CGEvent?) {
  event?.setIntegerValueField(.eventSourceUserData, value: ourEvents)
  event?.post(tap: .cghidEventTap)
}
/// Keyboard events: the real keyboard in global control, else that app's process only.
private func key(_ event: CGEvent?, _ pid: pid_t) {
  guard let event else { return }
  event.setIntegerValueField(.eventSourceUserData, value: ourEvents)
  if mode.global { event.post(tap: .cghidEventTap) } else { event.postToPid(pid) }
}

private func realClick(_ point: CGPoint, button: String, count: Int) {
  let (down, up, mouse): (CGEventType, CGEventType, CGMouseButton) =
    button == "right" ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
  for n in 1...max(1, count) {
    for type in [down, up] {
      let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: mouse)
      event?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
      hid(event)
      usleep(20_000)
    }
    usleep(60_000)
  }
}

/// The nearest relative that can be pressed and covers the same spot: a parent row or cell up to
/// four levels up, or a child (three levels down). Background clicks have no other way in.
private func pressableNear(_ element: AXUIElement) -> (AXUIElement, String)? {
  let point = center(element)
  let covers = { (e: AXUIElement) -> Bool in
    guard let point, let f = axFrame(e) else { return true }
    return f.insetBy(dx: -1, dy: -1).contains(point)
  }
  let press = { (e: AXUIElement) -> String? in
    let actions = axActions(e)
    return ["AXPress", "AXConfirm", "AXPick", "AXOpen"].first { actions.contains($0) }
  }
  var node = axElement(element, kAXParentAttribute)
  for _ in 0..<4 {
    guard let current = node else { break }
    let role = axString(current, kAXRoleAttribute) ?? ""
    if role == "AXWindow" || role == "AXApplication" { break }
    if let how = press(current), covers(current) { return (current, how) }
    // A table or outline row is chosen by selecting it.
    if role == "AXRow",
      AXUIElementSetAttributeValue(current, kAXSelectedAttribute as CFString, kCFBooleanTrue) == .success
    {
      return (current, "selected")
    }
    node = axElement(current, kAXParentAttribute)
  }
  var queue: [(AXUIElement, Int)] = axChildren(element).map { ($0, 1) }
  while !queue.isEmpty {
    let (e, depth) = queue.removeFirst()
    if let how = press(e), covers(e) { return (e, how) }
    if depth < 3 { queue.append(contentsOf: axChildren(e).map { ($0, depth + 1) }) }
  }
  return nil
}

private let needsGlobal = "这一步要接管鼠标：先用 take_over 申请全局控制，用户同意后再做"

private func verb(_ button: String, _ count: Int) -> String {
  button == "right" ? "右键点击" : count > 1 ? "双击" : "点击"
}

private func click(_ request: [String: Any]) throws -> String {
  let button = request["button"] as? String ?? "left"
  let count = request["count"] as? Int ?? 1
  if let id = request["element"] as? Int {
    let (target, element) = try registered(id)
    let name = registry.elements[id]?.2 ?? ""
    let actions = axActions(element)
    arrive(center(element))
    if button == "left" && count == 1 {
      for action in ["AXPress", "AXConfirm", "AXPick", "AXOpen"] where actions.contains(action) {
        if AXUIElementPerformAction(element, action as CFString) == .success {
          cursor.pulse()
          return "已点击「\(name)」"
        }
      }
    }
    if button == "left" && count == 1 {
      if inputRoles.contains(axString(element, kAXRoleAttribute) ?? ""),
        AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) == .success
      {
        cursor.pulse()
        return "已把焦点放到「\(name)」"
      }
      if let (pressable, how) = pressableNear(element),
        how == "selected" || AXUIElementPerformAction(pressable, how as CFString) == .success
      {
        cursor.pulse()
        return "已点击「\(name)」（按的是它所在的那一行）"
      }
    }
    if button == "left" && count == 2 && actions.contains("AXOpen")
      && AXUIElementPerformAction(element, "AXOpen" as CFString) == .success
    {
      cursor.pulse()
      return "已打开「\(name)」"
    }
    if button == "right" && actions.contains("AXShowMenu")
      && AXUIElementPerformAction(element, "AXShowMenu" as CFString) == .success
    {
      cursor.pulse()
      return "已打开「\(name)」的右键菜单"
    }
    guard mode.global else { throw fail("「\(name)」在后台\(verb(button, count))不了（它没有能直接按下的动作）。\(needsGlobal)") }
    guard let point = center(element) else {
      throw fail("「\(name)」读不到位置；可以 screenshot 后按坐标点")
    }
    bringForward(target)
    realClick(point, button: button, count: count)
    cursor.pulse()
    return "已在「\(name)」上\(verb(button, count))"
  }
  guard let x = request["x"] as? Double, let y = request["y"] as? Double else {
    throw fail("要给元素编号，或者 screenshot 里的 x、y 坐标")
  }
  guard mode.global else { throw fail("按坐标点击会用到真鼠标。\(needsGlobal)") }
  guard let shot = registry.screenshot else { throw fail("按坐标点击要先 screenshot") }
  let point = CGPoint(x: shot.frame.minX + x / shot.scale, y: shot.frame.minY + y / shot.scale)
  guard shot.frame.insetBy(dx: -1, dy: -1).contains(point) else { throw fail("坐标在截图范围外") }
  if shot.pid != 0, let app = NSRunningApplication(processIdentifier: shot.pid) {
    bringForward(try findApp(app.bundleIdentifier))
  }
  arrive(point)
  realClick(point, button: button, count: count)
  cursor.pulse()
  return "已在截图的 (\(Int(x)), \(Int(y))) 处\(verb(button, count))"
}

private func point(of request: [String: Any], _ prefix: String) throws -> CGPoint {
  if let id = request["\(prefix)Element"] as? Int {
    let (_, element) = try registered(id)
    guard let p = center(element) else { throw fail("读不到元素 \(id) 的位置") }
    return p
  }
  guard let x = request["\(prefix)X"] as? Double, let y = request["\(prefix)Y"] as? Double,
    let shot = registry.screenshot
  else { throw fail("拖拽的起点和终点要给元素编号，或者 screenshot 里的坐标") }
  return CGPoint(x: shot.frame.minX + x / shot.scale, y: shot.frame.minY + y / shot.scale)
}

private func drag(_ request: [String: Any]) throws -> String {
  guard mode.global else { throw fail("拖拽会用到真鼠标。\(needsGlobal)") }
  let from = try point(of: request, "from")
  let to = try point(of: request, "to")
  arrive(from)
  hid(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
  usleep(120_000)
  cursor.glide(to: to)
  let steps = 30
  for n in 1...steps {
    let t = Double(n) / Double(steps)
    let p = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
    hid(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left))
    usleep(15_000)
  }
  usleep(80_000)
  hid(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
  cursor.pulse()
  return "已从 (\(Int(from.x)), \(Int(from.y))) 拖到 (\(Int(to.x)), \(Int(to.y)))（屏幕坐标）"
}

private let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12,
  "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23,
  "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34,
  "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46,
  ".": 47, "`": 50, "return": 36, "enter": 36, "tab": 48, "space": 49, "delete": 51, "backspace": 51,
  "escape": 53, "esc": 53, "forwarddelete": 117, "home": 115, "end": 119, "pageup": 116,
  "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126, "f1": 122, "f2": 120, "f3": 99,
  "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100, "f9": 101, "f10": 109, "f11": 103, "f12": 111,
]
private let modifierFlags: [String: CGEventFlags] = [
  "cmd": .maskCommand, "command": .maskCommand, "shift": .maskShift, "option": .maskAlternate,
  "alt": .maskAlternate, "ctrl": .maskControl, "control": .maskControl, "fn": .maskSecondaryFn,
]

private func focusedIsSecure(_ target: Target) -> Bool {
  axElement(target.element, kAXFocusedUIElementAttribute).map(isSecure) ?? false
}

private func pressKeys(_ request: [String: Any]) throws -> String {
  guard let keys = request["keys"] as? String, !keys.isEmpty else { throw fail("要给按键，比如 cmd+l 或 return") }
  let target = try findApp(request["app"] as? String)
  var flags = CGEventFlags()
  var code: CGKeyCode?
  // "+" itself is a key: "+", "cmd++" and "cmd+plus" all mean shift+= with the modifiers.
  var spec = keys.lowercased().replacingOccurrences(of: " ", with: "")
  if spec == "+" { spec = "plus" } else if spec.hasSuffix("++") { spec = String(spec.dropLast()) + "plus" }
  for part in spec.split(separator: "+").map(String.init) {
    if part == "plus" {
      flags.insert(.maskShift)
      code = 24
    } else if let flag = modifierFlags[part] { flags.insert(flag) } else if let c = keyCodes[part] { code = c } else {
      throw fail("不认识的按键「\(part)」")
    }
  }
  guard let code else { throw fail("「\(keys)」里没有主键") }
  if mode.global { bringForward(target) }
  // A shortcut can't leak a password, but typed characters could: plain keys skip secure fields.
  if flags.isEmpty && code < 50 && focusedIsSecure(target) { throw fail("焦点在密码框里，不往里输入") }
  arrive(cursor.isPlaced ? nil : windowCenter(target))
  for down in [true, false] {
    let event = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
    event?.flags = flags
    key(event, target.app.processIdentifier)
    usleep(20_000)
  }
  return "已在「\(target.name)」按下 \(keys)"
}

private func keystrokes(_ text: String, _ pid: pid_t) {
  let lines = text.components(separatedBy: "\n")
  for (n, line) in lines.enumerated() {
    let units = Array(line.utf16)
    var start = 0
    while start < units.count {
      let chunk = Array(units[start..<min(start + 16, units.count)])
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
        event?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        key(event, pid)
      }
      usleep(12_000)
      start += 16
    }
    if n < lines.count - 1 {
      for down in [true, false] {
        let event = CGEvent(keyboardEventSource: nil, virtualKey: 36, keyDown: down)
        event?.flags = .maskShift
        key(event, pid)
      }
      usleep(12_000)
    }
  }
}

private func typeText(_ request: [String: Any]) throws -> String {
  guard let text = request["text"] as? String, !text.isEmpty else { throw fail("要给输入的文字") }
  var target: Target
  if let id = request["element"] as? Int {
    let (t, element) = try registered(id)
    target = t
    if isSecure(element) { throw fail("那是密码框，不往里输入") }
    arrive(center(element))
    if mode.global {
      bringForward(target)
      if AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue) != .success,
        let point = center(element)
      {
        realClick(point, button: "left", count: 1)
      }
      usleep(80_000)
    } else {
      AXUIElementSetAttributeValue(element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
      // Insert at the caret through Accessibility: no keystrokes, works with the app behind.
      let before = axString(element, kAXValueAttribute)
      if AXUIElementSetAttributeValue(element, kAXSelectedTextAttribute as CFString, text as CFString) == .success {
        let after = axString(element, kAXValueAttribute)
        if after != before || (before == nil && after == nil) {
          let field = registry.elements[id]?.2 ?? ""
          return "已在「\(field.hasPrefix("AX") || field.isEmpty ? target.name : field)」输入 \(text.count) 个字"
        }
      }
    }
  } else {
    target = try findApp(request["app"] as? String)
    if mode.global { bringForward(target) }
    arrive(cursor.isPlaced ? nil : windowCenter(target))
  }
  if focusedIsSecure(target) { throw fail("焦点在密码框里，不往里输入") }
  keystrokes(text, target.app.processIdentifier)
  return "已在「\(target.name)」输入 \(text.count) 个字"
}

private func setValue(_ request: [String: Any]) throws -> String {
  guard let id = request["element"] as? Int, let value = request["value"] as? String else {
    throw fail("要给元素编号和新的值")
  }
  let (_, element) = try registered(id)
  if isSecure(element) { throw fail("那是密码框，不往里填") }
  arrive(center(element))
  let result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, value as CFString)
  guard result == .success else { throw fail("这个元素的值改不了（\(result.rawValue)），可以点它再用 type_text 输入") }
  return "已把「\(registry.elements[id]?.2 ?? "")」设为「\(clip(value, 60))」"
}

/// The scroll bar that moves `element`'s content: its own, an enclosing scroll area's, or the
/// first scroll area inside it (for a whole window).
private func scrollBar(_ element: AXUIElement, horizontal: Bool) -> AXUIElement? {
  let name = horizontal ? kAXHorizontalScrollBarAttribute : kAXVerticalScrollBarAttribute
  var node: AXUIElement? = element
  for _ in 0..<12 {
    guard let current = node else { break }
    if let bar = axElement(current, name) { return bar }
    node = axElement(current, kAXParentAttribute)
  }
  var queue = [element]
  var visited = 0
  while !queue.isEmpty && visited < 400 {
    let e = queue.removeFirst()
    visited += 1
    if let bar = axElement(e, name) { return bar }
    queue.append(contentsOf: axChildren(e))
  }
  return nil
}

private func scroll(_ request: [String: Any]) throws -> String {
  let direction = request["direction"] as? String ?? "down"
  let amount = Int32(max(1, min(request["amount"] as? Int ?? 5, 50)))
  var element: AXUIElement
  var target: Target
  var name: String
  if let id = request["element"] as? Int {
    (target, element) = try registered(id)
    name = registry.elements[id]?.2 ?? ""
  } else {
    target = try findApp(request["app"] as? String)
    element = try window(of: target, index: request["window"] as? Int)
    name = target.name
  }
  let point = center(element)
  arrive(point)
  let words = ["up": "上", "left": "左", "right": "右"][direction] ?? "下"
  if !mode.global {
    // In the background: move the scroll bar through Accessibility, about a tenth per 5 lines.
    let horizontal = direction == "left" || direction == "right"
    guard let bar = scrollBar(element, horizontal: horizontal),
      let current = axAttribute(bar, kAXValueAttribute) as? Double
    else { throw fail("「\(name)」在后台滚不了（找不到滚动条）。\(needsGlobal)") }
    let sign: Double = direction == "up" || direction == "left" ? -1 : 1
    let next = min(1, max(0, current + sign * Double(amount) * 0.02))
    let result = AXUIElementSetAttributeValue(bar, kAXValueAttribute as CFString, next as CFNumber)
    guard result == .success else { throw fail("「\(name)」在后台滚不了（\(result.rawValue)）。\(needsGlobal)") }
    return "已在「\(name)」往\(words)滚动（位置 \(Int(current * 100))% → \(Int(next * 100))%）"
  }
  guard let point else { throw fail("读不到「\(name)」的位置") }
  bringForward(target)
  let (dy, dx): (Int32, Int32) =
    switch direction {
    case "up": (amount, 0)
    case "left": (0, amount)
    case "right": (0, -amount)
    default: (-amount, 0)
    }
  let event = CGEvent(
    scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0)
  event?.location = point
  hid(event)
  return "已在「\(name)」往\(words)滚动 \(amount) 行"
}

private func openApp(_ request: [String: Any]) throws -> String {
  guard let name = request["app"] as? String, !name.isEmpty else { throw fail("要给应用名或 bundle id") }
  let url: URL? =
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: name)
    ?? ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
      NSHomeDirectory() + "/Applications"]
    .map { URL(fileURLWithPath: "\($0)/\(name).app") }
    .first { FileManager.default.fileExists(atPath: $0.path) }
  if let bundle = url.flatMap({ Bundle(url: $0)?.bundleIdentifier }), blockedApps.contains(bundle) {
    throw fail("这个应用不能操作（钥匙串、密码和 Familiar 自己永远不碰）")
  }
  let open = Process()
  open.executableURL = URL(fileURLWithPath: "/usr/bin/open")
  // -g: launch or reopen without bringing it forward, so the user keeps what they are doing.
  open.arguments = (mode.global ? [] : ["-g"]) + (url.map { [$0.path] } ?? ["-a", name])
  open.standardError = FileHandle.nullDevice
  try open.run()
  open.waitUntilExit()
  guard open.terminationStatus == 0 else { throw fail("找不到应用「\(name)」") }
  for _ in 0..<50 {
    if let target = try? findApp(url.flatMap { Bundle(url: $0)?.bundleIdentifier } ?? name),
      !windows(of: target).isEmpty
    {
      if mode.global { bringForward(target) }
      arrive(windowCenter(target))
      return mode.global ? "已打开「\(target.name)」" : "已在后台打开「\(target.name)」（没有切到前台）"
    }
    usleep(100_000)
  }
  return "已让系统打开「\(name)」，窗口还没出现"
}

// MARK: - Screenshot

private func wait<T>(_ work: @escaping @Sendable () async throws -> T) throws -> T {
  let semaphore = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var result: Result<T, Error> = .failure(fail("超时"))
  Task.detached {
    do { result = .success(try await work()) } catch { result = .failure(error) }
    semaphore.signal()
  }
  if semaphore.wait(timeout: .now() + 20) == .timedOut { throw fail("截图超时") }
  return try result.get()
}

/// The main display, for global control without an app: everything on screen except our cursor.
private func screenshotScreen(_ request: [String: Any]) throws -> [String: Any] {
  let maxSide = CGFloat(request["maxSide"] as? Int ?? 1600)
  let ours = cursor.windowNumber
  let (image, scale, frame): (CGImage, CGFloat, CGRect) = try wait {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    let main = CGMainDisplayID()
    guard let display = content.displays.first(where: { $0.displayID == main }) ?? content.displays.first
    else { throw fail("找不到屏幕") }
    let mine = content.windows.filter { $0.windowID == CGWindowID(ours ?? -1) }
    let filter = SCContentFilter(display: display, excludingWindows: mine)
    let config = SCStreamConfiguration()
    let scale = min(CGFloat(filter.pointPixelScale), maxSide / CGFloat(max(display.width, display.height)))
    config.width = Int(CGFloat(display.width) * scale)
    config.height = Int(CGFloat(display.height) * scale)
    config.showsCursor = true
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    return (image, scale, CGDisplayBounds(display.displayID))
  }
  registry.screenshot = (0, frame, scale)
  return try described(image, app: "整个屏幕", window: "")
}

private func described(_ image: CGImage, app: String, window: String) throws -> [String: Any] {
  let size = CGSize(width: image.width, height: image.height)
  let rep = NSBitmapImageRep(cgImage: image)
  guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.75]) else {
    throw fail("截图编码失败")
  }
  let texts: [[String: Any]] = try wait {
    var request = RecognizeTextRequest()
    request.recognitionLanguages = [Locale.Language(identifier: "zh-Hans"), Locale.Language(identifier: "en-US")]
    request.usesLanguageCorrection = true
    let found = (try? await request.perform(on: image)) ?? []
    return found.compactMap { observation -> [String: Any]? in
      let text = observation.topCandidates(1).first?.string ?? ""
      if text.isEmpty { return nil }
      let box = observation.boundingBox.toImageCoordinates(size, origin: .upperLeft)
      return ["text": text, "x": Int(box.midX), "y": Int(box.midY)]
    }
  }
  return [
    "app": app, "window": window, "width": image.width, "height": image.height,
    "jpeg": jpeg.base64EncodedString(), "texts": texts,
  ]
}

private func screenshot(_ request: [String: Any]) throws -> [String: Any] {
  if !CGPreflightScreenCaptureAccess() {
    CGRequestScreenCaptureAccess()
    throw fail("截图需要「屏幕录制」权限：已请求，请在系统设置 › 隐私与安全性 › 屏幕与系统录音 里打开 Familiar，再重新打开 Familiar 后再试")
  }
  if mode.global && (request["app"] as? String ?? "").isEmpty { return try screenshotScreen(request) }
  let target = try findApp(request["app"] as? String)
  let axWindow = try window(of: target, index: request["window"] as? Int)
  guard let frame = axFrame(axWindow) else { throw fail("读不到窗口的位置") }
  let pid = target.app.processIdentifier
  let maxSide = CGFloat(request["maxSide"] as? Int ?? 1440)
  let (image, scale): (CGImage, CGFloat) = try wait {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let candidates = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 }
    guard
      let window = candidates.min(by: {
        abs($0.frame.minX - frame.minX) + abs($0.frame.minY - frame.minY) + abs($0.frame.width - frame.width)
          < abs($1.frame.minX - frame.minX) + abs($1.frame.minY - frame.minY) + abs($1.frame.width - frame.width)
      })
    else { throw fail("这个窗口不在屏幕上（可能最小化了或在别的桌面）") }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let config = SCStreamConfiguration()
    let native = CGFloat(filter.pointPixelScale)
    let scale = min(native, maxSide / max(window.frame.width, window.frame.height))
    config.width = Int(window.frame.width * scale)
    config.height = Int(window.frame.height * scale)
    config.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
    return (image, scale)
  }
  registry.screenshot = (pid, frame, scale)
  return try described(image, app: target.name, window: axString(axWindow, kAXTitleAttribute) ?? "")
}

// MARK: - Loop

nonisolated(unsafe) private var escTap: CFMachPort?

func runControl() -> Never {
  setvbuf(stdout, nil, _IOLBF, 0)
  Thread.detachNewThread {
    while let line = readLine() {
      guard let data = line.data(using: .utf8),
        let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
        let id = request["id"] as? Int
      else { continue }
      do {
        if !AXIsProcessTrusted() {
          throw fail("Familiar 还没有「辅助功能」权限：请在系统设置 › 隐私与安全性 › 辅助功能 里打开 Familiar")
        }
        let result: Any
        if let global = request["global"] as? Bool, global != mode.global {
          mode.global = global
          cursor.setGlobal(global)
        }
        switch request["op"] as? String ?? "" {
        case "cursor":
          if request["show"] as? Bool == true {
            cursor.show(sheet: request["sheet"] as? String, rate: request["rate"] as? Double ?? 1)
          } else {
            cursor.hide()
          }
          result = "ok"
        case "drag": result = try drag(request)
        case "apps": result = appList()
        case "read":
          let target = try findApp(request["app"] as? String)
          let w = try window(of: target, index: request["window"] as? Int)
          // Only when the model asked to read (not the re-read after each action).
          if request["shown"] as? Bool == true { arrive(center(w)) }
          result = readWindow(target, w, limit: request["limit"] as? Int ?? 400)
        case "click": result = try click(request)
        case "type": result = try typeText(request)
        case "key": result = try pressKeys(request)
        case "set": result = try setValue(request)
        case "scroll": result = try scroll(request)
        case "open": result = try openApp(request)
        case "screenshot": result = try screenshot(request)
        default: throw fail("未知操作")
        }
        reply(["id": id, "ok": true, "result": result])
      } catch let error as ControlError {
        reply(["id": id, "ok": false, "error": error.message])
      } catch {
        reply(["id": id, "ok": false, "error": error.localizedDescription])
      }
    }
    exit(0)
  }
  // Esc from the user (not one we posted) stops global control. An event tap, not an NSEvent
  // monitor: those only fire inside NSApp.run(), and this loop is a plain run loop. A default
  // (not listen-only) tap needs only Accessibility, not Input Monitoring; it passes every event
  // through unchanged.
  let watch: CGEventTapCallBack = { _, type, event, _ in
    // The system turns a slow tap off; turn it back on.
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
      if let tap = escTap { CGEvent.tapEnable(tap: tap, enable: true) }
      return Unmanaged.passUnretained(event)
    }
    if type == .keyDown, mode.global, event.getIntegerValueField(.keyboardEventKeycode) == 53,
      event.getIntegerValueField(.eventSourceUserData) != ourEvents
    {
      reply(["event": "escape"])
    }
    return Unmanaged.passUnretained(event)
  }
  if let tap = CGEvent.tapCreate(
    tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
    eventsOfInterest: CGEventMask(1 << CGEventType.keyDown.rawValue), callback: watch, userInfo: nil)
  {
    escTap = tap
    CFRunLoopAddSource(CFRunLoopGetMain(), CFMachPortCreateRunLoopSource(nil, tap, 0), .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
  } else {
    FileHandle.standardError.write(Data("familiar-sensor: no Esc watch (event tap refused)\n".utf8))
  }
  // Accessory, not prohibited: the pet cursor is a window of ours. Still no Dock icon.
  NSApplication.shared.setActivationPolicy(.accessory)
  RunLoop.main.run()
  exit(0)
}
