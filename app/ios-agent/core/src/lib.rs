//! The on-device core of the Stream iOS executor.
//!
//! The phone's app drives itself: a loopback tunnel reaches the phone's own developer services,
//! and this crate turns the shared action vocabulary into accessibility, display and HID
//! operations on that phone. It has no dependency on a computer at run time and no network
//! listener; the app shell owns the WebSocket to the backend and the loopback VPN.
//!
//! Layers:
//!
//! * [`ax`] — the snapshot model, refs, queries and digests.
//! * [`policy`] — the word/category tables, label detection and the device-side gate.
//! * [`ops`] — the normalized action vocabulary, its iOS mapping and the receipts.
//! * [`caps`] — the `hello` manifest and the iOS-version → path decision.
//! * [`dispatch`] — state checks, the gate, approval credentials and the surface call.
//! * [`surface`] — the narrow trait a transport implements.
//! * [`transport`] — the idevice-backed native surface (feature `device`).
//!
//! Protocol, gate, refs and approval rules are host-testable and covered by fixtures; the
//! transport is platform code and is verified against a real phone.
//!
//! The surface trait uses native `async fn`; it is only used through generics in this crate, so
//! the auto-trait caveat of async-in-trait does not apply.
#![allow(async_fn_in_trait)]
// The structured error carries optional approval semantics; boxing it would complicate every
// caller for a few dozen bytes on the failure path only.
#![allow(clippy::result_large_err)]

pub mod ax;
pub mod caps;
pub mod dispatch;
pub mod error;
pub mod ops;
pub mod policy;
pub mod surface;
pub mod version;

#[cfg(feature = "device")]
pub mod transport;

pub use ax::{AppInfo, AxNode, Element, Point, Query, Rect, Snapshot};
pub use caps::{Capability, Hello, CAPS_VERSION};
pub use dispatch::{Agent, AgentConfig, Clock, SystemClock};
pub use error::{AgentError, AgentResult, ApprovalSemantics, FailureCode};
pub use ops::{OcrMode, Op, PressKey, ScrollDir};
pub use policy::Policy;
pub use surface::{DisplayGeometry, IosSurface, Screenshot, ServiceState};
pub use version::{AutomationPath, IosVersion};
