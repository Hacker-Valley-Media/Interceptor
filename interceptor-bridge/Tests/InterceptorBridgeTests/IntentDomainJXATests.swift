import XCTest
@testable import interceptor_bridge

final class IntentDomainJXATests: XCTestCase {
    private let domain = IntentDomain()

    private func runCommand(_ command: String, action: [String: Any]) -> [String: Any] {
        let holder = TestResultHolder()
        let exp = expectation(description: "intent \(command)")
        domain.handle(command, action: action) { resp in
            holder.set(resp)
            exp.fulfill()
        }
        wait(for: [exp], timeout: 5.0)
        return holder.value
    }

    private func runDispatch(_ action: [String: Any]) -> [String: Any] {
        runCommand("dispatch", action: action)
    }

    func testPureJXAReturnsNumber() {
        let response = runDispatch(["jxa": "1 + 1"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        guard let result = data?["result"] else {
            XCTFail("missing JXA result")
            return
        }
        XCTAssertEqual(String(describing: result), "2")
        XCTAssertEqual(data?["raw"] as? String, "2")
        XCTAssertEqual(data?["language"] as? String, "JavaScript")
    }

    func testScriptRunAliasReturnsNumber() {
        let response = runCommand("run", action: ["jxa": "1 + 1"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(String(describing: data?["result"] ?? ""), "2")
    }

    func testDeprecatedJavascriptKeyStillRunsJXA() {
        let response = runCommand("run", action: ["javascript": "1 + 1"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(String(describing: data?["result"] ?? ""), "2")
    }

    func testScriptRunPassesArgumentsToRunHandler() {
        let response = runCommand("run", action: [
            "jxa": "run = argv => argv.join('|')",
            "args": ["alpha", "beta", "gamma"]
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? String, "alpha|beta|gamma")
        XCTAssertEqual(data?["arguments"] as? [String], ["alpha", "beta", "gamma"])
    }

    func testPureJXAReturnsBoolean() {
        let response = runDispatch(["jxa": "true"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? Bool, true)
        XCTAssertEqual(data?["raw"] as? String, "true")
    }

    func testPureJXAReturnsListWithBoolean() {
        let response = runDispatch(["jxa": "[1, \"two\", true]"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        let result = data?["result"] as? [Any]
        XCTAssertEqual(result?[0] as? Int32, 1)
        XCTAssertEqual(result?[1] as? String, "two")
        XCTAssertEqual(result?[2] as? Bool, true)
    }

    func testPureJXAReturnsRecord() {
        let response = runDispatch(["jxa": "({foo: \"bar\", n: 7})"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        let result = data?["result"] as? [String: Any]
        XCTAssertEqual(result?["foo"] as? String, "bar")
        XCTAssertEqual(result?["n"] as? Int32, 7)
    }

    func testOSAEmptyContainersSurviveEveryExecutionRoute() throws {
        let nested = "({empty: [], record: {}, nested: [[], {}]})"
        let cases: [([String: Any], String)] = [
            (["script": "return {}"], "[]"),
            (["script": "return {} as record"], "[]"),
            (["script": "return {empty:{}, nested:{{}, {marker:true}}}"],
             "{\"empty\":[],\"nested\":[[],{\"marker\":true}]}"),
            (["jxa": "[]"], "[]"),
            (["jxa": "({})"], "{}"),
            (["jxa": nested], "{\"empty\":[],\"nested\":[[],{}],\"record\":{}}"),
            (["jsc": "host.jxa('[]').result", "jscHost": "osa"], "[]"),
            (["jsc": "host.jxa('({})').result", "jscHost": "osa"], "{}"),
            (["jsc": "host.jxa('\(nested)').result", "jscHost": "osa"],
             "{\"empty\":[],\"nested\":[[],{}],\"record\":{}}")
        ]
        for (action, expected) in cases {
            let response = runDispatch(action)
            XCTAssertEqual(response["success"] as? Bool, true, "\(action): \(response)")
            let data = try XCTUnwrap(response["data"] as? [String: Any])
            let result = try XCTUnwrap(data["result"])
            let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            XCTAssertEqual(String(data: bytes, encoding: .utf8), expected, "\(action)")
        }
    }

    func testBundleJXAPrependsTargetBindingWithoutActivating() {
        let response = runDispatch([
            "bundleId": "com.apple.finder",
            "jxa": "typeof target"
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["targetBundleId"] as? String, "com.apple.finder")
        let script = data?["script"] as? String ?? ""
        XCTAssertTrue(script.contains("const target = Application(\"com.apple.finder\");"))
        XCTAssertFalse(script.contains("activate()"))
    }

    func testJXACompileErrorsAreStructured() {
        let response = runDispatch(["jxa": "function {"])
        XCTAssertEqual(response["success"] as? Bool, false)
        let error = response["error"] as? String ?? ""
        XCTAssertTrue(error.contains("osa_script JXA compile failed"))
        XCTAssertTrue(error.contains("--- script ---"))
    }

    func testJSCReturnsNumber() {
        let response = runDispatch(["jsc": "1 + 1"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? Int, 2)
        XCTAssertEqual(data?["raw"] as? String, "2")
        XCTAssertEqual(data?["language"] as? String, "JavaScriptCore")
    }

    func testJSCReturnsObject() {
        let response = runDispatch(["jsc": "({foo: \"bar\", n: 7, ok: true, arr: [1, 2]})"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        let result = data?["result"] as? [String: Any]
        XCTAssertEqual(result?["foo"] as? String, "bar")
        XCTAssertEqual(result?["n"] as? Int, 7)
        XCTAssertEqual(result?["ok"] as? Bool, true)
        let arr = result?["arr"] as? [Any]
        XCTAssertEqual(arr?[0] as? Int, 1)
        XCTAssertEqual(arr?[1] as? Int, 2)
    }

    func testJSCPassesArgumentsToRunHandler() {
        let response = runDispatch([
            "jsc": "run = argv => argv.join('|')",
            "args": ["alpha", "beta", "gamma"]
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? String, "alpha|beta|gamma")
        XCTAssertEqual(data?["arguments"] as? [String], ["alpha", "beta", "gamma"])
    }

    func testJSCRejectsBundleTargeting() {
        let response = runDispatch([
            "bundleId": "com.apple.finder",
            "jsc": "1 + 1"
        ])
        XCTAssertEqual(response["success"] as? Bool, false)
        let error = response["error"] as? String ?? ""
        XCTAssertTrue(error.contains("JavaScriptCore runs inside interceptor-bridge"))
        XCTAssertTrue(error.contains("Application(...)"))
    }

    func testJSCExceptionsAreStructured() {
        let response = runDispatch(["jsc": "throw new Error('boom')"])
        XCTAssertEqual(response["success"] as? Bool, false)
        let error = response["error"] as? String ?? ""
        XCTAssertTrue(error.contains("jsc failed"))
        XCTAssertTrue(error.contains("boom"))
        XCTAssertTrue(error.contains("--- script ---"))
    }

    func testJSCHostIsNotExposedByDefault() {
        let response = runDispatch(["jsc": "typeof host"])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? String, "undefined")
    }

    func testJSCHostRejectsUnknownCapability() {
        let response = runDispatch([
            "jsc": "typeof host",
            "jscHost": "sqlite,typo"
        ])
        XCTAssertEqual(response["success"] as? Bool, false)
        let error = response["error"] as? String ?? ""
        XCTAssertTrue(error.contains("unknown --jsc-host capability"))
        XCTAssertTrue(error.contains("typo"))
    }

    func testJSCHostExposesFilesystemWhenEnabled() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("interceptor-jsc-host-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("sample.txt")
        try "hello host".write(to: file, atomically: true, encoding: .utf8)

        let response = runDispatch([
            "jsc": "({exists: host.exists(argv[0]), text: host.readText(argv[0]), stat: host.stat(argv[0]).size})",
            "args": [file.path],
            "jscHost": "fs"
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        let result = data?["result"] as? [String: Any]
        XCTAssertEqual(result?["exists"] as? Bool, true)
        XCTAssertEqual(result?["text"] as? String, "hello host")
        XCTAssertEqual(result?["stat"] as? Int, 10)
    }

    func testJSCHostExposesShellWhenEnabled() {
        let response = runDispatch([
            "jsc": "host.shell('/bin/echo', ['hello']).stdout.trim()",
            "jscHost": "shell"
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(data?["result"] as? String, "hello")
    }

    func testJSCHostExposesSQLiteWhenEnabled() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("interceptor-jsc-sqlite-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let db = dir.appendingPathComponent("sample.db")
        let create = Process()
        create.executableURL = URL(fileURLWithPath: "/usr/bin/sqlite3")
        create.arguments = [
            db.path,
            "create table item(name text, n integer); insert into item values ('alpha', 1), ('beta', 2);"
        ]
        try create.run()
        create.waitUntilExit()
        XCTAssertEqual(create.terminationStatus, 0)

        let response = runDispatch([
            "jsc": "host.sqlite(argv[0], 'select name,n from item order by n')",
            "args": [db.path],
            "jscHost": "sqlite"
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        let result = data?["result"] as? [[String: Any]]
        XCTAssertEqual(result?.count, 2)
        XCTAssertEqual(result?.first?["name"] as? String, "alpha")
        XCTAssertEqual(result?.first?["n"] as? Int, 1)
    }

    func testJSCHostExposesJXAHelperWhenEnabled() {
        let response = runDispatch([
            "jsc": "host.jxa('1 + 1').result",
            "jscHost": "osa"
        ])
        XCTAssertEqual(response["success"] as? Bool, true)
        let data = response["data"] as? [String: Any]
        XCTAssertEqual(String(describing: data?["result"] ?? ""), "2")
    }
}
