//! Word and category tables behind the sensitive-action gate.
//!
//! The tables are the data files the Android executor ships (`assets/policy/*.json`), copied
//! here so the device core is self-contained. They are data, not policy code: a word-list
//! change touches the JSON, and the detection logic below is the only thing that reads them.

use serde::Deserialize;
use std::collections::HashSet;

use crate::ax::AppInfo;

pub mod detect;
pub mod gate;

pub use detect::Detect;
pub use gate::{kind_of, Gate};

/// `assets/policy/words.json`.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Words {
    pub commit_verbs: HashSet<String>,
    pub commit_phrases: Vec<String>,
    pub excluded_starts: Vec<String>,
    pub slide_verbs: HashSet<String>,
    pub cjk_commit_prefixes: Vec<String>,
    pub cjk_claim_words: Vec<String>,
    pub claim_words: HashSet<String>,
    pub claim_phrases: Vec<String>,
    pub cjk_claim_exceptions: Vec<String>,
    pub claim_exception_words: HashSet<String>,
    pub money_words: HashSet<String>,
    pub money_phrases: Vec<String>,
    pub cjk_money_keywords: Vec<String>,
    pub negative_words: HashSet<String>,
    pub cjk_negatives: Vec<String>,
    pub affirmative_words: HashSet<String>,
    pub cjk_affirmatives: Vec<String>,
    pub install_verbs: HashSet<String>,
    pub cjk_install_prefixes: Vec<String>,
    pub call_words: HashSet<String>,
    pub call_phrases: Vec<String>,
    pub cjk_call_prefixes: Vec<String>,
    pub setting_verbs: HashSet<String>,
    pub stepper_words: HashSet<String>,
    pub cjk_stepper_prefixes: Vec<String>,
    pub search_words: Vec<String>,
    pub password_words: Vec<String>,
    pub otp_words: Vec<String>,
    pub otp_tokens: HashSet<String>,
    pub otp_negatives: Vec<String>,
    pub not_code_phrases: Vec<String>,
    pub cjk_code_keywords: Vec<String>,
    pub code_nouns: Vec<String>,
    pub code_phrases: Vec<String>,
    pub code_words: Vec<String>,
    pub currency_words: HashSet<String>,
    pub unit_words: HashSet<String>,
    pub month_words: HashSet<String>,
    pub cancel_words: Vec<String>,
    pub cjk_cancel_prefixes: Vec<String>,
    pub currency_signs: String,
    pub unit_runes: String,
}

/// One category row of `assets/policy/apps.json`.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
pub struct Category {
    pub deny: bool,
    pub ids: Vec<String>,
    pub names: Vec<String>,
    pub ask: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default)]
struct CategoriesFile {
    categories: std::collections::BTreeMap<String, Category>,
}

/// App categories. `finance`, `passwords` and `blocked` are deny categories: an app in one of
/// them is invisible to the caller — no screen, no actions, no reads.
#[derive(Debug, Clone, Default)]
pub struct Categories {
    all: Vec<(String, Category)>,
}

impl Categories {
    pub fn from_json(json: &str) -> Result<Self, String> {
        let file: CategoriesFile =
            serde_json::from_str(json).map_err(|e| format!("apps.json: {e}"))?;
        Ok(Self {
            all: file.categories.into_iter().collect(),
        })
    }

    /// The category of an app by bundle id (a trailing `*` matches a prefix) or display name.
    pub fn of(&self, app: &AppInfo) -> Option<(&str, &Category)> {
        let pkg = app.package.to_lowercase();
        for (name, category) in &self.all {
            if category.ids.iter().any(|id| id.to_lowercase() == pkg) {
                return Some((name, category));
            }
        }
        for (name, category) in &self.all {
            if category.ids.iter().any(|id| {
                id.strip_suffix('*')
                    .map(|prefix| pkg.starts_with(&prefix.to_lowercase()))
                    .unwrap_or(false)
            }) {
                return Some((name, category));
            }
        }
        let title = app.name.to_lowercase();
        if !title.is_empty() {
            for (name, category) in &self.all {
                if category.names.iter().any(|n| n.to_lowercase() == title) {
                    return Some((name, category));
                }
            }
        }
        None
    }

    pub fn is_denied(&self, app: &AppInfo) -> bool {
        self.of(app).map(|(_, c)| c.deny).unwrap_or(false)
    }

    pub fn ask_of(&self, category: &str) -> &[String] {
        self.all
            .iter()
            .find(|(name, _)| name == category)
            .map(|(_, c)| c.ask.as_slice())
            .unwrap_or(&[])
    }
}

/// The loaded policy: word tables, detection and categories.
#[derive(Debug, Clone)]
pub struct Policy {
    pub detect: Detect,
    pub categories: Categories,
}

impl Policy {
    pub fn embedded() -> Result<Self, String> {
        let words: Words = serde_json::from_str(include_str!("../../assets/policy/words.json"))
            .map_err(|e| format!("words.json: {e}"))?;
        let categories = Categories::from_json(include_str!("../../assets/policy/apps.json"))?;
        Ok(Self {
            detect: Detect::new(words),
            categories,
        })
    }

    pub fn gate(&self) -> Gate<'_> {
        Gate::new(&self.detect, &self.categories)
    }

    pub fn category_name(&self, app: &AppInfo) -> Option<String> {
        self.categories.of(app).map(|(name, _)| name.to_string())
    }

    pub fn denied(&self, app: &AppInfo) -> bool {
        self.categories.is_denied(app)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(package: &str, name: &str) -> AppInfo {
        AppInfo {
            package: package.into(),
            name: name.into(),
        }
    }

    #[test]
    fn embedded_tables_load() {
        let policy = Policy::embedded().unwrap();
        assert!(policy.denied(&app("com.apple.Passbook", "Wallet")));
        assert!(policy.denied(&app("com.eg.android.AlipayGphone", "")));
        assert_eq!(
            policy.category_name(&app("com.apple.mobilesafari", "")),
            Some("browsers".into())
        );
        assert_eq!(
            policy.category_name(&app("com.tencent.xin", "WeChat")),
            Some("messaging".into())
        );
        assert!(!policy.denied(&app("com.tencent.xin", "WeChat")));
    }

    #[test]
    fn prefix_ids_match() {
        let policy = Policy::embedded().unwrap();
        // Any id in the table ending in `*` matches by prefix; find one at runtime.
        let (_, cat) = policy
            .categories
            .all
            .iter()
            .find(|(_, c)| c.ids.iter().any(|id| id.ends_with('*')))
            .expect("at least one prefix id");
        let prefix = cat
            .ids
            .iter()
            .find(|id| id.ends_with('*'))
            .unwrap()
            .trim_end_matches('*');
        assert!(policy
            .categories
            .of(&app(&format!("{prefix}some.app"), ""))
            .is_some());
    }
}
