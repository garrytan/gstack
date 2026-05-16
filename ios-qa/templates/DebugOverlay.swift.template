import SwiftUI

#if DEBUG

// MARK: - Debug Overlay View

public struct DebugOverlayView: View {
    @State private var isConnected = false
    @State private var lastAction = ""
    @State private var showingAction = false
    @State private var gradientRotation: Double = 0
    @State private var borderWidth: CGFloat = 3
    @State private var pulseOpacity: Double = 0

    public init() {}

    public var body: some View {
        ZStack {
            // Animated gradient border — flows around the screen edge
            if isConnected {
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(
                        AngularGradient(
                            gradient: Gradient(colors: [
                                Color(red: 0.0, green: 0.5, blue: 1.0),   // blue
                                Color(red: 0.0, green: 0.8, blue: 1.0),   // cyan
                                Color(red: 0.4, green: 0.3, blue: 1.0),   // purple
                                Color(red: 0.0, green: 0.6, blue: 1.0),   // blue-cyan
                                Color(red: 0.2, green: 0.9, blue: 0.9),   // teal
                                Color(red: 0.5, green: 0.2, blue: 1.0),   // violet
                                Color(red: 0.0, green: 0.5, blue: 1.0),   // back to blue
                            ]),
                            center: .center,
                            startAngle: .degrees(gradientRotation),
                            endAngle: .degrees(gradientRotation + 360)
                        ),
                        lineWidth: borderWidth
                    )
                    .ignoresSafeArea()
                    .onAppear {
                        withAnimation(.linear(duration: 2.5).repeatForever(autoreverses: false)) {
                            gradientRotation = 360
                        }
                    }

                // Outer glow
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(
                        AngularGradient(
                            gradient: Gradient(colors: [
                                .cyan.opacity(0.3), .blue.opacity(0.1),
                                .purple.opacity(0.3), .cyan.opacity(0.1),
                                .blue.opacity(0.3), .purple.opacity(0.1),
                                .cyan.opacity(0.3)
                            ]),
                            center: .center,
                            startAngle: .degrees(gradientRotation + 180),
                            endAngle: .degrees(gradientRotation + 540)
                        ),
                        lineWidth: 8
                    )
                    .blur(radius: 6)
                    .ignoresSafeArea()
            }

            // Top debug bar with glassmorphism
            VStack(spacing: 0) {
                if isConnected {
                    HStack(spacing: 8) {
                        // Glowing connection dot
                        Circle()
                            .fill(Color.cyan)
                            .frame(width: 6, height: 6)
                            .shadow(color: .cyan, radius: 4)
                            .shadow(color: .cyan, radius: 8)

                        Text("Claude is debugging")
                            .font(.system(size: 11, weight: .semibold, design: .monospaced))
                            .foregroundStyle(
                                LinearGradient(
                                    colors: [.white, .cyan.opacity(0.9)],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                            )

                        Spacer()

                        if showingAction {
                            Text(lastAction)
                                .font(.system(size: 10, weight: .regular, design: .monospaced))
                                .foregroundColor(.white.opacity(0.6))
                                .transition(.opacity.combined(with: .move(edge: .trailing)))
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill(.ultraThinMaterial)
                            .environment(\.colorScheme, .dark)
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .strokeBorder(
                                        LinearGradient(
                                            colors: [.white.opacity(0.2), .clear, .white.opacity(0.1)],
                                            startPoint: .topLeading,
                                            endPoint: .bottomTrailing
                                        ),
                                        lineWidth: 0.5
                                    )
                            )
                    )
                    .padding(.horizontal, 8)
                    .padding(.top, getSafeAreaTop() + 4)

                    Spacer()
                }
            }
        }
        .allowsHitTesting(false)
        .onReceive(NotificationCenter.default.publisher(for: .debugBridgeConnected)) { _ in
            withAnimation(.easeInOut(duration: 0.5)) {
                isConnected = true
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .debugBridgeDisconnected)) { _ in
            withAnimation(.easeInOut(duration: 0.3)) {
                isConnected = false
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .debugBridgeAction)) { notification in
            if let action = notification.userInfo?["action"] as? String {
                lastAction = action
                withAnimation(.easeInOut(duration: 0.2)) { showingAction = true }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    withAnimation(.easeOut(duration: 0.3)) { showingAction = false }
                }
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: .debugBridgeStateMutation)) { _ in
            // Pulse the border on state mutations
            withAnimation(.easeIn(duration: 0.1)) {
                borderWidth = 6
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                withAnimation(.easeOut(duration: 0.4)) {
                    borderWidth = 3
                }
            }
        }
    }

    private func getSafeAreaTop() -> CGFloat {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow }?
            .safeAreaInsets.top ?? 0
    }
}

// MARK: - Notification Names

extension Notification.Name {
    public static let debugBridgeConnected = Notification.Name("debugBridgeConnected")
    public static let debugBridgeDisconnected = Notification.Name("debugBridgeDisconnected")
    public static let debugBridgeAction = Notification.Name("debugBridgeAction")
    public static let debugBridgeStateMutation = Notification.Name("debugBridgeStateMutation")
}

// MARK: - Notifier

public enum DebugBridgeNotifier {
    public static func connected() {
        NotificationCenter.default.post(name: .debugBridgeConnected, object: nil)
    }

    public static func disconnected() {
        NotificationCenter.default.post(name: .debugBridgeDisconnected, object: nil)
    }

    public static func action(_ description: String) {
        NotificationCenter.default.post(
            name: .debugBridgeAction,
            object: nil,
            userInfo: ["action": description]
        )
    }

    public static func stateMutation() {
        NotificationCenter.default.post(name: .debugBridgeStateMutation, object: nil)
    }
}

// MARK: - View Extension

public extension View {
    func debugBridgeOverlay() -> some View {
        self.overlay(DebugOverlayView())
    }
}

#endif
