// FixtureApp — interaction-rich SwiftUI app used by the ios-qa device-path
// E2E test. Every control exposes a stable accessibility identifier and writes
// to visible verification state so device-driven taps have an explicit oracle.
//
// On launch:
//   1. Install UI resolvers before any request can arrive
//   2. Register typed state and boot StateServer (::1/127.0.0.1 + 9999)
//   3. Log the one-use boot token, then render the interaction harness
//
// Everything ios-qa-related is gated #if DEBUG. Release builds compile this
// to a no-op app (no StateServer, no DebugBridge import, no overlay).

import SwiftUI

#if canImport(UIKit)
import UIKit
#endif

#if DEBUG
import DebugBridgeCore
#endif

#if DEBUG && canImport(UIKit)
import DebugBridgeUI
#endif

@main
struct FixtureAppApp: App {
    #if DEBUG
    private let appState = FixtureAppState()
    #endif

    init() {
        #if DEBUG
        // Wire the three UIKit-backed bridges so /screenshot, /elements,
        // /tap, /type, /swipe are ready before the listener accepts requests.
        #if canImport(UIKit)
        DebugBridgeUIWiring.installAll()
        #endif
        DebugBridgeManager.shared.start(
            appState: appState,
            register: FixtureAppStateAccessor.register
        )
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView()
        }
    }
}

struct ContentView: View {
    private enum HarnessTab: String, Hashable {
        case controls
        case inputs
        case rows

        var title: String { rawValue.capitalized }
    }

    private struct HarnessRow: Identifiable {
        let id: String
        let title: String
        let symbol: String
    }

    private static let harnessRows = [
        HarnessRow(id: "alpha", title: "Alpha row", symbol: "a.circle.fill"),
        HarnessRow(id: "bravo", title: "Bravo row", symbol: "b.circle.fill"),
        HarnessRow(id: "charlie", title: "Charlie row", symbol: "c.circle.fill"),
        HarnessRow(id: "delta", title: "Delta row", symbol: "d.circle.fill"),
    ]

    @State private var selectedTab: HarnessTab = .controls
    @State private var lastAction = "Harness ready"
    @State private var totalActions = 0
    @State private var tabChangeCount = 0

    @State private var primaryButtonCount = 0
    @State private var borderedButtonCount = 0
    @State private var plainButtonCount = 0
    @State private var destructiveButtonCount = 0
    @State private var toolbarRefreshCount = 0
    @State private var menuAddCount = 0
    @State private var menuArchiveCount = 0
    @State private var detailOpenCount = 0
    @State private var detailCloseCount = 0
    @State private var detailButtonCount = 0
    @State private var isShowingDetail = false

    @State private var toggleValue = false
    @State private var toggleChangeCount = 0
    @State private var stepperValue = 0
    @State private var stepperChangeCount = 0
    @State private var selectedMode = "One"
    @State private var pickerChangeCount = 0
    @State private var draftText = ""
    @FocusState private var isTextFieldFocused: Bool
    @State private var textChangeCount = 0
    @State private var textCommitCount = 0
    @State private var uikitButtonCount = 0

    @State private var rowTapCounts: [String: Int] = [:]
    @State private var rowFlagCount = 0
    @State private var rowArchiveCount = 0
    @State private var rowToolbarCount = 0

    var body: some View {
        TabView(selection: $selectedTab) {
            controlsTab
                .tabItem {
                    Label("Controls", systemImage: "hand.tap.fill")
                        .accessibilityIdentifier("tab-controls")
                }
                .tag(HarnessTab.controls)

            inputsTab
                .tabItem {
                    Label("Inputs", systemImage: "slider.horizontal.3")
                        .accessibilityIdentifier("tab-inputs")
                }
                .tag(HarnessTab.inputs)

            rowsTab
                .tabItem {
                    Label("Rows", systemImage: "list.bullet.rectangle")
                        .accessibilityIdentifier("tab-rows")
                }
                .tag(HarnessTab.rows)
        }
        .accessibilityIdentifier("fixture-tab-view")
        .onChange(of: selectedTab) { newTab in
            tabChangeCount += 1
            record("Selected \(newTab.title) tab")
        }
    }

    private var controlsTab: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    verificationPanel

                    GroupBox {
                        LazyVGrid(
                            columns: [GridItem(.flexible()), GridItem(.flexible())],
                            spacing: 10
                        ) {
                            Button {
                                primaryButtonCount += 1
                                record("Primary button tapped")
                            } label: {
                                buttonLabel("Primary", count: primaryButtonCount, symbol: "bolt.fill")
                            }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("primary-button")
                            .accessibilityValue("\(primaryButtonCount) taps")

                            Button {
                                borderedButtonCount += 1
                                record("Bordered button tapped")
                            } label: {
                                buttonLabel("Bordered", count: borderedButtonCount, symbol: "square")
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("bordered-button")
                            .accessibilityValue("\(borderedButtonCount) taps")

                            Button {
                                plainButtonCount += 1
                                record("Plain button tapped")
                            } label: {
                                buttonLabel("Plain", count: plainButtonCount, symbol: "circle")
                                    .padding(.vertical, 8)
                                    .background(Color.accentColor.opacity(0.12))
                                    .clipShape(RoundedRectangle(cornerRadius: 8))
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("plain-button")
                            .accessibilityValue("\(plainButtonCount) taps")

                            Button(role: .destructive) {
                                destructiveButtonCount += 1
                                record("Destructive-style button tapped")
                            } label: {
                                buttonLabel(
                                    "Destructive",
                                    count: destructiveButtonCount,
                                    symbol: "exclamationmark.triangle.fill"
                                )
                            }
                            .buttonStyle(.bordered)
                            .accessibilityIdentifier("destructive-button")
                            .accessibilityValue("\(destructiveButtonCount) taps")
                        }
                    } label: {
                        Label("SwiftUI button styles", systemImage: "rectangle.3.group")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("button-styles-group")

                    GroupBox {
                        VStack(spacing: 10) {
                            verificationRow(
                                "Refresh",
                                value: toolbarRefreshCount,
                                identifier: "nav-refresh-count"
                            )
                            verificationRow(
                                "Menu add",
                                value: menuAddCount,
                                identifier: "menu-add-count"
                            )
                            verificationRow(
                                "Menu archive",
                                value: menuArchiveCount,
                                identifier: "menu-archive-count"
                            )
                            verificationRow(
                                "Detail opened / closed",
                                textValue: "\(detailOpenCount) / \(detailCloseCount)",
                                identifier: "detail-navigation-count"
                            )
                        }
                    } label: {
                        Label("Navigation and menu results", systemImage: "menubar.rectangle")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("navigation-results-group")

                    Button {
                        detailOpenCount += 1
                        isShowingDetail = true
                    } label: {
                        Label("Open detail screen (\(detailOpenCount))", systemImage: "chevron.forward.circle.fill")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.indigo)
                    .accessibilityIdentifier("open-detail-button")
                    .accessibilityValue("Opened \(detailOpenCount) times")
                }
                .padding()
            }
            .accessibilityIdentifier("controls-scroll-view")
            .navigationTitle("Tap Lab")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button {
                        toolbarRefreshCount += 1
                        record("Navigation refresh tapped")
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .accessibilityIdentifier("nav-refresh-button")
                    .accessibilityValue("\(toolbarRefreshCount) refreshes")
                }

                ToolbarItem(placement: .navigationBarTrailing) {
                    Menu {
                        Button {
                            menuAddCount += 1
                            record("Add menu item selected")
                        } label: {
                            Label("Add item (\(menuAddCount))", systemImage: "plus")
                        }
                        .accessibilityIdentifier("menu-add-item")

                        Button {
                            menuArchiveCount += 1
                            record("Archive menu item selected")
                        } label: {
                            Label("Archive item (\(menuArchiveCount))", systemImage: "archivebox")
                        }
                        .accessibilityIdentifier("menu-archive-item")
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .accessibilityLabel("Harness actions menu")
                    }
                    .accessibilityIdentifier("toolbar-actions-menu")
                    .accessibilityValue("Add \(menuAddCount), archive \(menuArchiveCount)")
                }
            }
            .navigationDestination(isPresented: $isShowingDetail) {
                VStack(spacing: 18) {
                    verificationPanel

                    Image(systemName: "rectangle.stack.badge.play.fill")
                        .font(.system(size: 46))
                        .foregroundColor(.indigo)
                        .accessibilityIdentifier("detail-screen-artwork")

                    Text("Navigation destination")
                        .font(.title2.bold())
                        .accessibilityIdentifier("detail-screen-title")

                    Button {
                        detailButtonCount += 1
                        record("Detail button tapped")
                    } label: {
                        Label("Detail tap (\(detailButtonCount))", systemImage: "hand.tap")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("detail-action-button")
                    .accessibilityValue("\(detailButtonCount) taps")

                    Text("Detail count: \(detailButtonCount)")
                        .font(.headline.monospacedDigit())
                        .accessibilityIdentifier("detail-action-count")
                }
                .padding()
                .navigationTitle("Detail")
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarBackButtonHidden(true)
                .toolbar {
                    ToolbarItem(placement: .navigationBarLeading) {
                        Button {
                            isShowingDetail = false
                        } label: {
                            Label("Back to Tap Lab", systemImage: "chevron.backward")
                        }
                        .accessibilityIdentifier("detail-back-button")
                    }
                }
            }
            .onChange(of: isShowingDetail) { isShowing in
                if isShowing {
                    record("Opened detail screen")
                } else {
                    detailCloseCount += 1
                    record("Closed detail screen")
                }
            }
        }
        .accessibilityIdentifier("controls-navigation-stack")
    }

    private var inputsTab: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    verificationPanel

                    GroupBox {
                        VStack(spacing: 14) {
                            Toggle(isOn: Binding(
                                get: { toggleValue },
                                set: { newValue in
                                    toggleValue = newValue
                                    toggleChangeCount += 1
                                    record("Toggle changed to \(newValue ? "on" : "off")")
                                }
                            )) {
                                Label("Harness toggle", systemImage: toggleValue ? "checkmark.circle.fill" : "circle")
                            }
                            .accessibilityIdentifier("harness-toggle")
                            .accessibilityValue(toggleValue ? "On" : "Off")

                            verificationRow(
                                "Toggle changes",
                                value: toggleChangeCount,
                                identifier: "toggle-change-count"
                            )

                            Divider()

                            Stepper(
                                value: Binding(
                                    get: { stepperValue },
                                    set: { newValue in
                                        let direction = newValue > stepperValue ? "up" : "down"
                                        stepperValue = newValue
                                        stepperChangeCount += 1
                                        record("Stepper moved \(direction) to \(newValue)")
                                    }
                                ),
                                in: 0...9
                            ) {
                                Label("Stepper value: \(stepperValue)", systemImage: "plusminus.circle")
                                    .monospacedDigit()
                            }
                            .accessibilityIdentifier("harness-stepper")
                            .accessibilityValue("Value \(stepperValue), changed \(stepperChangeCount) times")

                            verificationRow(
                                "Stepper changes",
                                value: stepperChangeCount,
                                identifier: "stepper-change-count"
                            )
                            verificationRow(
                                "Stepper value",
                                value: stepperValue,
                                identifier: "stepper-value"
                            )
                        }
                    } label: {
                        Label("Toggle and stepper", systemImage: "switch.2")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("toggle-stepper-group")

                    GroupBox {
                        VStack(alignment: .leading, spacing: 12) {
                            Picker("Harness mode", selection: Binding(
                                get: { selectedMode },
                                set: { newValue in
                                    selectedMode = newValue
                                    pickerChangeCount += 1
                                    record("Segment selected: \(newValue)")
                                }
                            )) {
                                Text("One").tag("One")
                                Text("Two").tag("Two")
                                Text("Three").tag("Three")
                            }
                            .pickerStyle(.segmented)
                            .accessibilityIdentifier("harness-segmented-picker")
                            .accessibilityValue("Selected \(selectedMode)")

                            verificationRow(
                                "Selected segment",
                                textValue: selectedMode,
                                identifier: "picker-selection-value"
                            )
                            verificationRow(
                                "Segment changes",
                                value: pickerChangeCount,
                                identifier: "picker-change-count"
                            )
                        }
                    } label: {
                        Label("Segmented picker", systemImage: "rectangle.split.3x1")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("picker-group")

                    GroupBox {
                        VStack(alignment: .leading, spacing: 10) {
                            TextField("Type a device message", text: $draftText)
                                .focused($isTextFieldFocused)
                                .textFieldStyle(.roundedBorder)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .submitLabel(.done)
                                .accessibilityIdentifier("harness-text-field")
                                .accessibilityValue(draftText)
                                .onSubmit {
                                    commitText(source: "keyboard submit")
                                }
                                .onChange(of: draftText) { newValue in
                                    textChangeCount += 1
                                    record("Text changed to \(newValue.isEmpty ? "empty" : newValue)")
                                }

                            HStack {
                                Text("Echo: \(draftText.isEmpty ? "<empty>" : draftText)")
                                    .font(.subheadline.monospaced())
                                    .lineLimit(1)
                                    .accessibilityIdentifier("text-echo-value")
                                    .accessibilityValue(draftText)
                                Spacer()
                                Button("Commit") {
                                    commitText(source: "commit button")
                                }
                                .buttonStyle(.bordered)
                                .accessibilityIdentifier("commit-text-button")
                                .accessibilityValue("Committed \(textCommitCount) times")
                            }

                            verificationRow(
                                "Text changes",
                                value: textChangeCount,
                                identifier: "text-change-count"
                            )
                            verificationRow(
                                "Text commits",
                                value: textCommitCount,
                                identifier: "text-commit-count"
                            )
                        }
                    } label: {
                        Label("Text entry", systemImage: "keyboard")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("text-entry-group")

                    #if canImport(UIKit)
                    GroupBox {
                        VStack(spacing: 10) {
                            UIKitHarnessButton(count: uikitButtonCount) {
                                uikitButtonCount += 1
                                record("UIKit UIButton tapped")
                            }
                            .frame(maxWidth: .infinity, minHeight: 48)

                            verificationRow(
                                "UIKit taps",
                                value: uikitButtonCount,
                                identifier: "uikit-button-count"
                            )
                        }
                    } label: {
                        Label("Native UIKit control", systemImage: "iphone")
                            .font(.headline)
                    }
                    .accessibilityIdentifier("uikit-control-group")
                    #endif
                }
                .padding()
            }
            .accessibilityIdentifier("inputs-scroll-view")
            .navigationTitle("Input Lab")
            .navigationBarTitleDisplayMode(.inline)
        }
        .accessibilityIdentifier("inputs-navigation-stack")
    }

    private var rowsTab: some View {
        NavigationStack {
            List {
                Section {
                    verificationPanel
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                }

                Section("Tap a row") {
                    ForEach(Self.harnessRows) { row in
                        Button {
                            let count = rowTapCounts[row.id, default: 0] + 1
                            rowTapCounts[row.id] = count
                            record("\(row.title) tapped")
                        } label: {
                            HStack(spacing: 12) {
                                Image(systemName: row.symbol)
                                    .foregroundColor(.accentColor)
                                Text(row.title)
                                Spacer()
                                Text("\(rowTapCounts[row.id, default: 0])")
                                    .font(.headline.monospacedDigit())
                                    .foregroundColor(.secondary)
                                    .accessibilityIdentifier("row-\(row.id)-count")
                            }
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("row-\(row.id)-button")
                        .accessibilityValue("\(rowTapCounts[row.id, default: 0]) taps")
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button {
                                rowFlagCount += 1
                                record("Flagged \(row.title)")
                            } label: {
                                Label("Flag", systemImage: "flag.fill")
                            }
                            .tint(.orange)
                            .accessibilityIdentifier("row-\(row.id)-flag-action")
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                            Button {
                                rowArchiveCount += 1
                                record("Archived \(row.title)")
                            } label: {
                                Label("Archive", systemImage: "archivebox.fill")
                            }
                            .tint(.indigo)
                            .accessibilityIdentifier("row-\(row.id)-archive-action")
                        }
                    }
                }

                Section("Row action results") {
                    verificationRow(
                        "Flags",
                        value: rowFlagCount,
                        identifier: "row-flag-count"
                    )
                    verificationRow(
                        "Archives",
                        value: rowArchiveCount,
                        identifier: "row-archive-count"
                    )
                    verificationRow(
                        "Toolbar checks",
                        value: rowToolbarCount,
                        identifier: "row-toolbar-count"
                    )
                }
            }
            .listStyle(.insetGrouped)
            .accessibilityIdentifier("rows-list")
            .navigationTitle("Row Lab")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button {
                        rowToolbarCount += 1
                        record("Rows toolbar check tapped")
                    } label: {
                        Label("Check rows", systemImage: "checkmark.circle")
                    }
                    .accessibilityIdentifier("rows-toolbar-button")
                    .accessibilityValue("\(rowToolbarCount) checks")
                }
            }
        }
        .accessibilityIdentifier("rows-navigation-stack")
    }

    private var verificationPanel: some View {
        VerificationPanel(
            lastAction: lastAction,
            totalActions: totalActions,
            selectedTab: selectedTab.title,
            tabChangeCount: tabChangeCount
        )
    }

    private func buttonLabel(_ title: String, count: Int, symbol: String) -> some View {
        VStack(spacing: 4) {
            Label(title, systemImage: symbol)
                .lineLimit(1)
            Text("Count \(count)")
                .font(.caption.monospacedDigit())
                .accessibilityIdentifier("\(title.lowercased())-button-count")
        }
        .frame(maxWidth: .infinity, minHeight: 40)
    }

    private func verificationRow(_ label: String, value: Int, identifier: String) -> some View {
        verificationRow(label, textValue: String(value), identifier: identifier)
    }

    private func verificationRow(_ label: String, textValue: String, identifier: String) -> some View {
        HStack {
            Text(label)
                .foregroundColor(.secondary)
            Spacer()
            Text(textValue)
                .font(.subheadline.bold().monospacedDigit())
                .accessibilityIdentifier(identifier)
                .accessibilityLabel(label)
                .accessibilityValue(textValue)
        }
    }

    private func commitText(source: String) {
        textCommitCount += 1
        isTextFieldFocused = false
        record("Text committed from \(source): \(draftText.isEmpty ? "empty" : draftText)")
    }

    private func record(_ action: String) {
        totalActions += 1
        lastAction = action
    }
}

private struct VerificationPanel: View {
    let lastAction: String
    let totalActions: Int
    let selectedTab: String
    let tabChangeCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label("LIVE", systemImage: "waveform.path.ecg")
                    .font(.caption.bold())
                    .foregroundColor(.green)
                    .accessibilityIdentifier("harness-live-indicator")
                Spacer()
                Text("Total \(totalActions)")
                    .font(.caption.bold().monospacedDigit())
                    .accessibilityIdentifier("total-action-count")
                    .accessibilityLabel("Total actions")
                    .accessibilityValue("\(totalActions)")
            }

            Text(lastAction)
                .font(.subheadline.weight(.semibold))
                .lineLimit(2)
                .accessibilityIdentifier("last-action-status")
                .accessibilityLabel("Last action")
                .accessibilityValue(lastAction)

            HStack {
                Text("Tab: \(selectedTab)")
                    .accessibilityIdentifier("selected-tab-status")
                    .accessibilityValue(selectedTab)
                Spacer()
                Text("Tab changes: \(tabChangeCount)")
                    .monospacedDigit()
                    .accessibilityIdentifier("tab-change-count")
                    .accessibilityValue("\(tabChangeCount)")
            }
            .font(.caption)
            .foregroundColor(.secondary)
        }
        .padding(12)
        .background(Color.green.opacity(0.10))
        .overlay {
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.green.opacity(0.35), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("verification-panel")
    }
}

#if canImport(UIKit)
private struct UIKitHarnessButton: UIViewRepresentable {
    let count: Int
    let action: () -> Void

    final class Coordinator: NSObject {
        var action: () -> Void

        init(action: @escaping () -> Void) {
            self.action = action
        }

        @objc func tapped() {
            action()
        }
    }

    func makeCoordinator() -> Coordinator {
        Coordinator(action: action)
    }

    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        var configuration = UIButton.Configuration.filled()
        configuration.cornerStyle = .medium
        configuration.image = UIImage(systemName: "hand.tap.fill")
        configuration.imagePadding = 8
        button.configuration = configuration
        button.accessibilityIdentifier = "uikit-button"
        button.accessibilityLabel = "UIKit button"
        button.addTarget(context.coordinator, action: #selector(Coordinator.tapped), for: .touchUpInside)
        return button
    }

    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.action = action
        var configuration = button.configuration ?? UIButton.Configuration.filled()
        configuration.title = "UIKit Tap (\(count))"
        button.configuration = configuration
        button.accessibilityValue = "\(count) taps"
    }
}
#endif
