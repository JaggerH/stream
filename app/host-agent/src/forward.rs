//! `http.forward` / `ws.forward` 的设备侧执行者（openspec `device-loopback-forward`）。
//!
//! 方向与 `http.fetch`（出站代发，目标任意主机、私网拒绝）相反：这里是**入站转发**——把主实例
//! 经设备连接派来的请求送到**这台设备自己回环地址**上的端口，再把响应/数据送回去。设备不开任何
//! 入站端口。设备侧只有两道闸门：
//!
//! 1. **端口必须在 hello 声明过的清单里**（`forward-ports.json`；主实例侧还会先查一遍，这里是
//!    第二道）。清单里没有的端口以 `port-not-declared` 拒绝，一帧都不发。
//! 2. **目标只能是 127.0.0.1**——URL 由端口和路径拼出来，目标地址是构造出来的回环 IP 字面量，
//!    没有 DNS、没有别的主机可去。
//!
//! `http.forward` 一帧请求一帧回复（wire 形状与 `http.fetch` 的 result 相同）；
//! `ws.forward` 建连后双向数据走主动帧 `{type:'fwd-data', id, b64}` / `{type:'fwd-close', id}`
//! （与 `state`/`abort` 主动帧同一先例）。`cred` 由主实例放进请求头（`x-stream-fwd-cred`），
//! 设备侧不解释它——凭证的校验、过期、范围都在主实例。

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// 请求/响应体上限，与后端 `src/http/device-forward.ts` 同值（后端先量，这里是第二道）。
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// ws 双向单帧上限，与后端 `MAX_FORWARD_FRAME` 同值。超帧即断会话。
pub const MAX_FRAME: usize = 1024 * 1024;
/// 单个请求的时长上界，防一个离谱的值把任务挂住（后端下发 30s）。
const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpForwardArgs {
    pub port: u16,
    pub cred: String,
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HttpForwardResult {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    /// base64（STANDARD，与 `http.fetch` 的 body 同一编码）
    pub body: String,
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WsForwardArgs {
    pub port: u16,
    pub cred: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

/// 后端 → 设备方向的 ws 转发帧（主实例会话循环路由进来的）。
#[derive(Debug, Clone)]
pub enum FwdFrame {
    /// base64
    Data(String),
    Close,
}

/// forward-ports.json 的一行形状（`device.rs::declared_ports` 读出来塞进 hello；执行者只认这份）。
#[derive(Debug, Clone, Default)]
pub struct ForwardPorts(pub Vec<u16>);

pub struct Forwarder {
    client: reqwest::Client,
    ports: Arc<Vec<u16>>,
}

fn port_error(port: u16) -> String {
    format!("port-not-declared: 端口 {port} 不在这台设备声明的可转发清单里")
}

impl Forwarder {
    pub fn new(ports: Vec<u16>) -> Result<Self, String> {
        let client = reqwest::Client::builder()
            // 3xx 原样回传：转发是透明的管道，跟随重定向是构件后端自己的事。
            .redirect(reqwest::redirect::Policy::none())
            // 目标永远是 127.0.0.1 字面量，代理只会把请求送去别处。
            .no_proxy()
            .build()
            .map_err(|e| format!("http client: {e}"))?;
        Ok(Self { client, ports: Arc::new(ports) })
    }

    fn check_port(&self, port: u16) -> Result<(), String> {
        if self.ports.contains(&port) { Ok(()) } else { Err(port_error(port)) }
    }

    /// `http.forward` 一帧请求 → 一帧回复（与 `httpfetch::Fetcher::reply` 同一帧形）。
    /// 日志只记方法、端口、结果与耗时——不记路径与头（凭证头不能进日志）。
    pub async fn reply_http(&self, id: Value, args: &Value) -> Value {
        let a: HttpForwardArgs = match serde_json::from_value(args.clone()) {
            Ok(a) => a,
            Err(e) => return json!({ "id": id, "error": format!("network: http.forward 参数不对：{e}"), "code": "network" }),
        };
        let port = a.port;
        let method = a.method.to_ascii_uppercase();
        let started = std::time::Instant::now();
        let out = self.http(a).await;
        let ms = started.elapsed().as_millis();
        match out {
            Ok(r) => {
                eprintln!("[http.forward] {method} 127.0.0.1:{port} → {} ({ms}ms)", r.status);
                json!({ "id": id, "result": r })
            }
            Err((code, message)) => {
                eprintln!("[http.forward] {method} 127.0.0.1:{port} → {code} ({ms}ms)");
                json!({ "id": id, "error": format!("{code}: {message}"), "code": code })
            }
        }
    }

    async fn http(&self, a: HttpForwardArgs) -> Result<HttpForwardResult, (&'static str, String)> {
        self.check_port(a.port).map_err(|m| ("port-not-declared", m))?;
        let url = reqwest::Url::parse(&format!("http://127.0.0.1:{}{}", a.port, a.path))
            .map_err(|e| ("network", format!("path 不对：{e}")))?;
        let method = reqwest::Method::from_bytes(a.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| ("network", format!("方法不对：{}", a.method)))?;
        let body = match &a.body {
            None => None,
            Some(b) => Some(
                base64::engine::general_purpose::STANDARD
                    .decode(b)
                    .map_err(|e| ("network", format!("body 不是 base64：{e}")))?,
            ),
        };
        let ms = a.timeout_ms.clamp(1, MAX_TIMEOUT_MS);
        let run = async {
            let mut req = self.client.request(method, url).header("x-stream-fwd-cred", &a.cred);
            for (k, v) in &a.headers {
                // 逐跳与身份头不该由后端下发（下发侧已剥）；这里再兜一道。
                let lk = k.to_ascii_lowercase();
                if lk == "host" || lk == "content-length" || lk == "connection" || lk == "cookie" || lk == "authorization" || lk.starts_with("proxy-") {
                    continue;
                }
                req = req.header(k.as_str(), v.as_str());
            }
            if let Some(b) = &body {
                req = req.body(b.clone());
            }
            let resp = req.send().await.map_err(|e| ("connect-failed", e.to_string()))?;
            let status = resp.status().as_u16();
            let mut headers: Vec<(String, String)> = Vec::new();
            for name in resp.headers().keys() {
                for v in resp.headers().get_all(name) {
                    if let Ok(s) = v.to_str() {
                        headers.push((name.as_str().to_string(), s.to_string()));
                    }
                }
            }
            let bytes = resp.bytes().await.map_err(|e| ("connect-failed", e.to_string()))?;
            if bytes.len() > MAX_BODY {
                return Err(("too-large", format!("响应体超过 {MAX_BODY} 字节")));
            }
            Ok(HttpForwardResult {
                status,
                headers,
                body: base64::engine::general_purpose::STANDARD.encode(&bytes),
                url: a.path.clone(),
            })
        };
        match tokio::time::timeout(Duration::from_millis(ms), run).await {
            Ok(r) => r,
            Err(_) => Err(("timeout", format!("{ms}ms 内没有完成"))),
        }
    }

    /// `ws.forward`：连到 `ws://127.0.0.1:port{path}`，连上即返回一个收件通道（后端 → 设备方向
    /// 的帧往里塞）；泵任务把两个方向搬运到 `out`（会话循环唯一的 socket 写端）。断开时泵自己
    /// 发一帧 `{type:'fwd-close', id}`。回执帧（建连成功/失败）由调用方发——open_ws 只负责建连。
    pub async fn open_ws(
        &self,
        id: u64,
        args: WsForwardArgs,
        out: mpsc::UnboundedSender<String>,
    ) -> Result<mpsc::UnboundedSender<FwdFrame>, String> {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        self.check_port(args.port)?;
        let mut req = format!("ws://127.0.0.1:{}{}", args.port, args.path)
            .into_client_request()
            .map_err(|e| format!("path 不对：{e}"))?;
        for (k, v) in &args.headers {
            let lk = k.to_ascii_lowercase();
            if lk == "host" || lk == "connection" || lk == "upgrade" || lk == "sec-websocket-key" || lk == "sec-websocket-version" || lk == "cookie" || lk == "authorization" || lk.starts_with("proxy-") {
                continue;
            }
            if let (Ok(name), Ok(val)) = (
                k.parse::<tokio_tungstenite::tungstenite::http::HeaderName>(),
                v.parse::<tokio_tungstenite::tungstenite::http::HeaderValue>(),
            ) {
                req.headers_mut().insert(name, val);
            }
        }
        if let Ok(val) = args.cred.parse() {
            req.headers_mut().insert("x-stream-fwd-cred", val);
        }
        let (ws, _resp) = tokio_tungstenite::connect_async(req)
            .await
            .map_err(|e| format!("connect-failed: {e}"))?;

        let (tx, mut rx) = mpsc::unbounded_channel::<FwdFrame>();
        tokio::spawn(async move {
            let (mut sink, mut stream) = ws.split();
            let mut closed_by_backend = false;
            loop {
                tokio::select! {
                    incoming = stream.next() => match incoming {
                        Some(Ok(Message::Binary(b))) => {
                            if b.len() > MAX_FRAME { break }
                            let frame = json!({ "type": "fwd-data", "id": id, "b64": base64::engine::general_purpose::STANDARD.encode(&b) });
                            if out.send(frame.to_string()).is_err() { break }
                        }
                        Some(Ok(Message::Text(t))) => {
                            if t.len() > MAX_FRAME { break }
                            let frame = json!({ "type": "fwd-data", "id": id, "b64": base64::engine::general_purpose::STANDARD.encode(t.as_bytes()) });
                            if out.send(frame.to_string()).is_err() { break }
                        }
                        Some(Ok(Message::Ping(_) | Message::Pong(_))) => { /* tungstenite 自动应答 ping */ }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    },
                    f = rx.recv() => match f {
                        Some(FwdFrame::Data(b64)) => {
                            let bytes = match base64::engine::general_purpose::STANDARD.decode(&b64) {
                                Ok(b) => b,
                                Err(_) => break,
                            };
                            if bytes.len() > MAX_FRAME || sink.send(Message::Binary(bytes)).await.is_err() { break }
                        }
                        Some(FwdFrame::Close) | None => {
                            closed_by_backend = true;
                            let _ = sink.send(Message::Close(None)).await;
                            break
                        }
                    },
                }
            }
            // 后端先关的那一侧不用再回帧（它知道）；设备侧先断才需要一帧告诉后端。
            if !closed_by_backend {
                let _ = out.send(json!({ "type": "fwd-close", "id": id }).to_string());
            }
        });
        Ok(tx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forwarder(ports: Vec<u16>) -> Forwarder {
        Forwarder::new(ports).unwrap()
    }

    #[test]
    fn undeclared_ports_are_refused_before_any_connection() {
        let f = forwarder(vec![8765]);
        let err = f.check_port(9999).unwrap_err();
        assert!(err.contains("port-not-declared"), "{err}");
        assert!(f.check_port(8765).is_ok());
    }

    /// http.forward 的参数不对要报 `network`（与 http.fetch 的分类一致），不是 panic。
    #[tokio::test]
    async fn malformed_args_are_a_network_error_not_a_panic() {
        let f = forwarder(vec![]);
        let out = f.reply_http(json!(7), &json!({ "port": "8765" })).await;
        assert!(out["error"].as_str().unwrap().contains("参数不对"), "{out}");
    }

    /// 声明了端口、回环上有服务：完整往返。
    #[tokio::test]
    async fn http_forward_round_trips_to_loopback() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = tokio::spawn(async move {
            let (mut s, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 4096];
            let n = s.read(&mut buf).await.unwrap();
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            assert!(req.contains("x-stream-fwd-cred: test-cred"), "{req}");
            assert!(req.contains("GET /status"), "{req}");
            s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok").await.unwrap();
        });
        let f = forwarder(vec![port]);
        let out = f
            .reply_http(
                json!(1),
                &json!({ "port": port, "cred": "test-cred", "method": "GET", "path": "/status", "headers": [], "timeoutMs": 5000 }),
            )
            .await;
        server.await.unwrap();
        assert_eq!(out["result"]["status"], json!(200), "{out}");
        assert_eq!(out["result"]["body"], base64::engine::general_purpose::STANDARD.encode(b"ok"));
    }

    /// 没声明的端口：连本地真有服务也不许转。
    #[tokio::test]
    async fn http_forward_refuses_undeclared_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let f = forwarder(vec![]);
        let out = f
            .reply_http(
                json!(1),
                &json!({ "port": port, "cred": "c", "method": "GET", "path": "/", "headers": [], "timeoutMs": 5000 }),
            )
            .await;
        assert_eq!(out["code"], json!("port-not-declared"), "{out}");
    }

    /// ws.forward 往返：假回环 WS 服务回声，双向帧都走通。
    #[tokio::test]
    async fn ws_forward_round_trips_to_loopback() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let echo = tokio::spawn(async move {
            let (s, _) = listener.accept().await.unwrap();
            let ws = tokio_tungstenite::accept_async(s).await.unwrap();
            let (mut sink, mut stream) = ws.split();
            while let Some(Ok(Message::Binary(b))) = stream.next().await {
                sink.send(Message::Binary(b)).await.unwrap();
            }
        });

        let f = forwarder(vec![port]);
        let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
        let args: WsForwardArgs = serde_json::from_value(json!({ "port": port, "cred": "c", "path": "/ws", "headers": [] })).unwrap();
        let tx = f.open_ws(42, args, out_tx).await.expect("open ws");

        // 设备方向 → 回声 → 后端方向
        tx.send(FwdFrame::Data(base64::engine::general_purpose::STANDARD.encode(b"hello ws"))).unwrap();
        let mut got_data = false;
        for _ in 0..50 {
            let line = tokio::time::timeout(Duration::from_millis(200), out_rx.recv()).await;
            match line {
                Ok(Some(text)) => {
                    let v: Value = serde_json::from_str(&text).unwrap();
                    if v["type"] == "fwd-data" {
                        assert_eq!(v["id"], json!(42));
                        let bytes = base64::engine::general_purpose::STANDARD.decode(v["b64"].as_str().unwrap()).unwrap();
                        assert_eq!(bytes, b"hello ws");
                        got_data = true;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(got_data, "没有收到回声帧");

        // 回环服务断开：设备侧要主动告诉后端（fwd-close）。
        echo.abort();
        let mut got_close = false;
        for _ in 0..50 {
            let line = tokio::time::timeout(Duration::from_millis(200), out_rx.recv()).await;
            match line {
                Ok(Some(text)) => {
                    let v: Value = serde_json::from_str(&text).unwrap();
                    if v["type"] == "fwd-close" && v["id"] == json!(42) {
                        got_close = true;
                        break;
                    }
                }
                _ => {}
            }
        }
        assert!(got_close, "没有收到 fwd-close");
    }
}
