//! The device-side safety gate.
//!
//! For one gated op it answers which reasons require an approval request. Structure outweighs
//! the word tables; an unrecognized commit-shaped label still gates through
//! `commit-unrecognized` (better one extra approval than one slipped commit). Reasons are an
//! open set — the caller treats any reason it does not know as requiring approval.
//!
//! This gate lives in the device core, after the request arrives and before any HID report or
//! accessibility action. There is deliberately no switch to turn it off: the only way past it
//! is an approval credential that binds the device, session, op, arguments and screen.

use crate::ax::{AppInfo, AxNode};

use super::{Categories, Detect};

/// Gated ops, as the dispatcher names them. Read-only ops are never passed to the gate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GatedOp {
    Tap,
    LongPress,
    Invoke,
    Type,
    Press,
    SetText,
    Scroll,
    Swipe,
}

impl GatedOp {
    pub fn name(self) -> &'static str {
        match self {
            GatedOp::Tap => "tap",
            GatedOp::LongPress => "longPress",
            GatedOp::Invoke => "invoke",
            GatedOp::Type => "type",
            GatedOp::Press => "press",
            GatedOp::SetText => "setText",
            GatedOp::Scroll => "scroll",
            GatedOp::Swipe => "swipe",
        }
    }
}

/// The action kind a reason belongs to, for category ask lists and exemptions.
pub fn kind_of(reason: &str) -> Option<&'static str> {
    match reason {
        "commit-label" | "commit-unrecognized" | "dialog-confirm" | "payment-label" => {
            Some("commit")
        }
        "message-send" => Some("send"),
        "install" => Some("install"),
        "setting" => Some("setting"),
        "call" => Some("call"),
        "link-leave-app" => Some("link"),
        _ => None,
    }
}

/// Apps where money or goods change hands: a click the tree cannot name is treated as a
/// possible commit (one extra approval is cheaper than one slipped order).
const BLIND_CLICK_CATEGORIES: [&str; 3] = ["shopping", "payments", "finance"];

const CALL_ID_PARTS: [&str; 10] = [
    "call_button",
    "callbutton",
    "call_action",
    "dial_button",
    "dialbutton",
    "dialpad_floating_action_button",
    "voice_call",
    "video_call",
    "start_call",
    "make_call",
];

const STEPPER_ICONS: [&str; 5] = ["+", "-", "＋", "－", "−"];
const ICON_GAP_PX: f64 = 160.0;

pub struct Gate<'a> {
    detect: &'a Detect,
    categories: &'a Categories,
}

impl<'a> Gate<'a> {
    pub fn new(detect: &'a Detect, categories: &'a Categories) -> Self {
        Self { detect, categories }
    }

    /// [target] is the node the action lands on (None for `scroll`, or for a blind tap),
    /// [typed_text] the text a `type` would enter, [root] the current tree, [blind] whether the
    /// tap point had neither an accessibility label nor OCR text.
    #[allow(clippy::too_many_arguments)]
    pub fn reasons(
        &self,
        op: GatedOp,
        target: Option<&AxNode>,
        target_path: Option<&str>,
        typed_text: Option<&str>,
        app: &AppInfo,
        root: Option<&AxNode>,
        blind: bool,
    ) -> Vec<String> {
        let category = self.categories.of(app);
        let cat = category.map(|(name, _)| name);
        let mut out: Vec<String> = Vec::new();

        let blind_commit = blind
            && cat
                .map(|c| BLIND_CLICK_CATEGORIES.contains(&c))
                .unwrap_or(false);
        match op {
            GatedOp::Tap | GatedOp::Invoke | GatedOp::LongPress => {
                let Some(t) = target else {
                    // No node under the point. In a shopping / payment / finance app that is
                    // exactly where a self-drawn commit button lives: ask rather than guess.
                    if blind_commit {
                        out.push("commit-unrecognized".into());
                    }
                    if !out.is_empty() && cat.map(|c| self.ask_has(c, "commit")).unwrap_or(false) {
                        out.push("app-category-ask".into());
                    }
                    return out;
                };
                if t.is_input() || t.is_tab() || t.is_list() {
                    return Vec::new();
                }
                let label = t.name.as_str();
                let claim = self.detect.is_claim_label(label);
                let (commit, money) = self.detect.commit_parts(label);
                if commit {
                    out.push("commit-label".into());
                }
                if self.detect.is_affirmative(label)
                    && screen_asks_commit(self.detect, root, target_path)
                {
                    out.push("dialog-confirm".into());
                }
                if cat == Some("stores")
                    && !claim
                    && (self.detect.is_install_label(label) || self.detect.is_affirmative(label))
                {
                    out.push("install".into());
                }
                if is_call_target(self.detect, t) {
                    out.push("call".into());
                }
                if t.clickable && self.detect.looks_like_url(label) && cat != Some("browsers") {
                    out.push("link-leave-app".into());
                }
                if cat == Some("settings")
                    && (t.is_switch()
                        || self.detect.is_setting_label(label)
                        || self.detect.is_stepper_label(label)
                        || is_stepper_icon(self.detect, t, root)
                        || t.is_slider())
                {
                    out.push("setting".into());
                }
                // A claim is free by itself, but not when it stands in a payment confirmation:
                // the screen asks a commit question, so the same button is the pay step there.
                if claim && screen_asks_commit(self.detect, root, target_path) {
                    out.push("commit-label".into());
                }
                let money_shown = self.detect.has_currency(label)
                    || root
                        .map(|r| screen_has_currency(self.detect, r))
                        .unwrap_or(false);
                if (commit || out.iter().any(|r| r == "install")) && (money || money_shown) {
                    out.push("payment-label".into());
                }
                if claim && out.iter().any(|r| r == "commit-label") && money_shown {
                    out.push("payment-label".into());
                }
                if out.is_empty() && unrecognized_commit(self.detect, t, root, target_path) {
                    out.push("commit-unrecognized".into());
                }
                // The node under the point had no label and no OCR text named it either: the
                // structural fallback could not see a drawn commit either way.
                if blind_commit && !out.iter().any(|r| kind_of(r) == Some("commit")) {
                    out.push("commit-unrecognized".into());
                }
            }
            GatedOp::Type | GatedOp::Press => {
                // A newline (typed into the field, or the IME's Enter on it) submits in many
                // apps. The dispatcher routes only `press` Enter here — Home, Lock and the
                // volume keys are not commits. A search field submits a query, not a commit;
                // messaging and social apps send; everywhere else the commit default applies.
                let Some(t) = target else { return Vec::new() };
                let submit = op == GatedOp::Press
                    || typed_text
                        .map(|text| text.contains('\n') || text.contains('\r'))
                        .unwrap_or(false);
                if !submit
                    || self
                        .detect
                        .is_search_field(t.label(), t.view_id.as_deref().unwrap_or(""))
                {
                    return Vec::new();
                }
                if cat == Some("messaging") || cat == Some("social") {
                    out.push("message-send".into());
                } else {
                    out.push("commit-unrecognized".into());
                }
            }
            GatedOp::SetText => {
                // Writing a slider's value is changing a setting, like clicking its track.
                if let Some(t) = target {
                    if cat == Some("settings") && t.is_slider() {
                        out.push("setting".into());
                    }
                }
            }
            GatedOp::Scroll | GatedOp::Swipe => {
                // Sliders such as 「滑动支付」/ "Slide to pay"; a list that scrolls is no slider.
                // A free swipe names its own start point, so a slider under that point counts too.
                let slider = root
                    .and_then(|r| find_slider(self.detect, r))
                    .or_else(|| target.filter(|t| t.is_slider()));
                if let Some(slider) = slider {
                    // A slider label often carries the verb after a prefix (「滑动支付」): the
                    // word tables match commits at the start, so also accept a mention.
                    let (mut commit, money) = self.detect.commit_parts(&slider.name);
                    if !commit && self.detect.mentions_commit(&slider.name) {
                        commit = true;
                    }
                    if commit {
                        out.push("commit-label".into());
                        if money
                            || self.detect.has_currency(&slider.name)
                            || root
                                .map(|r| screen_has_currency(self.detect, r))
                                .unwrap_or(false)
                        {
                            out.push("payment-label".into());
                        }
                    }
                }
                // A scroll or swipe that lands on a slider changes its value in Settings.
                if cat == Some("settings")
                    && (root
                        .map(|r| has_scrollable_slider(self.detect, r))
                        .unwrap_or(false)
                        || target.map(|t| t.is_slider()).unwrap_or(false))
                {
                    out.push("setting".into());
                }
            }
        }

        // The category table may mark kinds ask for apps in a category, above what the word
        // tables caught.
        if !out.is_empty() {
            if let Some(cat_name) = cat {
                let ask = self.categories.ask_of(cat_name);
                if out
                    .iter()
                    .filter_map(|r| kind_of(r))
                    .any(|kind| ask.iter().any(|a| a == kind))
                {
                    out.push("app-category-ask".into());
                }
            }
        }
        out
    }

    fn ask_has(&self, category: &str, kind: &str) -> bool {
        self.categories.ask_of(category).iter().any(|a| a == kind)
    }
}

// ---- structure ----------------------------------------------------------------------

/// Whether the screen asks a commit question ("Delete this message?") somewhere other than the
/// target.
fn screen_asks_commit(detect: &Detect, root: Option<&AxNode>, target_path: Option<&str>) -> bool {
    let Some(root) = root else { return false };
    let mut found = false;
    let mut walk = |path: &str, node: &AxNode| {
        if found || Some(path) == target_path {
            return;
        }
        if detect.is_question(&node.name) && detect.mentions_commit(&node.name) {
            found = true;
        }
    };
    walk_tree("n0", root, &mut walk);
    found
}

fn has_editable_non_search_input(detect: &Detect, root: &AxNode) -> bool {
    let mut found = false;
    let mut walk = |_: &str, node: &AxNode| {
        if found || !node.is_input() {
            return;
        }
        if !detect.is_search_field(&node.name, node.view_id.as_deref().unwrap_or("")) {
            found = true;
        }
    };
    walk_tree("n0", root, &mut walk);
    found
}

fn find_slider<'a>(detect: &Detect, root: &'a AxNode) -> Option<&'a AxNode> {
    let mut hit = None;
    walk_tree("n0", root, &mut |_, node| {
        if hit.is_none()
            && node.is_slider()
            && (detect.is_commit_label(&node.name) || detect.mentions_commit(&node.name))
        {
            hit = Some(node);
        }
    });
    hit
}

fn has_scrollable_slider(detect: &Detect, root: &AxNode) -> bool {
    let _ = detect;
    let mut found = false;
    walk_tree("n0", root, &mut |_, node| {
        if !found && node.scrollable && node.is_slider_shape() {
            found = true;
        }
    });
    found
}

fn screen_has_currency(detect: &Detect, root: &AxNode) -> bool {
    let mut found = false;
    walk_tree("n0", root, &mut |_, node| {
        if !found && detect.has_currency(&node.name) {
            found = true;
        }
    });
    found
}

/// A ＋ / － icon button beside a slider: the stepper's other form.
fn is_stepper_icon(detect: &Detect, t: &AxNode, root: Option<&AxNode>) -> bool {
    let _ = detect;
    let Some(root) = root else { return false };
    if !t.clickable || !STEPPER_ICONS.contains(&t.name.trim()) {
        return false;
    }
    let mut hit = false;
    walk_tree("n0", root, &mut |_, node| {
        if hit || !node.is_slider_shape() {
            return;
        }
        if t.rect.same_row(&node.rect) && t.rect.horizontal_gap(&node.rect) <= ICON_GAP_PX {
            hit = true;
        }
    });
    hit
}

fn is_call_target(detect: &Detect, t: &AxNode) -> bool {
    let id = t.view_id.as_deref().unwrap_or("").to_lowercase();
    if CALL_ID_PARTS.iter().any(|part| id.contains(part)) {
        return true;
    }
    detect.is_call_label(&t.name)
}

/// The conservative fallback: a clickable button the tables cannot place, standing where
/// commits stand — in a form or a confirmation dialog. Icon buttons count by structure.
fn unrecognized_commit(
    detect: &Detect,
    t: &AxNode,
    root: Option<&AxNode>,
    target_path: Option<&str>,
) -> bool {
    if !t.clickable && t.role != "Button" {
        return false;
    }
    let label = t.name.as_str();
    if !label.is_empty()
        && (detect.is_commit_label(label)
            || detect.is_claim_label(label)
            || detect.is_install_label(label)
            || detect.is_call_label(label)
            || detect.is_setting_label(label)
            || detect.is_affirmative(label)
            || detect.looks_like_url(label)
            || detect.is_dismissal(label)
            || detect.is_place_label(label)
            || detect.is_search_label(label))
    {
        return false;
    }
    let Some(root) = root else { return false };
    has_editable_non_search_input(detect, root)
        || screen_asks_commit(detect, Some(root), target_path)
}

fn walk_tree<'a, F: FnMut(&str, &'a AxNode)>(path: &str, node: &'a AxNode, f: &mut F) {
    f(path, node);
    for (i, child) in node.children.iter().enumerate() {
        walk_tree(&format!("{path}.n{i}"), child, f);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ax::Rect;
    use crate::policy::Policy;

    fn policy() -> Policy {
        Policy::embedded().unwrap()
    }

    fn app(package: &str, name: &str) -> AppInfo {
        AppInfo {
            package: package.into(),
            name: name.into(),
        }
    }

    fn screen(nodes: Vec<AxNode>) -> AxNode {
        let mut root = AxNode::new("Window", "", Rect::new(0.0, 0.0, 390.0, 844.0));
        root.children = nodes;
        root
    }

    fn reasons(
        policy: &Policy,
        op: GatedOp,
        target: Option<&AxNode>,
        app: &AppInfo,
        root: &AxNode,
    ) -> Vec<String> {
        policy.gate().reasons(
            op,
            target,
            target.map(|_| "n0.n0"),
            None,
            app,
            Some(root),
            false,
        )
    }

    #[test]
    fn commit_button_is_gated() {
        let p = policy();
        let btn =
            AxNode::new("Button", "立即支付", Rect::new(20.0, 700.0, 350.0, 44.0)).clickable();
        let root = screen(vec![btn.clone()]);
        let got = reasons(
            &p,
            GatedOp::Tap,
            Some(&btn),
            &app("com.taobao.taobao4iphone", "淘宝"),
            &root,
        );
        assert!(got.contains(&"commit-label".to_string()), "{got:?}");
        assert!(got.contains(&"payment-label".to_string()), "{got:?}");
    }

    #[test]
    fn ordinary_tab_is_free() {
        let p = policy();
        let tab = AxNode::new("Tab", "Home", Rect::new(0.0, 800.0, 97.0, 44.0)).clickable();
        let root = screen(vec![tab.clone()]);
        assert!(reasons(
            &p,
            GatedOp::Tap,
            Some(&tab),
            &app("com.tencent.xin", "WeChat"),
            &root
        )
        .is_empty());
    }

    #[test]
    fn blind_tap_in_payment_app_gates() {
        let p = policy();
        let root = screen(vec![]);
        let got = p.gate().reasons(
            GatedOp::Tap,
            None,
            None,
            None,
            &app("com.alipay.iphoneclient", ""),
            Some(&root),
            true,
        );
        assert_eq!(got, vec!["commit-unrecognized".to_string()]);
    }

    #[test]
    fn blind_tap_elsewhere_is_free() {
        let p = policy();
        let root = screen(vec![]);
        let got = p.gate().reasons(
            GatedOp::Tap,
            None,
            None,
            None,
            &app("com.apple.mobilesafari", "Safari"),
            Some(&root),
            true,
        );
        assert!(got.is_empty());
    }

    #[test]
    fn claim_is_free_but_claim_that_pays_is_not() {
        let p = policy();
        let claim =
            AxNode::new("Button", "领取红包", Rect::new(20.0, 600.0, 100.0, 40.0)).clickable();
        assert!(p.detect.is_claim_label(&claim.name));
        assert!(!p.detect.is_commit_label(&claim.name));
        let paid = AxNode::new(
            "Button",
            "领取并开通会员 ¥9.9",
            Rect::new(20.0, 600.0, 300.0, 40.0),
        )
        .clickable();
        assert!(p.detect.is_commit_label(&paid.name));
    }

    #[test]
    fn setting_switch_in_settings_app_gates() {
        let p = policy();
        let toggle =
            AxNode::new("Switch", "Wi-Fi", Rect::new(20.0, 200.0, 350.0, 44.0)).clickable();
        let root = screen(vec![toggle.clone()]);
        let got = reasons(
            &p,
            GatedOp::Tap,
            Some(&toggle),
            &app("com.apple.Preferences", "设置"),
            &root,
        );
        assert!(got.contains(&"setting".to_string()), "{got:?}");
    }

    #[test]
    fn newline_in_message_app_is_send() {
        let p = policy();
        let field =
            AxNode::new("TextField", "Message", Rect::new(20.0, 700.0, 300.0, 40.0)).editable();
        let root = screen(vec![field.clone()]);
        let got = p.gate().reasons(
            GatedOp::Type,
            Some(&field),
            Some("n0.n0"),
            Some("hello\n"),
            &app("com.tencent.xin", "WeChat"),
            Some(&root),
            false,
        );
        assert_eq!(got, vec!["message-send".to_string()]);
    }

    #[test]
    fn enter_in_search_field_is_free() {
        let p = policy();
        let field = AxNode::new("TextField", "搜索", Rect::new(20.0, 60.0, 300.0, 40.0)).editable();
        let root = screen(vec![field.clone()]);
        let got = p.gate().reasons(
            GatedOp::Press,
            Some(&field),
            Some("n0.n0"),
            None,
            &app("com.taobao.taobao4iphone", "淘宝"),
            Some(&root),
            false,
        );
        assert!(got.is_empty());
    }

    #[test]
    fn slide_to_pay_swipe_gates() {
        let p = policy();
        let slider = AxNode::new(
            "Slider",
            "滑动支付 ¥12.00",
            Rect::new(20.0, 700.0, 350.0, 50.0),
        );
        let root = screen(vec![slider]);
        let got = p.gate().reasons(
            GatedOp::Swipe,
            None,
            None,
            None,
            &app("com.taobao.taobao4iphone", "淘宝"),
            Some(&root),
            false,
        );
        assert!(got.contains(&"commit-label".to_string()), "{got:?}");
        assert!(got.contains(&"payment-label".to_string()), "{got:?}");
    }
}
