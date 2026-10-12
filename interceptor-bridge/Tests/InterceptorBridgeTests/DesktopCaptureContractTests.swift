import XCTest
@testable import interceptor_bridge
final class DesktopCaptureContractTests:XCTestCase{
    func testStrictRequestsPrecedeNativeCapture(){
        for action:[String:Any] in [["type":"desktop_screenshot","quality":0,"target_max_long_edge":0],["type":"desktop_capture","sub":"frame","timeoutMs":0],["type":"desktop_capture","sub":"status"]]{XCTAssertNil(DesktopCaptureValidation.validate(action))}
        for action:[String:Any] in [["type":"desktop_screenshot","window":0],["type":"desktop_screenshot","quality":101],["type":"desktop_screenshot","quality":1.5],["type":"desktop_capture","timeoutMs":10001],["type":"desktop_capture","app":NSNull()],["type":"desktop_screenshot","cwd":"a\0b"],["type":"desktop_capture","sub":"missing"],["type":"desktop_capture","quality":80]]{XCTAssertEqual(DesktopCaptureValidation.validate(action)?["code"] as? String,"invalid_request")}
        XCTAssertEqual(DesktopCaptureValidation.validate(["type":"desktop_screenshot","element":"e1"])?["code"] as? String,"unsupported_operation")
        XCTAssertNil(DesktopCaptureValidation.validate(["type":"macos_screenshot","quality":"legacy"]))
    }
    func testNeutralErrorNormalizationPreservesLegacyReplies(){
        let result:[String:Any]=["success":false,"error":"window not found: 123"]
        XCTAssertEqual(DesktopCaptureValidation.normalize(result,action:["type":"desktop_screenshot"])["code"] as? String,"unsupported_target")
        XCTAssertNil(DesktopCaptureValidation.normalize(result,action:["type":"macos_screenshot"])["code"])
    }
}
