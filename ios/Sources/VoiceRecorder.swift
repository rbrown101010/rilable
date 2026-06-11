import AVFoundation
import Combine
import SwiftUI

/// Records short voice prompts and transcribes them through the backend
/// (OpenAI Whisper — the API key never leaves the server).
@MainActor
final class VoiceRecorder: ObservableObject {
    enum RecState: Equatable {
        case idle
        case recording
        case transcribing
    }

    @Published var state: RecState = .idle
    private var recorder: AVAudioRecorder?

    private var fileURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("lovable-voice.m4a")
    }

    func toggle(onText: @escaping (String) -> Void) {
        switch state {
        case .idle:
            start()
        case .recording:
            stopAndTranscribe(onText: onText)
        case .transcribing:
            break
        }
    }

    private func start() {
        Task {
            let granted = await AVAudioApplication.requestRecordPermission()
            guard granted else {
                Haptics.error()
                return
            }
            do {
                let session = AVAudioSession.sharedInstance()
                try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
                try session.setActive(true)
                let settings: [String: Any] = [
                    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                    AVSampleRateKey: 16_000,
                    AVNumberOfChannelsKey: 1,
                    AVEncoderBitRateKey: 32_000,
                ]
                let recorder = try AVAudioRecorder(url: fileURL, settings: settings)
                recorder.record(forDuration: 90)
                self.recorder = recorder
                state = .recording
                Haptics.tap()
            } catch {
                print("Lovable voice: failed to start recording: \(error)")
                Haptics.error()
            }
        }
    }

    private func stopAndTranscribe(onText: @escaping (String) -> Void) {
        recorder?.stop()
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        state = .transcribing
        Haptics.tap()
        Task {
            defer { state = .idle }
            do {
                let data = try Data(contentsOf: fileURL)
                guard data.count > 2_000 else { return } // too short to bother
                let result: TranscriptionResult = try await ConvexService.shared.client.action(
                    "voice:transcribe",
                    with: ConvexService.authArgs(["audioBase64": data.base64EncodedString()])
                )
                let text = result.text.trimmingCharacters(in: .whitespacesAndNewlines)
                if !text.isEmpty {
                    Haptics.success()
                    onText(text)
                }
            } catch {
                print("Lovable voice: transcription failed: \(error)")
                Haptics.error()
            }
        }
    }
}

struct TranscriptionResult: Decodable {
    let text: String
}

/// Mic button that cycles idle → recording (red pulse) → transcribing.
struct VoiceButton: View {
    @ObservedObject var voice: VoiceRecorder
    /// "bare" renders just the glyph (home composer); "circle" matches the
    /// chat composer's circular buttons.
    var styleCircle = false
    let onText: (String) -> Void
    @State private var pulsing = false

    var body: some View {
        Button {
            voice.toggle(onText: onText)
        } label: {
            Group {
                switch voice.state {
                case .idle:
                    Image(systemName: "mic")
                        .font(.system(size: styleCircle ? 17 : 19, weight: .medium))
                        .foregroundStyle(styleCircle ? .white.opacity(0.92) : .white)
                case .recording:
                    Image(systemName: "stop.fill")
                        .font(.system(size: styleCircle ? 15 : 17, weight: .bold))
                        .foregroundStyle(Theme.red)
                        .opacity(pulsing ? 0.45 : 1)
                        .onAppear {
                            withAnimation(.easeInOut(duration: 0.55).repeatForever(autoreverses: true)) {
                                pulsing = true
                            }
                        }
                        .onDisappear { pulsing = false }
                case .transcribing:
                    ProgressView()
                        .tint(styleCircle ? .white : Theme.textSecondary)
                        .scaleEffect(0.8)
                }
            }
            .frame(width: styleCircle ? 44 : 28, height: styleCircle ? 44 : 28)
            .background(
                styleCircle ? AnyShapeStyle(Theme.surfaceLight.opacity(0.85)) : AnyShapeStyle(Color.clear),
                in: Circle()
            )
        }
        .accessibilityIdentifier("voiceButton")
    }
}

/// The Claude models the user can pick from, mirrored from convex/models.ts.
enum ClaudeModels {
    static let options: [(key: String, name: String, blurb: String)] = [
        ("fable-5", "Fable 5", "Newest"),
        ("claude-haiku-4-5", "Haiku 4.5", "Fastest"),
        ("claude-sonnet-4-6", "Sonnet 4.6", "Balanced"),
        ("claude-opus-4-8", "Opus 4.8", "Most capable"),
    ]

    static func shortName(for key: String?) -> String {
        options.first(where: { $0.key == key })?.name ?? "Sonnet 4.6"
    }
}
