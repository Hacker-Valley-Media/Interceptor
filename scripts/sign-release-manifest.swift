import Foundation
import Security
import CryptoKit

// Sign public release manifests with an existing keychain identity selected by
// exact certificate fingerprint. No private key material leaves the keychain.
func checked(_ status: OSStatus, _ operation: String) throws {
    if status != errSecSuccess { throw NSError(domain: operation, code: Int(status)) }
}
do {
    let arguments=Array(CommandLine.arguments.dropFirst())
    guard arguments.count == 3 || arguments.count == 4 && arguments[3] == "--inspect",
          arguments[2].range(of: "^[0-9A-Fa-f]{40}$", options: .regularExpression) != nil else {
        throw NSError(domain:"usage: sign-release-manifest input output certificateSHA1 [--inspect]",code:1)
    }
    var result: CFTypeRef?
    try checked(SecItemCopyMatching([
        kSecClass:kSecClassIdentity,kSecMatchLimit:kSecMatchLimitAll,kSecReturnRef:true
    ] as CFDictionary,&result),"query existing signing identities")
    let identities=result as? [SecIdentity] ?? []
    var matches:[(SecIdentity,SecCertificate,Data)]=[]
    for identity in identities {
        var certificate: SecCertificate?
        try checked(SecIdentityCopyCertificate(identity,&certificate),"copy public certificate")
        guard let certificate else {continue}
        let data=SecCertificateCopyData(certificate) as Data
        let hash=Insecure.SHA1.hash(data:data).map{String(format:"%02X",$0)}.joined()
        if hash == arguments[2].uppercased(){matches.append((identity,certificate,data))}
    }
    guard matches.count == 1 else {throw NSError(domain:"expected exactly one matching existing identity",code:matches.count)}
    let (identity,certificate,der)=matches[0]
    let metadata:[String:Any]=["certificateSHA1":arguments[2].uppercased(),"subject":SecCertificateCopySubjectSummary(certificate) as String? ?? "", "certificateSHA256":SHA256.hash(data:der).map{String(format:"%02x",$0)}.joined(),"digest":"sha256","detached":true]
    if arguments.count == 3 {
        let input=try Data(contentsOf:URL(fileURLWithPath:arguments[0]))
        guard !input.isEmpty && input.count <= 1_048_576 else {throw NSError(domain:"manifest requires 1 through 1048576 bytes",code:1)}
        var encoder: CMSEncoder?
        try checked(CMSEncoderCreate(&encoder),"create CMS encoder")
        guard let encoder else {throw NSError(domain:"CMS encoder absent",code:1)}
        try checked(CMSEncoderSetSignerAlgorithm(encoder,kCMSEncoderDigestAlgorithmSHA256),"select SHA256")
        try checked(CMSEncoderAddSigners(encoder,identity),"select exact existing signer")
        try checked(CMSEncoderSetHasDetachedContent(encoder,true),"select detached content")
        try checked(input.withUnsafeBytes{CMSEncoderUpdateContent(encoder,$0.baseAddress!,input.count)},"encode manifest")
        var encoded: CFData?
        try checked(CMSEncoderCopyEncodedContent(encoder,&encoded),"sign manifest")
        guard let encoded else {throw NSError(domain:"CMS output absent",code:1)}
        try (encoded as Data).write(to:URL(fileURLWithPath:arguments[1]),options:.atomic)
    }
    print(String(data:try JSONSerialization.data(withJSONObject:metadata,options:.sortedKeys),encoding:.utf8)!)
} catch { fputs("release manifest signing failed: \(error)\n",stderr);exit(1) }
