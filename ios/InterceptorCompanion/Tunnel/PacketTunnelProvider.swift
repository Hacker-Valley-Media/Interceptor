//
//  PacketTunnelProvider.swift — InterceptorCompanion's own loopback reflector.
//
//  Based on StosVPN by SideStore (https://github.com/SideStore/StosVPN,
//  TunnelProv/PacketTunnelProvider.swift, created by Stossy11). Modified by
//  Interceptor: renamed members, stopTunnel override, comments. Used under the
//  StosVPN License, reproduced below and in ../THIRD_PARTY_NOTICES.md.
//
//    StosVPN License
//
//    Copyright (c) 2025 SideStore Team
//
//    Permission is hereby granted, free of charge, to any person obtaining a copy
//    of this software and associated documentation files (the "Software"), to deal
//    in the Software without restriction, including without limitation the rights
//    to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
//    copies of the Software, and to permit persons to whom the Software is
//    furnished to do so, subject to the following conditions:
//
//    The above copyright notice and this permission notice shall be included in all
//    copies or substantial portions of the Software.
//
//    **Attribution is clearly given** to the original project and author(s) in a
//    prominent place (e.g., README, About page, or documentation).
//
//    Any derived project **must clearly state** that it is **based on** or **uses
//    code from** the original project.
//
//    Redistribution, rebranding, or publishing of the **entire project** (or a
//    substantially similar copy) under the same or similar name or branding,
//    **without explicit written permission**, is **prohibited**.
//
//    This clause is intended to prevent unauthorized re-uploads, clones, or
//    misrepresentation of the original work.
//
//    THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
//    IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
//    FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
//    AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
//    LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
//    OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
//    SOFTWARE.
//
//  What it does: a packet-tunnel Network Extension that makes this device's own
//  remoted reachable to an in-app client at 10.7.0.1, so the DDI mount can talk
//  to it without a Mac.
//
//  Apple documents routing a packet tunnel to loopback
//  (NetworkExtension/routing-your-vpn-network-traffic.md:
//  `NEPacketTunnelNetworkSettings(tunnelRemoteAddress: "127.0.0.1")`). The tunnel
//  interface is assigned 10.7.0.0/24 and only that subnet is routed through it;
//  the default route is excluded so no real traffic is captured. For every IPv4
//  packet the reflector swaps the device address (10.7.0.0) and the fake address
//  (10.7.0.1), which loops a connection to 10.7.0.1 back to the device's own
//  services listening on the tunnel interface. Needs the paid-account
//  com.apple.developer.networking.networkextension entitlement (Packet Tunnel).
//
//  Runs over any transport, including cellular — a virtual interface does not
//  depend on Wi-Fi (NEPacketTunnelProvider, iOS 9+).
//

import NetworkExtension

class PacketTunnelProvider: NEPacketTunnelProvider {
    private var tunnelDeviceIp = "10.7.0.0"
    private var tunnelFakeIp = "10.7.0.1"
    private var tunnelSubnetMask = "255.255.255.0"
    private var deviceIpValue: UInt32 = 0
    private var fakeIpValue: UInt32 = 0

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        if let v = options?["TunnelDeviceIP"] as? String { tunnelDeviceIp = v }
        if let v = options?["TunnelFakeIP"] as? String { tunnelFakeIp = v }
        deviceIpValue = ipToUInt32(tunnelDeviceIp)
        fakeIpValue = ipToUInt32(tunnelFakeIp)

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: tunnelDeviceIp)
        let ipv4 = NEIPv4Settings(addresses: [tunnelDeviceIp], subnetMasks: [tunnelSubnetMask])
        ipv4.includedRoutes = [NEIPv4Route(destinationAddress: tunnelDeviceIp, subnetMask: tunnelSubnetMask)]
        ipv4.excludedRoutes = [.default()]
        settings.ipv4Settings = ipv4

        setTunnelNetworkSettings(settings) { error in
            if let error { completionHandler(error); return }
            self.reflect()
            completionHandler(nil)
        }
    }

    private func reflect() {
        packetFlow.readPackets { [self] packets, protocols in
            let fake = fakeIpValue, device = deviceIpValue
            var modified = packets
            for i in modified.indices where protocols[i].int32Value == AF_INET && modified[i].count >= 20 {
                modified[i].withUnsafeMutableBytes { bytes in
                    guard let ptr = bytes.baseAddress?.assumingMemoryBound(to: UInt32.self) else { return }
                    let src = UInt32(bigEndian: ptr[3])
                    let dst = UInt32(bigEndian: ptr[4])
                    if src == device { ptr[3] = fake.bigEndian }
                    if dst == fake { ptr[4] = device.bigEndian }
                }
            }
            packetFlow.writePackets(modified, withProtocols: protocols)
            reflect()
        }
    }

    private func ipToUInt32(_ s: String) -> UInt32 {
        let c = s.split(separator: ".")
        guard c.count == 4, let b1 = UInt32(c[0]), let b2 = UInt32(c[1]), let b3 = UInt32(c[2]), let b4 = UInt32(c[3]) else { return 0 }
        return (b1 << 24) | (b2 << 16) | (b3 << 8) | b4
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }
}
