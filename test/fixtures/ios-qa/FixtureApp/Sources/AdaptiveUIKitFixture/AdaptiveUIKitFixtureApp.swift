import UIKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = UINavigationController(rootViewController: UIKitGalleryController())
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class UIKitGalleryController: UIViewController, UITextFieldDelegate {
    private let stack = UIStackView()
    private let countLabel = UILabel()
    private let echoLabel = UILabel()
    private var count = 0

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "UIKit Gallery"
        view.backgroundColor = .systemBackground

        let scroll = UIScrollView()
        scroll.accessibilityIdentifier = "uikit.vertical-scroll"
        stack.axis = .vertical
        stack.spacing = 16
        stack.layoutMargins = UIEdgeInsets(top: 24, left: 20, bottom: 24, right: 20)
        stack.isLayoutMarginsRelativeArrangement = true
        view.addSubview(scroll); scroll.addSubview(stack)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor), scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor), scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor), stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor), stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor)
        ])

        addButton("Increment", id: "uikit.increment", action: #selector(increment))
        countLabel.text = "Count: 0"; countLabel.accessibilityIdentifier = "uikit.count"; stack.addArrangedSubview(countLabel)
        let disabled = addButton("Unavailable", id: "uikit.disabled", action: #selector(noop)); disabled.isEnabled = false
        addButton("Show sheet", id: "uikit.sheet.open", action: #selector(showSheet))
        addButton("Show alert", id: "uikit.alert.open", action: #selector(showAlert))

        let field = UITextField(); field.placeholder = "Search terms"; field.borderStyle = .roundedRect
        field.accessibilityIdentifier = "uikit.search"; field.delegate = self; field.addTarget(self, action: #selector(textChanged(_:)), for: .editingChanged)
        stack.addArrangedSubview(field)
        echoLabel.text = "Echo: "; echoLabel.accessibilityIdentifier = "uikit.echo"; stack.addArrangedSubview(echoLabel)

        let horizontal = UIScrollView(); horizontal.accessibilityIdentifier = "uikit.horizontal-scroll"
        let cards = UIStackView(); cards.axis = .horizontal; cards.spacing = 12
        horizontal.addSubview(cards); cards.translatesAutoresizingMaskIntoConstraints = false; horizontal.heightAnchor.constraint(equalToConstant: 52).isActive = true
        NSLayoutConstraint.activate([cards.topAnchor.constraint(equalTo: horizontal.contentLayoutGuide.topAnchor), cards.bottomAnchor.constraint(equalTo: horizontal.contentLayoutGuide.bottomAnchor), cards.leadingAnchor.constraint(equalTo: horizontal.contentLayoutGuide.leadingAnchor), cards.trailingAnchor.constraint(equalTo: horizontal.contentLayoutGuide.trailingAnchor), cards.heightAnchor.constraint(equalTo: horizontal.frameLayoutGuide.heightAnchor)])
        for index in 0..<12 { let button = UIButton(type: .system); button.setTitle("Card \(index)", for: .normal); button.accessibilityIdentifier = "uikit.card.\(index)"; cards.addArrangedSubview(button) }
        stack.addArrangedSubview(horizontal)

        for index in 0..<35 { addButton("Row \(index)", id: "uikit.row.\(index)", action: #selector(openRow(_:)), tag: index) }

        let occluded = addButton("Occluded target", id: "uikit.occluded", action: #selector(noop))
        let blocker = UIView(); blocker.backgroundColor = .systemBackground; blocker.accessibilityIdentifier = "uikit.occluder"; blocker.isAccessibilityElement = true
        occluded.addSubview(blocker); blocker.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([blocker.topAnchor.constraint(equalTo: occluded.topAnchor), blocker.bottomAnchor.constraint(equalTo: occluded.bottomAnchor), blocker.leadingAnchor.constraint(equalTo: occluded.leadingAnchor), blocker.trailingAnchor.constraint(equalTo: occluded.trailingAnchor)])
    }

    @discardableResult private func addButton(_ title: String, id: String, action: Selector, tag: Int = 0) -> UIButton {
        let button = UIButton(type: .system); button.configuration = .bordered(); button.setTitle(title, for: .normal); button.accessibilityIdentifier = id; button.tag = tag
        button.addTarget(self, action: action, for: .touchUpInside); stack.addArrangedSubview(button); return button
    }
    @objc private func increment() { count += 1; countLabel.text = "Count: \(count)" }
    @objc private func noop() {}
    @objc private func textChanged(_ sender: UITextField) { echoLabel.text = "Echo: \(sender.text ?? "")" }
    @objc private func openRow(_ sender: UIButton) { navigationController?.pushViewController(DetailController(index: sender.tag), animated: true) }
    @objc private func showSheet() { let vc = UIViewController(); vc.view.backgroundColor = .systemBackground; vc.view.accessibilityIdentifier = "uikit.sheet.content"; vc.title = "Sheet content"; let nav = UINavigationController(rootViewController: vc); vc.navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Done", style: .done, target: self, action: #selector(closeSheet)); vc.navigationItem.rightBarButtonItem?.accessibilityIdentifier = "uikit.sheet.done"; present(nav, animated: true) }
    @objc private func closeSheet() { dismiss(animated: true) }
    @objc private func showAlert() { let alert = UIAlertController(title: "Confirm action", message: nil, preferredStyle: .alert); alert.addAction(UIAlertAction(title: "Cancel", style: .cancel)); alert.addAction(UIAlertAction(title: "Confirm", style: .default) { _ in self.count += 10; self.countLabel.text = "Count: \(self.count)" }); present(alert, animated: true) }
}

final class DetailController: UIViewController {
    init(index: Int) { super.init(nibName: nil, bundle: nil); title = "Detail \(index)"; view.accessibilityIdentifier = "uikit.detail.\(index)" }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
    override func viewDidLoad() { super.viewDidLoad(); view.backgroundColor = .systemBackground }
}
