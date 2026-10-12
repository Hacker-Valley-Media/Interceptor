// LocationDomain unit tests. Live tests gated behind LIVE_LOCATION=1.

import XCTest
import CoreLocation
@testable import interceptor_bridge

private final class ControlledLocationManager:CLLocationManager,@unchecked Sendable{
    var requests=0
    var stops=0
    var requestedOnMain=false
    override func requestLocation(){requests+=1;requestedOnMain=Thread.isMainThread}
    override func stopUpdatingLocation(){stops+=1}
}

final class LocationDomainTests: XCTestCase {
    private let domain = LocationDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 15.0)
        return holder.value
    }

    func testStatus_returnsField() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testReverse_invalidCoords_errors() {
        let r = runVerb("reverse", action: ["coords": "not-a-coord"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testGeocode_missingAddress_errors() {
        let r = runVerb("geocode")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDistance_missingFields_errors() {
        let r = runVerb("distance")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDistance_validCoords_succeeds() {
        let r = runVerb("distance", action: ["from": "37.0,-122.0", "to": "37.1,-122.1"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testHeadingStart_returnsMacOSNote() {
        let r = runVerb("heading_start")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testInvalidFieldsDoNotCreateNativeManager(){
        var creations=0
        let isolated=LocationDomain(makeManager:{creations+=1;return ControlledLocationManager()})
        for action:[String:Any] in [["sub":"current","accuracy":"best"],["sub":"reverse","coords":"0,,1"],["sub":"distance","from":"91,0","to":"0,0"],["sub":"postal-geocode","postal":"{\"extra\":\"x\"}"]]{
            let exp=expectation(description:"invalid location")
            isolated.handle("location",action:action){result in XCTAssertEqual(result["code"] as? String,"invalid_request");exp.fulfill()}
            wait(for:[exp],timeout:1)
        }
        XCTAssertEqual(creations,0)
    }
    func testCurrentAdmissionAndActualCallbackHaveIndependentOwnership(){
        let native=ControlledLocationManager(),holder=TestResultHolder()
        let isolated=LocationDomain(makeManager:{native})
        let first=expectation(description:"first fix"),second=expectation(description:"overlap refused")
        isolated.handle("location",action:["sub":"current"]){result in holder.set(result);first.fulfill()}
        isolated.handle("location",action:["sub":"current"]){result in
            XCTAssertEqual(result["code"] as? String,"resource_limit");second.fulfill()
            let fix=CLLocation(latitude:37,longitude:-122)
            isolated.locationManager(native,didUpdateLocations:[fix])
        }
        wait(for:[first,second],timeout:2)
        XCTAssertTrue(native.requestedOnMain);XCTAssertEqual(native.requests,1);XCTAssertEqual(native.stops,1)
        XCTAssertEqual(holder.value["success"] as? Bool,true)
        // A callback from a retired manager cannot satisfy a newer request.
        isolated.locationManager(native,didFailWithError:NSError(domain:kCLErrorDomain,code:CLError.denied.rawValue))
        XCTAssertEqual(native.stops,1)
    }
    func testCurrentDeadlineRepliesOnceAndRetiresNativeManager(){
        let native=ControlledLocationManager()
        let isolated=LocationDomain(makeManager:{native},requestTimeout:0.03)
        let timeout=expectation(description:"bounded current"),retired=expectation(description:"native retired")
        isolated.handle("location",action:["sub":"current"]){result in
            XCTAssertEqual(result["code"] as? String,"timeout_unknown_outcome");timeout.fulfill()
            DispatchQueue.main.asyncAfter(deadline:.now()+0.03){
                XCTAssertEqual(native.stops,1);XCTAssertNil(native.delegate)
                isolated.locationManager(native,didUpdateLocations:[CLLocation(latitude:1,longitude:2)])
                retired.fulfill()
            }
        }
        wait(for:[timeout,retired],timeout:2)
    }
    func testCoordinateAndNativeFixValidation(){
        XCTAssertEqual(LocationDomain.coordinates(" 1 , -2 "),[1,-2])
        for text in ["1,,2","91,0","0,181","NaN,0","0x1,0","0,0,1","1e999,0"]{XCTAssertNil(LocationDomain.coordinates(text))}
        XCTAssertTrue(LocationDomain.validFix(CLLocation(latitude:1,longitude:2)))
        let invalid=CLLocation(coordinate:.init(latitude:1,longitude:2),altitude:.nan,horizontalAccuracy:1,verticalAccuracy:1,timestamp:Date())
        XCTAssertFalse(LocationDomain.validFix(invalid))
    }

    func testGeocode_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_LOCATION"] == "1")
        let r = runVerb("geocode", action: ["address": "1 Apple Park Way Cupertino CA"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
