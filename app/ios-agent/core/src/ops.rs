//! The normalized action vocabulary and its iOS wire mapping.
//!
//! Callers name actions by the shared names (`tap`, `longPress`, `setText`, …). This module
//! parses them, accepting the historical spellings a surface already used (`click`, `setValue`,
//! `launchApp`), and the dispatcher maps each one onto an iOS mechanism. Actions the phone
//! cannot do fail before anything is sent.

use serde_json::{json, Value};

use crate::ax::{Point, Query, Rect};
use crate::error::{AgentError, AgentResult, FailureCode};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PressKey {
    Home,
    Lock,
    VolumeUp,
    VolumeDown,
    Enter,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScrollDir {
    Up,
    Down,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OcrMode {
    Auto,
    On,
    Off,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Op {
    Tap {
        rect: Rect,
    },
    LongPress {
        rect: Rect,
        duration_ms: u32,
    },
    Swipe {
        from: Point,
        to: Point,
        duration_ms: u32,
    },
    Scroll {
        dir: ScrollDir,
        amount: u8,
        until: Option<String>,
        max_steps: u32,
        timeout_ms: u64,
    },
    Type {
        text: String,
    },
    SetText {
        id: String,
        text: String,
    },
    Press {
        key: PressKey,
    },
    Screenshot,
    Find {
        query: Query,
        ocr: OcrMode,
    },
    Windows,
    OpenApp {
        package: String,
        fresh: bool,
    },
    Sleep {
        ms: u64,
    },
    /// `url` has no meaning on a phone: the foreground app is a bundle id, not a URL.
    Url,
    Status,
    /// Tap a node previously returned by `find`.
    Invoke {
        id: String,
    },
}

impl Op {
    pub fn name(&self) -> &'static str {
        match self {
            Op::Tap { .. } => "tap",
            Op::LongPress { .. } => "longPress",
            Op::Swipe { .. } => "swipe",
            Op::Scroll { .. } => "scroll",
            Op::Type { .. } => "type",
            Op::SetText { .. } => "setText",
            Op::Press { .. } => "press",
            Op::Screenshot => "screenshot",
            Op::Find { .. } => "find",
            Op::Windows => "windows",
            Op::OpenApp { .. } => "openApp",
            Op::Sleep { .. } => "sleep",
            Op::Url => "url",
            Op::Status => "status",
            Op::Invoke { .. } => "invoke",
        }
    }

    /// Ops that can change the device state pass the gate. Reads and waits do not.
    pub fn gated(&self) -> bool {
        matches!(
            self,
            Op::Tap { .. }
                | Op::LongPress { .. }
                | Op::Swipe { .. }
                | Op::Scroll { .. }
                | Op::Type { .. }
                | Op::SetText { .. }
                | Op::Press { .. }
                | Op::Invoke { .. }
        )
    }

    /// Whether this op needs a fresh accessibility snapshot to be judged or performed.
    pub fn needs_snapshot(&self) -> bool {
        matches!(
            self,
            Op::Tap { .. }
                | Op::LongPress { .. }
                | Op::Swipe { .. }
                | Op::Scroll { .. }
                | Op::Type { .. }
                | Op::SetText { .. }
                | Op::Press { .. }
                | Op::Invoke { .. }
                | Op::Find { .. }
                | Op::Windows
        )
    }
}

const UNSUPPORTED_ON_IOS: [&str; 5] = [
    "readText",
    "findImage",
    "moveMouse",
    "nudge",
    "readElements",
];

/// Parses `(name, args)` into an [`Op`]. Unknown names and malformed arguments never reach the
/// device.
pub fn parse_op(name: &str, args: &Value) -> AgentResult<Op> {
    if UNSUPPORTED_ON_IOS.contains(&name) {
        return Err(AgentError::new(
            FailureCode::UnsupportedOp,
            format!("{name} is not available on iOS"),
        ));
    }
    let op = match name {
        "tap" | "click" => Op::Tap {
            rect: rect_arg(args, "rect")?,
        },
        "longPress" | "long_press" => Op::LongPress {
            rect: rect_arg(args, "rect")?,
            duration_ms: u32_arg(args, "durationMs").unwrap_or(900).clamp(1, 60_000),
        },
        "swipe" => Op::Swipe {
            from: point_arg(args, "from")?,
            to: point_arg(args, "to")?,
            duration_ms: u32_arg(args, "durationMs").unwrap_or(300).clamp(1, 60_000),
        },
        "scroll" => Op::Scroll {
            dir: match str_arg(args, "dir")
                .unwrap_or_else(|| "down".into())
                .to_ascii_lowercase()
                .as_str()
            {
                "up" => ScrollDir::Up,
                "down" => ScrollDir::Down,
                other => {
                    return Err(bad_args(format!(
                        "scroll dir must be up or down, got {other}"
                    )));
                }
            },
            amount: u32_arg(args, "amount")
                .map(|v| v.clamp(1, 10) as u8)
                .unwrap_or(3),
            until: str_arg(args, "until"),
            max_steps: u32_arg(args, "maxSteps").unwrap_or(5).clamp(1, 50),
            timeout_ms: u64_arg(args, "timeoutMs").unwrap_or(10_000),
        },
        "type" => {
            let text =
                str_arg(args, "text").ok_or_else(|| bad_args("type needs a text string".into()))?;
            Op::Type { text }
        }
        "setText" | "setValue" => Op::SetText {
            id: str_arg(args, "ref")
                .or_else(|| str_arg(args, "id"))
                .ok_or_else(|| bad_args("setText needs a ref".into()))?,
            text: str_arg(args, "text").unwrap_or_default(),
        },
        "clearInput" => Op::SetText {
            id: str_arg(args, "ref")
                .or_else(|| str_arg(args, "id"))
                .ok_or_else(|| bad_args("clearInput needs a ref".into()))?,
            text: String::new(),
        },
        "press" => {
            let key = str_arg(args, "key").ok_or_else(|| bad_args("press needs a key".into()))?;
            let key = parse_key(&key)?;
            Op::Press { key }
        }
        "screenshot" | "captureWindow" => Op::Screenshot,
        "find" => Op::Find {
            query: serde_json::from_value(args.get("query").cloned().unwrap_or(Value::Null))
                .map_err(|e| bad_args(format!("find query: {e}")))?,
            ocr: match str_arg(args, "ocr")
                .unwrap_or_else(|| "auto".into())
                .to_ascii_lowercase()
                .as_str()
            {
                "on" => OcrMode::On,
                "off" => OcrMode::Off,
                _ => OcrMode::Auto,
            },
        },
        "windows" => Op::Windows,
        "openApp" | "launchApp" | "focusApp" | "ensureApp" => Op::OpenApp {
            package: str_arg(args, "package")
                .or_else(|| str_arg(args, "bundleId"))
                .ok_or_else(|| bad_args("openApp needs a package (bundle id)".into()))?,
            fresh: bool_arg(args, "fresh").unwrap_or(false),
        },
        "sleep" => Op::Sleep {
            ms: u64_arg(args, "ms").unwrap_or(0).min(600_000),
        },
        "invoke" => Op::Invoke {
            id: str_arg(args, "ref")
                .or_else(|| str_arg(args, "id"))
                .ok_or_else(|| bad_args("invoke needs a ref".into()))?,
        },
        "url" => Op::Url,
        "status" => Op::Status,
        other => {
            return Err(AgentError::new(
                FailureCode::UnknownOp,
                format!("unknown op: {other}"),
            ))
        }
    };
    Ok(op)
}

fn parse_key(key: &str) -> AgentResult<PressKey> {
    match key.to_ascii_lowercase().as_str() {
        "home" => Ok(PressKey::Home),
        "lock" | "power" => Ok(PressKey::Lock),
        "volumeup" | "volume_up" | "volume-up" => Ok(PressKey::VolumeUp),
        "volumedown" | "volume_down" | "volume-down" => Ok(PressKey::VolumeDown),
        "enter" | "return" => Ok(PressKey::Enter),
        "back" => Err(AgentError::new(
            FailureCode::UnsupportedOp,
            "Back is not an iOS key; the system Home swipe or a back button must be tapped",
        )),
        other => Err(bad_args(format!("unknown press key: {other}"))),
    }
}

fn bad_args(message: String) -> AgentError {
    AgentError::new(FailureCode::ActionFailed, message)
}

fn rect_arg(args: &Value, key: &str) -> AgentResult<Rect> {
    let value = args
        .get(key)
        .ok_or_else(|| bad_args(format!("missing {key}")))?;
    let x = num(value, "x")?;
    let y = num(value, "y")?;
    let w = num(value, "w")?;
    let h = num(value, "h")?;
    if w <= 0.0 || h <= 0.0 {
        return Err(bad_args(format!("{key} has non-positive size")));
    }
    Ok(Rect::new(x, y, w, h))
}

fn point_arg(args: &Value, key: &str) -> AgentResult<Point> {
    let value = args
        .get(key)
        .ok_or_else(|| bad_args(format!("missing {key}")))?;
    Ok(Point {
        x: num(value, "x")?,
        y: num(value, "y")?,
    })
}

fn num(value: &Value, key: &str) -> AgentResult<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
        .ok_or_else(|| bad_args(format!("{key} must be a finite number")))
}

fn str_arg(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(Value::as_str).map(str::to_string)
}

fn u32_arg(args: &Value, key: &str) -> Option<u32> {
    args.get(key)
        .and_then(Value::as_u64)
        .map(|v| v.min(u32::MAX as u64) as u32)
}

fn u64_arg(args: &Value, key: &str) -> Option<u64> {
    args.get(key).and_then(Value::as_u64)
}

fn bool_arg(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(Value::as_bool)
}

// ---- receipts -----------------------------------------------------------------------

/// The receipt of a gesture or an accessibility action.
pub fn action_receipt(via: &str) -> Value {
    json!({
        "via": via,
        "settled": true,
        "changedDuringRead": false,
    })
}

/// The receipt of a screenshot: base64 PNG plus the surface scale it was taken at.
pub fn screenshot_receipt(base64: &str, window: &str, scale: f64) -> Value {
    json!({ "base64": base64, "window": window, "scale": scale })
}

/// `find`'s receipt. `ocr` is present when the caller asked for it; iOS has no on-device OCR,
/// so an `on` request degrades to the tree and says so.
pub fn find_receipt(elements: Vec<crate::ax::Element>, ocr: OcrMode, viewport: Rect) -> Value {
    let ocr = match ocr {
        OcrMode::Off => json!({ "requested": "off", "used": false }),
        OcrMode::Auto => json!({ "requested": "auto", "used": false }),
        OcrMode::On => json!({
            "requested": "on",
            "used": false,
            "degraded": "ocr-unsupported",
        }),
    };
    json!({ "elements": elements, "viewport": viewport, "ocr": ocr })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_normalized_vocabulary() {
        let cases = [
            ("tap", json!({"rect":{"x":1,"y":2,"w":3,"h":4}})),
            (
                "longPress",
                json!({"rect":{"x":1,"y":2,"w":3,"h":4},"durationMs":1200}),
            ),
            (
                "swipe",
                json!({"from":{"x":1,"y":2},"to":{"x":3,"y":4},"durationMs":250}),
            ),
            ("scroll", json!({"dir":"up","amount":2})),
            ("type", json!({"text":"hello"})),
            ("setText", json!({"ref":"n0.n1","text":"x"})),
            ("press", json!({"key":"Home"})),
            ("screenshot", json!({})),
            ("find", json!({"query":{"role":"Button","name":"Pay"}})),
            ("windows", json!({})),
            ("openApp", json!({"package":"com.apple.Preferences"})),
            ("sleep", json!({"ms":100})),
            ("url", json!({})),
        ];
        for (name, args) in cases {
            assert!(parse_op(name, &args).is_ok(), "{name}");
        }
    }

    #[test]
    fn accepts_legacy_spellings() {
        assert!(matches!(
            parse_op("click", &json!({"rect":{"x":1,"y":2,"w":3,"h":4}})).unwrap(),
            Op::Tap { .. }
        ));
        assert!(matches!(
            parse_op("setValue", &json!({"ref":"n0","text":"x"})).unwrap(),
            Op::SetText { .. }
        ));
        assert!(matches!(
            parse_op("launchApp", &json!({"package":"a"})).unwrap(),
            Op::OpenApp { .. }
        ));
    }

    #[test]
    fn unknown_and_unsupported_are_refused_locally() {
        assert_eq!(
            parse_op("fly", &json!({})).unwrap_err().code,
            FailureCode::UnknownOp
        );
        assert_eq!(
            parse_op("readText", &json!({})).unwrap_err().code,
            FailureCode::UnsupportedOp
        );
        assert_eq!(
            parse_op("press", &json!({"key":"Back"})).unwrap_err().code,
            FailureCode::UnsupportedOp
        );
    }

    #[test]
    fn malformed_args_are_refused() {
        assert_eq!(
            parse_op("tap", &json!({"rect":{"x":1}})).unwrap_err().code,
            FailureCode::ActionFailed
        );
        assert_eq!(
            parse_op("tap", &json!({"rect":{"x":1,"y":2,"w":0,"h":4}}))
                .unwrap_err()
                .code,
            FailureCode::ActionFailed
        );
        assert_eq!(
            parse_op("setText", &json!({"text":"x"})).unwrap_err().code,
            FailureCode::ActionFailed
        );
    }

    #[test]
    fn scroll_amount_is_bounded() {
        let op = parse_op("scroll", &json!({"dir":"down","amount":99})).unwrap();
        match op {
            Op::Scroll { dir, amount, .. } => {
                assert_eq!(dir, ScrollDir::Down);
                assert_eq!(amount, 10);
            }
            _ => panic!("not a scroll"),
        }
    }

    #[test]
    fn gated_and_read_ops_are_classified() {
        for name in [
            "tap",
            "longPress",
            "swipe",
            "scroll",
            "type",
            "press",
            "setText",
        ] {
            let args = match name {
                "tap" => json!({"rect":{"x":1,"y":2,"w":3,"h":4}}),
                "longPress" => json!({"rect":{"x":1,"y":2,"w":3,"h":4}}),
                "swipe" => json!({"from":{"x":1,"y":2},"to":{"x":3,"y":4}}),
                "scroll" => json!({"dir":"up"}),
                "type" => json!({"text":"x"}),
                "press" => json!({"key":"Home"}),
                _ => json!({"ref":"n0","text":"x"}),
            };
            assert!(parse_op(name, &args).unwrap().gated(), "{name}");
        }
        for name in ["screenshot", "find", "windows", "sleep", "status"] {
            let args = if name == "find" {
                json!({"query":{}})
            } else {
                json!({})
            };
            assert!(!parse_op(name, &args).unwrap().gated(), "{name}");
        }
    }
}
