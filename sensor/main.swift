// familiar-sensor: Familiar's Computer History collector (docs/design.md §7).
//
// Started by the agent as a child process. stdin takes one JSON object per line:
//   {"type":"config","apps":["com.google.Chrome",...],"paused":false}
//   {"type":"prompt"}    ask macOS to show the Accessibility permission prompt
// stdout gives one JSON event per line; logs go to stderr only.
//
// Event-driven only: app switches and Accessibility notifications from every app except the
// excluded ones (the "apps" of the config command; plus a coarse idle check). Never
// screenshots. Secure text fields are never read. Excluded apps are not observed at all.
import AppKit
import ApplicationServices
import CoreAudio

setvbuf(stdout, nil, _IOLBF, 0)

// `familiar-sensor --icon <bundle id> <out.png>`: write the app's icon as a 64px PNG and exit.
let arguments = CommandLine.arguments
// `familiar-sensor --pdf <path>`: a PDF's text for the knowledge base, with OCR (pdf.swift).
if arguments.count == 3 && arguments[1] == "--pdf" { runPdf(arguments[2]) }
if arguments.count == 4 && arguments[1] == "--icon" {
  guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: arguments[2]) else {
    exit(1)
  }
  let icon = NSWorkspace.shared.icon(forFile: app.path)
  let size = 64
  guard
    let bitmap = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8,
      samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
      bytesPerRow: 0, bitsPerPixel: 0)
  else { exit(1) }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  icon.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
  NSGraphicsContext.restoreGraphicsState()
  guard let png = bitmap.representation(using: .png, properties: [:]),
    (try? png.write(to: URL(fileURLWithPath: arguments[3]))) != nil
  else { exit(1) }
  exit(0)
}

// `familiar-sensor --context`: whether now is a bad moment to speak up, as one JSON line, then
// exit. Window bounds and owners need no Screen Recording permission; titles are not read.
if arguments.count == 2 && arguments[1] == "--context" {
  var fullscreen = false
  if let front = NSWorkspace.shared.frontmostApplication,
    let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
      as? [[String: Any]]
  {
    let screens = NSScreen.screens.map { $0.frame.size }
    for w in windows where (w[kCGWindowOwnerPID as String] as? pid_t) == front.processIdentifier
      && (w[kCGWindowLayer as String] as? Int) == 0
    {
      guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
      let size = CGSize(width: b["Width"] ?? 0, height: b["Height"] ?? 0)
      if screens.contains(where: { $0 == size }) { fullscreen = true }
      break
    }
  }
  // The default input device running for any process: a call, a recording, dictation.
  var device = AudioDeviceID(0)
  var size = UInt32(MemoryLayout<AudioDeviceID>.size)
  var address = AudioObjectPropertyAddress(
    mSelector: kAudioHardwarePropertyDefaultInputDevice,
    mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
  var microphone = false
  if AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &device)
    == noErr
  {
    var running = UInt32(0)
    size = UInt32(MemoryLayout<UInt32>.size)
    address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    if AudioObjectGetPropertyData(device, &address, 0, nil, &size, &running) == noErr {
      microphone = running != 0
    }
  }
  let front = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
  let data = try! JSONSerialization.data(withJSONObject: [
    "fullscreen": fullscreen, "microphone": microphone, "front": front,
  ])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}

func emit(_ fields: [String: Any]) {
  var fields = fields
  fields["at"] = Int(Date().timeIntervalSince1970 * 1000)
  guard let data = try? JSONSerialization.data(withJSONObject: fields),
    let line = String(data: data, encoding: .utf8)
  else { return }
  print(line)
}
func log(_ text: String) {
  FileHandle.standardError.write(Data((text + "\n").utf8))
}

func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
  var value: AnyObject?
  return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}
func string(_ element: AXUIElement, _ name: String) -> String? {
  attribute(element, name) as? String
}
func child(_ element: AXUIElement, _ name: String) -> AXUIElement? {
  guard let value = attribute(element, name), CFGetTypeID(value) == AXUIElementGetTypeID()
  else { return nil }
  return (value as! AXUIElement)
}
func url(_ element: AXUIElement, _ name: String) -> String? {
  guard let value = attribute(element, name) else { return nil }
  if let u = value as? URL { return u.absoluteString }
  return value as? String
}

/// The page a browser window shows: the first AXWebArea, breadth-first, within a node budget.
func webArea(in window: AXUIElement) -> AXUIElement? {
  var queue = [window]
  var visited = 0
  while !queue.isEmpty && visited < 800 {
    let element = queue.removeFirst()
    visited += 1
    if string(element, kAXRoleAttribute) == "AXWebArea" { return element }
    if let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] {
      queue.append(contentsOf: children)
    }
  }
  return nil
}

let privateTitle = try! NSRegularExpression(
  pattern: "incognito|inprivate|private browsing|private window|无痕|隐身|隐私浏览|私密浏览",
  options: [.caseInsensitive])
func looksPrivate(_ title: String) -> Bool {
  privateTitle.firstMatch(in: title, range: NSRange(title.startIndex..., in: title)) != nil
}

/// Text near the caret (or the selection), at most `limit` characters.
func textContext(_ element: AXUIElement, limit: Int = 2000) -> String? {
  if let selected = string(element, kAXSelectedTextAttribute), !selected.isEmpty {
    return String(selected.prefix(limit))
  }
  guard let value = string(element, kAXValueAttribute), !value.isEmpty else { return nil }
  if value.count <= limit { return value }
  var caret = value.count
  if let range = attribute(element, kAXSelectedTextRangeAttribute),
    CFGetTypeID(range) == AXValueGetTypeID()
  {
    var cf = CFRange()
    if AXValueGetValue(range as! AXValue, .cfRange, &cf) { caret = min(max(cf.location, 0), value.count) }
  }
  let start = max(0, min(caret - limit / 2, value.count - limit))
  let from = value.index(value.startIndex, offsetBy: start)
  return String(value[from...].prefix(limit))
}

let callback: AXObserverCallback = { _, _, notification, _ in
  sensor.schedule((notification as String) == kAXValueChangedNotification ? 2.0 : 0.4)
}

final class Sensor {
  var excluded = Set<String>()
  var paused = true
  var trusted = false
  var observers: [pid_t: AXObserver] = [:]
  var pending: DispatchWorkItem?
  var lastCapture = ""
  var idle = false

  func configure(apps: [String], paused: Bool) {
    excluded = Set(apps)
    self.paused = paused
    detachAll()
    lastCapture = ""
    if !paused, let app = NSWorkspace.shared.frontmostApplication { activated(app) }
  }

  func checkTrust(prompt: Bool = false) {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    let now = AXIsProcessTrustedWithOptions(options)
    if now != trusted || prompt {
      trusted = now
      emit(["kind": "status", "trusted": now])
      if now && !paused, let app = NSWorkspace.shared.frontmostApplication { activated(app) }
    }
  }

  func activated(_ app: NSRunningApplication) {
    // Only apps with a Dock icon: system agents (loginwindow, notification and password
    // prompts, Stage Manager, helper processes) are not something the user is doing.
    guard !paused, app.activationPolicy == .regular, let bundle = app.bundleIdentifier
    else { return }
    if app.processIdentifier == getpid() { return }
    emit(["kind": "app", "bundleId": bundle, "app": app.localizedName ?? bundle])
    lastCapture = ""
    if trusted && !excluded.contains(bundle) {
      observe(app)
      schedule(0.4)
    }
  }

  func observe(_ app: NSRunningApplication) {
    let pid = app.processIdentifier
    if observers[pid] != nil { return }
    let element = AXUIElementCreateApplication(pid)
    // Chromium and Electron apps (VS Code, Cursor) only build their AX tree when asked.
    AXUIElementSetAttributeValue(element, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    var observer: AXObserver?
    guard AXObserverCreate(pid, callback, &observer) == .success, let observer else { return }
    for name in [
      kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification,
      kAXTitleChangedNotification, kAXFocusedUIElementChangedNotification,
      kAXValueChangedNotification,
    ] {
      AXObserverAddNotification(observer, element, name as CFString, nil)
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    observers[pid] = observer
  }

  func forget(_ pid: pid_t) {
    guard let observer = observers.removeValue(forKey: pid) else { return }
    CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
  }
  func detachAll() {
    for pid in Array(observers.keys) { forget(pid) }
    pending?.cancel()
  }

  /// Waits for things to settle (typing stops after `delay`), then reads the front window once.
  func schedule(_ delay: Double) {
    pending?.cancel()
    let work = DispatchWorkItem { [weak self] in self?.capture() }
    pending = work
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
  }

  func capture() {
    guard !paused, trusted, let app = NSWorkspace.shared.frontmostApplication,
      app.activationPolicy == .regular,
      let bundle = app.bundleIdentifier, !excluded.contains(bundle)
    else { return }
    let element = AXUIElementCreateApplication(app.processIdentifier)
    var event: [String: Any] = [
      "kind": "window", "bundleId": bundle, "app": app.localizedName ?? bundle,
    ]
    let window = child(element, kAXFocusedWindowAttribute)
    let title = window.flatMap { string($0, kAXTitleAttribute) } ?? ""
    if looksPrivate(title) {
      event["private"] = true
      return send(event)
    }
    if !title.isEmpty { event["title"] = title }
    if let window {
      if let area = webArea(in: window), let page = url(area, "AXURL") {
        event["url"] = page
      } else if let document = url(window, kAXDocumentAttribute) {
        event["url"] = document
      }
    }
    if let focused = child(element, kAXFocusedUIElementAttribute) {
      let role = string(focused, kAXRoleAttribute) ?? ""
      let subrole = string(focused, kAXSubroleAttribute) ?? ""
      if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
        event["secure"] = true
      } else {
        if !role.isEmpty { event["role"] = role }
        if let text = textContext(focused) { event["text"] = text }
      }
    }
    send(event)
  }

  func send(_ event: [String: Any]) {
    let signature = String(describing: event.sorted { $0.key < $1.key })
    if signature == lastCapture { return }
    lastCapture = signature
    emit(event)
  }

  func checkIdle() {
    guard !paused else { return }
    let anyInput = CGEventType(rawValue: ~0)!
    let seconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: anyInput)
    let now = seconds >= 300
    if now != idle {
      idle = now
      emit(["kind": now ? "idle" : "active"])
    }
  }
}

let sensor = Sensor()
let workspace = NSWorkspace.shared.notificationCenter
workspace.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
) { note in
  if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
    sensor.activated(app)
  }
}
workspace.addObserver(
  forName: NSWorkspace.didTerminateApplicationNotification, object: nil, queue: .main
) { note in
  if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
    sensor.forget(app.processIdentifier)
  }
}

struct Command: Decodable {
  let type: String
  let apps: [String]?
  let paused: Bool?
}
Thread.detachNewThread {
  while let line = readLine() {
    guard let command = try? JSONDecoder().decode(Command.self, from: Data(line.utf8)) else {
      log("familiar-sensor: bad command")
      continue
    }
    DispatchQueue.main.async {
      switch command.type {
      case "config": sensor.configure(apps: command.apps ?? [], paused: command.paused ?? false)
      case "prompt": sensor.checkTrust(prompt: true)
      default: log("familiar-sensor: unknown command \(command.type)")
      }
    }
  }
  // The agent went away: so do we.
  exit(0)
}

sensor.trusted = AXIsProcessTrusted()
emit(["kind": "status", "trusted": sensor.trusted])
Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { _ in
  if !sensor.trusted { sensor.checkTrust() }
}
Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { _ in sensor.checkIdle() }
NSApplication.shared.setActivationPolicy(.prohibited)
RunLoop.main.run()
