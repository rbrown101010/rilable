import SwiftUI

struct ChatView: View {
    @StateObject private var vm: ProjectViewModel
    @StateObject private var voice = VoiceRecorder()
    @State private var draft = ""
    @State private var sending = false
    @State private var exportingApk = false
    @State private var apkExportError: String?
    @State private var showPreview = false
    @State private var showDetails = false
    @FocusState private var focused: Bool

    init(projectId: String) {
        _vm = StateObject(wrappedValue: ProjectViewModel(projectId: projectId))
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "MMM d 'at' h:mm a"
        return formatter
    }()

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            VStack(spacing: 0) {
                topBar
                messageList
                if vm.project?.isLive == true {
                    suggestionChips
                }
                composer
            }
        }
        .toolbar(.hidden, for: .navigationBar)
        .task { vm.wake() }
        .onAppear {
            switch DeepLinkRouter.shared.consumeTab() {
            case .preview: showPreview = true
            case .code: showDetails = true
            default: break
            }
        }
        .onChange(of: vm.project?.status) { oldStatus, newStatus in
            guard let old = oldStatus, let new = newStatus else { return }
            if new == "live" && Project.busyStatuses.contains(old) {
                Haptics.success()
            } else if new == "error" {
                Haptics.error()
            }
        }
        .fullScreenCover(isPresented: $showPreview) {
            PreviewScreen(vm: vm)
        }
        .sheet(isPresented: $showDetails) {
            DetailsSheet(vm: vm)
        }
    }

    // MARK: - Top bar

    private var topBar: some View {
        HStack {
            CircleIconButton(systemName: "house") {
                Haptics.tap()
                DeepLinkRouter.shared.goHome()
            }
            .accessibilityIdentifier("homeButton")
            Spacer()
            CircleIconButton(systemName: "play") {
                Haptics.tap()
                showPreview = true
            }
            .opacity(vm.project?.previewUrl == nil ? 0.4 : 1)
            .disabled(vm.project?.previewUrl == nil)
            .accessibilityIdentifier("playButton")
        }
        .overlay(namePill)
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }

    @ViewBuilder
    private var namePill: some View {
        if let project = vm.project {
            if project.isBusy && project.name == "New App" {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(Theme.surfaceLight)
                        .frame(width: 150, height: 15)
                        .shimmering()
                    Image(systemName: "chevron.down")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Theme.textSecondary)
                }
                .padding(.horizontal, 18)
                .frame(height: 44)
                .frame(maxWidth: 250)
                .background(Theme.surface, in: Capsule())
            } else {
                Menu {
                    if let urlString = project.previewUrl, let url = URL(string: urlString) {
                        Link(destination: url) {
                            Label("Open in Safari", systemImage: "safari")
                        }
                        Button {
                            UIPasteboard.general.string = urlString
                            Haptics.tap()
                        } label: {
                            Label("Copy link", systemImage: "link")
                        }
                    }
                    Button {
                        Haptics.tap()
                        vm.retry()
                    } label: {
                        Label("Rebuild from scratch", systemImage: "hammer")
                    }
                } label: {
                    HStack(spacing: 8) {
                        Text(project.name)
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(.white)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    .padding(.horizontal, 22)
                    .frame(height: 44)
                    .background(Theme.surface, in: Capsule())
                }
                .frame(maxWidth: 260)
            }
        }
    }

    // MARK: - Messages

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 18) {
                    if let project = vm.project {
                        Text(Self.dateFormatter.string(
                            from: Date(timeIntervalSince1970: project.creationTime / 1000)
                        ))
                        .font(.system(size: 15))
                        .foregroundStyle(Theme.textSecondary)
                        .padding(.top, 16)
                    }
                    ForEach(vm.messages) { message in
                        messageView(message)
                            .id(message.id)
                    }
                    if vm.project?.isBusy == true {
                        WorkingCard(detail: vm.project?.statusDetail)
                            .id("working")
                    }
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 14)
            }
            .scrollDismissesKeyboard(.interactively)
            .onChange(of: vm.messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.25)) { scrollToBottom(proxy) }
            }
            .onChange(of: vm.project?.status) { _, _ in
                scrollToBottom(proxy)
            }
            .onAppear { scrollToBottom(proxy) }
        }
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy) {
        if vm.project?.isBusy == true {
            proxy.scrollTo("working", anchor: .bottom)
        } else if let last = vm.messages.last(where: { $0.role != "log" }) {
            proxy.scrollTo(last.id, anchor: .bottom)
        }
    }

    @ViewBuilder
    private func messageView(_ message: Message) -> some View {
        switch message.role {
        case "user":
            VStack(alignment: .trailing, spacing: 12) {
                HStack {
                    Spacer(minLength: 56)
                    Text(message.content)
                        .font(.system(size: 17))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 13)
                        .background(Theme.surfaceLight, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
                }
                HStack(spacing: 22) {
                    Button {
                        draft = message.content
                        focused = true
                        Haptics.tap()
                    } label: {
                        Image(systemName: "pencil")
                            .font(.system(size: 16))
                            .foregroundStyle(Theme.textSecondary)
                    }
                    Button {
                        UIPasteboard.general.string = message.content
                        Haptics.tap()
                    } label: {
                        Image(systemName: "square.on.square")
                            .font(.system(size: 15))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                .padding(.trailing, 4)
            }
        case "agent":
            agentView(message)
        default:
            // Build logs stay in the database but are hidden in the Lovable UI;
            // the Working card surfaces current progress instead.
            EmptyView()
        }
    }

    @ViewBuilder
    private func agentView(_ message: Message) -> some View {
        if message.content.hasPrefix("✅") {
            let parsed = parseAgentMessage(message.content)
            VStack(alignment: .leading, spacing: 18) {
                BuildCard(
                    title: parsed.title,
                    onDetails: {
                        Haptics.tap()
                        showDetails = true
                    },
                    onPreview: {
                        Haptics.tap()
                        showPreview = true
                    }
                )
                if !parsed.body.isEmpty {
                    MarkdownText(content: parsed.body)
                }
                apkExportPanel
                actionRow(copyText: parsed.body.isEmpty ? message.content : parsed.body)
            }
        } else if message.content.hasPrefix("❌") {
            VStack(alignment: .leading, spacing: 14) {
                Text(message.content.replacingOccurrences(of: "❌ ", with: ""))
                    .font(.system(size: 16))
                    .foregroundStyle(Theme.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Haptics.tap()
                    vm.retry()
                } label: {
                    Text("Try again")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.black)
                        .padding(.horizontal, 22)
                        .padding(.vertical, 11)
                        .background(.white, in: Capsule())
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                MarkdownText(content: message.content)
                actionRow(copyText: message.content)
            }
        }
    }

    private func parseAgentMessage(_ content: String) -> (title: String, body: String) {
        let name = vm.project?.name ?? "your app"
        let title = content.hasPrefix("✅ Updated")
            ? "Updated \(name)"
            : "Built \(name)"
        var body = ""
        if let bangRange = content.range(of: "! ") {
            body = String(content[bangRange.upperBound...]).trimmingCharacters(in: .whitespaces)
        }
        return (title, body)
    }

    @ViewBuilder
    private var apkExportPanel: some View {
        if let project = vm.project, project.platform != "mobile", project.isLive {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Button {
                        startApkExport()
                    } label: {
                        Label(exportingApk ? "Exporting APK…" : "Export APK", systemImage: "square.and.arrow.down")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(maxWidth: .infinity)
                            .frame(height: 46)
                            .background(Theme.surfaceLight, in: Capsule())
                    }
                    .disabled(exportingApk)
                    .accessibilityIdentifier("exportApkButton")

                    if let installUrl = project.installUrl, let url = URL(string: installUrl) {
                        Link(destination: url) {
                            Text("Download")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(.black)
                                .frame(maxWidth: .infinity)
                                .frame(height: 46)
                                .background(.white, in: Capsule())
                        }
                        .accessibilityIdentifier("downloadApkLink")
                    }
                }
                if exportingApk || project.status == "building" {
                    Text(project.statusDetail ?? "Building Android APK…")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.textSecondary)
                }
                if let apkExportError {
                    Text(apkExportError)
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.red)
                } else if project.error?.localizedCaseInsensitiveContains("android apk") == true {
                    Text(project.error ?? "Android APK builder unavailable.")
                        .font(.system(size: 14))
                        .foregroundStyle(Theme.red)
                }
            }
            .padding(14)
            .background(Theme.surface.opacity(0.72), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .strokeBorder(Theme.stroke, lineWidth: 1)
            )
        }
    }

    private func actionRow(copyText: String) -> some View {
        HStack(spacing: 24) {
            Button { Haptics.tap() } label: {
                Image(systemName: "arrow.uturn.backward")
            }
            Button { Haptics.tap() } label: {
                Image(systemName: "hand.thumbsup")
            }
            Button { Haptics.tap() } label: {
                Image(systemName: "hand.thumbsdown")
            }
            Button {
                UIPasteboard.general.string = copyText
                Haptics.tap()
            } label: {
                Image(systemName: "square.on.square")
            }
            Button { Haptics.tap() } label: {
                Image(systemName: "ellipsis")
            }
        }
        .font(.system(size: 15))
        .foregroundStyle(Theme.textSecondary)
    }

    // MARK: - Chips + composer

    private let suggestions = ["Polish the design", "Implement search", "Add more features"]

    private var suggestionChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(suggestions, id: \.self) { suggestion in
                    Button {
                        Haptics.tap()
                        draft = suggestion
                        focused = true
                    } label: {
                        Text(suggestion)
                            .font(.system(size: 15, weight: .medium))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 15)
                            .padding(.vertical, 11)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 13, style: .continuous))
                            .overlay(
                                RoundedRectangle(cornerRadius: 13, style: .continuous)
                                    .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
                            )
                    }
                }
            }
            .padding(.horizontal, 16)
        }
        .padding(.bottom, 12)
    }

    private var busy: Bool { vm.project?.isBusy ?? true }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 16) {
            TextField(
                "",
                text: $draft,
                prompt: Text(busy ? "Queue follow-up…" : "Ask Forge…")
                    .foregroundStyle(Theme.textSecondary),
                axis: .vertical
            )
            .font(.system(size: 17))
            .foregroundStyle(.white)
            .tint(Theme.blue)
            .lineLimit(1...4)
            .focused($focused)
            .accessibilityIdentifier("chatField")
            .padding(.top, 4)

            HStack(spacing: 12) {
                ComposerCircle(systemName: "plus")
                chatModelMenu
                Spacer()
                VoiceButton(voice: voice, styleCircle: true) { text in
                    draft = draft.isEmpty ? text : draft + " " + text
                }
                if busy {
                    ZStack {
                        Circle().fill(.white).frame(width: 44, height: 44)
                        RoundedRectangle(cornerRadius: 4)
                            .fill(.black)
                            .frame(width: 15, height: 15)
                    }
                } else if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: send) {
                        ZStack {
                            Circle().fill(.white).frame(width: 44, height: 44)
                            if sending {
                                ProgressView().tint(.black)
                            } else {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundStyle(.black)
                            }
                        }
                    }
                    .disabled(sending)
                    .accessibilityIdentifier("chatSendButton")
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Theme.composer, in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .strokeBorder(Theme.stroke, lineWidth: 1)
        )
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private var chatModelMenu: some View {
        Menu {
            ForEach(ClaudeModels.options, id: \.key) { option in
                Button {
                    Haptics.tap()
                    vm.setModel(option.key)
                } label: {
                    if (vm.project?.model ?? "claude-sonnet-4-6") == option.key {
                        Label(option.name, systemImage: "checkmark")
                    } else {
                        Text(option.name)
                    }
                }
            }
        } label: {
            HStack(spacing: 7) {
                Text(ClaudeModels.shortName(for: vm.project?.model))
                    .font(.system(size: 15, weight: .semibold))
                    .lineLimit(1)
                    .fixedSize()
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundStyle(.white.opacity(0.92))
            .padding(.horizontal, 18)
            .frame(height: 44)
            .background(Theme.surfaceLight.opacity(0.85), in: Capsule())
        }
        .accessibilityIdentifier("chatModelMenu")
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy else { return }
        sending = true
        Haptics.tap()
        Task {
            if await vm.send(text) {
                draft = ""
            } else {
                Haptics.error()
            }
            sending = false
        }
    }

    private func startApkExport() {
        guard !exportingApk else { return }
        exportingApk = true
        apkExportError = nil
        Haptics.tap()
        Task {
            if await vm.exportAndroidApk() {
                apkExportError = nil
            } else {
                apkExportError = "Android APK builder unavailable or not configured. Try again after the builder is online."
                Haptics.error()
            }
            exportingApk = false
        }
    }
}

// MARK: - Components

/// Agent text with markdown links rendered tappable (install links, Apple
/// sign-in links). Paragraphs are split so spacing survives markdown parsing.
struct MarkdownText: View {
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                Text(attributed(paragraph))
                    .font(.system(size: 17))
                    .foregroundStyle(.white.opacity(0.92))
                    .lineSpacing(4)
                    .tint(Theme.blue)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    private var paragraphs: [String] {
        content.components(separatedBy: "\n\n").filter { !$0.isEmpty }
    }

    private func attributed(_ text: String) -> AttributedString {
        (try? AttributedString(
            markdown: text,
            options: AttributedString.MarkdownParsingOptions(
                interpretedSyntax: .inlineOnlyPreservingWhitespace
            )
        )) ?? AttributedString(text)
    }
}

struct ComposerCircle: View {
    let systemName: String

    var body: some View {
        Button { Haptics.tap() } label: {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .medium))
                .foregroundStyle(.white.opacity(0.92))
                .frame(width: 44, height: 44)
                .background(Theme.surfaceLight.opacity(0.85), in: Circle())
        }
    }
}

struct WorkingCard: View {
    let detail: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text("Working…")
                .font(.system(size: 21, weight: .bold))
                .foregroundStyle(.white)
            Text(detail ?? "Thinking")
                .font(.system(size: 17))
                .foregroundStyle(Theme.textSecondary)
                .contentTransition(.opacity)
                .animation(.easeInOut(duration: 0.25), value: detail)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Theme.stroke, lineWidth: 1)
        )
    }
}

struct BuildCard: View {
    let title: String
    let onDetails: () -> Void
    let onPreview: () -> Void

    var body: some View {
        VStack(spacing: 15) {
            HStack(alignment: .top) {
                Text(title)
                    .font(.system(size: 20, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "bookmark")
                    .font(.system(size: 17))
                    .foregroundStyle(Theme.textSecondary)
            }
            HStack(spacing: 10) {
                cardButton("Details", identifier: "detailsButton", action: onDetails)
                cardButton("Preview", identifier: "previewButton", action: onPreview)
            }
        }
        .padding(16)
        .background(Theme.card, in: RoundedRectangle(cornerRadius: 26, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .strokeBorder(Theme.blue, lineWidth: 1.5)
        )
        .shadow(color: Theme.blue.opacity(0.30), radius: 12)
    }

    private func cardButton(_ label: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(Theme.surfaceLight.opacity(0.75), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityIdentifier(identifier)
    }
}
