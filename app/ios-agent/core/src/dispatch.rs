//! Op dispatch: capability check, state check, the gate, approval credentials, then the
//! surface action and its receipt.
//!
//! Order is fixed and observable: a caller that gets `approval-required` knows nothing was
//! performed; a caller that gets a receipt knows the action ran. The gate cannot be skipped —
//! there is no argument that turns it off, and every gated op rebuilds the snapshot it is
//! judged on rather than trusting the caller's view.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::ax::{digest_tree, hex, AppInfo, AxNode, Point, Rect, Snapshot};
use crate::caps::Hello;
use crate::error::{
    AgentError, AgentResult, ApprovalApp, ApprovalControl, ApprovalSemantics, FailureCode,
};
use crate::ops::{
    action_receipt, find_receipt, parse_op, screenshot_receipt, Op, PressKey, ScrollDir,
};
use crate::policy::gate::{kind_of, GatedOp};
use crate::policy::Policy;
use crate::surface::IosSurface;
use crate::version::{AutomationPath, IosVersion};

pub struct AgentConfig {
    pub device_id: String,
    pub device_name: String,
    pub agent_version: String,
    /// One automation session. Reconnects keep it; a new session invalidates credentials.
    pub session_id: String,
    pub ios_version: IosVersion,
    pub path: AutomationPath,
}

pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }
}

pub struct Agent<S: IosSurface> {
    config: AgentConfig,
    hello: Hello,
    policy: Policy,
    surface: S,
    /// The snapshot the caller last saw, for binding refs.
    readable: Mutex<Option<Snapshot>>,
    used_approvals: Mutex<HashSet<String>>,
    clock: Arc<dyn Clock>,
}

impl<S: IosSurface> Agent<S> {
    pub fn new(config: AgentConfig, surface: S, policy: Policy) -> Self {
        Self::with_clock(config, surface, policy, Arc::new(SystemClock))
    }

    pub fn with_clock(
        config: AgentConfig,
        surface: S,
        policy: Policy,
        clock: Arc<dyn Clock>,
    ) -> Self {
        let hello = Hello::for_device(
            config.device_id.clone(),
            config.device_name.clone(),
            config.agent_version.clone(),
            config.ios_version,
            config.path,
        );
        Self {
            config,
            hello,
            policy,
            surface,
            readable: Mutex::new(None),
            used_approvals: Mutex::new(HashSet::new()),
            clock,
        }
    }

    pub fn hello(&self) -> &Hello {
        &self.hello
    }

    /// The frame a relay sends after the WebSocket opens.
    pub fn hello_frame(&self) -> Value {
        serde_json::to_value(&self.hello).expect("hello serializes")
    }

    pub async fn dispatch(&self, name: &str, args: &Value) -> AgentResult<Value> {
        let op = parse_op(name, args)?;
        if self.config.path == AutomationPath::Unsupported {
            return Err(AgentError::new(
                FailureCode::ServiceUnavailable,
                format!(
                    "iOS {} has no supported automation path",
                    self.config.ios_version
                ),
            ));
        }
        if !self.hello.declares(op.name()) {
            return Err(AgentError::new(
                FailureCode::UnsupportedOp,
                format!("{} is not declared by this device", op.name()),
            ));
        }
        let state = self.surface.state();
        self.check_state(&op, &state)?;

        match op {
            Op::Sleep { ms } => {
                tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
                Ok(json!({}))
            }
            Op::Status => Ok(json!({
                "ok": true,
                "locked": state.locked,
                "busy": state.busy,
                "iosVersion": self.config.ios_version.to_string(),
                "path": self.config.path.as_str(),
                "ops": self.hello.ops,
            })),
            Op::Screenshot => {
                let snap = self.snapshot(true).await?;
                self.deny(&snap)?;
                let shot = self.surface.screenshot().await?;
                let base64 = base64_encode(&shot.png);
                Ok(screenshot_receipt(&base64, &shot.window, shot.scale))
            }
            Op::Windows => {
                let snap = self.snapshot(true).await?;
                self.deny(&snap)?;
                Ok(Value::Array(snap.windows()))
            }
            Op::Find { query, ocr } => {
                let snap = self.snapshot(true).await?;
                self.deny(&snap)?;
                Ok(find_receipt(snap.find(&query), ocr, snap.root.rect))
            }
            Op::Url => Err(AgentError::new(
                FailureCode::UnsupportedOp,
                "url has no meaning on a phone",
            )),
            Op::OpenApp { package, fresh } => {
                self.deny_app(&AppInfo {
                    package: package.clone(),
                    name: String::new(),
                })?;
                self.surface.launch_app(&package, fresh).await?;
                Ok(json!({ "ok": true, "fresh": fresh }))
            }
            _ => self.gated(op, args).await,
        }
    }

    fn check_state(&self, op: &Op, state: &crate::surface::ServiceState) -> AgentResult<()> {
        if self.config.path == AutomationPath::XctestSession && !state.bridge_available {
            return Err(AgentError::new(
                FailureCode::ServiceUnavailable,
                "the in-process XCTest bridge is not linked",
            ));
        }
        if !state.paired {
            return Err(AgentError::new(
                FailureCode::PairingMissing,
                "no pairing record; run the one-time setup",
            ));
        }
        if !state.developer_mode {
            return Err(AgentError::new(
                FailureCode::DeveloperModeOff,
                "Developer Mode is off",
            ));
        }
        if !state.ddi_mounted {
            return Err(AgentError::new(
                FailureCode::DdiMissing,
                "the developer disk image is not mounted",
            ));
        }
        let exempt_from_lock = matches!(op, Op::Status | Op::Sleep { .. } | Op::Windows | Op::Url);
        if state.locked && !exempt_from_lock {
            return Err(AgentError::new(FailureCode::Locked, "the screen is locked"));
        }
        if state.busy && !matches!(op, Op::Status | Op::Sleep { .. }) {
            return Err(AgentError::new(
                FailureCode::DeviceBusy,
                "another task holds this device",
            ));
        }
        Ok(())
    }

    async fn gated(&self, op: Op, args: &Value) -> AgentResult<Value> {
        let snap = self.snapshot(false).await?;
        self.deny(&snap)?;
        let resolved = self.resolve_target(&op, &snap)?;
        let typed = match &op {
            Op::Type { text } => Some(text.as_str()),
            _ => None,
        };
        let gate_op = gate_op(&op).expect("gated op");
        let reasons = self.policy.gate().reasons(
            gate_op,
            resolved.node,
            resolved.path.as_deref(),
            typed,
            &snap.app,
            Some(&snap.root),
            resolved.blind,
        );
        let approval = parse_approval(args)?;
        let consume = self.approve(&op, args, &snap, &resolved, &reasons, approval)?;

        let receipt = self.perform(&op, &snap, &resolved).await?;
        if let Some(id) = consume {
            self.used_approvals.lock().unwrap().insert(id);
        }
        Ok(receipt)
    }

    async fn perform(
        &self,
        op: &Op,
        _snap: &Snapshot,
        resolved: &Resolved<'_>,
    ) -> AgentResult<Value> {
        match op {
            Op::Tap { rect } => {
                self.surface.touch(rect.center(), 0).await?;
                Ok(action_receipt("hid"))
            }
            Op::LongPress { rect, duration_ms } => {
                self.surface.touch(rect.center(), *duration_ms).await?;
                Ok(action_receipt("hid"))
            }
            Op::Invoke { .. } => {
                let node = resolved.node.expect("invoke resolved a node");
                self.surface.touch(node.rect.center(), 0).await?;
                Ok(action_receipt("hid"))
            }
            Op::Swipe {
                from,
                to,
                duration_ms,
            } => {
                self.surface.swipe(*from, *to, *duration_ms).await?;
                Ok(action_receipt("hid"))
            }
            Op::Scroll { dir, amount, .. } => {
                self.surface.scroll(*dir, *amount).await?;
                Ok(action_receipt("hid"))
            }
            Op::Type { text } => {
                self.surface.type_text(text).await?;
                Ok(action_receipt("pasteboard"))
            }
            Op::SetText { id, text } => {
                let node = resolved.node.expect("setText resolved a node");
                self.surface.set_text(id, node, text).await?;
                let mut receipt = action_receipt("ax");
                receipt["confirmed"] = json!(false);
                if let Some(path) = &resolved.path {
                    if path != id {
                        receipt["relocated"] = json!(path);
                    }
                }
                Ok(receipt)
            }
            Op::Press { key } => {
                self.surface.press(*key).await?;
                Ok(action_receipt("hid"))
            }
            _ => Err(AgentError::new(
                FailureCode::UnsupportedOp,
                format!("{} is not a gated op", op.name()),
            )),
        }
    }

    /// Validates a supplied approval credential, or builds the `approval-required` receipt.
    /// Returns the credential id to consume after a successful action.
    fn approve(
        &self,
        op: &Op,
        args: &Value,
        snap: &Snapshot,
        resolved: &Resolved<'_>,
        reasons: &[String],
        approval: Option<ApprovalCredential>,
    ) -> AgentResult<Option<String>> {
        let binding = binding_digest(
            &self.config.device_id,
            &self.config.session_id,
            op.name(),
            args,
        );
        let Some(cred) = approval else {
            if reasons.is_empty() {
                return Ok(None);
            }
            return Err(AgentError::new(
                FailureCode::ApprovalRequired,
                format!("{} needs approval: {}", op.name(), reasons.join(", ")),
            )
            .with_semantics(self.semantics(op, snap, resolved, reasons, &binding)));
        };

        let now = self.clock.now_ms();
        if cred.expires_at_ms <= now {
            return Err(AgentError::new(
                FailureCode::ApprovalExpired,
                "the approval credential has expired",
            ));
        }
        if cred.binding_digest != binding {
            return Err(AgentError::new(
                FailureCode::ApprovalMismatch,
                "the approval credential was minted for another device, session, op or arguments",
            ));
        }
        if self.used_approvals.lock().unwrap().contains(&cred.id) {
            return Err(AgentError::new(
                FailureCode::ApprovalUsed,
                "the approval credential has already been used",
            ));
        }
        if cred.screen_digest != snap.screen_digest() {
            return Err(AgentError::new(
                FailureCode::ApprovalStale,
                "the screen changed since the approval was granted",
            ));
        }
        Ok(Some(cred.id))
    }

    fn semantics(
        &self,
        op: &Op,
        snap: &Snapshot,
        resolved: &Resolved<'_>,
        reasons: &[String],
        binding: &str,
    ) -> ApprovalSemantics {
        let category = self.policy.category_name(&snap.app);
        let control = resolved.node.map(|node| {
            let label = clip(&node.name, 80);
            let masked = if node.password
                || self.policy.detect.is_credential_field(
                    node.password,
                    &node.name,
                    node.view_id.as_deref().unwrap_or(""),
                ) {
                "••••".to_string()
            } else {
                label
            };
            ApprovalControl {
                role: node.role.clone(),
                label: if masked.is_empty() {
                    None
                } else {
                    Some(masked)
                },
            }
        });
        ApprovalSemantics {
            op: op.name().to_string(),
            app: ApprovalApp {
                package: snap.app.package.clone(),
                name: snap.app.name.clone(),
                category,
            },
            control,
            reasons: reasons.to_vec(),
            binding_digest: binding.to_string(),
            screen_digest: snap.screen_digest().to_string(),
            snapshot_ref: Some(snap.snapshot_ref.clone()),
        }
    }

    async fn snapshot(&self, remember: bool) -> AgentResult<Snapshot> {
        let snap = self.surface.snapshot().await?;
        if remember {
            *self.readable.lock().unwrap() = Some(snap.clone());
        }
        Ok(snap)
    }

    fn deny(&self, snap: &Snapshot) -> AgentResult<()> {
        self.deny_app(&snap.app)
    }

    fn deny_app(&self, app: &AppInfo) -> AgentResult<()> {
        if self.policy.denied(app) {
            return Err(AgentError::new(
                FailureCode::AppDenied,
                format!("{} is in a deny category", display_app(app)),
            ));
        }
        Ok(())
    }

    /// Resolves the node an op lands on, failing a ref that no longer names what it did.
    fn resolve_target<'a>(&'a self, op: &Op, snap: &'a Snapshot) -> AgentResult<Resolved<'a>> {
        match op {
            Op::Tap { rect } | Op::LongPress { rect, .. } => {
                let point = rect.center();
                Ok(Resolved::at_point(snap, point))
            }
            Op::Invoke { id } => self.resolve_ref(id, snap),
            Op::SetText { id, .. } => self.resolve_ref(id, snap),
            Op::Swipe { from, .. } => Ok(Resolved::at_point(snap, *from)),
            Op::Scroll { .. } => Ok(Resolved::none()),
            Op::Type { .. } => {
                let target = snap.focused_input();
                Ok(match target {
                    Some((path, node)) => Resolved {
                        path: Some(path),
                        node: Some(node),
                        blind: false,
                    },
                    None => Resolved::none(),
                })
            }
            Op::Press { key } => {
                // Only Enter submits. Home, Lock and the volume keys are hardware buttons and
                // are not judged as commits; they still passed the state checks above.
                if *key != PressKey::Enter {
                    return Ok(Resolved::none());
                }
                let target = snap.focused_input();
                Ok(match target {
                    Some((path, node)) => Resolved {
                        path: Some(path),
                        node: Some(node),
                        blind: false,
                    },
                    None => Resolved::none(),
                })
            }
            _ => Ok(Resolved::none()),
        }
    }

    fn resolve_ref<'a>(&'a self, id: &str, snap: &'a Snapshot) -> AgentResult<Resolved<'a>> {
        let previous = self.readable.lock().unwrap().clone();
        let Some(previous) = previous else {
            return Err(stale_ref(id));
        };
        let Some(old) = previous.node_by_ref(id) else {
            return Err(stale_ref(id));
        };
        let fp = fingerprint(old);
        if let Some(node) = snap.node_by_ref(id) {
            if fingerprint(node) == fp {
                return Ok(Resolved {
                    path: Some(id.to_string()),
                    node: Some(node),
                    blind: false,
                });
            }
        }
        // The tree moved the node: accept it only if exactly one node still matches what the
        // caller saw.
        let matches: Vec<(String, &AxNode)> = snap
            .walk()
            .into_iter()
            .filter(|(_, n)| fingerprint(n) == fp)
            .collect();
        if matches.len() == 1 {
            let (path, node) = &matches[0];
            return Ok(Resolved {
                path: Some(path.clone()),
                node: Some(node),
                blind: false,
            });
        }
        Err(stale_ref(id))
    }
}

struct Resolved<'a> {
    path: Option<String>,
    node: Option<&'a AxNode>,
    blind: bool,
}

impl<'a> Resolved<'a> {
    fn none() -> Self {
        Self {
            path: None,
            node: None,
            blind: false,
        }
    }

    fn at_point(snap: &'a Snapshot, point: Point) -> Self {
        match snap.deepest_at(point) {
            Some((path, node)) => Self {
                path: Some(path),
                node: Some(node),
                blind: node.label().is_empty(),
            },
            None => Self {
                path: None,
                node: None,
                blind: true,
            },
        }
    }
}

fn stale_ref(id: &str) -> AgentError {
    AgentError::new(
        FailureCode::StaleRef,
        format!("{id} no longer names the control it was found on"),
    )
}

fn gate_op(op: &Op) -> Option<GatedOp> {
    match op {
        Op::Tap { .. } => Some(GatedOp::Tap),
        Op::LongPress { .. } => Some(GatedOp::LongPress),
        Op::Invoke { .. } => Some(GatedOp::Invoke),
        Op::Type { .. } => Some(GatedOp::Type),
        Op::Press { .. } => Some(GatedOp::Press),
        Op::SetText { .. } => Some(GatedOp::SetText),
        Op::Scroll { .. } => Some(GatedOp::Scroll),
        Op::Swipe { .. } => Some(GatedOp::Swipe),
        _ => None,
    }
}

fn display_app(app: &AppInfo) -> String {
    if app.name.is_empty() {
        app.package.clone()
    } else {
        format!("{} ({})", app.name, app.package)
    }
}

fn clip(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn fingerprint(node: &AxNode) -> String {
    let mut hasher = Sha256::new();
    hasher.update(node.role.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(node.name.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(node.view_id.as_deref().unwrap_or("").as_bytes());
    hasher.update(b"\x1f");
    for v in [node.rect.x, node.rect.y, node.rect.w, node.rect.h] {
        hasher.update((v.round() as i64).to_le_bytes());
    }
    hasher.update([
        node.clickable as u8,
        node.editable as u8,
        node.scrollable as u8,
    ]);
    hex(&hasher.finalize())
}

// ---- approval credentials ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct ApprovalCredential {
    id: String,
    binding_digest: String,
    screen_digest: String,
    expires_at_ms: u64,
}

fn parse_approval(args: &Value) -> AgentResult<Option<ApprovalCredential>> {
    let Some(value) = args.get("approval") else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    let id = value
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| bad_approval("approval.id is required"))?;
    let binding_digest = value
        .get("bindingDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_approval("approval.bindingDigest is required"))?;
    let screen_digest = value
        .get("screenDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| bad_approval("approval.screenDigest is required"))?;
    let expires_at_ms = value
        .get("expiresAt")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        })
        .ok_or_else(|| bad_approval("approval.expiresAt is required (epoch milliseconds)"))?;
    Ok(Some(ApprovalCredential {
        id: id.to_string(),
        binding_digest: binding_digest.to_string(),
        screen_digest: screen_digest.to_string(),
        expires_at_ms,
    }))
}

fn bad_approval(message: &str) -> AgentError {
    AgentError::new(FailureCode::ApprovalMismatch, message)
}

/// `digest(device, session, op, canonical args without the credential)`.
pub fn binding_digest(device: &str, session: &str, op: &str, args: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(device.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(session.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(op.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(canonical(args).as_bytes());
    hex(&hasher.finalize())
}

fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().filter(|k| k.as_str() != "approval").collect();
            keys.sort();
            let mut out = String::from("{");
            for (i, key) in keys.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).expect("key serializes"));
                out.push(':');
                out.push_str(&canonical(&map[*key]));
            }
            out.push('}');
            out
        }
        Value::Array(items) => {
            let mut out = String::from("[");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(&canonical(item));
            }
            out.push(']');
            out
        }
        other => serde_json::to_string(other).expect("scalar serializes"),
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Re-exported for tests and for the transport's own receipt building.
pub fn screen_digest_of(root: &AxNode) -> String {
    digest_tree(root)
}

/// A scroll gesture's endpoints, used by surfaces that do not implement their own curve.
pub fn scroll_swipe(
    geometry: crate::surface::DisplayGeometry,
    dir: ScrollDir,
    amount: u8,
) -> (Point, Point, u32) {
    let steps = amount.clamp(1, 10) as f64;
    let distance = geometry.height * (0.12 + 0.06 * steps).min(0.72);
    let (from_y, to_y) = match dir {
        ScrollDir::Down => (geometry.height * 0.72, geometry.height * 0.72 - distance),
        ScrollDir::Up => (geometry.height * 0.28, geometry.height * 0.28 + distance),
    };
    (
        Point {
            x: geometry.width / 2.0,
            y: from_y.max(1.0),
        },
        Point {
            x: geometry.width / 2.0,
            y: to_y.max(1.0),
        },
        320,
    )
}

/// The reasons a gate answer maps to, for tests and for callers that want to label a refusal.
pub fn reason_kind(reason: &str) -> Option<&'static str> {
    kind_of(reason)
}

/// The rect a tap op covers; used by tests.
pub fn tap_center(rect: Rect) -> Point {
    rect.center()
}
