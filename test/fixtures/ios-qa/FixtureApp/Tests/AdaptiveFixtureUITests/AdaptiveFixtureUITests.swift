import XCTest

final class AdaptiveFixtureUITests: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = false }

    func testSwiftUIActionsInputModalAndVerticalNavigation() {
        let app = XCUIApplication(bundleIdentifier: "com.gstack.iosqa.adaptive.swiftui")
        app.launch()
        app.buttons["swiftui.increment"].tap()
        XCTAssertEqual(app.staticTexts["swiftui.count"].label, "Count: 1")
        XCTAssertFalse(app.buttons["swiftui.disabled"].isEnabled)
        app.textFields["swiftui.search"].tap(); app.textFields["swiftui.search"].typeText("adapt")
        XCTAssertEqual(app.staticTexts["swiftui.echo"].label, "Echo: adapt")
        app.buttons["swiftui.sheet.open"].tap(); XCTAssertTrue(app.staticTexts["swiftui.sheet.content"].waitForExistence(timeout: 2)); app.buttons["swiftui.sheet.done"].tap()
        app.buttons["swiftui.alert.open"].tap(); app.alerts.buttons["Confirm"].tap()
        XCTAssertEqual(app.staticTexts["swiftui.count"].label, "Count: 11")
        let row = app.buttons["swiftui.row.30"]; for _ in 0..<12 where !row.isHittable { app.swipeUp() }; XCTAssertTrue(row.isHittable); row.tap()
        XCTAssertTrue(app.staticTexts["swiftui.detail.30"].waitForExistence(timeout: 2))
    }

    func testUIKitActionsInputModalAndVerticalNavigation() {
        let app = XCUIApplication(bundleIdentifier: "com.gstack.iosqa.adaptive.uikit")
        app.launch()
        app.buttons["uikit.increment"].tap()
        XCTAssertEqual(app.staticTexts["uikit.count"].label, "Count: 1")
        XCTAssertFalse(app.buttons["uikit.disabled"].isEnabled)
        app.textFields["uikit.search"].tap(); app.textFields["uikit.search"].typeText("adapt")
        XCTAssertEqual(app.staticTexts["uikit.echo"].label, "Echo: adapt")
        app.buttons["uikit.sheet.open"].tap(); XCTAssertTrue(app.otherElements["uikit.sheet.content"].waitForExistence(timeout: 2)); app.buttons["uikit.sheet.done"].tap()
        app.buttons["uikit.alert.open"].tap(); app.alerts.buttons["Confirm"].tap()
        XCTAssertEqual(app.staticTexts["uikit.count"].label, "Count: 11")
        let row = app.buttons["uikit.row.30"]; for _ in 0..<12 where !row.isHittable { app.swipeUp() }; XCTAssertTrue(row.isHittable); row.tap()
        XCTAssertTrue(app.otherElements["uikit.detail.30"].waitForExistence(timeout: 2))
    }

    func testNestedHorizontalScrollingUsesContainerNotScreenCoordinates() {
        for bundle in ["com.gstack.iosqa.adaptive.swiftui", "com.gstack.iosqa.adaptive.uikit"] {
            let app = XCUIApplication(bundleIdentifier: bundle); app.launch()
            let prefix = bundle.hasSuffix("swiftui") ? "swiftui" : "uikit"
            let container = app.scrollViews["\(prefix).horizontal-scroll"]
            for _ in 0..<4 where !container.exists { app.swipeUp() }
            XCTAssertTrue(container.waitForExistence(timeout: 2))
            let card = app.buttons["\(prefix).card.11"]
            for _ in 0..<8 where !card.isHittable { container.swipeLeft() }
            XCTAssertTrue(card.isHittable)
        }
    }

    func testUIKitOccludedControlExistsButIsNotHittable() {
        let app = XCUIApplication(bundleIdentifier: "com.gstack.iosqa.adaptive.uikit"); app.launch()
        let target = app.buttons["uikit.occluded"]
        for _ in 0..<16 where !target.exists { app.swipeUp() }
        XCTAssertTrue(target.exists)
        XCTAssertFalse(target.isHittable)
    }
}
