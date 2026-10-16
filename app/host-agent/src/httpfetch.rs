//! `http.fetch` 的设备侧实现：后端经 `/api/host` 派来一个 HTTP 请求，这里替它在本机发出。
//!
//! 线上形状与后端 `src/http/host-relay.ts` 的 `HttpFetchArgs` / `HttpFetchResult` 一一对应；
//! 语义见 openspec/changes/device-execution/specs/device-http-fetch/spec.md。每一跳都过三道闸门：
//! 允许主机（`ALLOW_HOSTS` 优先于下发清单）→ 私网地址（不可关闭）→ 10MB 上限。
//! cookie 由后端放进请求头；这里不存任何状态——请求之间没有 cookie jar、没有会话。

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::dns::{Addrs, Name, Resolve, Resolving};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, LOCATION};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::{Host, Url};

use crate::netguard;

/// 与后端 `src/devices/fetch.ts` 的 `MAX_DEVICE_BODY` 同值。量的是解压后的字节——调用方拿到的就是它。
pub const MAX_BODY: usize = 10 * 1024 * 1024;
/// 与 Fetch 规范（undici）同值。
pub const MAX_REDIRECTS: usize = 20;
/// 后端下发固定 30s（`fetch.ts` 的 `DEFAULT_TIMEOUT_MS`）；这里只防一个离谱的值把任务挂住。
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RedirectMode {
    Manual,
    Follow,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FetchArgs {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    pub redirect: RedirectMode,
    pub timeout_ms: u64,
    #[serde(default)]
    pub allow_hosts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct FetchResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// base64
    pub body: String,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FetchError {
    pub code: &'static str,
    pub message: String,
}

impl FetchError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

/// 哪些地址不许连。生产只有一种（[`Guard::strict`]）；放行 loopback 的那档只在 `cfg(test)` 下存在
/// ——测试要连本机的假服务器，而「私网拒绝不可配置」的意思是二进制里根本没有关掉它的路。
#[derive(Debug, Clone, Copy)]
pub struct Guard {
    loopback_ok: bool,
}

impl Guard {
    pub fn strict() -> Self {
        Self { loopback_ok: false }
    }
    #[cfg(test)]
    pub fn loopback_ok() -> Self {
        Self { loopback_ok: true }
    }
    pub fn blocks(&self, ip: IpAddr) -> bool {
        netguard::is_blocked_ip(ip) && !(self.loopback_ok && ip.is_loopback())
    }
}

/// resolver 拒绝时塞进 reqwest 错误链里的那一环；[`classify`] 顺着 `source()` 把它认回来。
#[derive(Debug)]
struct PrivateTarget(String);

impl std::fmt::Display for PrivateTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{} 解析到私网地址", self.0)
    }
}

impl std::error::Error for PrivateTarget {}

/// 解析 DNS，并在**连接之前**检查每一个结果：任一落在私网就整体拒绝（不是挑一个公网的连）。
/// reqwest 只会连这里交回去的地址，所以检查过的就是要连的——DNS rebinding 换不了中间那一下。
struct GuardedResolver {
    guard: Guard,
}

impl Resolve for GuardedResolver {
    fn resolve(&self, name: Name) -> Resolving {
        let guard = self.guard;
        let host = name.as_str().to_string();
        Box::pin(async move {
            let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            if let Some(bad) = addrs.iter().find(|a| guard.blocks(a.ip())) {
                let e: Box<dyn std::error::Error + Send + Sync> = Box::new(PrivateTarget(format!("{host}（{}）", bad.ip())));
                return Err(e);
            }
            let addrs: Addrs = Box::new(addrs.into_iter());
            Ok(addrs)
        })
    }
}

pub struct Fetcher {
    client: reqwest::Client,
    guard: Guard,
    /// `ALLOW_HOSTS`；`None` = 没配，按后端下发的。
    device_allow: Option<Vec<String>>,
}

impl Fetcher {
    pub fn new(guard: Guard, device_allow: Option<Vec<String>>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            .dns_resolver(Arc::new(GuardedResolver { guard }))
            // 重定向我们自己逐跳走：每一跳都要重新过主机清单与私网检查，reqwest 的自动跟随两样都不做。
            .redirect(reqwest::redirect::Policy::none())
            // 见 Cargo.toml 那段：走代理时 resolver 解析的是代理，私网检查被整个绕过。
            .no_proxy()
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Self { client, guard, device_allow })
    }

    /// 一帧请求 → 一帧回复。错误消息以 code 开头：后端 `POST /api/devices/:id/ops` 的 502 只给消息，
    /// 人看那一行就要认得出是哪一类。日志只记方法、主机、结果与耗时（spec「不泄露内容」）。
    pub async fn reply(&self, id: Value, args: &Value) -> Value {
        let a: FetchArgs = match serde_json::from_value(args.clone()) {
            Ok(a) => a,
            Err(e) => return json!({ "id": id, "error": format!("network: http.fetch 参数不对：{e}"), "code": "network" }),
        };
        let host = Url::parse(&a.url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default();
        let method = a.method.to_ascii_uppercase();
        let started = Instant::now();
        let out = self.fetch(a).await;
        let ms = started.elapsed().as_millis();
        match out {
            Ok(r) => {
                eprintln!("[http.fetch] {method} {host} → {} ({ms}ms)", r.status);
                json!({ "id": id, "result": r })
            }
            Err(e) => {
                eprintln!("[http.fetch] {method} {host} → {} ({ms}ms)", e.code);
                json!({ "id": id, "error": format!("{}: {}", e.code, e.message), "code": e.code })
            }
        }
    }

    /// 整个请求（含全部跳转与读 body）一个超时：调用方给的是「这件事最多等多久」，不是每一跳。
    pub async fn fetch(&self, args: FetchArgs) -> Result<FetchResult, FetchError> {
        let ms = args.timeout_ms.clamp(1, MAX_TIMEOUT_MS);
        match tokio::time::timeout(Duration::from_millis(ms), self.run(args)).await {
            Ok(r) => r,
            Err(_) => Err(FetchError::new("timeout", format!("{ms}ms 内没有完成"))),
        }
    }

    async fn run(&self, args: FetchArgs) -> Result<FetchResult, FetchError> {
        let allow = netguard::effective_allow(self.device_allow.as_deref(), &args.allow_hosts).to_vec();
        let mut url = Url::parse(&args.url).map_err(|e| FetchError::new("network", format!("url 不对：{e}")))?;
        let mut method = Method::from_bytes(args.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| FetchError::new("network", format!("方法不对：{}", args.method)))?;
        let mut headers = request_headers(&args.headers)?;
        let mut body = match &args.body {
            None => None,
            Some(b) => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .map_err(|e| FetchError::new("network", format!("body 不是 base64：{e}")))?,
            ),
        };
        let mut hops = 0usize;
        loop {
            self.check_target(&url, &allow)?;
            let mut req = self.client.request(method.clone(), url.clone()).headers(headers.clone());
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            let resp = req.send().await.map_err(classify)?;
            let status = resp.status().as_u16();
            let follow = args.redirect == RedirectMode::Follow && matches!(status, 301 | 302 | 303 | 307 | 308);
            // 没有 Location 的 3xx 按 Fetch 规范原样交回去。
            let location = resp.headers().get(LOCATION).and_then(|v| v.to_str().ok()).map(str::to_string);
            let (true, Some(loc)) = (follow, location) else {
                return read_response(resp).await;
            };
            hops += 1;
            if hops > MAX_REDIRECTS {
                return Err(FetchError::new("network", format!("超过 {MAX_REDIRECTS} 次重定向")));
            }
            let next = url.join(&loc).map_err(|e| FetchError::new("network", format!("重定向地址不对：{e}")))?;
            if (matches!(status, 301 | 302) && method == Method::POST) || (status == 303 && method != Method::GET && method != Method::HEAD) {
                method = Method::GET;
                body = None;
                for h in ["content-type", "content-encoding", "content-language", "content-location"] {
                    headers.remove(h);
                }
            }
            // 后端为原主机放进来的凭据不能跟去另一个源（Review Focus 2）。
            if url.origin() != next.origin() {
                for h in ["authorization", "proxy-authorization", "cookie"] {
                    headers.remove(h);
                }
            }
            url = next;
        }
    }

    /// 每一跳发出之前：协议、主机清单、IP 字面量的私网检查。名字的私网检查在 [`GuardedResolver`]——
    /// reqwest 遇到 IP 字面量不调 resolver，所以字面量只能在这里查。
    fn check_target(&self, url: &Url, allow: &[String]) -> Result<(), FetchError> {
        if url.scheme() != "http" && url.scheme() != "https" {
            return Err(FetchError::new("network", format!("不支持的协议：{}", url.scheme())));
        }
        let host = url.host_str().ok_or_else(|| FetchError::new("network", "url 里没有主机"))?;
        if !netguard::host_allowed(host, allow) {
            return Err(FetchError::new("host-not-allowed", format!("{host} 不在允许的主机里")));
        }
        let literal = match url.host() {
            Some(Host::Ipv4(a)) => Some(IpAddr::V4(a)),
            Some(Host::Ipv6(a)) => Some(IpAddr::V6(a)),
            _ => None,
        };
        if let Some(ip) = literal {
            if self.guard.blocks(ip) {
                return Err(FetchError::new("private-target", format!("{host} 是私网地址")));
            }
        }
        Ok(())
    }
}

/// 后端给的请求头 → reqwest 的。连接层的头由 reqwest 按真实请求算；照抄后端给的（尤其
/// `content-length`、`host`）只会和实际发出去的字节对不上。`accept-encoding` 也交给 reqwest：
/// 它自己声明的编码它一定解得开，调用方声明的（比如 `zstd`）它未必解得开，解不开就会把压缩字节原样交回去。
fn request_headers(pairs: &[(String, String)]) -> Result<HeaderMap, FetchError> {
    const SKIP: &[&str] = &[
        "host", "content-length", "connection", "transfer-encoding", "keep-alive", "upgrade", "proxy-connection", "te", "trailer",
        "accept-encoding",
    ];
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
        let name = HeaderName::from_bytes(k.as_bytes()).map_err(|_| FetchError::new("network", format!("请求头名不对：{k}")))?;
        if SKIP.contains(&name.as_str()) {
            continue;
        }
        let value = HeaderValue::from_str(v).map_err(|_| FetchError::new("network", format!("请求头 {k} 的值不对")))?;
        map.append(name, value);
    }
    Ok(map)
}

async fn read_response(mut resp: reqwest::Response) -> Result<FetchResult, FetchError> {
    let status = resp.status().as_u16();
    let url = resp.url().to_string();
    let headers = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_string(), String::from_utf8_lossy(v.as_bytes()).into_owned()))
        .collect();
    if resp.content_length().is_some_and(|n| n > MAX_BODY as u64) {
        return Err(too_large());
    }
    let mut buf = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(classify)? {
        if buf.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(FetchResult { status, headers, body: base64::engine::general_purpose::STANDARD.encode(&buf), url })
}

fn too_large() -> FetchError {
    FetchError::new("too-large", format!("响应体超过 {MAX_BODY} 字节"))
}

/// reqwest 的错误 → 线上 code。resolver 的拒绝埋在错误链深处（reqwest → hyper-util → 我们的
/// `PrivateTarget`），顺着 `source()` 找；找不到才看是不是超时，其余都是 `network`。
fn classify(e: reqwest::Error) -> FetchError {
    // 先剥掉 URL：reqwest 的 Display 带着完整 URL（含查询串），而这条信息会回到后端的运行记录里，
    // 交易类 URL 的查询串常带 token。错误链里更深的那几层（hyper / IO）不含 URL。
    let e = e.without_url();
    let mut src: Option<&(dyn std::error::Error + 'static)> = Some(&e);
    while let Some(s) = src {
        if let Some(p) = s.downcast_ref::<PrivateTarget>() {
            return FetchError::new("private-target", p.to_string());
        }
        src = s.source();
    }
    if e.is_timeout() {
        return FetchError::new("timeout", e.to_string());
    }
    let mut msg = e.to_string();
    let mut s = std::error::Error::source(&e);
    while let Some(x) = s {
        msg.push_str("：");
        msg.push_str(&x.to_string());
        s = x.source();
    }
    FetchError::new("network", msg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    /// 只会按顺序回放固定响应的 HTTP/1.1 服务器：每个连接读一个请求、写一个响应、关连接。
    /// 记下收到的原始请求（小写），供断言请求行、头与 body。
    struct Canned {
        addr: SocketAddr,
        requests: Arc<Mutex<Vec<String>>>,
        hits: Arc<AtomicUsize>,
    }

    impl Canned {
        fn url(&self, path: &str) -> String {
            format!("http://{}{path}", self.addr)
        }
        fn hits(&self) -> usize {
            self.hits.load(Ordering::SeqCst)
        }
        fn request(&self, i: usize) -> String {
            self.requests.lock().unwrap()[i].clone()
        }
    }

    async fn serve(responses: Vec<Vec<u8>>) -> Canned {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let hits = Arc::new(AtomicUsize::new(0));
        let (rq, h) = (requests.clone(), hits.clone());
        tokio::spawn(async move {
            for resp in responses {
                let Ok((mut s, _)) = l.accept().await else { return };
                h.fetch_add(1, Ordering::SeqCst);
                let req = read_request(&mut s).await;
                rq.lock().unwrap().push(req);
                let _ = s.write_all(&resp).await;
                let _ = s.shutdown().await;
            }
        });
        Canned { addr, requests, hits }
    }

    async fn read_request(s: &mut TcpStream) -> String {
        let mut buf = Vec::new();
        let mut tmp = [0u8; 8192];
        loop {
            let n = s.read(&mut tmp).await.unwrap_or(0);
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&tmp[..n]);
            if let Some(end) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                let head = String::from_utf8_lossy(&buf[..end]).to_lowercase();
                let len = head
                    .lines()
                    .find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0)))
                    .unwrap_or(0);
                while buf.len() < end + 4 + len {
                    let n = s.read(&mut tmp).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    buf.extend_from_slice(&tmp[..n]);
                }
                break;
            }
        }
        String::from_utf8_lossy(&buf).to_lowercase()
    }

    fn resp(status: &str, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
        for (k, v) in headers {
            head.push_str(&format!("{k}: {v}\r\n"));
        }
        head.push_str("\r\n");
        let mut out = head.into_bytes();
        out.extend_from_slice(body);
        out
    }

    fn args(url: &str, allow: &[&str]) -> FetchArgs {
        FetchArgs {
            method: "GET".into(),
            url: url.into(),
            headers: vec![],
            body: None,
            redirect: RedirectMode::Manual,
            timeout_ms: 5_000,
            allow_hosts: allow.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn fetcher() -> Fetcher {
        Fetcher::new(Guard::loopback_ok(), None).unwrap()
    }

    fn b64(b: &[u8]) -> String {
        base64::engine::general_purpose::STANDARD.encode(b)
    }

    fn header<'a>(r: &'a FetchResult, name: &str) -> Vec<&'a str> {
        r.headers.iter().filter(|(k, _)| k == name).map(|(_, v)| v.as_str()).collect()
    }

    #[tokio::test]
    async fn returns_status_multi_value_headers_body_and_final_url() {
        let s = serve(vec![resp("200 OK", &[("Set-Cookie", "a=1"), ("Set-Cookie", "b=2")], b"hello")]).await;
        let r = fetcher().fetch(args(&s.url("/x?q=1"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(header(&r, "set-cookie"), vec!["a=1", "b=2"], "多值头逐个保留、顺序不变");
        assert_eq!(r.body, b64(b"hello"));
        assert_eq!(r.url, s.url("/x?q=1"));
    }

    #[tokio::test]
    async fn sends_method_headers_and_body_but_not_connection_headers() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let mut a = args(&s.url("/submit"), &["127.0.0.1"]);
        a.method = "POST".into();
        a.headers = vec![
            ("Cookie".into(), "sid=abc".into()),
            ("X-Multi".into(), "1".into()),
            ("X-Multi".into(), "2".into()),
            ("Content-Length".into(), "999".into()),
            ("Host".into(), "evil.example".into()),
        ];
        a.body = Some(b64(b"k=v"));
        fetcher().fetch(a).await.unwrap();
        let req = s.request(0);
        assert!(req.starts_with("post /submit http/1.1"), "{req}");
        assert!(req.contains("cookie: sid=abc"));
        assert!(req.contains("x-multi: 1") && req.contains("x-multi: 2"));
        assert!(req.contains("content-length: 3"), "content-length 按真实 body 算：{req}");
        assert!(!req.contains("evil.example"), "host 头不照抄：{req}");
        assert!(req.ends_with("k=v"));
    }

    /// spec「302 原样回传」：东财靠这个判会话失效。
    #[tokio::test]
    async fn manual_mode_returns_the_redirect_untouched() {
        let s = serve(vec![resp("302 Found", &[("Location", "/login")], b"")]).await;
        let r = fetcher().fetch(args(&s.url("/Trade/Buy"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.status, 302);
        assert_eq!(header(&r, "location"), vec!["/login"]);
        assert_eq!(s.hits(), 1, "manual 不跟随");
    }

    #[tokio::test]
    async fn same_origin_redirect_keeps_cookie() {
        let s = serve(vec![resp("302 Found", &[("Location", "/next")], b""), resp("200 OK", &[], b"done")]).await;
        let mut a = args(&s.url("/start"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Cookie".into(), "sid=abc".into())];
        let r = fetcher().fetch(a).await.unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.url, s.url("/next"));
        assert_eq!(r.body, b64(b"done"));
        assert!(s.request(1).starts_with("get /next "));
        assert!(s.request(1).contains("cookie: sid=abc"));
    }

    #[tokio::test]
    async fn cross_origin_redirect_drops_cookie() {
        let b = serve(vec![resp("200 OK", &[], b"")]).await;
        let to_b = format!("http://localhost:{}/landing", b.addr.port());
        let a_srv = serve(vec![resp("302 Found", &[("Location", to_b.as_str())], b"")]).await;
        let mut a = args(&a_srv.url("/start"), &["127.0.0.1", "localhost"]);
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Cookie".into(), "sid=abc".into()), ("Authorization".into(), "Bearer t".into()), ("X-Keep".into(), "1".into())];
        fetcher().fetch(a).await.unwrap();
        let req = b.request(0);
        assert!(!req.contains("cookie:"), "跨源不带 cookie：{req}");
        assert!(!req.contains("authorization:"));
        assert!(req.contains("x-keep: 1"));
    }

    #[tokio::test]
    async fn see_other_turns_post_into_get_without_body() {
        let s = serve(vec![resp("303 See Other", &[("Location", "/done")], b""), resp("200 OK", &[], b"")]).await;
        let mut a = args(&s.url("/form"), &["127.0.0.1"]);
        a.method = "POST".into();
        a.redirect = RedirectMode::Follow;
        a.headers = vec![("Content-Type".into(), "application/x-www-form-urlencoded".into())];
        a.body = Some(b64(b"k=v"));
        fetcher().fetch(a).await.unwrap();
        let second = s.request(1);
        assert!(second.starts_with("get /done "), "{second}");
        assert!(!second.contains("content-type:"));
        assert!(!second.ends_with("k=v"));
    }

    #[tokio::test]
    async fn too_many_redirects_is_a_network_error() {
        let hops: Vec<Vec<u8>> = (0..=MAX_REDIRECTS).map(|_| resp("302 Found", &[("Location", "/again")], b"")).collect();
        let s = serve(hops).await;
        let mut a = args(&s.url("/again"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "network");
    }

    #[tokio::test]
    async fn a_declared_length_over_the_cap_is_too_large() {
        let mut raw = format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", MAX_BODY + 1).into_bytes();
        raw.extend_from_slice(b"x");
        let s = serve(vec![raw]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "too-large");
    }

    #[tokio::test]
    async fn an_undeclared_body_over_the_cap_is_too_large() {
        let mut raw = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        raw.extend(std::iter::repeat(b'x').take(MAX_BODY + 1));
        let s = serve(vec![raw]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "too-large");
    }

    /// Review Focus 3：包代码自己带了 Accept-Encoding，对端回 gzip。
    #[tokio::test]
    async fn gzip_response_is_decoded() {
        let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        enc.write_all("你好".as_bytes()).unwrap();
        let gz = enc.finish().unwrap();
        let s = serve(vec![resp("200 OK", &[("Content-Encoding", "gzip")], &gz)]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1"]);
        a.headers = vec![("Accept-Encoding".into(), "gzip, deflate, br".into())];
        let r = fetcher().fetch(a).await.unwrap();
        assert_eq!(r.body, b64("你好".as_bytes()));
        assert!(header(&r, "content-encoding").is_empty(), "解压后不再声称是 gzip");
    }

    /// 错误信息会写进后端的运行记录：交易类 URL 的查询串里带着 token，不能跟着错误回去。
    #[tokio::test]
    async fn a_network_error_does_not_echo_the_url() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        let e = fetcher().fetch(args(&format!("http://{addr}/trade?secret=XYZ"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "network");
        assert!(!e.message.contains("XYZ") && !e.message.contains("/trade"), "{}", e.message);
    }

    #[tokio::test]
    async fn a_silent_server_times_out() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = l.accept().await {
                held.push(s);
            }
        });
        let mut a = args(&format!("http://{addr}/"), &["127.0.0.1"]);
        a.timeout_ms = 200;
        let started = Instant::now();
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "timeout");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[tokio::test]
    async fn a_host_outside_the_list_is_refused_without_connecting() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let e = fetcher().fetch(args(&s.url("/"), &["example.com"])).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(s.hits(), 0);
    }

    /// spec「设备侧清单优先」，端到端那一半：下发清单放行，设备的 ALLOW_HOSTS 不放行。
    #[tokio::test]
    async fn the_device_allow_list_overrides_the_sent_one() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::loopback_ok(), Some(vec!["eastmoneysec.com".into()])).unwrap();
        let e = f.fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(s.hits(), 0);
    }

    #[tokio::test]
    async fn the_strict_guard_refuses_a_private_ip_literal_even_when_listed() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::strict(), None).unwrap();
        let e = f.fetch(args(&s.url("/"), &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "private-target");
        assert_eq!(s.hits(), 0);
    }

    /// 走 resolver 那条路：名字解析到 loopback，错误要从 reqwest 的错误链里认回成 private-target。
    #[tokio::test]
    async fn the_strict_guard_refuses_a_name_that_resolves_to_a_private_address() {
        let s = serve(vec![resp("200 OK", &[], b"")]).await;
        let f = Fetcher::new(Guard::strict(), None).unwrap();
        let url = format!("http://localhost:{}/", s.addr.port());
        let e = f.fetch(args(&url, &["localhost"])).await.unwrap_err();
        assert_eq!(e.code, "private-target", "{e:?}");
        assert_eq!(s.hits(), 0);
    }

    /// spec「重定向到内网被拦」。
    #[tokio::test]
    async fn a_redirect_into_the_private_network_is_refused_on_that_hop() {
        let s = serve(vec![resp("302 Found", &[("Location", "http://10.0.0.5/")], b"")]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1", "10.0.0.5"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "private-target");
    }

    #[tokio::test]
    async fn a_redirect_to_an_unlisted_host_is_refused_on_that_hop() {
        let b = serve(vec![resp("200 OK", &[], b"")]).await;
        let to_b = format!("http://localhost:{}/", b.addr.port());
        let s = serve(vec![resp("302 Found", &[("Location", to_b.as_str())], b"")]).await;
        let mut a = args(&s.url("/"), &["127.0.0.1"]);
        a.redirect = RedirectMode::Follow;
        let e = fetcher().fetch(a).await.unwrap_err();
        assert_eq!(e.code, "host-not-allowed");
        assert_eq!(b.hits(), 0);
    }

    #[tokio::test]
    async fn only_http_and_https_are_fetched() {
        let e = fetcher().fetch(args("ftp://127.0.0.1/x", &["127.0.0.1"])).await.unwrap_err();
        assert_eq!(e.code, "network");
    }

    /// Review Focus 1：环境里的代理变量不改变设备请求的去向。
    #[tokio::test]
    async fn system_proxy_env_is_ignored() {
        let proxy = serve(vec![resp("200 OK", &[], b"from-proxy")]).await;
        let target = serve(vec![resp("200 OK", &[], b"direct")]).await;
        std::env::set_var("HTTP_PROXY", proxy.url(""));
        std::env::set_var("http_proxy", proxy.url(""));
        let f = fetcher();
        std::env::remove_var("HTTP_PROXY");
        std::env::remove_var("http_proxy");
        let r = f.fetch(args(&target.url("/"), &["127.0.0.1"])).await.unwrap();
        assert_eq!(r.body, b64(b"direct"));
        assert_eq!(proxy.hits(), 0);
    }

    #[tokio::test]
    async fn the_reply_frame_has_the_wire_shape_the_backend_parses() {
        let s = serve(vec![resp("204 No Content", &[], b"")]).await;
        let ok = fetcher()
            .reply(json!(7), &json!({"method":"GET","url": s.url("/"),"headers":[],"redirect":"manual","timeoutMs":5000,"allowHosts":["127.0.0.1"]}))
            .await;
        assert_eq!(ok["id"], 7);
        assert_eq!(ok["result"]["status"], 204);
        assert!(ok["result"]["headers"].is_array());
        assert_eq!(ok["result"]["body"], "");
        assert!(ok.get("error").is_none());

        let refused = fetcher()
            .reply(json!(8), &json!({"method":"GET","url":"http://example.com/","headers":[],"redirect":"manual","timeoutMs":5000,"allowHosts":["example.org"]}))
            .await;
        assert_eq!(refused["id"], 8);
        assert_eq!(refused["code"], "host-not-allowed");
        assert!(refused["error"].as_str().unwrap().starts_with("host-not-allowed: "), "消息里带上 code，直接看 502 也认得出");

        let bad = fetcher().reply(json!(9), &json!({"url": 1})).await;
        assert_eq!(bad["code"], "network");
    }
}
