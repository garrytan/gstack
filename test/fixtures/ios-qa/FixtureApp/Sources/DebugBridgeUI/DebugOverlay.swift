// AUTO-GENERATED from gstack/ios-qa/templates/DebugOverlay.swift.template
//
// DebugOverlay — on-device visual presence. Animated brand-colored border +
// agent attribution chip + (optional) recording watermark. Renders above
// sheets, alerts, and modals via a dedicated UIWindow with high windowLevel.
//
// Everything in this file is gated #if DEBUG and gone in Release.

#if DEBUG && canImport(UIKit)

import SwiftUI
import UIKit

@MainActor
public final class DebugOverlayWindow {
    public static let shared = DebugOverlayWindow()

    private var window: UIWindow?

    public func install(recording: Bool = false) {
        guard window == nil else { return }
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first else { return }

        let w = PassThroughWindow(windowScene: scene)
        w.windowLevel = .alert + 1
        w.backgroundColor = .clear
        w.isUserInteractionEnabled = false

        let host = UIHostingController(rootView: OverlayRoot(recording: recording))
        host.view.backgroundColor = .clear
        w.rootViewController = host
        w.isHidden = false

        window = w
    }

    public func setAttribution(_ identity: String) {
        OverlayAttributionState.shared.identity = identity
    }
}

/// A window that lets touches pass through to underlying windows.
private final class PassThroughWindow: UIWindow {
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        let view = super.hitTest(point, with: event)
        return view == rootViewController?.view ? nil : view
    }
}

@MainActor
final class OverlayAttributionState: ObservableObject {
    static let shared = OverlayAttributionState()
    @Published var identity: String = "Claude Code (local)"
}

private struct OverlayRoot: View {
    @StateObject private var attribution = OverlayAttributionState.shared
    @State private var phase: CGFloat = 0
    let recording: Bool

    var body: some View {
        ZStack {
            // Animated brand border
            BorderShape()
                .stroke(
                    AngularGradient(
                        gradient: Gradient(colors: [
                            BrandColor.accent.opacity(0.0),
                            BrandColor.accent.opacity(0.8),
                            BrandColor.accent.opacity(0.0),
                        ]),
                        center: .center,
                        angle: .degrees(phase * 360)
                    ),
                    lineWidth: 4
                )
                .ignoresSafeArea()
                .onAppear {
                    withAnimation(.linear(duration: 2.0).repeatForever(autoreverses: false)) {
                        phase = 1.0
                    }
                }

            // Attribution chip (top safe area)
            VStack {
                HStack {
                    Spacer()
                    Text("Driven by \(attribution.identity)")
                        .font(.caption2.weight(.semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 4)
                        .background(
                            Capsule().fill(BrandColor.accent.opacity(0.85))
                        )
                        .padding(.trailing, 12)
                        .padding(.top, 8)
                    Spacer().frame(width: 0)
                }
                Spacer()
            }

            // Recording watermark (diagonal, bottom-right)
            if recording {
                VStack {
                    Spacer()
                    HStack {
                        Spacer()
                        Text("AGENT DEMO")
                            .font(.system(size: 10, weight: .heavy, design: .monospaced))
                            .foregroundColor(.red.opacity(0.7))
                            .rotationEffect(.degrees(-30))
                            .padding(.trailing, 16)
                            .padding(.bottom, 30)
                    }
                }
            }
        }
        .allowsHitTesting(false)
    }
}

private struct BorderShape: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.addRoundedRect(in: rect.insetBy(dx: 2, dy: 2), cornerSize: CGSize(width: 16, height: 16))
        return p
    }
}

private enum BrandColor {
    // gstack brand color — resolved from DESIGN.md when codegen runs.
    // Default falls back to a deep blue.
    static let accent = Color(red: 0.0, green: 0.46, blue: 1.0)
}

#endif // DEBUG && canImport(UIKit)
