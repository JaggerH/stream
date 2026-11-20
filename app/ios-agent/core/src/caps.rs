//! Capability negotiation: what this phone promises in its `hello`, and what the automation
//! path makes available.
//!
//! The manifest uses the shared `capsVersion` / `caps` shape: `caps` maps a capability id to
//! `{v}` (or `{v, availability}`). Capability ids are an open vocabulary; a backend keeps ids
//! it does not know. A caller refuses before sending when the device did not declare an op, or
//! declared a capability below the version an action needs.

use serde::Serialize;
use std::collections::BTreeMap;

use crate::version::{AutomationPath, IosVersion};

pub const CAPS_VERSION: u32 = 1;

/// Versions from the shared action contract. A surface that backs an action declares the
/// capability the action belongs to at the same version as every other surface.
pub const CAP_UI_TREE: (&str, u32) = ("ui.tree", 7);
pub const CAP_UI_ACT: (&str, u32) = ("ui.act", 2);
pub const CAP_SCREEN_SHOT: (&str, u32) = ("screen.shot", 1);
pub const CAP_APP_LAUNCH: (&str, u32) = ("app.launch", 2);
pub const CAP_APP_IN_USE: (&str, u32) = ("app.in_use", 1);
pub const CAP_INPUT_TEXT: (&str, u32) = ("input.text", 1);

/// Full op set of the native path. `ui.ocr` is deliberately absent: iOS has no on-device OCR,
/// so `ocr: "on"` degrades to the tree.
pub const NATIVE_OPS: &[&str] = &[
    "tap",
    "longPress",
    "swipe",
    "scroll",
    "invoke",
    "type",
    "setText",
    "press",
    "screenshot",
    "find",
    "windows",
    "openApp",
    "sleep",
    "status",
];

/// The XCTest path backs the same action set through the in-process session. It only connects
/// when the app's Swift bridge is linked; without it the agent answers `service-unavailable`.
pub const XCTEST_OPS: &[&str] = NATIVE_OPS;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct Capability {
    pub v: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    #[serde(rename = "type")]
    pub frame: &'static str,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub platform: &'static str,
    pub name: String,
    #[serde(rename = "agentVersion")]
    pub agent_version: String,
    pub ops: Vec<&'static str>,
    #[serde(rename = "capsVersion")]
    pub caps_version: u32,
    pub caps: BTreeMap<String, Capability>,
    /// Extra, additive fields: the OS version and the path it selected. A backend under the
    /// current hello parser ignores unknown fields; the iOS pairing change reads them.
    #[serde(rename = "iosVersion")]
    pub ios_version: String,
    pub path: &'static str,
}

impl Hello {
    pub fn for_device(
        device_id: String,
        name: String,
        agent_version: String,
        version: IosVersion,
        path: AutomationPath,
    ) -> Self {
        let mut caps = BTreeMap::new();
        if path != AutomationPath::Unsupported {
            for (id, v) in [
                CAP_UI_TREE,
                CAP_UI_ACT,
                CAP_SCREEN_SHOT,
                CAP_APP_LAUNCH,
                CAP_APP_IN_USE,
                CAP_INPUT_TEXT,
            ] {
                caps.insert(id.to_string(), Capability { v });
            }
        }
        if let Some(path_cap) = path.capability_id() {
            caps.insert(path_cap.to_string(), Capability { v: 1 });
        }
        let ops = match path {
            AutomationPath::NativeAccessibility => NATIVE_OPS.to_vec(),
            AutomationPath::XctestSession => XCTEST_OPS.to_vec(),
            AutomationPath::Unsupported => Vec::new(),
        };
        Self {
            frame: "hello",
            device_id,
            platform: "ios",
            name,
            agent_version,
            ops,
            caps_version: CAPS_VERSION,
            caps,
            ios_version: version.to_string(),
            path: path.as_str(),
        }
    }

    /// Whether this connection declared `op`. A caller checks this before sending.
    pub fn declares(&self, op: &str) -> bool {
        self.ops.contains(&op)
    }

    /// Whether the declared version of a capability satisfies `required`.
    pub fn supports(&self, capability: &str, required: u32) -> bool {
        self.caps
            .get(capability)
            .map(|c| c.v >= required)
            .unwrap_or(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(path: AutomationPath) -> Hello {
        Hello::for_device(
            "ios:abc".into(),
            "iPhone".into(),
            "0.1.0".into(),
            IosVersion::new(27, 0),
            path,
        )
    }

    #[test]
    fn native_hello_declares_the_contract() {
        let h = hello(AutomationPath::NativeAccessibility);
        assert_eq!(h.platform, "ios");
        assert!(h.declares("tap"));
        assert!(h.declares("windows"));
        assert!(!h.declares("url"));
        assert!(h.supports("ui.tree", 7));
        assert!(!h.supports("ui.tree", 8));
        assert!(h.supports("ios.ax-native", 1));
        assert!(!h.supports("ui.ocr", 1));
        assert_eq!(h.path, "native-accessibility");
    }

    #[test]
    fn xctest_hello_declares_its_path() {
        let h = hello(AutomationPath::XctestSession);
        assert!(h.supports("ios.xctest-session", 1));
        assert!(!h.supports("ios.ax-native", 1));
        assert!(h.declares("tap"));
    }

    #[test]
    fn unsupported_version_declares_nothing() {
        let h = hello(AutomationPath::Unsupported);
        assert!(h.ops.is_empty());
        assert!(h.caps.is_empty());
    }

    #[test]
    fn serializes_camel_case() {
        let value = serde_json::to_value(hello(AutomationPath::NativeAccessibility)).unwrap();
        assert_eq!(value["type"], "hello");
        assert_eq!(value["deviceId"], "ios:abc");
        assert_eq!(value["capsVersion"], 1);
        assert_eq!(value["caps"]["ui.tree"]["v"], 7);
    }
}
