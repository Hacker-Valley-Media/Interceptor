import UIKit

@main final class FixtureApp: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession, options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Fixture", sessionRole: session.role)
        configuration.delegateClass = FixtureScene.self
        return configuration
    }
}

final class FixtureScene: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        window = UIWindow(windowScene: scene)
        window?.rootViewController = FixtureController()
        window?.makeKeyAndVisible()
    }
}

/// Real controls and an occluded button exercise native actuation, not mocked selectors.
final class FixtureController: UIViewController, UIPickerViewDataSource, UIPickerViewDelegate, UIGestureRecognizerDelegate, UITextFieldDelegate {
    private let status = UILabel()
    private var taps = 0
    private var pinches = 0
    private var rotations = 0
    private var gestureArea: UIView?
    private let choices = ["Alpha", "Beta", "Gamma"]

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let scroll = UIScrollView(frame: view.bounds)
        scroll.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        scroll.contentSize = CGSize(width: view.bounds.width, height: 2200)
        scroll.accessibilityIdentifier = "scroll"
        view.addSubview(scroll)
        status.frame = CGRect(x: 20, y: 65, width: 330, height: 30)
        status.text = "Covered taps: 0"
        status.accessibilityIdentifier = "result"
        scroll.addSubview(status)

        let button = UIButton(type: .system)
        button.frame = CGRect(x: 20, y: 110, width: 320, height: 70)
        button.setTitle("Covered button", for: .normal)
        button.accessibilityIdentifier = "covered"
        button.backgroundColor = .systemBlue.withAlphaComponent(0.15)
        button.addTarget(self, action: #selector(tapped), for: .touchUpInside)
        scroll.addSubview(button)
        let overlay = UIView(frame: CGRect(x: 145, y: 115, width: 70, height: 60))
        overlay.backgroundColor = .systemRed
        overlay.isAccessibilityElement = true
        overlay.accessibilityLabel = "Center overlay"
        scroll.addSubview(overlay)

        let field = UITextField(frame: CGRect(x: 20, y: 200, width: 320, height: 40))
        field.borderStyle = .roundedRect
        field.placeholder = "Type here"
        field.autocapitalizationType = .none
        field.accessibilityIdentifier = "input"
        field.delegate = self
        scroll.addSubview(field)
        let secure = UITextField(frame: CGRect(x: 20, y: 250, width: 320, height: 40))
        secure.borderStyle = .roundedRect
        secure.isSecureTextEntry = true
        secure.text = "fixture-private-value"
        secure.accessibilityIdentifier = "secure"
        secure.placeholder = "Password"
        scroll.addSubview(secure)

        let slider = UISlider(frame: CGRect(x: 20, y: 310, width: 320, height: 40))
        slider.value = 0.2
        slider.accessibilityIdentifier = "slider"
        slider.accessibilityLabel = "Level"
        scroll.addSubview(slider)
        let picker = UIPickerView(frame: CGRect(x: 20, y: 360, width: 320, height: 130))
        picker.dataSource = self
        picker.delegate = self
        picker.accessibilityIdentifier = "picker"
        scroll.addSubview(picker)

        let area = UIView(frame: CGRect(x: 20, y: 510, width: 320, height: 160))
        area.backgroundColor = .systemGreen.withAlphaComponent(0.3)
        area.isAccessibilityElement = true
        area.accessibilityLabel = "Gesture area"
        area.accessibilityIdentifier = "gestureArea"
        gestureArea = area
        let pinch = UIPinchGestureRecognizer(target: self, action: #selector(pinched))
        pinch.delegate = self
        area.addGestureRecognizer(pinch)
        let rotation = UIRotationGestureRecognizer(target: self, action: #selector(rotated))
        rotation.delegate = self
        area.addGestureRecognizer(rotation)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped))
        doubleTap.numberOfTapsRequired = 2
        area.addGestureRecognizer(doubleTap)
        let twoFinger = UITapGestureRecognizer(target: self, action: #selector(twoFingerTapped))
        twoFinger.numberOfTouchesRequired = 2
        area.addGestureRecognizer(twoFinger)
        scroll.addSubview(area)
        for n in 0..<25 {
            let row = UILabel(frame: CGRect(x: 20, y: 720 + n * 50, width: 320, height: 40))
            row.text = "Row \(n)"
            row.accessibilityIdentifier = "row\(n)"
            scroll.addSubview(row)
        }
    }

    @objc private func tapped() { taps += 1; status.text = "Covered taps: \(taps)" }
    @objc private func pinched(_ sender: UIPinchGestureRecognizer) { if sender.state == .ended { pinches += 1; gestureArea?.accessibilityValue = "pinches: \(pinches), rotations: \(rotations)"; status.text = "Pinch received" } }
    @objc private func rotated(_ sender: UIRotationGestureRecognizer) { if sender.state == .ended { rotations += 1; gestureArea?.accessibilityValue = "pinches: \(pinches), rotations: \(rotations)"; status.text = "Rotation received" } }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    @objc private func doubleTapped() { status.text = "Double tap received" }
    @objc private func twoFingerTapped() { status.text = "Two finger tap received" }
    func textFieldDidChangeSelection(_ textField: UITextField) {
        guard let range = textField.selectedTextRange else { return }
        status.accessibilityValue = "selection: \(textField.offset(from: textField.beginningOfDocument, to: range.start)),\(textField.offset(from: textField.beginningOfDocument, to: range.end))"
    }
    func textFieldShouldReturn(_ textField: UITextField) -> Bool { status.text = "Return received"; return true }
    func numberOfComponents(in pickerView: UIPickerView) -> Int { 1 }
    func pickerView(_ pickerView: UIPickerView, numberOfRowsInComponent component: Int) -> Int { choices.count }
    func pickerView(_ pickerView: UIPickerView, titleForRow row: Int, forComponent component: Int) -> String? { choices[row] }
}
