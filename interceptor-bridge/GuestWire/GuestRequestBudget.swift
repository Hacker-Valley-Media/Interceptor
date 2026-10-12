import Foundation
import CoreFoundation

extension GuestWire {
    /// Public requests admit integral seconds. Private transactions forward
    /// their fractional remainder; neither path may invent a fresh deadline.
    public static func requestBudget(_ action: [String: Any], defaultSeconds: Double) throws -> Double {
        guard let number = (action["timeout"] ?? defaultSeconds) as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID(),
              number.doubleValue.isFinite, number.doubleValue > 0, number.doubleValue <= 50 else { throw Failure.framing("guest request needs a positive numeric budget at most 50s") }
        return number.doubleValue
    }
}
