//! Chrome **Native Messaging** 模式：被浏览器用 stdio 拉起，把本机 `data/ext-relay-token`
//! 交给我们那个扩展。
//!
//! **为什么要有它**：扩展连后端 WS 时完全不校验对端身份——token 是它向对端索取的，对端
//! 给什么就用什么。于是本机任何进程抢到 8900 就拿到这条通道的全部能力（任意页面
//! `Runtime.evaluate`）。修法是用**文件系统当带外通道**：token 只有同一个用户读得到。
//! 扩展读不了文件，但能通过 native messaging 拉起一个本机可执行文件——就是这里。
//!
//! **平台无关**（纯 stdio + 读文件），所以在 Linux/mac 上立刻能跑，不进 `windows.rs`。
//!
//! ## Wire 格式（Chrome 定的，不是我们定的）
//!
//! 每一帧 = 4 字节 **native-endian** 长度前缀 + 该长度的 UTF-8 JSON body。stdin 收、stdout 发。
//! **stdout 上除了帧不许有任何别的字节**——一个 `println!` 就能把协议打断，且表现是扩展那边
//! 收到一条乱码后静默断开。所以本模块的日志一律 `eprintln!`。

use serde_json::{json, Value};
use std::io::{Read, Write};

use crate::datadir::{self, Env, Fs};

/// Chrome 侧单条消息上限是 64MB 级别；我们的请求都是几十字节。超出就是有人在乱塞，
/// 直接拒绝而不是先分配一块内存。
const MAX_FRAME: u32 = 1024 * 1024;

/// 读一帧。`Ok(None)` = 干净的 EOF（Chrome 关掉了端口，正常退出）。
pub fn read_frame<R: Read>(r: &mut R) -> Result<Option<Vec<u8>>, String> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    // native-endian：Chrome 用的是**主机字节序**，不是网络序。写成 be 会在 x86 上表现为
    // "长度是个天文数字"，直接把第一帧就打死。
    let n = u32::from_ne_bytes(len);
    if n > MAX_FRAME {
        return Err(format!("frame too large: {n} bytes"));
    }
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

/// 写一帧。
pub fn write_frame<W: Write>(w: &mut W, body: &[u8]) -> Result<(), String> {
    let n = u32::try_from(body.len()).map_err(|_| "frame too large".to_string())?;
    w.write_all(&n.to_ne_bytes()).map_err(|e| e.to_string())?;
    w.write_all(body).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

/// 处理一条请求，返回要回给扩展的那条 JSON。
///
/// **永远返回一条响应，永远不 panic**——扩展那边是在 `await` 一条回复，我们静默死掉等于
/// 让它挂在那里。读不到 token 就回 `{ok:false,error:"人话"}`。
pub fn handle<F: Fs>(fs: &F, env: &Env, req: &Value) -> Value {
    let id = req.get("id").cloned();
    let op = req.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let mut out = match op {
        // 存活探测：扩展用它确认 host 装好了、版本对得上，不必先要 token。
        "ping" => json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }),
        "token" => match datadir::read_token(fs, env) {
            Ok(token) => {
                let source = datadir::resolve_token_path(fs, env)
                    .map(|p| p.display().to_string())
                    .unwrap_or_else(|| "STREAM_HOST_TOKEN".to_string());
                json!({ "ok": true, "token": token, "source": source })
            }
            Err(e) => json!({ "ok": false, "error": e }),
        },
        "" => json!({ "ok": false, "error": "missing \"op\"" }),
        other => json!({ "ok": false, "error": format!("unknown op: {other}") }),
    };
    // id 原样回带——扩展一次只发一条，但回带 id 让它不必靠顺序对账。
    if let (Some(id), Some(obj)) = (id, out.as_object_mut()) {
        obj.insert("id".to_string(), id);
    }
    out
}

/// 一整个 native-messaging 会话：读一帧 → 回一帧，直到 EOF。
pub fn serve<R: Read, W: Write, F: Fs>(r: &mut R, w: &mut W, fs: &F, env: &Env) -> Result<(), String> {
    loop {
        let Some(frame) = read_frame(r)? else { return Ok(()) };
        // JSON 解析失败也要回一帧：静默丢弃会让扩展那边永远等下去。
        let reply = match serde_json::from_slice::<Value>(&frame) {
            Ok(req) => handle(fs, env, &req),
            Err(e) => json!({ "ok": false, "error": format!("bad JSON: {e}") }),
        };
        write_frame(w, reply.to_string().as_bytes())?;
    }
}

/// 这次启动是不是 native-messaging 模式。
///
/// **Chrome 不允许在清单的 `path` 上带参数**，所以我们没法靠自己的 flag 被拉起来——判据只能是
/// Chrome 自己塞进 argv 的那两样：调用方 origin（`chrome-extension://<id>/`）和
/// `--parent-window=<handle>`。`--native-messaging` 那条只为手工调试留着。
pub fn is_native_messaging(args: &[String]) -> bool {
    args.iter().any(|a| {
        a == "--native-messaging" || a.starts_with("chrome-extension://") || a.starts_with("--parent-window=")
    })
}

/// 调用方的 extension id（Chrome 把 origin 放在 argv 里）。只用于日志——真正的准入
/// 由清单的 `allowed_origins` 在 Chrome 那边执行，我们这边再判一次也拦不住谁。
pub fn calling_extension_id(args: &[String]) -> Option<String> {
    args.iter()
        .find_map(|a| a.strip_prefix("chrome-extension://"))
        .map(|s| s.trim_end_matches('/').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::path::Path;

    #[derive(Default)]
    struct FakeFs(HashMap<String, String>);
    impl Fs for FakeFs {
        fn exists(&self, path: &Path) -> bool {
            self.0.contains_key(&path.to_string_lossy().to_string())
        }
        fn read_to_string(&self, path: &Path) -> Option<String> {
            self.0.get(&path.to_string_lossy().to_string()).cloned()
        }
    }
    fn fs_with_token() -> FakeFs {
        FakeFs(HashMap::from([("/d/ext-relay-token".to_string(), "secret-tok\n".to_string())]))
    }
    fn env_at_d() -> Env {
        Env { data_dir: Some("/d".into()), ..Default::default() }
    }

    fn framed(body: &str) -> Vec<u8> {
        let mut v = (body.len() as u32).to_ne_bytes().to_vec();
        v.extend_from_slice(body.as_bytes());
        v
    }

    #[test]
    fn a_frame_round_trips() {
        let mut buf = Vec::new();
        write_frame(&mut buf, br#"{"op":"token"}"#).unwrap();
        assert_eq!(&buf[..4], &(14u32).to_ne_bytes());
        let mut cur = std::io::Cursor::new(buf);
        assert_eq!(read_frame(&mut cur).unwrap().unwrap(), br#"{"op":"token"}"#);
        assert!(read_frame(&mut cur).unwrap().is_none(), "读完就该是干净的 EOF");
    }

    /// 长度前缀是**主机字节序**。写成大端会在 x86 上把第一帧就判成天文数字长度。
    #[test]
    fn the_length_prefix_is_native_endian() {
        let mut buf = Vec::new();
        write_frame(&mut buf, b"ab").unwrap();
        assert_eq!(u32::from_ne_bytes(buf[..4].try_into().unwrap()), 2);
    }

    #[test]
    fn an_oversized_frame_is_refused_rather_than_allocated() {
        let mut bad = (MAX_FRAME + 1).to_ne_bytes().to_vec();
        bad.extend_from_slice(b"x");
        assert!(read_frame(&mut std::io::Cursor::new(bad)).is_err());
    }

    #[test]
    fn token_op_returns_the_token() {
        let r = handle(&fs_with_token(), &env_at_d(), &json!({ "op": "token", "id": 7 }));
        assert_eq!(r["ok"], json!(true));
        assert_eq!(r["token"], json!("secret-tok"));
        assert_eq!(r["id"], json!(7), "id 要原样回带");
        assert_eq!(r["source"], json!("/d/ext-relay-token"));
    }

    /// 读不到 token 是**回一条 error**，不是 panic、也不是空 token —— 扩展拿到空串会照样去连，
    /// 然后在 401 上打转，没人知道真因。
    #[test]
    fn a_missing_token_comes_back_as_an_error_object() {
        let r = handle(&FakeFs::default(), &Env::default(), &json!({ "op": "token" }));
        assert_eq!(r["ok"], json!(false));
        assert!(r["token"].is_null());
        assert!(r["error"].as_str().unwrap().contains("ext-relay-token"));
    }

    #[test]
    fn ping_answers_without_needing_a_token() {
        let r = handle(&FakeFs::default(), &Env::default(), &json!({ "op": "ping" }));
        assert_eq!(r["ok"], json!(true));
        assert!(r["version"].is_string());
    }

    #[test]
    fn an_unknown_op_is_an_error_not_silence() {
        let r = handle(&FakeFs::default(), &Env::default(), &json!({ "op": "wat" }));
        assert_eq!(r["ok"], json!(false));
        assert!(r["error"].as_str().unwrap().contains("wat"));
    }

    #[test]
    fn serve_answers_each_frame_and_stops_at_eof() {
        let mut input = framed(r#"{"op":"ping","id":1}"#);
        input.extend(framed(r#"{"op":"token","id":2}"#));
        let mut out = Vec::new();
        serve(&mut std::io::Cursor::new(input), &mut out, &fs_with_token(), &env_at_d()).unwrap();

        let mut cur = std::io::Cursor::new(out);
        let a: Value = serde_json::from_slice(&read_frame(&mut cur).unwrap().unwrap()).unwrap();
        let b: Value = serde_json::from_slice(&read_frame(&mut cur).unwrap().unwrap()).unwrap();
        assert_eq!(a["id"], json!(1));
        assert_eq!(b["token"], json!("secret-tok"));
        assert!(read_frame(&mut cur).unwrap().is_none());
    }

    /// 坏 JSON 也必须回一帧——静默丢弃会让扩展那边的 `await` 永远挂着。
    #[test]
    fn malformed_json_still_gets_a_reply() {
        let mut out = Vec::new();
        serve(&mut std::io::Cursor::new(framed("{not json")), &mut out, &FakeFs::default(), &Env::default())
            .unwrap();
        let mut cur = std::io::Cursor::new(out);
        let r: Value = serde_json::from_slice(&read_frame(&mut cur).unwrap().unwrap()).unwrap();
        assert_eq!(r["ok"], json!(false));
    }

    /// Chrome 不给我们加 flag 的机会——模式判定只能靠它自己塞进来的 origin / parent-window。
    #[test]
    fn the_mode_is_detected_from_what_chrome_puts_in_argv() {
        let chrome = ["chrome-extension://abcdefghijklmnopabcdefghijklmnop/".to_string(), "--parent-window=0".to_string()];
        assert!(is_native_messaging(&chrome));
        assert_eq!(calling_extension_id(&chrome).unwrap(), "abcdefghijklmnopabcdefghijklmnop");
        assert!(is_native_messaging(&["--native-messaging".to_string()]));
        assert!(!is_native_messaging(&["verify".to_string()]));
        assert!(!is_native_messaging(&[]));
    }
}
