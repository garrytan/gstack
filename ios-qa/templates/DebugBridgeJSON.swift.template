import Foundation

#if DEBUG
import DebugBridge

enum DebugBridgeJSON {
    static func stringify(_ object: Any) -> String {
        if JSONSerialization.isValidJSONObject(object),
           let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
           let json = String(data: data, encoding: .utf8) {
            return json
        }
        return String(describing: object)
    }

    static func mutation(_ description: String) {
        DebugBridgeNotifier.stateMutation()
        DebugBridgeNotifier.action(description)
    }
}
#endif
