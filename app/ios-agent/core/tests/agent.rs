//! End-to-end (in-process) tests of the dispatcher, gate, refs and approval credentials over a
//! recording fake surface. No phone is involved; the snapshot fixture is constructed, not
//! captured from a device.

use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

use stream_ios_agent::ax::{AppInfo, AxNode, Point, Rect, Snapshot};
use stream_ios_agent::dispatch::{binding_digest, Agent, AgentConfig, Clock};
use stream_ios_agent::error::FailureCode;
use stream_ios_agent::ops::{PressKey, ScrollDir};
use stream_ios_agent::surface::{DisplayGeometry, IosSurface, Screenshot, ServiceState};
use stream_ios_agent::version::{AutomationPath, IosVersion};
use stream_ios_agent::Policy;

#[derive(Debug, Clone, PartialEq)]
enum Call {
    Touch(Point, u32),
    Swipe(Point, Point, u32),
    Type(String),
    SetText(String, String),
    Press(PressKey),
    Screenshot,
    Launch(String, bool),
    Scroll(ScrollDir, u8),
}

#[derive(Clone)]
struct FakeSurface {
    state: Arc<Mutex<ServiceState>>,
    snapshot: Arc<Mutex<Snapshot>>,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl FakeSurface {
    fn new(snapshot: Snapshot) -> Self {
        Self {
            state: Arc::new(Mutex::new(ServiceState::default())),
            snapshot: Arc::new(Mutex::new(snapshot)),
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn set_state(&self, state: ServiceState) {
        *self.state.lock().unwrap() = state;
    }

    fn set_snapshot(&self, snapshot: Snapshot) {
        *self.snapshot.lock().unwrap() = snapshot;
    }
}

impl IosSurface for FakeSurface {
    fn state(&self) -> ServiceState {
        *self.state.lock().unwrap()
    }

    fn geometry(&self) -> DisplayGeometry {
        DisplayGeometry::default()
    }

    async fn snapshot(&self) -> Result<Snapshot, stream_ios_agent::AgentError> {
        Ok(self.snapshot.lock().unwrap().clone())
    }

    async fn touch(
        &self,
        point: Point,
        duration_ms: u32,
    ) -> Result<(), stream_ios_agent::AgentError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Touch(point, duration_ms));
        Ok(())
    }

    async fn swipe(
        &self,
        from: Point,
        to: Point,
        duration_ms: u32,
    ) -> Result<(), stream_ios_agent::AgentError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Swipe(from, to, duration_ms));
        Ok(())
    }

    async fn type_text(&self, text: &str) -> Result<(), stream_ios_agent::AgentError> {
        self.calls.lock().unwrap().push(Call::Type(text.into()));
        Ok(())
    }

    async fn set_text(
        &self,
        id: &str,
        _node: &AxNode,
        text: &str,
    ) -> Result<(), stream_ios_agent::AgentError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::SetText(id.into(), text.into()));
        Ok(())
    }

    async fn press(&self, key: PressKey) -> Result<(), stream_ios_agent::AgentError> {
        self.calls.lock().unwrap().push(Call::Press(key));
        Ok(())
    }

    async fn screenshot(&self) -> Result<Screenshot, stream_ios_agent::AgentError> {
        self.calls.lock().unwrap().push(Call::Screenshot);
        Ok(Screenshot {
            png: b"png-bytes".to_vec(),
            window: "com.example.app".into(),
            scale: 3.0,
        })
    }

    async fn launch_app(
        &self,
        package: &str,
        fresh: bool,
    ) -> Result<(), stream_ios_agent::AgentError> {
        self.calls
            .lock()
            .unwrap()
            .push(Call::Launch(package.into(), fresh));
        Ok(())
    }

    async fn scroll(&self, dir: ScrollDir, amount: u8) -> Result<(), stream_ios_agent::AgentError> {
        self.calls.lock().unwrap().push(Call::Scroll(dir, amount));
        Ok(())
    }
}

struct FixedClock(u64);

impl Clock for FixedClock {
    fn now_ms(&self) -> u64 {
        self.0
    }
}

fn app(package: &str, name: &str) -> AppInfo {
    AppInfo {
        package: package.into(),
        name: name.into(),
    }
}

fn window(children: Vec<AxNode>) -> AxNode {
    let mut root = AxNode::new("Window", "", Rect::new(0.0, 0.0, 390.0, 844.0));
    root.children = children;
    root
}

fn snapshot(app_info: AppInfo, children: Vec<AxNode>) -> Snapshot {
    Snapshot::build(window(children), app_info)
}

fn pay_button() -> AxNode {
    AxNode::new("Button", "立即支付", Rect::new(20.0, 700.0, 350.0, 44.0)).clickable()
}

fn ordinary_button() -> AxNode {
    AxNode::new("Button", "Settings", Rect::new(20.0, 100.0, 350.0, 44.0)).clickable()
}

fn browser_snapshot() -> Snapshot {
    snapshot(
        app("com.apple.mobilesafari", "Safari"),
        vec![ordinary_button()],
    )
}

fn config(version: IosVersion, path: AutomationPath) -> AgentConfig {
    AgentConfig {
        device_id: "ios:test".into(),
        device_name: "Test iPhone".into(),
        agent_version: "0.1.0".into(),
        session_id: "session-1".into(),
        ios_version: version,
        path,
    }
}

fn agent(surface: FakeSurface) -> Agent<FakeSurface> {
    Agent::new(
        config(IosVersion::new(27, 0), AutomationPath::NativeAccessibility),
        surface,
        Policy::embedded().unwrap(),
    )
}

fn agent_with_clock(surface: FakeSurface, now: u64) -> Agent<FakeSurface> {
    Agent::with_clock(
        config(IosVersion::new(27, 0), AutomationPath::NativeAccessibility),
        surface,
        Policy::embedded().unwrap(),
        std::sync::Arc::new(FixedClock(now)),
    )
}

fn tap_args(rect: Rect) -> Value {
    json!({"rect":{"x":rect.x,"y":rect.y,"w":rect.w,"h":rect.h}})
}

// ---- capabilities and state ---------------------------------------------------------

#[test]
fn hello_announces_the_ios_path() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let hello = a.hello_frame();
    assert_eq!(hello["platform"], "ios");
    assert_eq!(hello["path"], "native-accessibility");
    assert_eq!(hello["caps"]["ui.tree"]["v"], 7);
    assert!(hello["ops"].as_array().unwrap().iter().any(|v| v == "tap"));
    assert!(!hello["ops"].as_array().unwrap().iter().any(|v| v == "url"));
}

#[tokio::test]
async fn ios_below_18_is_service_unavailable() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = Agent::new(
        config(IosVersion::new(17, 7), AutomationPath::Unsupported),
        surface,
        Policy::embedded().unwrap(),
    );
    let err = a.dispatch("windows", &json!({})).await.unwrap_err();
    assert_eq!(err.code, FailureCode::ServiceUnavailable);
}

#[tokio::test]
async fn xctest_path_without_bridge_is_service_unavailable() {
    let surface = FakeSurface::new(browser_snapshot());
    surface.set_state(ServiceState {
        bridge_available: false,
        ..Default::default()
    });
    let a = Agent::new(
        config(IosVersion::new(20, 0), AutomationPath::XctestSession),
        surface,
        Policy::embedded().unwrap(),
    );
    let err = a
        .dispatch("tap", &tap_args(Rect::new(20.0, 100.0, 100.0, 44.0)))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::ServiceUnavailable);
}

#[tokio::test]
async fn state_codes_are_distinct() {
    for (state, code) in [
        (
            ServiceState {
                paired: false,
                ..Default::default()
            },
            FailureCode::PairingMissing,
        ),
        (
            ServiceState {
                developer_mode: false,
                ..Default::default()
            },
            FailureCode::DeveloperModeOff,
        ),
        (
            ServiceState {
                ddi_mounted: false,
                ..Default::default()
            },
            FailureCode::DdiMissing,
        ),
        (
            ServiceState {
                locked: true,
                ..Default::default()
            },
            FailureCode::Locked,
        ),
        (
            ServiceState {
                busy: true,
                ..Default::default()
            },
            FailureCode::DeviceBusy,
        ),
    ] {
        let surface = FakeSurface::new(browser_snapshot());
        surface.set_state(state);
        let a = agent(surface);
        let err = a
            .dispatch("tap", &tap_args(Rect::new(20.0, 100.0, 100.0, 44.0)))
            .await
            .unwrap_err();
        assert_eq!(err.code, code, "{state:?}");
    }
}

#[tokio::test]
async fn find_is_blocked_while_locked_and_windows_is_exempt() {
    let surface = FakeSurface::new(browser_snapshot());
    surface.set_state(ServiceState {
        locked: true,
        ..Default::default()
    });
    let a = agent(surface);
    assert_eq!(
        a.dispatch("find", &json!({"query":{}}))
            .await
            .unwrap_err()
            .code,
        FailureCode::Locked
    );
    // windows is exempt from the keyguard check, like Android's
    assert!(a.dispatch("windows", &json!({})).await.is_ok());
}

#[tokio::test]
async fn status_reports_the_path() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let out = a.dispatch("status", &json!({})).await.unwrap();
    assert_eq!(out["path"], "native-accessibility");
    assert_eq!(out["iosVersion"], "27.0");
}

// ---- reads --------------------------------------------------------------------------

#[tokio::test]
async fn find_returns_elements_and_ocr_degrades() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let out = a
        .dispatch("find", &json!({"query":{"name":"Settings"},"ocr":"on"}))
        .await
        .unwrap();
    let elements = out["elements"].as_array().unwrap();
    assert_eq!(elements.len(), 1);
    assert_eq!(elements[0]["name"], "Settings");
    assert_eq!(out["ocr"]["requested"], "on");
    assert_eq!(out["ocr"]["used"], false);
    assert_eq!(out["ocr"]["degraded"], "ocr-unsupported");
}

#[tokio::test]
async fn screenshot_is_base64_png() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let out = a.dispatch("screenshot", &json!({})).await.unwrap();
    assert_eq!(out["base64"], "cG5nLWJ5dGVz");
    assert_eq!(out["scale"], 3.0);
}

#[tokio::test]
async fn denied_category_hides_reads_and_actions() {
    let snap = snapshot(
        app("com.eg.android.AlipayGphone", "支付宝"),
        vec![pay_button()],
    );
    let surface = FakeSurface::new(snap);
    let a = agent(surface);
    assert_eq!(
        a.dispatch("find", &json!({"query":{}}))
            .await
            .unwrap_err()
            .code,
        FailureCode::AppDenied
    );
    assert_eq!(
        a.dispatch("openApp", &json!({"package":"com.apple.Passbook"}))
            .await
            .unwrap_err()
            .code,
        FailureCode::AppDenied
    );
}

#[tokio::test]
async fn open_app_launches() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let out = a
        .dispatch(
            "openApp",
            &json!({"package":"com.apple.Preferences","fresh":true}),
        )
        .await
        .unwrap();
    assert_eq!(out["ok"], true);
    assert!(a.hello().declares("openApp"));
}

// ---- the gate -----------------------------------------------------------------------

#[tokio::test]
async fn commit_tap_needs_approval_and_does_nothing() {
    let snap = snapshot(app("com.taobao.taobao4iphone", "淘宝"), vec![pay_button()]);
    let surface = FakeSurface::new(snap.clone());
    let calls = surface.calls.clone();
    let a = agent(surface);
    let err = a
        .dispatch("tap", &tap_args(Rect::new(20.0, 700.0, 350.0, 44.0)))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::ApprovalRequired);
    let semantics = err.semantics.unwrap();
    assert!(semantics.reasons.iter().any(|r| r == "commit-label"));
    assert!(semantics.reasons.iter().any(|r| r == "payment-label"));
    assert_eq!(semantics.app.category.as_deref(), Some("shopping"));
    assert_eq!(semantics.control.unwrap().role, "Button");
    assert_eq!(semantics.screen_digest, snap.screen_digest());
    assert!(calls.lock().unwrap().is_empty(), "nothing may be performed");
}

#[tokio::test]
async fn ordinary_tap_runs() {
    let surface = FakeSurface::new(browser_snapshot());
    let calls = surface.calls.clone();
    let a = agent(surface);
    let out = a
        .dispatch("tap", &tap_args(Rect::new(20.0, 100.0, 350.0, 44.0)))
        .await
        .unwrap();
    assert_eq!(out["via"], "hid");
    assert_eq!(
        calls.lock().unwrap().clone(),
        vec![Call::Touch(Point { x: 195.0, y: 122.0 }, 0)]
    );
}

#[tokio::test]
async fn newline_typing_in_messaging_gates() {
    let field = AxNode::new("TextField", "Message", Rect::new(20.0, 700.0, 300.0, 40.0))
        .editable()
        .focused();
    let surface = FakeSurface::new(snapshot(app("com.tencent.xin", "WeChat"), vec![field]));
    let a = agent(surface);
    let err = a
        .dispatch("type", &json!({"text":"hi\n"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::ApprovalRequired);
    assert!(err
        .semantics
        .unwrap()
        .reasons
        .iter()
        .any(|r| r == "message-send"));
}

#[tokio::test]
async fn enter_in_messaging_needs_approval_but_home_does_not() {
    let field = AxNode::new("TextField", "Message", Rect::new(20.0, 700.0, 300.0, 40.0))
        .editable()
        .focused();
    let surface = FakeSurface::new(snapshot(app("com.tencent.xin", "WeChat"), vec![field]));
    let a = agent(surface);
    let err = a
        .dispatch("press", &json!({"key":"Enter"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::ApprovalRequired);
    assert!(a.dispatch("press", &json!({"key":"Home"})).await.is_ok());
}

#[tokio::test]
async fn back_is_refused_before_anything_is_sent() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let err = a
        .dispatch("press", &json!({"key":"Back"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::UnsupportedOp);
}

#[tokio::test]
async fn slider_swipe_gates() {
    let slider = AxNode::new(
        "Slider",
        "滑动支付 ¥12.00",
        Rect::new(20.0, 700.0, 350.0, 50.0),
    );
    let surface = FakeSurface::new(snapshot(
        app("com.taobao.taobao4iphone", "淘宝"),
        vec![slider],
    ));
    let a = agent(surface);
    let err = a
        .dispatch(
            "swipe",
            &json!({"from":{"x":30.0,"y":725.0},"to":{"x":350.0,"y":725.0}}),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::ApprovalRequired);
    assert!(err
        .semantics
        .unwrap()
        .reasons
        .iter()
        .any(|r| r == "payment-label"));
}

// ---- approval credentials -----------------------------------------------------------

fn commit_setup() -> (FakeSurface, Snapshot) {
    let snap = snapshot(app("com.taobao.taobao4iphone", "淘宝"), vec![pay_button()]);
    (FakeSurface::new(snap.clone()), snap)
}

fn credential(snap: &Snapshot, args: &Value, id: &str, expires_at: u64) -> Value {
    json!({
        "id": id,
        "bindingDigest": binding_digest("ios:test", "session-1", "tap", args),
        "screenDigest": snap.screen_digest(),
        "expiresAt": expires_at,
    })
}

#[tokio::test]
async fn a_valid_credential_executes_once() {
    let (surface, snap) = commit_setup();
    let calls = surface.calls.clone();
    let a = agent_with_clock(surface, 1_000);
    let rect = Rect::new(20.0, 700.0, 350.0, 44.0);
    let base = tap_args(rect);
    let mut args = base.clone();
    args["approval"] = credential(&snap, &base, "cred-1", 61_000);
    let out = a.dispatch("tap", &args).await.unwrap();
    assert_eq!(out["via"], "hid");
    assert_eq!(calls.lock().unwrap().len(), 1);
    // Replaying the same credential is refused and performs nothing.
    let err = a.dispatch("tap", &args).await.unwrap_err();
    assert_eq!(err.code, FailureCode::ApprovalUsed);
    assert_eq!(calls.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn expired_mismatched_and_stale_credentials_are_distinct() {
    let (surface, snap) = commit_setup();
    let a = agent_with_clock(surface, 1_000);
    let rect = Rect::new(20.0, 700.0, 350.0, 44.0);
    let base = tap_args(rect);

    let mut expired = base.clone();
    expired["approval"] = credential(&snap, &base, "c-exp", 1_000);
    assert_eq!(
        a.dispatch("tap", &expired).await.unwrap_err().code,
        FailureCode::ApprovalExpired
    );

    let mut mismatched = base.clone();
    let mut other = base.clone();
    other["rect"] = json!({"x":1.0,"y":2.0,"w":3.0,"h":4.0});
    mismatched["approval"] = credential(&snap, &other, "c-mis", 61_000);
    assert_eq!(
        a.dispatch("tap", &mismatched).await.unwrap_err().code,
        FailureCode::ApprovalMismatch
    );

    let mut stale = base.clone();
    let mut cred = credential(&snap, &base, "c-stale", 61_000);
    cred["screenDigest"] = json!("deadbeef");
    stale["approval"] = cred;
    assert_eq!(
        a.dispatch("tap", &stale).await.unwrap_err().code,
        FailureCode::ApprovalStale
    );
}

// ---- refs ---------------------------------------------------------------------------

fn editable_snapshot(name: &str) -> Snapshot {
    snapshot(
        app("com.apple.mobilesafari", "Safari"),
        vec![AxNode::new("TextField", name, Rect::new(20.0, 100.0, 300.0, 40.0)).editable()],
    )
}

#[tokio::test]
async fn set_text_uses_a_ref_from_find() {
    let surface = FakeSurface::new(editable_snapshot("Search"));
    let calls = surface.calls.clone();
    let a = agent(surface);
    let found = a
        .dispatch("find", &json!({"query":{"role":"TextField"}}))
        .await
        .unwrap();
    let id = found["elements"][0]["ref"].as_str().unwrap().to_string();
    let out = a
        .dispatch("setText", &json!({"ref":id,"text":"hello"}))
        .await
        .unwrap();
    assert_eq!(out["via"], "ax");
    assert_eq!(
        calls.lock().unwrap().clone(),
        vec![Call::SetText(id, "hello".into())]
    );
}

#[tokio::test]
async fn a_moved_control_relocates_by_identity() {
    let surface = FakeSurface::new(editable_snapshot("Search"));
    let handle = surface.clone();
    let a = agent(surface);
    let found = a
        .dispatch("find", &json!({"query":{"role":"TextField"}}))
        .await
        .unwrap();
    let id = found["elements"][0]["ref"].as_str().unwrap().to_string();

    // A container appears: the same field moves one level down but keeps its identity.
    let mut root = window(vec![]);
    root.children = vec![editable_snapshot("Search").root];
    handle.set_snapshot(Snapshot::build(
        root,
        app("com.apple.mobilesafari", "Safari"),
    ));

    let out = a
        .dispatch("setText", &json!({"ref":id,"text":"x"}))
        .await
        .unwrap();
    assert_eq!(out["relocated"], "n0.n0.n0");
}

#[tokio::test]
async fn a_ref_whose_control_changed_is_stale() {
    let surface = FakeSurface::new(editable_snapshot("Search"));
    let handle = surface.clone();
    let a = agent(surface);
    let found = a
        .dispatch("find", &json!({"query":{"role":"TextField"}}))
        .await
        .unwrap();
    let id = found["elements"][0]["ref"].as_str().unwrap().to_string();
    // The same path now names a different control.
    handle.set_snapshot(editable_snapshot("Password"));
    let err = a
        .dispatch("setText", &json!({"ref":id,"text":"x"}))
        .await
        .unwrap_err();
    assert_eq!(err.code, FailureCode::StaleRef);
}

#[tokio::test]
async fn invoke_taps_a_found_node() {
    let surface = FakeSurface::new(browser_snapshot());
    let a = agent(surface);
    let found = a
        .dispatch("find", &json!({"query":{"name":"Settings"}}))
        .await
        .unwrap();
    let id = found["elements"][0]["ref"].as_str().unwrap().to_string();
    let out = a.dispatch("invoke", &json!({"ref":id})).await.unwrap();
    assert_eq!(out["via"], "hid");
}

// ---- gestures and unsupported ops ---------------------------------------------------

#[tokio::test]
async fn swipe_scroll_and_long_press_reach_the_surface() {
    let surface = FakeSurface::new(browser_snapshot());
    let calls = surface.calls.clone();
    let a = agent(surface);
    a.dispatch(
        "swipe",
        &json!({"from":{"x":10.0,"y":10.0},"to":{"x":20.0,"y":200.0},"durationMs":200}),
    )
    .await
    .unwrap();
    a.dispatch("scroll", &json!({"dir":"up","amount":2}))
        .await
        .unwrap();
    a.dispatch("longPress", &tap_args(Rect::new(20.0, 100.0, 350.0, 44.0)))
        .await
        .unwrap();
    let calls = calls.lock().unwrap().clone();
    assert!(matches!(calls[0], Call::Swipe(_, _, 200)));
    assert!(matches!(calls[1], Call::Scroll(ScrollDir::Up, 2)));
    assert!(matches!(calls[2], Call::Touch(_, 900)));
}

#[tokio::test]
async fn url_and_undeclared_ops_fail_before_the_surface() {
    let surface = FakeSurface::new(browser_snapshot());
    let calls = surface.calls.clone();
    let a = agent(surface);
    assert_eq!(
        a.dispatch("url", &json!({})).await.unwrap_err().code,
        FailureCode::UnsupportedOp
    );
    assert_eq!(
        a.dispatch("readText", &json!({})).await.unwrap_err().code,
        FailureCode::UnsupportedOp
    );
    assert_eq!(
        a.dispatch("fly", &json!({})).await.unwrap_err().code,
        FailureCode::UnknownOp
    );
    assert!(calls.lock().unwrap().is_empty());
}

// ---- the constructed fixture --------------------------------------------------------

#[test]
fn the_fixture_is_a_complete_snapshot() {
    let raw = include_str!("fixtures/payment-screen.json");
    let fixture: serde_json::Value = serde_json::from_str(raw).unwrap();
    let app: AppInfo = serde_json::from_value(fixture["app"].clone()).unwrap();
    let root: AxNode = serde_json::from_value(fixture["root"].clone()).unwrap();
    let snap = Snapshot::build(root, app);
    let pay = snap.find(&stream_ios_agent::Query {
        name: Some("立即支付".into()),
        ..Default::default()
    });
    assert_eq!(pay.len(), 1);
    assert_eq!(pay[0].rect.w, 350.0);
}
