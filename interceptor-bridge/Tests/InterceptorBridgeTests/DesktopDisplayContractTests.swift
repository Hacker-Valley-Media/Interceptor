import XCTest
@testable import interceptor_bridge

final class DesktopDisplayContractTests: XCTestCase {
    func testDisplayRequestsRefuseMalformedIdentityBeforeNativeReads() {
        XCTAssertNil(DesktopDisplayValidation.validate(["type": "desktop_display_list"]))
        XCTAssertNil(DesktopDisplayValidation.validate(["type": "desktop_display_info", "id": 1.0]))
        for id: Any in [0, -1, 1.5, "1", true, NSNull(), Double(UInt32.max) + 1] {
            XCTAssertEqual(DesktopDisplayValidation.validate(["type": "desktop_display_info", "id": id])?["code"] as? String, "invalid_request")
        }
        XCTAssertEqual(DesktopDisplayValidation.validate(["type": "desktop_display_list", "id": 1])?["code"] as? String, "invalid_request")
        XCTAssertNil(DesktopDisplayValidation.validate(["type": "macos_display", "sub": "info", "id": "1"]))
    }
}
