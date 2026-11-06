// The pet cursor for Computer Use (control.swift): a pointer with the pet tucked under it, so the
// user can see where it acts. It glides to each target before the action, and a ring spreads on
// a click. Click-through, above everything, on every Space. In global control the real pointer
// is there too, so only the pet shows.
import AppKit
import QuartzCore

final class CursorOverlay {
  static let shared = CursorOverlay()

  private var panel: NSPanel?
  private let arrow = CAShapeLayer()
  private let pet = CALayer()
  private let ring = CAShapeLayer()
  private var frames: [String: [CGImage]] = [:]
  private var row = "idle"
  private var frame = 0
  private var timer: Timer?
  private var motion: Timer?
  private var shown = false
  /// The pet's own playback rate (settings › 宠物), so it moves like the pet on the desktop.
  private var rate = 1.0

  private let size = NSSize(width: 64, height: 64)
  /// The pointer's tip inside the panel (AppKit coordinates, origin bottom left).
  private let tip = NSPoint(x: 6, y: 58)
  private let accent = NSColor(srgbRed: 0x5b / 255, green: 0x57 / 255, blue: 0xd1 / 255, alpha: 1)

  /// Rows of a ChatGPT-style sheet: 8 columns of 192×208 cells.
  private func load(sheet path: String?) {
    frames = [:]
    guard let path, let image = NSImage(contentsOfFile: path),
      let cg = image.cgImage(forProposedRect: nil, context: nil, hints: nil)
    else { return }
    let cellW = cg.width / 8
    let cellH = cellW * 208 / 192
    for (name, row, count) in [("idle", 0, 6), ("right", 1, 8), ("left", 2, 8)] {
      frames[name] = (0..<count).compactMap {
        cg.cropping(to: CGRect(x: $0 * cellW, y: row * cellH, width: cellW, height: cellH))
      }
    }
  }

  /// A polygon with every corner rounded by `radius`.
  private func rounded(_ points: [CGPoint], radius: CGFloat) -> CGPath {
    let path = CGMutablePath()
    let n = points.count
    let mid = { (a: CGPoint, b: CGPoint) in CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2) }
    path.move(to: mid(points[n - 1], points[0]))
    for i in 0..<n {
      path.addArc(tangent1End: points[i], tangent2End: points[(i + 1) % n], radius: radius)
    }
    path.closeSubpath()
    return path
  }

  private func build() -> NSPanel {
    let panel = NSPanel(
      contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered, defer: false)
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = false
    panel.ignoresMouseEvents = true
    panel.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.screenSaverWindow)) + 1)
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
    let view = NSView(frame: NSRect(origin: .zero, size: size))
    view.wantsLayer = true
    panel.contentView = view
    let root = view.layer!

    // An arrowhead, about 20pt: tip, bottom of the straight left edge, the notch, right point (y up).
    let shape: [CGPoint] = [
      CGPoint(x: 0, y: 0), CGPoint(x: 0, y: -19), CGPoint(x: 5.2, y: -14.2), CGPoint(x: 13.6, y: -13.6),
    ]
    arrow.path = rounded(shape.map { CGPoint(x: tip.x + $0.x, y: tip.y + $0.y) }, radius: 1.4)
    arrow.fillColor = accent.cgColor
    arrow.strokeColor = NSColor.white.cgColor
    arrow.lineWidth = 1.8
    arrow.lineJoin = .round
    // It floats over other apps' windows: the one place a soft shadow is allowed.
    arrow.shadowColor = NSColor.black.cgColor
    arrow.shadowOpacity = 0.28
    arrow.shadowRadius = 3
    arrow.shadowOffset = CGSize(width: 0, height: -1)
    // Just off the pointer's lower right, with a little air between them.
    pet.frame = CGRect(x: tip.x + 10, y: tip.y - 16 - 32, width: 29, height: 32)
    pet.contentsGravity = .resizeAspect
    pet.magnificationFilter = .linear
    root.addSublayer(pet)
    root.addSublayer(arrow)

    ring.path = CGPath(ellipseIn: CGRect(x: -12, y: -12, width: 24, height: 24), transform: nil)
    ring.position = CGPoint(x: tip.x, y: tip.y)
    ring.fillColor = NSColor.clear.cgColor
    ring.strokeColor = accent.cgColor
    ring.lineWidth = 1.5
    ring.opacity = 0
    root.addSublayer(ring)
    return panel
  }

  private func setRow(_ name: String) {
    if row == name { return }
    row = name
    frame = 0
  }

  private func tick() {
    guard let list = frames[row] ?? frames["idle"], !list.isEmpty else { return }
    frame = (frame + 1) % list.count
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    pet.contents = list[frame]
    CATransaction.commit()
  }

  /// Frames per second like the desktop pet: 6 standing, 9 on the move, times its rate.
  private func play() {
    timer?.invalidate()
    let fps = (row == "idle" ? 6.0 : 9.0) * rate
    timer = Timer.scheduledTimer(withTimeInterval: 1 / max(1, fps), repeats: true) { _ in self.tick() }
    tick()
  }

  /// Quartz global point (origin top left of the main display) to the panel origin.
  private func origin(for point: CGPoint) -> NSPoint {
    let height = NSScreen.screens.first?.frame.height ?? 0
    return NSPoint(x: point.x - tip.x, y: height - point.y - tip.y)
  }

  func show(sheet: String?, rate: Double) {
    onMain {
      self.load(sheet: sheet)
      self.rate = min(3, max(0.25, rate))
      if self.panel == nil { self.panel = self.build() }
      self.play()
    }
  }

  func hide() {
    onMain {
      self.timer?.invalidate()
      self.timer = nil
      self.motion?.invalidate()
      self.panel?.orderOut(nil)
      self.shown = false
    }
  }

  func setGlobal(_ on: Bool) {
    onMain { self.arrow.isHidden = on }
  }

  /// Moves to `point`; returns how long the glide takes so the action can wait for it.
  @discardableResult
  func glide(to point: CGPoint) -> TimeInterval {
    var duration: TimeInterval = 0
    onMain {
      guard let panel = self.panel else { return }
      let target = self.origin(for: point)
      if !self.shown {
        panel.setFrameOrigin(target)
        panel.orderFrontRegardless()
        self.shown = true
        return
      }
      let from = panel.frame.origin
      let distance = hypot(target.x - from.x, target.y - from.y)
      if distance < 2 { return }
      duration = min(0.9, max(0.4, distance / 1200))
      self.setRow(target.x >= from.x ? "right" : "left")
      self.play()
      // Stepped by hand: the window animator left the panel where it was.
      self.motion?.invalidate()
      let start = Date()
      let total = duration
      self.motion = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { timer in
        let t = min(1, Date().timeIntervalSince(start) / total)
        let eased = t < 0.5 ? 2 * t * t : 1 - pow(-2 * t + 2, 2) / 2
        panel.setFrameOrigin(
          NSPoint(x: from.x + (target.x - from.x) * eased, y: from.y + (target.y - from.y) * eased))
        if t >= 1 {
          timer.invalidate()
          self.setRow("idle")
          self.play()
        }
      }
    }
    return duration
  }

  /// A ring spreading from the tip: the click landed.
  func pulse() {
    onMain {
      let scale = CABasicAnimation(keyPath: "transform.scale")
      scale.fromValue = 0.3
      scale.toValue = 1.4
      let fade = CABasicAnimation(keyPath: "opacity")
      fade.fromValue = 0.8
      fade.toValue = 0
      let group = CAAnimationGroup()
      group.animations = [scale, fade]
      group.duration = 0.5
      group.timingFunction = CAMediaTimingFunction(name: .easeOut)
      self.ring.add(group, forKey: "pulse")
    }
  }

  /// Whether it is on screen somewhere already (keys and typing leave it where it is).
  var isPlaced: Bool {
    var placed = false
    onMain { placed = self.shown }
    return placed
  }

  /// Our own window, left out of full-screen screenshots.
  var windowNumber: Int? {
    var number: Int?
    onMain { number = self.panel?.windowNumber }
    return number
  }
}

func onMain(_ work: () -> Void) {
  if Thread.isMainThread { work() } else { DispatchQueue.main.sync(execute: work) }
}
