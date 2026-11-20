//! Label detection over the word tables.
//!
//! Ported from the Android executor's `Detect.kt` so both surfaces judge a label the same way.
//! Latin and Cyrillic labels are matched word by word; labels in scripts without spaces
//! (Chinese, Japanese, Korean) by prefix after punctuation, digits and prices are removed.
//! Structure (a clickable button, a password field) is checked by the caller and outweighs the
//! tables; an unrecognized commit-shaped label still gates through the conservative fallback.

use regex::Regex;
use std::collections::HashSet;

use super::Words;

pub const MAX_COMMIT_WORDS: usize = 6;
pub const MAX_CJK_RUNES: usize = 14;

const CRYPTO_TICKERS: &str = "BTC|ETH|USDT|USDC|USDE|DAI|BNB|SOL|XRP|ADA|DOGE|TRX|TON|AVAX|DOT|MATIC|POL|LTC|BCH|SUI|APT|ARB|OP|ENA|WBTC|WETH|STETH|EURC|FDUSD|PYUSD|SATS";

#[derive(Debug, Clone)]
pub struct Detect {
    w: Words,
    commit_phrases: Vec<Vec<String>>,
    excluded_starts: Vec<Vec<String>>,
    money_phrases: Vec<Vec<String>>,
    call_phrases: Vec<Vec<String>>,
    claim_phrases: Vec<Vec<String>>,
    cancel_singles: HashSet<String>,
    cancel_phrases: Vec<Vec<String>>,
    currency_re: Regex,
    domain_re: Regex,
}

impl Detect {
    pub fn new(w: Words) -> Self {
        let phrases = |v: &[String]| v.iter().map(|p| tokenize(p)).collect::<Vec<_>>();
        let cancel_singles = w
            .cancel_words
            .iter()
            .filter(|w| !w.contains(' '))
            .cloned()
            .collect();
        let cancel_phrases = phrases(
            &w.cancel_words
                .iter()
                .filter(|w| w.contains(' '))
                .cloned()
                .collect::<Vec<_>>(),
        );
        let currency_re = Regex::new(&format!(
            r"(?:US\$|HK\$|NT\$|A\$|C\$|S\$|R\$|\$|€|£|¥|￥|₩|₹|₽|₺|₫|฿|₱|₪|CHF|USD|EUR|GBP|CNY|RMB|JPY|KRW|HKD|TWD|INR|RUB|AUD|CAD|SGD|BRL|MXN)\s?\d|\d(?:[\d.,\s]*\d)?\s?(?:€|元|円|원|₽|zł|kr|Kč|руб|USD|EUR|GBP|CNY|RMB|JPY|KRW|HKD|TWD|INR|RUB|AUD|CAD|SGD|BRL|MXN)|\b(?:{tickers})\s?\d|\d(?:[\d.,\s]*\d)?\s?(?:{tickers})\b",
            tickers = CRYPTO_TICKERS
        ))
        .expect("currency regex");
        let domain_re =
            Regex::new(r"^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$").expect("domain regex");
        Self {
            commit_phrases: phrases(&w.commit_phrases),
            excluded_starts: phrases(&w.excluded_starts),
            money_phrases: phrases(&w.money_phrases),
            call_phrases: phrases(&w.call_phrases),
            claim_phrases: phrases(&w.claim_phrases),
            cancel_singles,
            cancel_phrases,
            currency_re,
            domain_re,
            w,
        }
    }

    // ---- normalization ---------------------------------------------------------------

    /// Lower-case words of letters and digits, keeping in-word apostrophes and hyphens.
    pub fn tokenize(&self, text: &str) -> Vec<String> {
        tokenize(text)
    }

    /// Words of a label without numbers, so prices and counts do not count towards its length.
    pub fn label_words(&self, label: &str) -> Vec<String> {
        tokenize(label)
            .into_iter()
            .filter(|t| !is_number(t))
            .collect()
    }

    pub fn has_cjk(&self, s: &str) -> bool {
        s.chars().any(is_cjk_char)
    }

    /// A CJK label without whitespace, punctuation, symbols and digits: 「去结算(3)」→「去结算」.
    pub fn cjk_core(&self, s: &str) -> String {
        s.to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace() && !is_punct(*c) && !is_symbol(*c) && !c.is_numeric())
            .collect()
    }

    // ---- commit ---------------------------------------------------------------------

    /// Whether a button label is a commit, in any supported language.
    pub fn is_commit_label(&self, label: &str) -> bool {
        if label.is_empty() || self.is_dismissal(label) {
            return false;
        }
        // A bare claim (「确认领取235元」/ "Get coupon") hands over a coupon or reward and costs
        // nothing; one that also names paying or activating (「领取并开通会员」) is a commit.
        if self.names_claim(label) {
            return self.claim_names_payment(label);
        }
        if self.has_cjk(label) {
            let core = self.cjk_core(label);
            let runes = core.chars().count();
            if core.is_empty()
                || runes > MAX_CJK_RUNES
                || contains_any(&core, &self.w.cjk_negatives)
            {
                return false;
            }
            if has_prefix_any(&core, &self.w.cjk_commit_prefixes) {
                return true;
            }
            // 「同意并支付」「確認して購入」: a commit after a conjunction.
            for p in &self.w.cjk_commit_prefixes {
                for j in CJK_JOINTS {
                    if core.contains(&format!("{j}{p}")) {
                        return true;
                    }
                }
            }
            // Mixed labels such as "Send 发送" fall through to the word check.
        }
        let ws = self.label_words(label);
        if ws.is_empty()
            || ws.len() > MAX_COMMIT_WORDS
            || ws.iter().any(|t| self.w.negative_words.contains(t))
        {
            return false;
        }
        if starts_with_phrase(&ws, 0, &self.excluded_starts) {
            return false;
        }
        if starts_with_phrase(&ws, 0, &self.commit_phrases) {
            return true;
        }
        if self.w.commit_verbs.contains(&ws[0]) {
            return true;
        }
        // "Yes, delete", "OK, send it".
        if self.w.affirmative_words.contains(&ws[0])
            && ws.len() >= 2
            && (self.w.commit_verbs.contains(&ws[1])
                || starts_with_phrase(&ws, 1, &self.commit_phrases))
        {
            return true;
        }
        // "Slide to pay", "Swipe to confirm", "Tap to send".
        if ws.len() >= 3
            && self.w.slide_verbs.contains(&ws[0])
            && matches!(ws[1].as_str(), "to" | "pour" | "para" | "zum")
            && (self.w.commit_verbs.contains(&ws[2])
                || starts_with_phrase(&ws, 2, &self.commit_phrases))
        {
            return true;
        }
        false
    }

    /// Whether a label confirms a dialog: OK, Yes, 确定.
    pub fn is_affirmative(&self, label: &str) -> bool {
        if self.has_cjk(label) {
            let core = self.cjk_core(label);
            return self.w.cjk_affirmatives.contains(&core);
        }
        let ws = self.label_words(label);
        (1..=2).contains(&ws.len()) && self.w.affirmative_words.contains(&ws[0])
    }

    /// Whether a label names giving up rather than going ahead: 取消, Back, Cancel — matched as a
    /// leading word or prefix, so "send it back" stays a commit.
    pub fn is_dismissal(&self, label: &str) -> bool {
        if self.has_cjk(label) && has_prefix_any(&self.cjk_core(label), &self.w.cjk_cancel_prefixes)
        {
            return true;
        }
        let ws = self.label_words(label);
        if ws.is_empty() {
            return false;
        }
        if self.cancel_singles.contains(&ws[0]) {
            return true;
        }
        starts_with_phrase(&ws, 0, &self.cancel_phrases)
    }

    /// Whether a label names a place rather than an action: "Order history", 「订单明细」.
    pub fn is_place_label(&self, label: &str) -> bool {
        if self
            .label_words(label)
            .iter()
            .any(|t| self.w.negative_words.contains(t))
        {
            return true;
        }
        self.has_cjk(label) && contains_any(&self.cjk_core(label), &self.w.cjk_negatives)
    }

    /// Whether a label marks a search control: 搜索, Find, Rechercher.
    pub fn is_search_label(&self, label: &str) -> bool {
        contains_any(&label.to_lowercase(), &self.w.search_words)
    }

    /// Whether a sentence talks about a commit: "Delete this message?".
    pub fn mentions_commit(&self, text: &str) -> bool {
        if self.has_cjk(text) {
            let core = self.cjk_core(text);
            if self.w.cjk_commit_prefixes.iter().any(|p| core.contains(p)) {
                return true;
            }
        }
        let ws = self.label_words(text);
        ws.iter().enumerate().any(|(i, t)| {
            self.w.commit_verbs.contains(t) || starts_with_phrase(&ws, i, &self.commit_phrases)
        })
    }

    /// Whether a label names claiming a coupon, reward or red packet — in Chinese (领取 / 领券 /
    /// 立即领 / 去领 / 抢券 / 领红包, including 「确认领取…」) or English (claim / collect / get coupon).
    fn names_claim(&self, label: &str) -> bool {
        if label.is_empty() {
            return false;
        }
        if self.has_cjk(label) {
            let core = self.cjk_core(label);
            return self.w.cjk_claim_words.iter().any(|w| core.contains(w));
        }
        let ws = self.label_words(label);
        ws.iter().any(|t| self.w.claim_words.contains(t))
            || contains_phrase(&ws, &self.claim_phrases)
    }

    /// Whether the same label also names something beyond the free claim: paying, activating,
    /// buying, subscribing, renewing, submitting, ordering or redeeming.
    fn claim_names_payment(&self, label: &str) -> bool {
        if self.has_cjk(label) {
            let rest = self.strip_claim_words(&self.cjk_core(label));
            if rest.is_empty() {
                return false;
            }
            return contains_any(&rest, &self.w.cjk_money_keywords)
                || contains_any(&rest, &self.w.cjk_claim_exceptions)
                || self.w.cjk_commit_prefixes.iter().any(|p| rest.contains(p));
        }
        let rest = strip_claim_tokens(&self.label_words(label), &self.w, &self.claim_phrases);
        if rest.is_empty() {
            return false;
        }
        rest.iter().any(|t| {
            self.w.money_words.contains(t)
                || self.w.claim_exception_words.contains(t)
                || self.w.commit_verbs.contains(t)
        }) || contains_phrase(&rest, &self.money_phrases)
            || contains_phrase(&rest, &self.commit_phrases)
    }

    /// [core] without every claim word and the modifier directly in front of it.
    fn strip_claim_words(&self, core: &str) -> String {
        let mut rest = core.to_string();
        for word in &self.w.cjk_claim_words {
            while let Some(at) = rest.find(word) {
                let modifier = CLAIM_MODIFIERS.iter().find(|m| {
                    at >= m.len()
                        && rest.is_char_boundary(at - m.len())
                        && rest.get(at - m.len()..at) == Some(*m)
                });
                let start = match modifier {
                    Some(m) => at - m.len(),
                    None => at,
                };
                rest.replace_range(start..at + word.len(), "");
            }
        }
        rest
    }

    /// A claim that costs nothing: not a commit, not a payment.
    pub fn is_claim_label(&self, label: &str) -> bool {
        self.names_claim(label) && !self.claim_names_payment(label)
    }

    /// Whether a commit's label moves money by itself: pays, buys, sells, swaps, lends, borrows.
    pub fn moves_money(&self, label: &str) -> bool {
        if self.is_claim_label(label) {
            return false;
        }
        if self.has_cjk(label) && contains_any(&self.cjk_core(label), &self.w.cjk_money_keywords) {
            return true;
        }
        let ws = self.label_words(label);
        ws.iter().any(|t| self.w.money_words.contains(t))
            || contains_phrase(&ws, &self.money_phrases)
    }

    /// Both halves of a commit judgment on one label.
    pub fn commit_parts(&self, label: &str) -> (bool, bool) {
        let commit = self.is_commit_label(label);
        (commit, commit && self.moves_money(label))
    }

    /// Install buttons in app stores and the system's package dialog. A price alone buys an app too.
    pub fn is_install_label(&self, label: &str) -> bool {
        if self.has_cjk(label) {
            return has_prefix_any(&self.cjk_core(label), &self.w.cjk_install_prefixes);
        }
        let ws = self.label_words(label);
        if ws.is_empty() {
            return self.has_currency(label);
        }
        ws.len() <= MAX_COMMIT_WORDS && self.w.install_verbs.contains(&ws[0])
    }

    /// Call buttons, by label.
    pub fn is_call_label(&self, label: &str) -> bool {
        if self.has_cjk(label) {
            return has_prefix_any(&self.cjk_core(label), &self.w.cjk_call_prefixes);
        }
        let ws = self.label_words(label);
        if ws.is_empty() || ws.len() > MAX_COMMIT_WORDS {
            return false;
        }
        self.w.call_words.contains(&ws[0]) || starts_with_phrase(&ws, 0, &self.call_phrases)
    }

    /// Buttons that change a setting, in the Settings app.
    pub fn is_setting_label(&self, label: &str) -> bool {
        let ws = self.label_words(label);
        (1..=MAX_COMMIT_WORDS).contains(&ws.len()) && self.w.setting_verbs.contains(&ws[0])
    }

    /// Stepper buttons that change a setting in place: `Increase font size` / 「增大字号」.
    pub fn is_stepper_label(&self, label: &str) -> bool {
        if label.is_empty() {
            return false;
        }
        if self.has_cjk(label) {
            return has_prefix_any(&self.cjk_core(label), &self.w.cjk_stepper_prefixes);
        }
        let ws = self.label_words(label);
        !ws.is_empty() && self.w.stepper_words.contains(&ws[0])
    }

    pub fn is_question(&self, s: &str) -> bool {
        let t = s.trim();
        t.contains('?')
            || t.contains('？')
            || t.ends_with('吗')
            || t.ends_with('嗎')
            || t.ends_with('か')
            || t.ends_with('까')
    }

    // ---- money on screen ------------------------------------------------------------

    /// Whether s shows an amount of money.
    pub fn has_currency(&self, s: &str) -> bool {
        self.currency_re.is_match(s)
    }

    /// Whether a link label is a web address.
    pub fn looks_like_url(&self, s: &str) -> bool {
        let t = s.trim();
        let l = t.to_lowercase();
        if l.contains("://") || l.starts_with("www.") {
            return true;
        }
        !t.contains(' ') && !t.contains('\t') && self.domain_re.is_match(&l)
    }

    /// Whether an input is a search box, by its label or stable id.
    pub fn is_search_field(&self, label: &str, view_id: &str) -> bool {
        let text = format!("{} {}", label.to_lowercase(), view_id.to_lowercase());
        contains_any(&text, &self.w.search_words)
    }

    /// Whether typing into a field with these traits would hand a password or one-time code to
    /// the agent.
    pub fn is_credential_field(&self, is_password: bool, label: &str, view_id: &str) -> bool {
        if is_password {
            return true;
        }
        let text = format!(
            "{} {}",
            label.to_lowercase(),
            view_id.to_lowercase().replace('_', " ")
        );
        if contains_any(&text, &self.w.password_words) {
            return true;
        }
        if contains_any(&text, &self.w.otp_negatives) {
            return false;
        }
        if contains_any(&text, &self.w.otp_words) {
            return true;
        }
        tokenize(&text)
            .iter()
            .any(|t| self.w.otp_tokens.contains(t))
    }

    /// Whether a text is about a one-time code (an input's caption, a notification body), and so
    /// any long digit run in it is a code, not a price or an order number.
    pub fn is_code_context(&self, text: &str) -> bool {
        let lower = text.to_lowercase();
        if contains_any(&lower, &self.w.not_code_phrases) {
            return false;
        }
        if contains_any(&lower, &self.w.otp_words) || contains_any(&lower, &self.w.password_words) {
            return true;
        }
        if tokenize(&lower)
            .iter()
            .any(|t| self.w.otp_tokens.contains(t))
        {
            return true;
        }
        self.has_cjk(text) && contains_any(&self.cjk_core(text), &self.w.cjk_code_keywords)
    }
}

const CJK_JOINTS: [&str; 5] = ["并", "並", "して", "하고", "및"];
const CLAIM_MODIFIERS: [&str; 4] = ["确认", "確認", "立即", "去"];

fn is_number(t: &str) -> bool {
    !t.is_empty() && t.chars().all(|c| c.is_ascii_digit())
}

pub(crate) fn tokenize(text: &str) -> Vec<String> {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut out = Vec::new();
    let mut buf = String::new();
    for (i, c) in chars.iter().enumerate() {
        if c.is_alphanumeric() {
            buf.push(*c);
        } else if (*c == '\'' || *c == '’' || *c == '-')
            && !buf.is_empty()
            && chars.get(i + 1).map(|n| n.is_alphabetic()).unwrap_or(false)
        {
            buf.push(if *c == '’' { '\'' } else { *c });
        } else if !buf.is_empty() {
            out.push(std::mem::take(&mut buf));
        }
    }
    if !buf.is_empty() {
        out.push(buf);
    }
    out
}

fn is_cjk_char(c: char) -> bool {
    matches!(c as u32,
        0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF |
        0x3040..=0x30FF | 0x31F0..=0x31FF |
        0x1100..=0x11FF | 0x3130..=0x318F | 0xAC00..=0xD7AF |
        0x20000..=0x2FA1F)
}

fn is_punct(c: char) -> bool {
    matches!(c as u32,
        0x21..=0x2F | 0x3A..=0x40 | 0x5B..=0x60 | 0x7B..=0x7E |
        0x2000..=0x206F | 0x3000..=0x303F | 0xFE30..=0xFE4F | 0xFF00..=0xFF65)
}

fn is_symbol(c: char) -> bool {
    matches!(c as u32, 0x20A0..=0x20CF | 0x2190..=0x2BFF)
}

fn starts_with_phrase(ws: &[String], from: usize, phrases: &[Vec<String>]) -> bool {
    phrases
        .iter()
        .any(|p| !p.is_empty() && p.len() <= ws.len() - from && ws[from..from + p.len()] == p[..])
}

fn contains_phrase(ws: &[String], phrases: &[Vec<String>]) -> bool {
    phrases.iter().any(|p| {
        !p.is_empty()
            && p.len() <= ws.len()
            && (0..=ws.len() - p.len()).any(|i| ws[i..i + p.len()] == p[..])
    })
}

fn contains_any(s: &str, subs: &[String]) -> bool {
    subs.iter().any(|sub| s.contains(sub.as_str()))
}

fn has_prefix_any(s: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|p| s.starts_with(p.as_str()))
}

fn strip_claim_tokens(ws: &[String], w: &Words, claim_phrases: &[Vec<String>]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < ws.len() {
        let phrase = claim_phrases
            .iter()
            .find(|p| !p.is_empty() && p.len() <= ws.len() - i && ws[i..i + p.len()] == p[..]);
        match phrase {
            Some(p) => i += p.len(),
            None => {
                if !w.claim_words.contains(&ws[i]) {
                    out.push(ws[i].clone());
                }
                i += 1;
            }
        }
    }
    out
}
