//! The executor surface the dispatcher talks to.
//!
//! One implementation drives the phone's native services (`transport::native`); tests use a
//! recording fake. Keeping this boundary narrow is what lets the protocol layer, the gate and
//! the ref/approval rules be exercised on a Linux host with no iPhone attached.

use crate::ax::{AxNode, Point, Snapshot};
use crate::error::AgentResult;
use crate::ops::{PressKey, ScrollDir};

/// What the platform reports about itself. The failure codes are decided from these facts, not
/// guessed from a failed action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServiceState {
    /// The screen is locked with a passcode.
    pub locked: bool,
    /// Another task holds the device for this session lease.
    pub busy: bool,
    /// A pairing record exists for this phone.
    pub paired: bool,
    /// The developer disk image is mounted.
    pub ddi_mounted: bool,
    /// Developer Mode is on.
    pub developer_mode: bool,
    /// The in-process XCTest bridge is linked and ready (the iOS 18–26 path).
    pub bridge_available: bool,
}

impl Default for ServiceState {
    fn default() -> Self {
        Self {
            locked: false,
            busy: false,
            paired: true,
            ddi_mounted: true,
            developer_mode: true,
            bridge_available: true,
        }
    }
}

/// Screen geometry in points, plus the pixel scale. HID coordinates are normalized 0..65535,
/// so a tap at a snapshot rect converts through this.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DisplayGeometry {
    pub width: f64,
    pub height: f64,
    pub scale: f64,
}

impl Default for DisplayGeometry {
    fn default() -> Self {
        Self {
            width: 390.0,
            height: 844.0,
            scale: 3.0,
        }
    }
}

impl DisplayGeometry {
    /// The 0..65535 pair UniversalHID expects for a point in screen points.
    pub fn normalize(&self, point: Point) -> (u16, u16) {
        let x = (point.x / self.width).clamp(0.0, 1.0);
        let y = (point.y / self.height).clamp(0.0, 1.0);
        ((x * 65535.0).round() as u16, (y * 65535.0).round() as u16)
    }
}

/// A captured screen: PNG bytes and the scale it was captured at.
#[derive(Debug, Clone, PartialEq)]
pub struct Screenshot {
    pub png: Vec<u8>,
    pub window: String,
    pub scale: f64,
}

pub trait IosSurface: Send + Sync {
    fn state(&self) -> ServiceState;

    fn geometry(&self) -> DisplayGeometry;

    async fn snapshot(&self) -> AgentResult<Snapshot>;

    /// A touch that lands at `point` and lifts after `duration_ms` (0 = a tap).
    async fn touch(&self, point: Point, duration_ms: u32) -> AgentResult<()>;

    async fn swipe(&self, from: Point, to: Point, duration_ms: u32) -> AgentResult<()>;

    /// Enter text into the focused field. The transport picks the path (pasteboard for any
    /// script, HID keyboard as the fallback).
    async fn type_text(&self, text: &str) -> AgentResult<()>;

    /// Write text into a specific field, named by its ref and node.
    async fn set_text(&self, id: &str, node: &AxNode, text: &str) -> AgentResult<()>;

    async fn press(&self, key: PressKey) -> AgentResult<()>;

    async fn screenshot(&self) -> AgentResult<Screenshot>;

    async fn launch_app(&self, package: &str, fresh: bool) -> AgentResult<()>;

    /// Scroll a scrollable area by `amount` steps in `dir`.
    async fn scroll(&self, dir: ScrollDir, amount: u8) -> AgentResult<()>;
}
