import SwiftUI

struct WelcomeView: View {
    @AppStorage("hasEntered") private var hasEntered = false
    @State private var appeared = false

    var body: some View {
        ZStack {
            LovableBloom()

            VStack(spacing: 0) {
                Spacer()

                Image("LogoMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 96, height: 96)
                    .shadow(color: Theme.bloomPink.opacity(0.55), radius: 28, y: 8)
                    .scaleEffect(appeared ? 1 : 0.6)
                    .opacity(appeared ? 1 : 0)

                Text("Forge")
                    .font(.system(size: 46, weight: .bold, design: .serif))
                    .foregroundStyle(.white)
                    .padding(.top, 22)

                Text("Build anything.\nRight from your phone.")
                    .font(.system(size: 17, weight: .medium))
                    .multilineTextAlignment(.center)
                    .foregroundStyle(.white.opacity(0.75))
                    .lineSpacing(4)
                    .padding(.top, 10)
                    .opacity(appeared ? 1 : 0)

                Spacer()

                Button {
                    Haptics.tap()
                    hasEntered = true
                } label: {
                    Text("Enter App")
                        .font(.system(size: 18, weight: .bold))
                        .foregroundStyle(.black)
                        .frame(maxWidth: .infinity)
                        .frame(height: 58)
                        .background(.white, in: Capsule())
                }
                .buttonStyle(PressableButtonStyle())
                .padding(.bottom, 16)

                Text("One user · No sign-in needed")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.white.opacity(0.65))
                    .padding(.bottom, 10)
            }
            .padding(.horizontal, 28)
        }
        .onAppear {
            withAnimation(.spring(response: 0.7, dampingFraction: 0.7)) {
                appeared = true
            }
        }
    }
}
