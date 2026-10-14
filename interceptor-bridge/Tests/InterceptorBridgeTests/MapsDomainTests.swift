// MapsDomain unit tests. Network-dependent calls (search, directions,
// reverse-geocode) are gated behind LIVE_NETWORK=1 to keep CI offline-clean.

import XCTest
import MapKit
@testable import interceptor_bridge

final class MapsDomainTests: XCTestCase {
    private let domain = MapsDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 10.0)
        return holder.value
    }

    func testSearch_missingQuery_errors() {
        let r = runVerb("search")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testDirections_missingFrom_errors() {
        let r = runVerb("directions", action: ["to": "Apple Park"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testEta_missingTo_errors() {
        let r = runVerb("eta", action: ["from": "Apple Park"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testReverse_invalidCoords_errors() {
        let r = runVerb("reverse", action: ["coords": "not-a-coord"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testMapItemOpen_unknownId_errors() {
        let r = runVerb("mapitem-open", action: ["id": "B-99999"])
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testMalformedFieldsRefuseBeforeNativeDispatch(){
        let cases:[[String:Any]]=[["sub":"search","query":"x","limit":"3"],["sub":"complete","query":"x","limit":true],["sub":"search","query":"x","region":"1,,2,3"],["sub":"eta","from":"91,0","to":"0,0"],["sub":"reverse","coords":"0,0","query":"unowned"],["sub":"search","query":"x","address_include":"country","address_exclude":"locality"]]
        for action in cases{
            var action=action;action["type"]="desktop_maps";XCTAssertNotNil(MapsDomain.validationError(action))
        }
        XCTAssertEqual(MapsDomain.regionValues("1,2,3,4"),[1,2,3,4])
        XCTAssertNil(MapsDomain.regionValues("1,2,0,4"))
    }
    func testNativeFilterConstantsAreApplied(){
        XCTAssertTrue(MapsDomain.poiFilter("airport,pharmacy")!.includes(.airport))
        XCTAssertTrue(MapsDomain.poiFilter(MKPointOfInterestCategory.pharmacy.rawValue)!.includes(.pharmacy))
        XCTAssertNil(MapsDomain.poiFilter("missing-category"))
        if #available(macOS 15, *){
            XCTAssertTrue(MapsDomain.addressFilter(["address_include":"country,postalCode"])!.includes(.postalCode))
            XCTAssertTrue(MapsDomain.addressFilter(["address_exclude":"locality"])!.excludes(.locality))
            XCTAssertNil(MapsDomain.addressFilter(["address_include":"unknown"]))
        }
    }
    func testCompleterReportsActualErrorOnce(){
        let received=TestResultHolder()
        let delegate=CompleterDelegate{results,error in received.set(["count":results.count,"error":(error as NSError?)?.code ?? 0])}
        delegate.fire(with:[],error:NSError(domain:"fixture",code:42));delegate.fire(with:[])
        XCTAssertEqual(received.value["error"] as? Int,42)
    }
    func testWorkRevokesReplyWhileRetainingNativeCleanup(){
        let received=TestResultHolder(),cleanup=TestResultHolder();cleanup.set(["busy":true])
        let work=MapsWork{received.set($0)};weak var retained:NSObject?
        do{let native=NSObject();retained=native;work.keep(native,cancel:{cleanup.set(["busy":false])},busy:{cleanup.value["busy"] as? Bool == true})}
        XCTAssertNotNil(retained);XCTAssertTrue(work.busy())
        XCTAssertTrue(work.reply(["success":false]));XCTAssertFalse(work.reply(["success":true]));XCTAssertFalse(work.awaitingReply)
        XCTAssertNotNil(retained);work.cancel();XCTAssertFalse(work.busy());work.clear();XCTAssertNil(retained)
        XCTAssertEqual(received.value["success"] as? Bool,false)
    }
    func testMapItemIdentityExpiresAndEvictsWithoutRebinding(){
        var now:TimeInterval=0;let cache=MapItemCache(clock:{now});let item=MKMapItem(placemark:MKPlacemark(coordinate:.init(latitude:1,longitude:2)))
        let first=cache.put(item);XCTAssertTrue(cache.get(first)===item)
        for _ in 0..<128{XCTAssertNotEqual(cache.put(item),first)}
        XCTAssertNil(cache.get(first));let last=cache.put(item);now=301;XCTAssertNil(cache.get(last));XCTAssertNotEqual(cache.put(item),last)
    }
    func testOutputBoundsAndReplyIdentity(){
        let action:[String:Any]=["sub":"search","query":"x","limit":1]
        let point:[String:Any]=["id":"B-fixture","name":NSNull(),"isCurrentLocation":false,"placemark":["name":NSNull(),"coordinate":[1.0,2.0]]]
        XCTAssertNil(MapsDomain.resultError(WireFormat.success(["query":"x","results":[point]]),action:action))
        XCTAssertNotNil(MapsDomain.resultError(WireFormat.success(["query":"x","results":[point,point]]),action:action))
        XCTAssertNotNil(MapsDomain.resultError(WireFormat.success(["query":"other","results":[]]),action:action))
        XCTAssertNotNil(MapsDomain.resultError(WireFormat.success(["query":"x","completions":[["title":String(repeating:"x",count:4097),"subtitle":""]]]),action:["sub":"complete","query":"x"]))
    }

    // Live tests — gated behind LIVE_NETWORK=1.
    func testSearch_live_coffee() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_NETWORK"] == "1")
        let r = runVerb("search", action: ["query": "coffee", "limit": 3])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
