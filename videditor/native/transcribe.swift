// ChopChop transcriber: speech to text on this Mac with Apple's Speech framework. Nothing leaves the Mac.
//
//   chopchop-transcribe <audio file> [--locale en-US]     → JSON on stdout
//   chopchop-transcribe --check                           → {"analyzer": true|false, "os": "26.1"}
//
// Output: {"engine": "apple", "locale": "en_US", "segments": [{"start": 1.2, "end": 4.8, "text": "…", "words": [{"start", "end", "text"}]}]}
// Progress goes to stderr as "PROGRESS 0.42" lines; other stderr lines are messages for the log.
//
// macOS 26 and later: SpeechAnalyzer + SpeechTranscriber (long-form, on-device, fast).
// Older macOS: SFSpeechRecognizer with on-device recognition.
// ChopChop compiles this file with swiftc the first time it is needed (Xcode Command Line Tools); when the
// SDK is too old for SpeechAnalyzer it compiles again with -D CHOPCHOP_NO_ANALYZER.
import Foundation
import AVFoundation
import Speech

struct Word: Codable { let start: Double; let end: Double; let text: String }
struct Segment: Codable { let start: Double; let end: Double; let text: String; let words: [Word] }
struct Output: Codable { let engine: String; let locale: String; let segments: [Segment] }
struct Failure: Error, LocalizedError { let message: String; init(_ m: String) { message = m }; var errorDescription: String? { message } }

func say(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func progress(_ f: Double) { say(String(format: "PROGRESS %.3f", min(1, max(0, f)))) }
func fail(_ s: String, _ code: Int32 = 1) -> Never { say(s); exit(code) }
func emit<T: Encodable>(_ value: T) {
  let enc = JSONEncoder()
  guard let data = try? enc.encode(value) else { fail("could not encode the result") }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write("\n".data(using: .utf8)!)
}
func seconds(_ t: CMTime) -> Double { t.isValid && t.isNumeric ? t.seconds : 0 }

@main
struct Main {
  static func main() async {
    var args = Array(CommandLine.arguments.dropFirst())
    var localeId: String? = nil
    if let i = args.firstIndex(of: "--locale"), i + 1 < args.count { localeId = args[i + 1]; args.removeSubrange(i...(i + 1)) }
    let osv = ProcessInfo.processInfo.operatingSystemVersion
    let osString = "\(osv.majorVersion).\(osv.minorVersion)"
    if args.first == "--check" {
      var analyzer = false
      #if !CHOPCHOP_NO_ANALYZER
      if #available(macOS 26.0, *) { analyzer = true }
      #endif
      struct Check: Codable { let analyzer: Bool; let os: String }
      emit(Check(analyzer: analyzer, os: osString)); return
    }
    guard let path = args.first else { fail("usage: chopchop-transcribe <audio file> [--locale en-US]", 64) }
    let url = URL(fileURLWithPath: path)
    let requested = localeId.map { Locale(identifier: $0) } ?? Locale.current
    do {
      #if !CHOPCHOP_NO_ANALYZER
      if #available(macOS 26.0, *) { emit(try await analyzerTranscribe(url: url, requested: requested)); return }
      #endif
      emit(try await legacyTranscribe(url: url, requested: requested))
    } catch {
      fail("transcription failed: \(error.localizedDescription)")
    }
  }
}

#if !CHOPCHOP_NO_ANALYZER
@available(macOS 26.0, *)
func analyzerTranscribe(url: URL, requested: Locale) async throws -> Output {
  // The person's locale, else the same language anywhere, else US English.
  var locale: Locale? = await SpeechTranscriber.supportedLocale(equivalentTo: requested)
  if locale == nil, let lang = requested.language.languageCode?.identifier { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: lang)) }
  if locale == nil { locale = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en_US")) }
  guard let locale else { throw Failure("This Mac has no speech transcription for \(requested.identifier).") }

  let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
  // The language model is downloaded by macOS the first time (shared by all apps).
  if let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
    say("downloading the speech model for \(locale.identifier) (first time only)…")
    try await request.downloadAndInstall()
  }

  let file = try AVAudioFile(forReading: url)
  let total = Double(file.length) / file.processingFormat.sampleRate
  let analyzer = SpeechAnalyzer(modules: [transcriber])

  let collector = Task { () throws -> [Segment] in
    var segments: [Segment] = []
    for try await result in transcriber.results {
      let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      if text.isEmpty { continue }
      var words: [Word] = []
      for run in result.text.runs {
        let w = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if w.isEmpty { continue }
        if let range = run.audioTimeRange { words.append(Word(start: seconds(range.start), end: seconds(range.end), text: w)) }
        else if let last = words.last { words[words.count - 1] = Word(start: last.start, end: last.end, text: last.text + w) } // punctuation has no time of its own
      }
      let start = seconds(result.range.start), end = seconds(result.range.end)
      segments.append(Segment(start: start, end: end, text: text, words: words))
      if total > 0 { progress(end / total) }
    }
    return segments
  }

  if let last = try await analyzer.analyzeSequence(from: file) {
    try await analyzer.finalizeAndFinish(through: last)
  } else {
    await analyzer.cancelAndFinishNow()
  }
  let segments = try await collector.value
  progress(1)
  return Output(engine: "apple", locale: locale.identifier, segments: segments)
}
#endif

// macOS 25 and earlier.
func legacyTranscribe(url: URL, requested: Locale) async throws -> Output {
  let status: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { c in
    SFSpeechRecognizer.requestAuthorization { c.resume(returning: $0) }
  }
  guard status == .authorized else {
    throw Failure("Speech recognition is not allowed. Turn it on in System Settings → Privacy & Security → Speech Recognition (for Terminal), then try again.")
  }
  guard let recognizer = SFSpeechRecognizer(locale: requested) ?? SFSpeechRecognizer() else { throw Failure("No speech recognizer for \(requested.identifier).") }
  guard recognizer.supportsOnDeviceRecognition else { throw Failure("On-device speech recognition is not available for \(recognizer.locale.identifier) on this Mac.") }
  let request = SFSpeechURLRecognitionRequest(url: url)
  request.requiresOnDeviceRecognition = true
  request.shouldReportPartialResults = false
  if #available(macOS 13.0, *) { request.addsPunctuation = true }

  final class Box: @unchecked Sendable { var done = false; var task: SFSpeechRecognitionTask? }
  let box = Box()
  let words: [Word] = try await withCheckedThrowingContinuation { c in
    box.task = recognizer.recognitionTask(with: request) { result, error in
      if box.done { return }
      if let error { box.done = true; c.resume(throwing: error); return }
      guard let result, result.isFinal else { return }
      box.done = true
      c.resume(returning: result.bestTranscription.segments.map { Word(start: $0.timestamp, end: $0.timestamp + $0.duration, text: $0.substring) })
    }
  }
  _ = box.task
  progress(1)
  // One segment carrying every word; ChopChop splits it into sentences.
  let text = words.map { $0.text }.joined(separator: " ")
  let segments = words.isEmpty ? [] : [Segment(start: words.first!.start, end: words.last!.end, text: text, words: words)]
  return Output(engine: "apple", locale: recognizer.locale.identifier, segments: segments)
}
