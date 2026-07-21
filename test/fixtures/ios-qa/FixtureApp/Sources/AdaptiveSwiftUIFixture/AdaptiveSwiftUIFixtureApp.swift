import SwiftUI

@main
struct AdaptiveSwiftUIFixtureApp: App {
    var body: some Scene { WindowGroup { GalleryView() } }
}

private struct GalleryView: View {
    @State private var count = 0
    @State private var query = ""
    @State private var showingSheet = false
    @State private var showingAlert = false

    var body: some View {
        NavigationStack {
            List {
                Section("Actions") {
                    Button("Increment") { count += 1 }
                        .accessibilityIdentifier("swiftui.increment")
                    Text("Count: \(count)")
                        .accessibilityIdentifier("swiftui.count")
                    Button("Unavailable") {}
                        .disabled(true)
                        .accessibilityIdentifier("swiftui.disabled")
                    Button("Show sheet") { showingSheet = true }
                        .accessibilityIdentifier("swiftui.sheet.open")
                    Button("Show alert") { showingAlert = true }
                        .accessibilityIdentifier("swiftui.alert.open")
                }

                Section("Input") {
                    TextField("Search terms", text: $query)
                        .textInputAutocapitalization(.never)
                        .accessibilityIdentifier("swiftui.search")
                    Text("Echo: \(query)")
                        .accessibilityIdentifier("swiftui.echo")
                }

                Section("Nested horizontal scroll") {
                    ScrollView(.horizontal) {
                        HStack {
                            ForEach(0..<12) { index in
                                Button("Card \(index)") {}
                                    .buttonStyle(.bordered)
                                    .accessibilityIdentifier("swiftui.card.\(index)")
                            }
                        }
                    }
                    .accessibilityIdentifier("swiftui.horizontal-scroll")
                }

                Section("Long vertical list") {
                    ForEach(0..<35) { index in
                        NavigationLink("Row \(index)") {
                            Text("Detail \(index)")
                                .accessibilityIdentifier("swiftui.detail.\(index)")
                        }
                        .accessibilityIdentifier("swiftui.row.\(index)")
                    }
                }
            }
            .accessibilityIdentifier("swiftui.list")
            .navigationTitle("SwiftUI Gallery")
            .sheet(isPresented: $showingSheet) {
                NavigationStack {
                    Text("Sheet content").accessibilityIdentifier("swiftui.sheet.content")
                        .toolbar {
                            Button("Done") { showingSheet = false }
                                .accessibilityIdentifier("swiftui.sheet.done")
                        }
                }
            }
            .alert("Confirm action", isPresented: $showingAlert) {
                Button("Cancel", role: .cancel) {}
                Button("Confirm") { count += 10 }
            }
        }
    }
}
