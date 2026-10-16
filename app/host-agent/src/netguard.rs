//! `http.fetch` 在设备侧的两道闸门：目标主机在不在允许清单里、目标地址是不是私网。
//!
//! 全是纯函数，与 OS 无关——每个地址段都在 Linux 上的 `cargo test` 里钉住。
//! 权威：openspec/changes/device-execution/design.md D6、specs/device-http-fetch/spec.md。

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// 与后端 `src/devices/run-context.ts` 的 `norm` 同一条规则：去空白、小写、去掉一个前导点和一个尾点。
/// 两边规则不一致的后果是「后端放行、设备拒绝」或反过来——同一份声明在两处得出两个答案。
fn norm(s: &str) -> String {
    let lower = s.trim().to_ascii_lowercase();
    let mut t: &str = &lower;
    if let Some(r) = t.strip_prefix('.') {
        t = r;
    }
    if let Some(r) = t.strip_suffix('.') {
        t = r;
    }
    t.to_string()
}

/// 主机名后缀匹配。**不是子串**：`evil-eastmoneysec.com` 不算 `eastmoneysec.com`。
pub fn host_allowed(host: &str, allow: &[String]) -> bool {
    let h = norm(host);
    allow.iter().any(|d| {
        let s = norm(d);
        !s.is_empty() && (h == s || h.ends_with(&format!(".{s}")))
    })
}

/// `ALLOW_HOSTS=a.com,b.com`。去空白、丢空项；一项都不剩就当没配——空清单不能变成「全部拒绝」
/// 这种看起来像配置、其实是手滑的状态。
pub fn parse_allow_hosts(raw: Option<&str>) -> Option<Vec<String>> {
    let list: Vec<String> = raw?
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if list.is_empty() { None } else { Some(list) }
}

/// 设备配了 `ALLOW_HOSTS` 就以它为准，**整个替换**后端下发的清单（D6）：这道闸门是给不信任后端的
/// 运维者用的，和后端清单取并集就等于没有。
pub fn effective_allow<'a>(device: Option<&'a [String]>, sent: &'a [String]) -> &'a [String] {
    device.unwrap_or(sent)
}

/// 这个地址能不能连。D6 列的段（loopback / RFC1918 / 链路本地 / CGNAT / ULA）之外，还拒
/// `0/8`（Linux 上连 0.0.0.0 就是连本机）与组播、保留段（不是一个能发 HTTP 的公网主机）。
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => blocked_v4(v4),
        IpAddr::V6(v6) => blocked_v6(v6),
    }
}

fn blocked_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || a == 127
        || (a == 100 && (b & 0xc0) == 64) // 100.64/10：CGNAT，Tailscale 的地址就在这里
        || (a == 169 && b == 254)
        || (a == 172 && (b & 0xf0) == 16)
        || (a == 192 && b == 168)
        || a >= 224
}

fn blocked_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() {
        return true;
    }
    let s = ip.segments();
    if (s[0] & 0xffc0) == 0xfe80 || (s[0] & 0xffc0) == 0xfec0 {
        return true; // 链路本地；站点本地（已废弃，但仍是内网）
    }
    if (s[0] & 0xfe00) == 0xfc00 || (s[0] & 0xff00) == 0xff00 {
        return true; // ULA；组播
    }
    embedded_v4(&s).is_some_and(blocked_v4)
}

/// IPv6 外壳里的 IPv4。不拆开判，`::ffff:10.0.0.5` 这种写法就能把内网地址带过 v6 那几条规则。
fn embedded_v4(s: &[u16; 8]) -> Option<Ipv4Addr> {
    let v4 = |hi: u16, lo: u16| Ipv4Addr::new((hi >> 8) as u8, hi as u8, (lo >> 8) as u8, lo as u8);
    // ::ffff:a.b.c.d（映射）与 ::a.b.c.d（兼容，已废弃）
    if s[..5].iter().all(|&x| x == 0) && (s[5] == 0xffff || s[5] == 0) {
        return Some(v4(s[6], s[7]));
    }
    // 64:ff9b::a.b.c.d（NAT64 公认前缀：网关会替你连到那个 v4）
    if s[0] == 0x64 && s[1] == 0xff9b && s[2..6].iter().all(|&x| x == 0) {
        return Some(v4(s[6], s[7]));
    }
    // 2002:AABB:CCDD::/48（6to4）
    if s[0] == 0x2002 {
        return Some(v4(s[1], s[2]));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn list(xs: &[&str]) -> Vec<String> {
        xs.iter().map(|s| s.to_string()).collect()
    }
    fn ip(s: &str) -> IpAddr {
        s.parse().unwrap()
    }

    #[test]
    fn suffix_matches_the_domain_and_its_subdomains_only() {
        let allow = list(&["eastmoneysec.com"]);
        assert!(host_allowed("eastmoneysec.com", &allow));
        assert!(host_allowed("jywg.eastmoneysec.com", &allow));
        assert!(host_allowed("JYWG.EastMoneySec.com.", &allow), "大小写与尾点不影响");
        // 后缀伪装：不是子串匹配。
        assert!(!host_allowed("evil-eastmoneysec.com", &allow));
        assert!(!host_allowed("eastmoneysec.com.evil.io", &allow));
        assert!(!host_allowed("push2.eastmoney.com", &allow));
    }

    #[test]
    fn entries_are_normalised_like_the_backend_and_empty_ones_match_nothing() {
        assert!(host_allowed("a.example.com", &list(&[" .Example.COM. "])));
        assert!(!host_allowed("example.com", &list(&["", "  ", "."])));
        assert!(!host_allowed("example.com", &[]));
        assert!(host_allowed("10.0.0.5", &list(&["10.0.0.5"])), "IP 字面量按相等匹配");
    }

    #[test]
    fn allow_hosts_env_is_parsed_and_blank_means_unset() {
        assert_eq!(parse_allow_hosts(None), None);
        assert_eq!(parse_allow_hosts(Some("")), None);
        assert_eq!(parse_allow_hosts(Some(" , ,")), None);
        assert_eq!(parse_allow_hosts(Some("eastmoneysec.com, eastmoney.com ")), Some(list(&["eastmoneysec.com", "eastmoney.com"])));
    }

    /// spec「设备侧清单优先」：设备配了 ALLOW_HOSTS，下发的清单再宽也不算数。
    #[test]
    fn the_device_list_replaces_the_sent_one() {
        let device = list(&["eastmoneysec.com"]);
        let sent = list(&["eastmoneysec.com", "eastmoney.com"]);
        let allow = effective_allow(Some(&device), &sent);
        assert!(!host_allowed("push2.eastmoney.com", allow));
        assert!(host_allowed("push2.eastmoney.com", effective_allow(None, &sent)));
    }

    #[test]
    fn private_and_special_ipv4_ranges_are_blocked() {
        for s in [
            "0.0.0.0", "0.1.2.3", "10.0.0.5", "10.255.255.255", "127.0.0.1", "127.8.8.8",
            "100.64.0.1", "100.127.255.255", "169.254.169.254", "172.16.0.1", "172.31.255.255",
            "192.168.1.1", "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
        ] {
            assert!(is_blocked_ip(ip(s)), "{s} 应被拒");
        }
    }

    #[test]
    fn public_ipv4_neighbours_of_the_blocked_ranges_are_allowed() {
        for s in ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.169.0.1", "169.255.0.1", "223.255.255.255"] {
            assert!(!is_blocked_ip(ip(s)), "{s} 是公网地址");
        }
    }

    #[test]
    fn private_and_special_ipv6_ranges_are_blocked() {
        for s in ["::", "::1", "fe80::1", "febf::1", "fec0::1", "fc00::1", "fd12:3456::1", "ff02::1"] {
            assert!(is_blocked_ip(ip(s)), "{s} 应被拒");
        }
    }

    /// 借 IPv6 外壳套一个内网 v4：映射、兼容、NAT64、6to4 都要按里面的 v4 再判一次。
    #[test]
    fn ipv6_forms_embedding_a_private_ipv4_are_blocked() {
        for s in ["::ffff:10.0.0.5", "::ffff:127.0.0.1", "::10.0.0.5", "64:ff9b::a00:5", "64:ff9b::c0a8:101", "2002:c0a8:101::1", "2002:7f00:1::"] {
            assert!(is_blocked_ip(ip(s)), "{s} 内嵌的是私网 v4");
        }
        for s in ["::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1", "2606:4700::1111", "2400:3200::1"] {
            assert!(!is_blocked_ip(ip(s)), "{s} 是公网地址");
        }
    }
}
