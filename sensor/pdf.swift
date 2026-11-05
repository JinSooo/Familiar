// `familiar-sensor --pdf <path>`: the text of a PDF for the knowledge base, as JSON on stdout:
//   {"pages":[{"text":"…","ocr":"page"|"images"|null}, …]}
// A page with a text layer keeps it (exact); only pages that also carry images are recognized,
// and what the images say beyond the text layer is added under 【图中文字】. A page with no text
// layer (scans, PDFs exported as pictures) is recognized whole into Markdown: title, paragraphs,
// lists and tables in reading order. Vision runs on this Mac; nothing leaves it.
import CoreGraphics
import Foundation
import PDFKit
import Vision

private let languages = [Locale.Language(identifier: "zh-Hans"), Locale.Language(identifier: "en-US")]
/** A page with fewer visible characters than this counts as having no text layer. */
private let minLayer = 20

private struct PageText: Encodable {
  let text: String
  let ocr: String?
}

/** Rendered so the long side is about 4500 px: at 2x, Chinese OCR misread about one word in three. */
private func render(_ page: PDFPage) -> (CGImage, CGRect)? {
  let box = page.bounds(for: .mediaBox)
  let scale = min(6, 4500 / max(box.width, box.height, 1))
  let w = Int(box.width * scale), h = Int(box.height * scale)
  guard w > 0, h > 0,
    let ctx = CGContext(
      data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)
  else { return nil }
  ctx.setFillColor(CGColor(gray: 1, alpha: 1))
  ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.scaleBy(x: scale, y: scale)
  ctx.translateBy(x: -box.origin.x, y: -box.origin.y)
  page.draw(with: .mediaBox, to: ctx)
  guard let image = ctx.makeImage() else { return nil }
  return (image, box)
}

/** Whether the page draws an image of some size (directly or inside a form XObject). */
private func hasImages(_ page: PDFPage) -> Bool {
  guard let dict = page.pageRef?.dictionary else { return false }
  func scan(_ resources: CGPDFDictionaryRef, depth: Int) -> Bool {
    var xobjects: CGPDFDictionaryRef?
    guard CGPDFDictionaryGetDictionary(resources, "XObject", &xobjects), let xobjects else {
      return false
    }
    var found = false
    CGPDFDictionaryApplyBlock(
      xobjects,
      { _, value, _ in
        var stream: CGPDFStreamRef?
        guard CGPDFObjectGetValue(value, .stream, &stream), let stream,
          let info = CGPDFStreamGetDictionary(stream)
        else { return true }
        var subtype: UnsafePointer<CChar>?
        guard CGPDFDictionaryGetName(info, "Subtype", &subtype), let subtype else { return true }
        let kind = String(cString: subtype)
        if kind == "Image" {
          var w: CGPDFInteger = 0, h: CGPDFInteger = 0
          CGPDFDictionaryGetInteger(info, "Width", &w)
          CGPDFDictionaryGetInteger(info, "Height", &h)
          // Icons, bullets and rules are not worth reading.
          if w >= 64 && h >= 64 { found = true }
        } else if kind == "Form", depth < 3 {
          var inner: CGPDFDictionaryRef?
          if CGPDFDictionaryGetDictionary(info, "Resources", &inner), let inner,
            scan(inner, depth: depth + 1)
          {
            found = true
          }
        }
        return !found
      }, nil)
    return found
  }
  var resources: CGPDFDictionaryRef?
  guard CGPDFDictionaryGetDictionary(dict, "Resources", &resources), let resources else {
    return false
  }
  return scan(resources, depth: 0)
}

private struct Block {
  let rect: CGRect  // in image coordinates, lower-left origin
  let text: String
}

/** Recognized blocks in reading order, as Markdown pieces; paragraphs inside lists and tables are dropped. */
private func blocks(_ docs: [DocumentObservation], size: CGSize) -> [Block] {
  var out: [Block] = []
  for doc in docs {
    let c = doc.document
    let rect = { (r: NormalizedRegion) in r.boundingBox.toImageCoordinates(size) }
    var containers: [CGRect] = []
    for list in c.lists {
      let r = rect(list.boundingRegion)
      containers.append(r)
      out.append(Block(rect: r, text: list.items.map { "- " + $0.itemString }.joined(separator: "\n")))
    }
    for table in c.tables {
      let r = rect(table.boundingRegion)
      containers.append(r)
      let rows = table.rows.map { row in
        "| "
          + row.map { $0.content.text.transcript.replacingOccurrences(of: "\n", with: " ") }
          .joined(separator: " | ") + " |"
      }
      guard let first = rows.first else { continue }
      let rule = "|" + String(repeating: " --- |", count: max(1, table.rows.first?.count ?? 1))
      out.append(Block(rect: r, text: ([first, rule] + rows.dropFirst()).joined(separator: "\n")))
    }
    let title = c.title?.transcript
    if let t = c.title { out.append(Block(rect: rect(t.boundingRegion), text: "## " + t.transcript)) }
    for p in c.paragraphs where p.transcript != title {
      let r = rect(p.boundingRegion)
      let center = CGPoint(x: r.midX, y: r.midY)
      if containers.contains(where: { $0.contains(center) }) { continue }
      out.append(Block(rect: r, text: p.transcript))
    }
  }
  // Top to bottom (higher y first in lower-left coordinates), then left to right.
  let line = size.height * 0.01
  return out.sorted {
    abs($0.rect.maxY - $1.rect.maxY) > line ? $0.rect.maxY > $1.rect.maxY : $0.rect.minX < $1.rect.minX
  }
}

private func recognize(_ image: CGImage) async -> [DocumentObservation] {
  var request = RecognizeDocumentsRequest()
  request.textRecognitionOptions.recognitionLanguages = languages
  request.textRecognitionOptions.useLanguageCorrection = true
  request.barcodeDetectionOptions.enabled = false
  return (try? await request.perform(on: image)) ?? []
}

private func pageText(_ page: PDFPage) async -> PageText {
  let layer = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let visible = layer.filter { !$0.isWhitespace }.count
  let scanned = visible < minLayer
  guard scanned || hasImages(page), let (image, box) = render(page) else {
    return PageText(text: layer, ocr: nil)
  }
  let size = CGSize(width: image.width, height: image.height)
  let found = blocks(await recognize(image), size: size)
  if scanned {
    let text = found.map(\.text).joined(separator: "\n\n")
    return PageText(text: text.isEmpty ? layer : text, ocr: text.isEmpty ? nil : "page")
  }
  // Text the layer already has under the same spot is not image text.
  let toPage = { (r: CGRect) in
    CGRect(
      x: box.minX + r.minX / size.width * box.width, y: box.minY + r.minY / size.height * box.height,
      width: r.width / size.width * box.width, height: r.height / size.height * box.height)
  }
  let extra = found.filter { block in
    let chars = block.text.filter { !$0.isWhitespace && $0 != "-" && $0 != "#" && $0 != "|" }.count
    guard chars >= 4 else { return false }
    let under = (page.selection(for: toPage(block.rect))?.string ?? "").filter { !$0.isWhitespace }
    return Double(under.count) < Double(chars) * 0.3
  }
  guard !extra.isEmpty else { return PageText(text: layer, ocr: nil) }
  let images = extra.map(\.text).joined(separator: "\n\n")
  return PageText(text: "\(layer)\n\n【图中文字】\n\(images)", ocr: "images")
}

func runPdf(_ path: String) -> Never {
  guard let pdf = PDFDocument(url: URL(fileURLWithPath: path)) else {
    FileHandle.standardError.write(Data("familiar-sensor: cannot open PDF\n".utf8))
    exit(1)
  }
  if pdf.isLocked {
    FileHandle.standardError.write(Data("familiar-sensor: PDF is encrypted\n".utf8))
    exit(2)
  }
  let done = DispatchSemaphore(value: 0)
  var pages: [PageText] = []
  Task {
    for i in 0..<pdf.pageCount {
      guard let page = pdf.page(at: i) else { continue }
      pages.append(await pageText(page))
    }
    done.signal()
  }
  done.wait()
  let data = (try? JSONEncoder().encode(["pages": pages])) ?? Data("{\"pages\":[]}".utf8)
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}
