// MusicDomain unit tests. Live tests gated behind LIVE_MUSIC=1.

import XCTest
@testable import interceptor_bridge

final class MusicDomainTests: XCTestCase {
    private let domain = MusicDomain()

    func runVerb(_ sub: String, action: [String: Any] = [:]) -> [String: Any] {
        var act = action; act["sub"] = sub
        let holder = TestResultHolder()
        let exp = expectation(description: sub)
        domain.handle(sub, action: act) { resp in holder.set(resp); exp.fulfill() }
        wait(for: [exp], timeout: 30.0)
        return holder.value
    }

    func testStatus_returnsAvailability() {
        let r = runVerb("status")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testMalformedFieldsRefuseBeforeMusicKit(){
        let cases:[[String:Any]]=[["sub":"seek","time":"3"],["sub":"seek","time":true],["sub":"library","limit":0],["sub":"library","limit":101],["sub":"library","kind":"artist","sort":"title"],["sub":"play","song":"x","album":"y"],["sub":"pause","song":"x"],["sub":"library-search","term":"x","types":"unknown"],["sub":"repeat","mode":"unknown"]]
        for item in cases{var item=item;item["type"]="desktop_music";XCTAssertNotNil(MusicDomain.validationError(item))}
        XCTAssertNil(MusicDomain.validationError(["type":"desktop_music","sub":"library","kind":"album","limit":3,"offset":1,"include_tracks":true]))
    }
    func testReplyBoundsAndNativeAcceptance(){
        let item:[String:Any]=["id":"native-id","title":"native title"],action:[String:Any]=["sub":"library","limit":1]
        XCTAssertNil(MusicDomain.resultError(WireFormat.success(["items":[item]]),action:action))
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(["items":[item,item]]),action:action))
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(["items":[["id":"","title":"x"]]]),action:action))
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(["ok":false]),action:["sub":"pause"]))
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(["available":true]),action:action))
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(["entries":[item],"count":0]),action:["sub":"queue"]))
    }
    func testSystemObservationContractAndAbsentMeasurements(){
        let data:[String:Any]=["status":"stopped","playbackRate":NSNull(),"playbackTime":NSNull(),"repeatMode":"off","shuffleMode":"off","queueLength":0,"system":["running":false]]
        XCTAssertNil(MusicDomain.resultError(WireFormat.success(data),action:["sub":"now-playing"]))
        var invalid=data;invalid["system"]=["running":"false"]
        XCTAssertNotNil(MusicDomain.resultError(WireFormat.success(invalid),action:["sub":"now-playing"]))
    }

    func testSearch_missingTerm_errors() {
        let r = runVerb("search")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testSong_missingId_errors() {
        let r = runVerb("song")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testAlbum_missingId_errors() {
        let r = runVerb("album")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testPlay_missingFields_errors() {
        let r = runVerb("play")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testSeek_missingTime_errors() {
        let r = runVerb("seek")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testRepeatMode_setOff_succeeds() {
        let r = runVerb("repeat", action: ["mode": "off"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testShuffle_setOff_succeeds() {
        let r = runVerb("shuffle", action: ["mode": "off"])
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testNowPlaying_returnsState() {
        let r = runVerb("now-playing")
        XCTAssertEqual(r["success"] as? Bool, true)
    }

    func testUnknownVerb_errors() {
        let r = runVerb("nope")
        XCTAssertEqual(r["success"] as? Bool, false)
    }

    func testSearch_live() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["LIVE_MUSIC"] == "1")
        let r = runVerb("search", action: ["term": "hello", "types": "song", "limit": 3])
        XCTAssertEqual(r["success"] as? Bool, true)
    }
}
