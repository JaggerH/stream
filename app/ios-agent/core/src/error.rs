//! Structured failures.
//!
//! Every failure the device answers carries a machine-readable `code` and a human message, in
//! the shape the relay already forwards (`{error, code, semantics?}`). The code set is open;
//! callers treat an unknown code as a terminal failure.

use serde::{Deserialize, Serialize};

/// Machine-readable failure codes. The first block is the iOS device surface's own; the second
/// is inherited from the shared action contract so a caller sees the same codes on every surface.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum FailureCode {
    // iOS surface state.
    /// The phone's screen is locked (secure keyguard).
    Locked,
    /// The action reached a point only a person can complete (passcode prompt, system
    /// permission dialog, an unsupported third-party control).
    NeedsHuman,
    /// Another task holds the device for the length of the session lease.
    DeviceBusy,
    /// A developer service the action needs is not answering.
    ServiceUnavailable,
    /// No pairing record for this phone; the one-time setup has not been done.
    PairingMissing,
    /// The developer disk image is not mounted.
    DdiMissing,
    /// Developer Mode is off on the phone.
    DeveloperModeOff,
    // Shared action contract.
    /// The device's own gate classified a gated action as sensitive.
    ApprovalRequired,
    /// The screen changed between approval and execution.
    ApprovalStale,
    /// The approval credential has expired.
    ApprovalExpired,
    /// The credential was minted for another device, session, op or argument set.
    ApprovalMismatch,
    /// The credential has already been spent.
    ApprovalUsed,
    /// The foreground app is in a deny category: no reads and no actions.
    AppDenied,
    /// The action is not implemented on this surface; nothing was sent.
    UnsupportedOp,
    /// The agent does not know the op name at all.
    UnknownOp,
    /// A ref no longer names what it named when it was returned.
    StaleRef,
    /// The action was attempted and failed on the device.
    ActionFailed,
}

impl FailureCode {
    pub fn as_str(self) -> &'static str {
        match self {
            FailureCode::Locked => "locked",
            FailureCode::NeedsHuman => "needs-human",
            FailureCode::DeviceBusy => "device-busy",
            FailureCode::ServiceUnavailable => "service-unavailable",
            FailureCode::PairingMissing => "pairing-missing",
            FailureCode::DdiMissing => "ddi-missing",
            FailureCode::DeveloperModeOff => "developer-mode-off",
            FailureCode::ApprovalRequired => "approval-required",
            FailureCode::ApprovalStale => "approval-stale",
            FailureCode::ApprovalExpired => "approval-expired",
            FailureCode::ApprovalMismatch => "approval-mismatch",
            FailureCode::ApprovalUsed => "approval-used",
            FailureCode::AppDenied => "app-denied",
            FailureCode::UnsupportedOp => "unsupported-op",
            FailureCode::UnknownOp => "unknown-op",
            FailureCode::StaleRef => "stale-ref",
            FailureCode::ActionFailed => "action-failed",
        }
    }
}

impl std::fmt::Display for FailureCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The structured receipt of an `approval-required` answer. It names what was going to happen
/// and what the screen was, with no screen text and no credential value in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalSemantics {
    pub op: String,
    pub app: ApprovalApp,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub control: Option<ApprovalControl>,
    pub reasons: Vec<String>,
    #[serde(rename = "bindingDigest")]
    pub binding_digest: String,
    #[serde(rename = "screenDigest")]
    pub screen_digest: String,
    #[serde(rename = "snapshotRef", skip_serializing_if = "Option::is_none")]
    pub snapshot_ref: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalApp {
    pub package: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApprovalControl {
    pub role: String,
    /// The label, clipped and with credential-looking values masked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

/// One device-side failure.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentError {
    pub code: FailureCode,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantics: Option<ApprovalSemantics>,
}

impl AgentError {
    pub fn new(code: FailureCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            semantics: None,
        }
    }

    pub fn with_semantics(mut self, semantics: ApprovalSemantics) -> Self {
        self.semantics = Some(semantics);
        self
    }

    /// The frame the relay forwards. `error` keeps the historical `code: message` spelling.
    pub fn to_wire(&self) -> serde_json::Value {
        let mut obj = serde_json::Map::new();
        obj.insert(
            "error".into(),
            serde_json::Value::String(format!("{}: {}", self.code.as_str(), self.message)),
        );
        obj.insert(
            "code".into(),
            serde_json::Value::String(self.code.as_str().into()),
        );
        if let Some(semantics) = &self.semantics {
            obj.insert(
                "semantics".into(),
                serde_json::to_value(semantics).expect("semantics serialize"),
            );
        }
        serde_json::Value::Object(obj)
    }
}

impl std::fmt::Display for AgentError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AgentError {}

pub type AgentResult<T> = Result<T, AgentError>;
