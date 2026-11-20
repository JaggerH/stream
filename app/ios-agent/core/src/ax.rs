//! The accessibility model shared by the dispatcher, the gate and the transport backends.
//!
//! A snapshot is a tree of nodes with a role, a label, an optional stable identifier and a
//! screen rect. The transport fills it from whichever mechanism the OS generation provides
//! (native AX on iOS 27+, the XCTest bridge on iOS 18–26). Everything downstream — querying,
//! hit-testing for the gate, digests, refs — works on this model and is host-testable.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, w: f64, h: f64) -> Self {
        Self { x, y, w, h }
    }

    pub fn center(&self) -> Point {
        Point {
            x: self.x + self.w / 2.0,
            y: self.y + self.h / 2.0,
        }
    }

    pub fn contains(&self, p: Point) -> bool {
        p.x >= self.x && p.x <= self.x + self.w && p.y >= self.y && p.y <= self.y + self.h
    }

    pub fn is_empty(&self) -> bool {
        self.w <= 0.0 || self.h <= 0.0
    }

    pub fn area(&self) -> f64 {
        self.w.max(0.0) * self.h.max(0.0)
    }

    /// The vertical ranges overlap by at least half the smaller height.
    pub fn same_row(&self, other: &Rect) -> bool {
        let overlap = (self.y + self.h).min(other.y + other.h) - self.y.max(other.y);
        overlap >= self.h.min(other.h) / 2.0
    }

    /// Horizontal gap between two rects (0 when they touch or overlap).
    pub fn horizontal_gap(&self, other: &Rect) -> f64 {
        (other.x.max(self.x) - (self.x + self.w).min(other.x + other.w)).max(0.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct AxNode {
    /// Platform role (`Button`, `TextField`, `StaticText`, …).
    #[serde(default)]
    pub role: String,
    /// The accessibility label (the text VoiceOver reads).
    #[serde(default)]
    pub name: String,
    /// The platform class name, when the surface reports one.
    #[serde(default, rename = "className")]
    pub class_name: String,
    /// A stable id the app gave the control (Android calls it a view id; iOS calls it an
    /// accessibility identifier).
    #[serde(default, rename = "viewId", skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    /// The control's current value (masked before it leaves the agent if it is a credential).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    #[serde(default)]
    pub rect: Rect,
    #[serde(default)]
    pub clickable: bool,
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub scrollable: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub focused: bool,
    #[serde(default)]
    pub password: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<AxNode>,
}

fn default_true() -> bool {
    true
}

impl AxNode {
    pub fn new(role: impl Into<String>, name: impl Into<String>, rect: Rect) -> Self {
        Self {
            role: role.into(),
            name: name.into(),
            rect,
            enabled: true,
            ..Default::default()
        }
    }

    pub fn clickable(mut self) -> Self {
        self.clickable = true;
        self
    }

    pub fn editable(mut self) -> Self {
        self.editable = true;
        self
    }

    pub fn scrollable(mut self) -> Self {
        self.scrollable = true;
        self
    }

    pub fn focused(mut self) -> Self {
        self.focused = true;
        self
    }

    pub fn child(mut self, child: AxNode) -> Self {
        self.children.push(child);
        self
    }

    pub fn label(&self) -> &str {
        if !self.name.is_empty() {
            &self.name
        } else {
            self.view_id.as_deref().unwrap_or("")
        }
    }

    pub fn is_input(&self) -> bool {
        self.editable
            || self.role.ends_with("EditText")
            || matches!(
                self.role.as_str(),
                "TextField" | "SecureTextField" | "TextView"
            )
    }

    pub fn is_tab(&self) -> bool {
        self.role == "Tab"
            || self
                .class_name
                .rsplit('.')
                .next()
                .unwrap_or("")
                .starts_with("Tab")
    }

    pub fn is_list(&self) -> bool {
        self.scrollable || self.role.contains("List") || self.role.contains("Recycler")
    }

    pub fn is_switch(&self) -> bool {
        let class = self.class_name.rsplit('.').next().unwrap_or("");
        class.contains("Switch")
            || class.contains("CheckBox")
            || class.contains("ToggleButton")
            || class.contains("RadioButton")
            || matches!(
                self.role.as_str(),
                "Switch" | "CheckBox" | "Toggle" | "RadioButton"
            )
    }

    pub fn is_slider_shape(&self) -> bool {
        !self.scrollable
            && (self.role.to_ascii_lowercase().contains("slider")
                || self.role.to_ascii_lowercase().contains("seek")
                || self.class_name.contains("Slider")
                || self.class_name.contains("Seek"))
    }

    pub fn is_slider(&self) -> bool {
        !self.scrollable && self.is_slider_shape()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct AppInfo {
    /// Bundle id on iOS.
    #[serde(default, rename = "package")]
    pub package: String,
    #[serde(default)]
    pub name: String,
}

/// One element as `find` reports it. `id` is the ref the caller uses in `setText` / `tap`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Element {
    #[serde(rename = "ref")]
    pub id: String,
    pub role: String,
    pub name: String,
    #[serde(rename = "className")]
    pub class_name: String,
    #[serde(rename = "viewId", skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    pub rect: Rect,
    pub clickable: bool,
    pub editable: bool,
    pub scrollable: bool,
    pub focused: bool,
    pub enabled: bool,
}

/// The query vocabulary of the shared action contract, plus `viewId`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Query {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(
        default,
        rename = "nameContains",
        skip_serializing_if = "Option::is_none"
    )]
    pub name_contains: Option<String>,
    #[serde(default, rename = "className", skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, rename = "viewId", skip_serializing_if = "Option::is_none")]
    pub view_id: Option<String>,
}

impl Query {
    pub fn matches(&self, path: &str, node: &AxNode) -> bool {
        if let Some(role) = &self.role {
            if !node.role.eq_ignore_ascii_case(role) {
                return false;
            }
        }
        if let Some(name) = &self.name {
            if node.name != *name {
                return false;
            }
        }
        if let Some(needle) = &self.name_contains {
            if !node.name.to_lowercase().contains(&needle.to_lowercase()) {
                return false;
            }
        }
        if let Some(class_name) = &self.class_name {
            let short = node.class_name.rsplit('.').next().unwrap_or("");
            if !node.class_name.eq_ignore_ascii_case(class_name)
                && !short.eq_ignore_ascii_case(class_name)
            {
                return false;
            }
        }
        if let Some(prefix) = &self.path {
            if !(path == prefix || path.starts_with(&format!("{prefix}."))) {
                return false;
            }
        }
        if let Some(view_id) = &self.view_id {
            if node.view_id.as_deref() != Some(view_id.as_str()) {
                return false;
            }
        }
        true
    }
}

/// A screen at one moment. Refs (`n0.n2`) are stable for this snapshot only; using one after
/// the screen changed is a `stale-ref`, never a guess.
#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub root: AxNode,
    pub app: AppInfo,
    pub tree_digest: String,
    pub snapshot_ref: String,
}

impl Snapshot {
    pub fn build(root: AxNode, app: AppInfo) -> Self {
        let tree_digest = digest_tree(&root);
        let snapshot_ref = format!("snap:{}", &tree_digest[..8]);
        Self {
            root,
            app,
            tree_digest,
            snapshot_ref,
        }
    }

    pub fn screen_digest(&self) -> &str {
        &self.tree_digest
    }

    /// Depth-first walk yielding `(path, node)`.
    pub fn walk(&self) -> Vec<(String, &AxNode)> {
        let mut out = Vec::new();
        walk_node("n0", &self.root, &mut out);
        out
    }

    pub fn node_by_ref(&self, id: &str) -> Option<&AxNode> {
        if !id.starts_with("n0") {
            return None;
        }
        let mut node = &self.root;
        let mut parts = id.split('.');
        if parts.next() != Some("n0") {
            return None;
        }
        for part in parts {
            let index = part.strip_prefix('n')?.parse::<usize>().ok()?;
            node = node.children.get(index)?;
        }
        Some(node)
    }

    /// The deepest node containing `p`, with zero-area nodes skipped.
    pub fn deepest_at(&self, p: Point) -> Option<(String, &AxNode)> {
        let mut best: Option<(String, &AxNode)> = None;
        for (path, node) in self.walk() {
            if node.rect.is_empty() || !node.rect.contains(p) {
                continue;
            }
            if best
                .as_ref()
                .map(|(_, b)| node.rect.area() <= b.rect.area())
                .unwrap_or(true)
            {
                best = Some((path, node));
            }
        }
        best
    }

    pub fn focused_input(&self) -> Option<(String, &AxNode)> {
        self.walk()
            .into_iter()
            .find(|(_, n)| n.focused && n.is_input())
    }

    pub fn find(&self, query: &Query) -> Vec<Element> {
        self.walk()
            .into_iter()
            .filter(|(path, node)| query.matches(path, node))
            .map(|(path, node)| element(path, node))
            .collect()
    }

    /// Windows: the iOS surface is single-window; the one window is the foreground app.
    pub fn windows(&self) -> Vec<serde_json::Value> {
        vec![serde_json::json!({
            "id": self.app.package,
            "app": self.app.package,
            "title": self.app.name,
            "rect": self.root.rect,
            "focused": true,
        })]
    }

    pub fn element(&self, id: &str) -> Option<Element> {
        self.node_by_ref(id).map(|n| element(id.to_string(), n))
    }
}

fn element(path: String, node: &AxNode) -> Element {
    Element {
        id: path,
        role: node.role.clone(),
        name: node.name.clone(),
        class_name: node.class_name.clone(),
        view_id: node.view_id.clone(),
        value: node.value.clone().map(|v| mask_value(node, &v)),
        rect: node.rect,
        clickable: node.clickable,
        editable: node.editable,
        scrollable: node.scrollable,
        focused: node.focused,
        enabled: node.enabled,
    }
}

/// A credential field's value never leaves the device. Ordinary fields keep theirs.
pub fn mask_value(node: &AxNode, value: &str) -> String {
    if node.password || is_credential_label(node.label()) {
        "••••••".to_string()
    } else {
        value.to_string()
    }
}

/// Conservative credential-label check used by the masker. It is not the gate: a false
/// positive only masks a value.
pub fn is_credential_label(label: &str) -> bool {
    let lower = label.to_lowercase();
    [
        "password",
        "passcode",
        "密码",
        "密碼",
        "パスワード",
        "비밀번호",
        "otp",
        "one-time code",
    ]
    .iter()
    .any(|w| lower.contains(w))
}

fn walk_node<'a>(path: &str, node: &'a AxNode, out: &mut Vec<(String, &'a AxNode)>) {
    out.push((path.to_string(), node));
    for (i, child) in node.children.iter().enumerate() {
        walk_node(&format!("{path}.n{i}"), child, out);
    }
}

/// A structural digest of the screen: roles, labels, masked values, rects and flags. Volatile
/// text (a clock in the status bar) changes it; that is intended — an approval binds to the
/// screen it was granted on.
pub fn digest_tree(root: &AxNode) -> String {
    let mut hasher = Sha256::new();
    fn feed(hasher: &mut Sha256, node: &AxNode) {
        hasher.update(node.role.as_bytes());
        hasher.update(b"\x1f");
        hasher.update(node.name.as_bytes());
        hasher.update(b"\x1f");
        if let Some(v) = &node.value {
            hasher.update(mask_value(node, v).as_bytes());
        }
        hasher.update(b"\x1f");
        for v in [node.rect.x, node.rect.y, node.rect.w, node.rect.h] {
            hasher.update(v.round().to_i64_bytes());
            hasher.update(b",");
        }
        hasher.update([
            node.clickable as u8,
            node.editable as u8,
            node.scrollable as u8,
            node.focused as u8,
            node.enabled as u8,
        ]);
        for child in &node.children {
            feed(hasher, child);
        }
        hasher.update(b"\x1e");
    }
    feed(&mut hasher, root);
    hex(&hasher.finalize())
}

trait RoundBytes {
    fn to_i64_bytes(self) -> [u8; 8];
}

impl RoundBytes for f64 {
    fn to_i64_bytes(self) -> [u8; 8] {
        (self.round() as i64).to_le_bytes()
    }
}

pub fn hex(bytes: &[u8]) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> AxNode {
        AxNode::new("Window", "", Rect::new(0.0, 0.0, 390.0, 844.0)).child(
            AxNode::new("Button", "Pay now", Rect::new(20.0, 700.0, 350.0, 44.0)).clickable(),
        )
    }

    #[test]
    fn refs_round_trip_and_stale_refs_are_none() {
        let snap = Snapshot::build(tree(), AppInfo::default());
        let el = snap.find(&Query {
            name: Some("Pay now".into()),
            ..Default::default()
        });
        assert_eq!(el.len(), 1);
        assert!(snap.node_by_ref(&el[0].id).is_some());
        assert!(snap.node_by_ref("n0.n9").is_none());
        assert!(snap.node_by_ref("x1").is_none());
    }

    #[test]
    fn hit_test_picks_the_deepest_node() {
        let snap = Snapshot::build(tree(), AppInfo::default());
        let (path, node) = snap.deepest_at(Point { x: 100.0, y: 720.0 }).unwrap();
        assert_eq!(node.name, "Pay now");
        assert_eq!(path, "n0.n0");
    }

    #[test]
    fn digest_ignores_nothing_but_masks_values() {
        let a = Snapshot::build(
            AxNode::new("Window", "", Rect::default()),
            AppInfo::default(),
        );
        let b = Snapshot::build(
            AxNode::new("Window", "", Rect::default()),
            AppInfo::default(),
        );
        assert_eq!(a.tree_digest, b.tree_digest);
        let mut node = AxNode::new("Window", "", Rect::default());
        node.value = Some("123456".into());
        let c = Snapshot::build(node.clone(), AppInfo::default());
        assert_ne!(a.tree_digest, c.tree_digest);
        node.password = true;
        let d = Snapshot::build(node, AppInfo::default());
        let e = Snapshot::build(
            {
                let mut n = AxNode::new("Window", "", Rect::default());
                n.value = Some("999999".into());
                n.password = true;
                n
            },
            AppInfo::default(),
        );
        assert_eq!(d.tree_digest, e.tree_digest, "password values are masked");
    }

    #[test]
    fn query_matching() {
        let n = AxNode::new("Button", "Pay now", Rect::default());
        assert!(Query {
            role: Some("button".into()),
            name_contains: Some("pay".into()),
            ..Default::default()
        }
        .matches("n0", &n));
        assert!(!Query {
            name: Some("pay now".into()),
            ..Default::default()
        }
        .matches("n0", &n));
        assert!(!Query {
            role: Some("TextField".into()),
            ..Default::default()
        }
        .matches("n0", &n));
    }
}
