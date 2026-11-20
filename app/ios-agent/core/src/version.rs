//! iOS version parsing and the automation path it selects.
//!
//! The device core is one binary inside the phone's app, but the service that drives the phone
//! differs by OS generation:
//!
//! * iOS 27 and later: the paired native services (accessibility inspector, display capture,
//!   UniversalHID). No XCTest session runs.
//! * iOS 18 through 26: an in-process XCTest automation session, driven through the app's
//!   Swift bridge (the testmanagerd connection lives in-process; there is no separate runner).
//! * Below 18: no supported path.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct IosVersion {
    pub major: u32,
    pub minor: u32,
}

impl IosVersion {
    pub const fn new(major: u32, minor: u32) -> Self {
        Self { major, minor }
    }

    /// Parses `27`, `27.1`, `18.4.1` (the patch is accepted and ignored). Anything else is None.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let mut parts = text.split('.');
        let major = parts.next()?.parse::<u32>().ok()?;
        let minor = match parts.next() {
            Some(m) => m.parse::<u32>().ok()?,
            None => 0,
        };
        if parts.any(|p| p.parse::<u32>().is_err()) {
            return None;
        }
        Some(Self { major, minor })
    }
}

impl std::fmt::Display for IosVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}.{}", self.major, self.minor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AutomationPath {
    /// iOS 27+: native accessibility / screenshot / HID services, no XCTest session.
    #[serde(alias = "native")]
    NativeAccessibility,
    /// iOS 18–26: an in-process XCTest session through the app's Swift bridge.
    #[serde(alias = "xctest")]
    XctestSession,
    /// Below iOS 18: not supported.
    Unsupported,
}

impl AutomationPath {
    pub const NATIVE_MIN_MAJOR: u32 = 27;
    pub const XCTEST_MIN_MAJOR: u32 = 18;

    pub fn for_version(version: IosVersion) -> Self {
        if version.major >= Self::NATIVE_MIN_MAJOR {
            AutomationPath::NativeAccessibility
        } else if version.major >= Self::XCTEST_MIN_MAJOR {
            AutomationPath::XctestSession
        } else {
            AutomationPath::Unsupported
        }
    }

    /// The capability id that tells the backend which path this connection takes. Capability
    /// ids are an open vocabulary; an older backend keeps the entry it does not know.
    pub fn capability_id(self) -> Option<&'static str> {
        match self {
            AutomationPath::NativeAccessibility => Some("ios.ax-native"),
            AutomationPath::XctestSession => Some("ios.xctest-session"),
            AutomationPath::Unsupported => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            AutomationPath::NativeAccessibility => "native-accessibility",
            AutomationPath::XctestSession => "xctest-session",
            AutomationPath::Unsupported => "unsupported",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_variants() {
        assert_eq!(IosVersion::parse("27"), Some(IosVersion::new(27, 0)));
        assert_eq!(IosVersion::parse("18.4.1"), Some(IosVersion::new(18, 4)));
        assert_eq!(IosVersion::parse(" 26.0 "), Some(IosVersion::new(26, 0)));
        assert_eq!(IosVersion::parse("27.x"), None);
        assert_eq!(IosVersion::parse(""), None);
    }

    #[test]
    fn path_boundaries() {
        for (v, path) in [
            (IosVersion::new(17, 7), AutomationPath::Unsupported),
            (IosVersion::new(18, 0), AutomationPath::XctestSession),
            (IosVersion::new(26, 4), AutomationPath::XctestSession),
            (IosVersion::new(27, 0), AutomationPath::NativeAccessibility),
            (IosVersion::new(30, 1), AutomationPath::NativeAccessibility),
        ] {
            assert_eq!(AutomationPath::for_version(v), path, "{v}");
        }
    }
}
