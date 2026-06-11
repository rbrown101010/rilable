import SwiftUI

struct HomeView: View {
    @StateObject private var vm = ProjectsViewModel()
    @StateObject private var voice = VoiceRecorder()
    @State private var prompt = ""
    @State private var platform = "web"
    @AppStorage("selectedModel") private var selectedModel = "claude-sonnet-4-6"
    @State private var creating = false
    @State private var path: [String] = []
    @State private var showDrawer = false
    @FocusState private var promptFocused: Bool
    @Namespace private var toggleNamespace

    private let drawerSpring = Animation.spring(response: 0.38, dampingFraction: 0.86)

    var body: some View {
        NavigationStack(path: $path) {
            ZStack {
                LovableBloom()
                VStack(spacing: 0) {
                    topBar
                    Spacer()
                    connectPill
                    greeting
                    platformToggle
                    composerCard
                    Spacer()
                    Spacer()
                    Spacer()
                    HStack(spacing: 6) {
                        Image(systemName: "triangle.fill")
                            .font(.system(size: 9, weight: .bold))
                        Text("Works with Vercel gateway")
                            .font(.system(size: 13, weight: .medium))
                    }
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.bottom, 4)
                }

                drawerOverlay
            }
            .toolbar(.hidden, for: .navigationBar)
            .navigationDestination(for: String.self) { id in
                ChatView(projectId: id)
            }
        }
        .tint(.white)
        .onOpenURL(perform: handleDeepLink)
        .onReceive(DeepLinkRouter.shared.$pendingProjectId) { id in
            guard let id else { return }
            DeepLinkRouter.shared.clearPendingProject()
            if path.last != id { path = [id] }
        }
        .onReceive(DeepLinkRouter.shared.$pendingHome) { go in
            guard go else { return }
            DeepLinkRouter.shared.clearPendingHome()
            path = []
        }
    }

    // MARK: - Drawer

    @ViewBuilder
    private var drawerOverlay: some View {
        if showDrawer {
            Color.black.opacity(0.55)
                .ignoresSafeArea()
                .transition(.opacity)
                .onTapGesture { closeDrawer() }
                .zIndex(1)
            HStack(spacing: 0) {
                ProjectsDrawer(
                    onSelect: { id in
                        closeDrawer()
                        DeepLinkRouter.shared.openProject(id)
                    },
                    onNewBuild: {
                        closeDrawer()
                        promptFocused = true
                    }
                )
                .frame(width: 304)
                Spacer(minLength: 0)
            }
            .transition(.move(edge: .leading))
            .zIndex(2)
        }
    }

    private func closeDrawer() {
        withAnimation(drawerSpring) { showDrawer = false }
    }

    // MARK: - Pieces

    private var topBar: some View {
        HStack {
            CircleIconButton(systemName: "line.3.horizontal") {
                Haptics.tap()
                promptFocused = false
                withAnimation(drawerSpring) { showDrawer = true }
            }
            .accessibilityIdentifier("menuButton")
            Spacer()
        }
        .overlay(
            HStack(spacing: 9) {
                Image("LogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 28, height: 28)
                Text("Forge")
                    .font(.system(size: 27, weight: .bold, design: .serif))
                    .foregroundStyle(.white)
            }
        )
        .padding(.horizontal, 16)
        .padding(.top, 6)
    }

    private var connectPill: some View {
        Button {
            Haptics.tap()
        } label: {
            HStack(spacing: 10) {
                HStack(spacing: -7) {
                    toolBadge(systemName: "triangle.fill", color: Color(red: 0.20, green: 0.66, blue: 0.33))
                    toolBadge(systemName: "number", color: Color(red: 0.88, green: 0.10, blue: 0.41))
                    toolBadge(systemName: "envelope.fill", color: Color(red: 0.92, green: 0.26, blue: 0.21))
                }
                Text("Connect all your tools")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(.white)
                Image(systemName: "arrow.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 14)
            .frame(height: 52)
            .background(.black.opacity(0.55), in: Capsule())
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        }
        .buttonStyle(PressableButtonStyle())
    }

    private func toolBadge(systemName: String, color: Color) -> some View {
        Image(systemName: systemName)
            .font(.system(size: 11, weight: .bold))
            .foregroundStyle(color)
            .frame(width: 26, height: 26)
            .background(.white, in: Circle())
            .overlay(Circle().strokeBorder(.black.opacity(0.25), lineWidth: 0.5))
    }

    private var greeting: some View {
        Text("Got an idea, \(AppConfig.userName)?")
            .font(.system(size: 30, weight: .semibold, design: .serif))
            .foregroundStyle(.white)
            .padding(.top, 26)
    }

    private var platformToggle: some View {
        HStack(spacing: 4) {
            platformButton("Web", icon: "globe", value: "web")
            platformButton("Mobile", icon: "iphone", value: "mobile")
        }
        .padding(4)
        .background(Color(red: 0.118, green: 0.118, blue: 0.125).opacity(0.96), in: Capsule())
        .overlay(Capsule().strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
        .padding(.top, 26)
    }

    private func platformButton(_ label: String, icon: String, value: String) -> some View {
        Button {
            Haptics.tap()
            withAnimation(.spring(response: 0.35, dampingFraction: 0.74)) {
                platform = value
            }
        } label: {
            HStack(spacing: 7) {
                Image(systemName: icon)
                    .font(.system(size: 13, weight: .semibold))
                Text(label)
                    .font(.system(size: 15, weight: .semibold))
            }
            .foregroundStyle(platform == value ? .black : Theme.textSecondary)
            .padding(.horizontal, 20)
            .frame(height: 38)
            .background {
                if platform == value {
                    Capsule()
                        .fill(.white)
                        .matchedGeometryEffect(id: "platform-pill", in: toggleNamespace)
                }
            }
            .contentShape(Capsule())
        }
        .accessibilityIdentifier("platform-\(value)")
    }

    private var composerCard: some View {
        VStack(alignment: .leading, spacing: 18) {
            TextField(
                "",
                text: $prompt,
                prompt: Text("Ask Forge to build anything…")
                    .foregroundStyle(Theme.textSecondary),
                axis: .vertical
            )
            .font(.system(size: 17))
            .foregroundStyle(.white)
            .tint(Theme.blue)
            .lineLimit(1...5)
            .focused($promptFocused)
            .accessibilityIdentifier("promptField")

            HStack(spacing: 18) {
                Button { Haptics.tap() } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 21, weight: .medium))
                        .foregroundStyle(.white)
                }

                Spacer()

                Menu {
                    ForEach(ClaudeModels.options, id: \.key) { option in
                        Button {
                            Haptics.tap()
                            selectedModel = option.key
                        } label: {
                            if selectedModel == option.key {
                                Label(option.name, systemImage: "checkmark")
                            } else {
                                Text(option.name)
                            }
                        }
                    }
                } label: {
                    HStack(spacing: 6) {
                        Text(ClaudeModels.shortName(for: selectedModel))
                            .font(.system(size: 17, weight: .medium))
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                }
                .accessibilityIdentifier("modelMenu")

                VoiceButton(voice: voice) { text in
                    prompt = prompt.isEmpty ? text : prompt + " " + text
                }

                Button(action: submit) {
                    ZStack {
                        Circle()
                            .fill(canSubmit ? Color.white : Color.white.opacity(0.85))
                            .frame(width: 44, height: 44)
                        if creating {
                            ProgressView().tint(.black)
                        } else {
                            Image(systemName: "arrow.up")
                                .font(.system(size: 18, weight: .bold))
                                .foregroundStyle(canSubmit ? .black : Color.black.opacity(0.35))
                        }
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(!canSubmit)
                .accessibilityIdentifier("sendButton")
            }
        }
        .padding(.horizontal, 18)
        .padding(.top, 20)
        .padding(.bottom, 14)
        .background(Color(red: 0.118, green: 0.118, blue: 0.125).opacity(0.96), in: RoundedRectangle(cornerRadius: 30, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 30, style: .continuous)
                .strokeBorder(Color.white.opacity(0.07), lineWidth: 1)
        )
        .padding(.horizontal, 16)
        .padding(.top, 14)
    }

    private var canSubmit: Bool {
        !prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !creating
    }

    private func submit() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !creating else { return }
        creating = true
        Haptics.tap()
        Task {
            if let id = await vm.create(prompt: text, platform: platform, model: selectedModel) {
                prompt = ""
                promptFocused = false
                path.append(id)
            } else {
                Haptics.error()
            }
            creating = false
        }
    }

    private func handleDeepLink(_ url: URL) {
        guard url.scheme == "forge" else { return }
        switch url.host() {
        case "home":
            path = []
        case "project":
            let id = url.lastPathComponent
            guard !id.isEmpty, id != "/" else { return }
            var tab: ProjectTab?
            if let raw = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "tab" })?.value {
                tab = DeepLinkRouter.tab(from: raw)
            }
            DeepLinkRouter.shared.openProject(id, tab: tab)
        default:
            break
        }
    }
}

// MARK: - Left drawer

struct ProjectsDrawer: View {
    @StateObject private var vm = ProjectsViewModel()
    let onSelect: (String) -> Void
    let onNewBuild: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                Image("LogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 24, height: 24)
                Text("Your builds")
                    .font(.system(size: 22, weight: .bold, design: .serif))
                    .foregroundStyle(.white)
            }
            .padding(.horizontal, 20)
            .padding(.top, 16)
            .padding(.bottom, 14)

            Button {
                Haptics.tap()
                onNewBuild()
            } label: {
                HStack(spacing: 12) {
                    Image(systemName: "plus")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(width: 32, height: 32)
                        .background(.white, in: Circle())
                    Text("New build")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                    Spacer()
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 8)
                .contentShape(Rectangle())
            }
            .buttonStyle(PressableButtonStyle())

            Rectangle()
                .fill(Color.white.opacity(0.07))
                .frame(height: 1)
                .padding(.horizontal, 20)
                .padding(.vertical, 8)

            if vm.loaded && vm.projects.isEmpty {
                Text("No builds yet.")
                    .font(.system(size: 15))
                    .foregroundStyle(Theme.textSecondary)
                    .padding(20)
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(vm.projects) { project in
                            Button {
                                Haptics.tap()
                                onSelect(project.id)
                            } label: {
                                drawerRow(project)
                            }
                            .buttonStyle(PressableButtonStyle())
                            .accessibilityIdentifier("drawer-\(project.name)")
                            .contextMenu {
                                Button(role: .destructive) {
                                    vm.delete(project)
                                } label: {
                                    Label("Delete build", systemImage: "trash")
                                }
                            }
                        }
                    }
                    .padding(.top, 4)
                    .padding(.bottom, 30)
                }
            }

            Spacer(minLength: 0)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(
            Color(red: 0.055, green: 0.055, blue: 0.062)
                .clipShape(.rect(bottomTrailingRadius: 28, topTrailingRadius: 28))
                .ignoresSafeArea()
                .shadow(color: .black.opacity(0.6), radius: 24, x: 8)
        )
    }

    private func drawerRow(_ project: Project) -> some View {
        HStack(spacing: 12) {
            OrbIcon(seed: project.id, size: 40)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(project.name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .lineLimit(1)
                    if project.isMobile {
                        Image(systemName: "iphone")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.textSecondary)
                    }
                }
                HStack(spacing: 6) {
                    Circle().fill(statusColor(project)).frame(width: 6, height: 6)
                    Text(project.isBusy ? (project.statusDetail ?? "Working…") : project.statusLabel)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.textSecondary)
                        .lineLimit(1)
                }
            }
            Spacer()
            Image(systemName: "chevron.right")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Theme.textSecondary.opacity(0.5))
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }

    private func statusColor(_ project: Project) -> Color {
        if project.isLive { return Theme.green }
        if project.isError { return Theme.red }
        return Theme.amber
    }
}
