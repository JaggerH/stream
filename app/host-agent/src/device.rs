//! 设备模式：这台 Linux 机器（NAS）不是主实例，而是主实例的一个执行位置。
//!
//! `STREAM_BACKEND_URL` 在场就进入这个模式：首次启动用 `STREAM_PAIRING_CODE` 配对，device token
//! 存进状态目录，之后每次启动都用它直接连——配对码只用一次。被主实例撤销后作废保存的配对，
//! 再用环境变量里的码配（通常它早已用过，于是挂起等用户换新码）。
//! 权威：openspec/changes/device-execution/specs/linux-device-agent/spec.md、design.md D8。

use std::convert::Infallible;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::netguard;
use crate::relay::{self, SessionEnd, Supervisor};

/// 设备模式声明的全部 op。浏览器通道（`browser`）是计划 3 的事；这里只声明真的能做的。
pub const DEVICE_OPS: &[&str] = &["http.fetch"];
const PAIRING_FILE: &str = "device.json";
const REVOKED_FILE: &str = "device.json.revoked";

#[derive(Debug, Clone)]
pub struct DeviceEnv {
    pub backend: Url,
    pub pairing_code: Option<String>,
    pub state_dir: PathBuf,
    pub name: String,
    pub allow_hosts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pairing {
    pub device_id: String,
    pub device_token: String,
}

#[derive(Debug, PartialEq)]
pub enum Startup {
    Saved(Pairing),
    Pair(String),
    NoCode,
}

#[derive(Debug, PartialEq)]
pub enum PairError {
    /// 主实例明确拒了（码不对、过期、老后端不认 linux）。同一个码再试只会继续被拒。
    Rejected(String),
    /// 没连上 / 5xx。主实例可能还没起来，退避重试。
    Unreachable(String),
}

#[derive(Debug, PartialEq)]
pub enum PairNext {
    Park,
    Retry,
}

impl DeviceEnv {
    /// 读设备模式的配置。`Ok(None)` = 不是设备模式（没有 `STREAM_BACKEND_URL`）；`Err` = 是设备模式
    /// 但配置不能用——启动即判死，因为它不会自己变好。
    pub fn from_lookup(get: &dyn Fn(&str) -> Option<String>, hostname: Option<String>) -> Result<Option<DeviceEnv>, String> {
        let val = |k: &str| get(k).map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let Some(raw) = val("STREAM_BACKEND_URL") else { return Ok(None) };
        let backend = Url::parse(&raw).map_err(|e| format!("STREAM_BACKEND_URL 不是合法地址（{raw}）：{e}"))?;
        if backend.scheme() != "http" && backend.scheme() != "https" {
            return Err(format!("STREAM_BACKEND_URL 只能是 http:// 或 https://（{raw}）"));
        }
        let state_dir = val("STREAM_AGENT_DATA")
            .map(PathBuf::from)
            .or_else(|| val("XDG_DATA_HOME").map(|x| PathBuf::from(x).join("stream-agent")))
            .or_else(|| val("HOME").map(|h| PathBuf::from(h).join(".local/share/stream-agent")))
            .ok_or("没有可用的状态目录：设 STREAM_AGENT_DATA（容器里指向挂载的数据卷）")?;
        let name = val("STREAM_DEVICE_NAME")
            .or_else(|| hostname.map(|h| h.trim().to_string()).filter(|h| !h.is_empty()))
            .unwrap_or_else(|| "Linux".to_string());
        Ok(Some(DeviceEnv {
            backend,
            pairing_code: val("STREAM_PAIRING_CODE"),
            state_dir,
            name,
            allow_hosts: netguard::parse_allow_hosts(get("ALLOW_HOSTS").as_deref()),
        }))
    }

    pub fn from_process() -> Result<Option<DeviceEnv>, String> {
        DeviceEnv::from_lookup(&|k: &str| std::env::var(k).ok(), sysinfo::System::host_name())
    }
}

/// 建状态目录并确认写得进去。**在花掉配对码之前做**：码是一次性的，配对成功后才发现 token
/// 存不下，主实例那边已经多了一台再也连不上的设备。
pub fn ensure_state_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("建不了状态目录 {}：{e}", dir.display()))?;
    let probe = dir.join(".write-probe");
    std::fs::write(&probe, b"").map_err(|e| format!("状态目录 {} 写不进去：{e}", dir.display()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

pub fn load_pairing(dir: &Path) -> Result<Option<Pairing>, String> {
    let path = dir.join(PAIRING_FILE);
    let text = match std::fs::read_to_string(&path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("读不了 {}：{e}", path.display())),
    };
    let p: Pairing = serde_json::from_str(&text)
        .map_err(|e| format!("{} 坏了（{e}）——确认这台设备已在主实例撤销后删掉它，再用新配对码启动", path.display()))?;
    if !p.device_id.starts_with("linux:") || p.device_token.is_empty() {
        return Err(format!("{} 里不是一份 linux 设备的配对", path.display()));
    }
    Ok(Some(p))
}

/// 写临时文件再改名：断电只会留下旧文件或新文件，不会留下半个 token。
pub fn save_pairing(dir: &Path, p: &Pairing) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = dir.join(format!("{PAIRING_FILE}.tmp"));
    let body = serde_json::to_vec_pretty(p).map_err(|e| e.to_string())?;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&tmp)
        .map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    f.write_all(&body).and_then(|_| f.sync_all()).map_err(|e| format!("写不了 {}：{e}", tmp.display()))?;
    std::fs::rename(&tmp, dir.join(PAIRING_FILE)).map_err(|e| format!("保存配对失败：{e}"))
}

/// 撤销之后：挪开而不是删掉，排错时还看得到当初是哪台设备。
pub fn forget_pairing(dir: &Path) -> Result<(), String> {
    std::fs::rename(dir.join(PAIRING_FILE), dir.join(REVOKED_FILE)).map_err(|e| format!("作废保存的配对失败：{e}"))
}

pub fn startup(saved: Option<Pairing>, code: Option<&str>) -> Startup {
    match (saved, code) {
        (Some(p), _) => Startup::Saved(p),
        (None, Some(c)) => Startup::Pair(c.to_string()),
        (None, None) => Startup::NoCode,
    }
}

/// 被拒的码不重试：容器 `restart: always` 下每次启动都拿旧码去配，主实例在连续失败后会作废
/// **当前**有效的那个码——用户刚生成、还没来得及填进环境变量的新码就这样被烧掉了。
pub fn after_pair_failure(e: &PairError) -> PairNext {
    match e {
        PairError::Rejected(_) => PairNext::Park,
        PairError::Unreachable(_) => PairNext::Retry,
    }
}

/// 控制面（配对）的 HTTP 客户端。和 `http.fetch` 不同，它**要**能连私网——主实例多半就在
/// Tailscale（100.64/10）或局域网上；代理照样不走，与 WS 那条路一致。
pub fn control_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("http client")
}

fn api_url(backend: &Url, path: &str) -> Url {
    let mut u = backend.clone();
    let base = u.path().trim_end_matches('/').to_string();
    u.set_path(&format!("{base}{path}"));
    u.set_query(None);
    u.set_fragment(None);
    u
}

pub fn ws_url(backend: &Url) -> String {
    let mut u = api_url(backend, "/api/host");
    let scheme = if backend.scheme() == "https" { "wss" } else { "ws" };
    u.set_scheme(scheme).expect("http(s) → ws(s) 总是允许");
    u.to_string()
}

pub async fn pair(client: &reqwest::Client, backend: &Url, code: &str, name: &str) -> Result<Pairing, PairError> {
    let resp = client
        .post(api_url(backend, "/api/devices/pair"))
        .json(&json!({ "code": code, "name": name, "platform": "linux" }))
        .send()
        .await
        .map_err(|e| PairError::Unreachable(e.to_string()))?;
    let status = resp.status();
    let body: Value = resp.json().await.unwrap_or(Value::Null);
    if status.is_success() {
        return match (body["deviceId"].as_str(), body["deviceToken"].as_str()) {
            (Some(id), Some(token)) if id.starts_with("linux:") && !token.is_empty() => {
                Ok(Pairing { device_id: id.to_string(), device_token: token.to_string() })
            }
            _ => Err(PairError::Rejected(format!("主实例的配对回复不是一台 linux 设备（主实例太旧？）：{body}"))),
        };
    }
    if status.is_client_error() {
        return Err(PairError::Rejected(body["error"].as_str().map(str::to_string).unwrap_or_else(|| status.to_string())));
    }
    Err(PairError::Unreachable(format!("HTTP {status}")))
}

/// 用配对码换 device token 并存下。连不上就退避重试；被拒就挂起——见 [`after_pair_failure`]。
pub async fn obtain_pairing(env: &DeviceEnv, code: &str) -> Pairing {
    let client = control_client();
    let mut backoff = Supervisor::default();
    loop {
        let err = match pair(&client, &env.backend, code, &env.name).await {
            Ok(p) => {
                if let Err(e) = save_pairing(&env.state_dir, &p) {
                    eprintln!("[device] 配对成功但存不下 token（{e}）——在主实例上撤销 {} 后修好状态目录再重配", p.device_id);
                    std::process::exit(2);
                }
                eprintln!("[device] 配对成功：{}", p.device_id);
                return p;
            }
            Err(e) => e,
        };
        let why = match &err {
            PairError::Rejected(w) | PairError::Unreachable(w) => w.clone(),
        };
        match after_pair_failure(&err) {
            PairNext::Park => {
                match park(&format!("配对码被主实例拒绝（{why}）——同一个码不再重试；在主实例上生成新码、设进 STREAM_PAIRING_CODE 后重启")).await {}
            }
            PairNext::Retry => {
                let d = backoff.after(&SessionEnd::ConnectFailed(why.clone()));
                eprintln!("[device] 连不上主实例配对（{why}）——{:.1}s 后重试", d.as_secs_f32());
                tokio::time::sleep(d).await;
            }
        }
    }
}

/// 停在这里等人：进程不退（退了容器会被拉起来再试一遍同一个码），每小时重打一行，看日志的人总能看到。
pub async fn park(why: &str) -> Infallible {
    loop {
        eprintln!("[device] {why}");
        tokio::time::sleep(Duration::from_secs(3600)).await;
    }
}

pub fn device_hello(device_id: &str, name: &str) -> Value {
    relay::hello_frame(device_id, "linux", name, env!("CARGO_PKG_VERSION"), DEVICE_OPS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::os::unix::fs::PermissionsExt;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k: &str| m.get(k).cloned()
    }

    fn fresh_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("stream-agent-test-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn sample() -> Pairing {
        Pairing { device_id: "linux:0b7c".into(), device_token: "tok".into() }
    }

    #[test]
    fn no_backend_url_means_not_device_mode() {
        assert!(DeviceEnv::from_lookup(&env_of(&[]), None).unwrap().is_none());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "  ")]), None).unwrap().is_none());
    }

    #[test]
    fn the_env_is_read_with_its_defaults() {
        let e = DeviceEnv::from_lookup(
            &env_of(&[("STREAM_BACKEND_URL", "http://100.101.102.103:8900"), ("STREAM_PAIRING_CODE", " 123456 "), ("HOME", "/home/nas")]),
            Some("DS920".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.backend.as_str(), "http://100.101.102.103:8900/");
        assert_eq!(e.pairing_code.as_deref(), Some("123456"));
        assert_eq!(e.state_dir, PathBuf::from("/home/nas/.local/share/stream-agent"));
        assert_eq!(e.name, "DS920");
        assert_eq!(e.allow_hosts, None);
    }

    #[test]
    fn explicit_settings_win_over_defaults() {
        let e = DeviceEnv::from_lookup(
            &env_of(&[
                ("STREAM_BACKEND_URL", "https://stream.example.com/base/"),
                ("STREAM_AGENT_DATA", "/data"),
                ("XDG_DATA_HOME", "/xdg"),
                ("STREAM_DEVICE_NAME", " 家里的 NAS "),
                ("ALLOW_HOSTS", "eastmoneysec.com, eastmoney.com"),
                ("STREAM_PAIRING_CODE", ""),
            ]),
            Some("ignored".into()),
        )
        .unwrap()
        .unwrap();
        assert_eq!(e.state_dir, PathBuf::from("/data"));
        assert_eq!(e.name, "家里的 NAS");
        assert_eq!(e.pairing_code, None, "空配对码 = 没给");
        assert_eq!(e.allow_hosts, Some(vec!["eastmoneysec.com".to_string(), "eastmoney.com".to_string()]));
        let xdg = DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "http://h:1"), ("XDG_DATA_HOME", "/xdg"), ("HOME", "/home/x")]), None).unwrap().unwrap();
        assert_eq!(xdg.state_dir, PathBuf::from("/xdg/stream-agent"));
        assert_eq!(xdg.name, "Linux");
    }

    #[test]
    fn a_bad_backend_url_or_no_state_dir_is_a_startup_error() {
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "not a url")]), None).is_err());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "ftp://h/"), ("HOME", "/h")]), None).is_err());
        assert!(DeviceEnv::from_lookup(&env_of(&[("STREAM_BACKEND_URL", "http://h:1")]), None).is_err(), "没有任何状态目录可用");
    }

    #[test]
    fn the_relay_url_follows_the_backend_scheme_and_base_path() {
        let u = |s: &str| ws_url(&Url::parse(s).unwrap());
        assert_eq!(u("http://100.64.1.2:8900"), "ws://100.64.1.2:8900/api/host");
        assert_eq!(u("https://stream.example.com/"), "wss://stream.example.com/api/host");
        assert_eq!(u("https://example.com/stream/?x=1#f"), "wss://example.com/stream/api/host");
    }

    #[test]
    fn the_hello_declares_linux_and_only_http_fetch() {
        let h = device_hello("linux:0b7c", "nas");
        assert_eq!(h["type"], "hello");
        assert_eq!(h["deviceId"], "linux:0b7c");
        assert_eq!(h["platform"], "linux");
        assert_eq!(h["name"], "nas");
        assert_eq!(h["ops"], json!(["http.fetch"]));
        assert_eq!(h["agentVersion"], env!("CARGO_PKG_VERSION"));
    }

    #[test]
    fn a_saved_pairing_round_trips_and_is_private() {
        let d = fresh_dir("roundtrip");
        ensure_state_dir(&d).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), None);
        save_pairing(&d, &sample()).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), Some(sample()));
        let mode = std::fs::metadata(d.join("device.json")).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "device token 只给本用户读");
        let text = std::fs::read_to_string(d.join("device.json")).unwrap();
        assert!(text.contains("\"deviceId\"") && text.contains("\"deviceToken\""));
    }

    /// 坏文件不能被当成"没配过"：那会拿环境变量里的码再配一台新设备，留下一条孤儿记录。
    #[test]
    fn a_corrupt_or_foreign_pairing_file_is_an_error_not_a_reset() {
        let d = fresh_dir("corrupt");
        ensure_state_dir(&d).unwrap();
        std::fs::write(d.join("device.json"), "{not json").unwrap();
        assert!(load_pairing(&d).is_err());
        std::fs::write(d.join("device.json"), r#"{"deviceId":"android:1","deviceToken":"t"}"#).unwrap();
        assert!(load_pairing(&d).is_err());
    }

    #[test]
    fn forgetting_moves_the_pairing_aside() {
        let d = fresh_dir("forget");
        ensure_state_dir(&d).unwrap();
        save_pairing(&d, &sample()).unwrap();
        forget_pairing(&d).unwrap();
        assert_eq!(load_pairing(&d).unwrap(), None);
        assert!(d.join("device.json.revoked").exists(), "留一份供排错");
    }

    #[test]
    fn an_unwritable_state_dir_fails_before_any_code_is_spent() {
        let d = fresh_dir("readonly");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o500)).unwrap();
        let r = ensure_state_dir(&d);
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o700)).unwrap();
        // root 跑测试时权限不生效，这条断言只在非 root 下有意义。
        if !is_root() {
            assert!(r.is_err());
        }
    }

    fn is_root() -> bool {
        std::fs::read_to_string("/proc/self/status")
            .map(|s| s.lines().any(|l| l.starts_with("Uid:") && l.split_whitespace().nth(1) == Some("0")))
            .unwrap_or(false)
    }

    /// spec「容器重启不需要重新配对」：保存的配对在，就不碰（多半已过期的）配对码。
    #[test]
    fn a_saved_pairing_wins_over_the_code_in_the_env() {
        assert_eq!(startup(Some(sample()), Some("999999")), Startup::Saved(sample()));
        assert_eq!(startup(None, Some("123456")), Startup::Pair("123456".into()));
        assert_eq!(startup(None, None), Startup::NoCode);
    }

    /// Review Focus 4：被拒的码不再试（重启循环会烧掉用户刚生成的新码），连不上才重试。
    #[test]
    fn a_rejected_code_parks_and_an_unreachable_backend_retries() {
        assert_eq!(after_pair_failure(&PairError::Rejected("配对码不对".into())), PairNext::Park);
        assert_eq!(after_pair_failure(&PairError::Unreachable("refused".into())), PairNext::Retry);
    }

    /// 只回一次固定响应的 HTTP 端，记下请求原文。
    async fn one_shot(status: &str, body: &str) -> (Url, Arc<Mutex<String>>) {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let seen = Arc::new(Mutex::new(String::new()));
        let s2 = seen.clone();
        let resp = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        tokio::spawn(async move {
            let Ok((mut s, _)) = l.accept().await else { return };
            let mut buf = vec![0u8; 8192];
            let mut got = Vec::new();
            loop {
                let n = s.read(&mut buf).await.unwrap_or(0);
                if n == 0 { break; }
                got.extend_from_slice(&buf[..n]);
                if let Some(end) = got.windows(4).position(|w| w == b"\r\n\r\n") {
                    let head = String::from_utf8_lossy(&got[..end]).to_lowercase();
                    let len = head.lines().find_map(|l| l.strip_prefix("content-length:").map(|v| v.trim().parse::<usize>().unwrap_or(0))).unwrap_or(0);
                    if got.len() >= end + 4 + len { break; }
                }
            }
            *s2.lock().unwrap() = String::from_utf8_lossy(&got).into_owned();
            let _ = s.write_all(resp.as_bytes()).await;
        });
        (Url::parse(&format!("http://{addr}")).unwrap(), seen)
    }

    #[tokio::test]
    async fn pairing_posts_the_code_with_the_linux_platform() {
        let (base, seen) = one_shot("200 OK", r#"{"deviceId":"linux:0b7c","deviceToken":"tok"}"#).await;
        let p = pair(&control_client(), &base, "123456", "nas").await.unwrap();
        assert_eq!(p, sample());
        let req = seen.lock().unwrap().clone();
        assert!(req.starts_with("POST /api/devices/pair "), "{req}");
        let body: Value = serde_json::from_str(req.split("\r\n\r\n").nth(1).unwrap()).unwrap();
        assert_eq!(body, json!({"code": "123456", "name": "nas", "platform": "linux"}));
    }

    #[tokio::test]
    async fn a_403_is_a_rejection_carrying_the_backend_reason() {
        let (base, _) = one_shot("403 Forbidden", r#"{"error":"配对码无效或已过期"}"#).await;
        assert_eq!(pair(&control_client(), &base, "000000", "nas").await, Err(PairError::Rejected("配对码无效或已过期".into())));
    }

    /// 老后端忽略 platform、发回 android 的 id：拿着它连上来会被以 4003 关掉，不如在这里就说清。
    #[tokio::test]
    async fn a_non_linux_device_id_is_a_rejection() {
        let (base, _) = one_shot("200 OK", r#"{"deviceId":"android:0b7c","deviceToken":"tok"}"#).await;
        assert!(matches!(pair(&control_client(), &base, "123456", "nas").await, Err(PairError::Rejected(_))));
    }

    #[tokio::test]
    async fn a_5xx_or_no_answer_is_unreachable() {
        let (base, _) = one_shot("503 Service Unavailable", "{}").await;
        assert!(matches!(pair(&control_client(), &base, "1", "n").await, Err(PairError::Unreachable(_))));
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = Url::parse(&format!("http://{}", l.local_addr().unwrap())).unwrap();
        drop(l);
        assert!(matches!(pair(&control_client(), &dead, "1", "n").await, Err(PairError::Unreachable(_))));
    }
}
