//! `browser.profiles` / `browser.claim` —— profile 认领的 agent 半边（browser-identity D3）。
//!
//! Chrome 不给扩展任何读 profile 的 API，扩展只知道自己的 `nodeId`。「这个节点是哪个 profile」只有
//! 站在机器上的人能回答：列出用户数据目录里的全部 profile（`browser.profiles`），再逐个用那个 profile
//! 打开扩展自己的认领页（`browser.claim`），页面里的扩展实例把 `nonce` 交回 Stream。交回的是谁，
//! 那个 profile 就是谁。
//!
//! 平台无关：环境变量、读文件、spawn 都从外面注入（spawn 复用 `launch.rs` 的 `ProcessWorld`），
//! 于是三个平台的默认目录、`Local State` 的解析、命令行的拼法在 Linux 的 `cargo test` 上全都覆盖得到，
//! 单测也永远不会真的拉起一个浏览器。

use crate::launch::{LaunchSpec, ProcessWorld};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// `browser.profiles` 的入参。全部可选——默认就是"用户自己那个 Chrome 的默认用户数据目录"。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ProfilesSpec {
    /// 浏览器可执行文件。只用来推断是哪一家（Chrome / Chromium），用户数据目录跟着换。
    #[serde(default)]
    pub exe: Option<String>,
    /// 显式指定用户数据目录。给了就不推断——用户用 `--user-data-dir` 起过另一份 Chrome 时用得上。
    #[serde(default, rename = "userDataDir")]
    pub user_data_dir: Option<String>,
    /// 看哪个扩展装没装。缺省 = Stream 扩展（`STREAM_EXTENSION_ID`）。
    #[serde(default, rename = "extensionId")]
    pub extension_id: Option<String>,
}

/// Stream 扩展的固定 id（扩展清单里的 `key` 派生，unpacked 装载也不变）。
pub const STREAM_EXTENSION_ID: &str = "dmhlfkdjljnilhnfajjpaobehenbokij";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    /// `--profile-directory` 的值（`Default`、`Profile 1`）。不随用户改名而变，是认领的键。
    pub dir: String,
    /// Chrome 里显示的名字（用户可改）。
    pub name: String,
    /// 这个 profile 登录 Chrome 用的 Google 账号。只给用户起名时作提示，不参与任何判定。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaia_email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gaia_name: Option<String>,
    /// 这个 profile 里装着并启用了 Stream 扩展。两份偏好文件都读不出来时缺席（不知道，不是没装）。
    /// 面板据此只给装了的 profile 开认领页——没装的开出来只是一扇打不开的窗。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_extension: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profiles {
    pub user_data_dir: String,
    pub profiles: Vec<ProfileInfo>,
    /// `profile.last_active_profiles`：此刻（或 Chrome 上次退出时）打开着的 profile。
    pub last_active: Vec<String>,
}

/// 是哪一家浏览器——只决定默认用户数据目录在哪。
#[derive(Debug, Clone, Copy, PartialEq)]
enum Flavour {
    Chrome,
    Chromium,
}

/// 从 `exe` 推：文件名里带 `chromium` 就是 Chromium，其余一律按 Chrome。手工切两种分隔符，理由同
/// `launch::target_stem`：这串路径可能是后端从 Linux 容器里传下来的 Windows 路径。
fn flavour_of(exe: Option<&str>) -> Flavour {
    let stem = exe.map(|e| e.rsplit(['/', '\\']).next().unwrap_or(e).to_lowercase()).unwrap_or_default();
    if stem.contains("chromium") {
        Flavour::Chromium
    } else {
        Flavour::Chrome
    }
}

/// 默认的用户数据目录。`os` 取 `std::env::consts::OS` 的值，由调用方传进来——这样三个平台的位置都能
/// 在 Linux 上单测。拼接用该平台自己的分隔符、不用 `PathBuf::join`：后者的分隔符跟着**编译目标**走，
/// 在 Linux 上测 Windows 路径会拼出 `C:\…\Local/Google\…` 这种两不像。
///
/// 位置（spike S4，Windows 已在真机复核，macOS 未验）：
/// - Windows `%LOCALAPPDATA%\Google\Chrome\User Data`
/// - macOS `~/Library/Application Support/Google/Chrome`
/// - Linux `$XDG_CONFIG_HOME/google-chrome`（缺省 `~/.config`）
fn default_user_data_dir(os: &str, flavour: Flavour, env: &dyn Fn(&str) -> Option<String>) -> Result<String, String> {
    let need = |k: &str| env(k).filter(|v| !v.is_empty()).ok_or_else(|| format!("user-data-dir-unknown: 环境变量 {k} 没有设置——传 `userDataDir` 指明"));
    Ok(match os {
        "windows" => {
            let rel = match flavour {
                Flavour::Chrome => r"Google\Chrome\User Data",
                Flavour::Chromium => r"Chromium\User Data",
            };
            format!(r"{}\{rel}", need("LOCALAPPDATA")?.trim_end_matches('\\'))
        }
        "macos" => {
            let rel = match flavour {
                Flavour::Chrome => "Google/Chrome",
                Flavour::Chromium => "Chromium",
            };
            format!("{}/Library/Application Support/{rel}", need("HOME")?.trim_end_matches('/'))
        }
        _ => {
            let base = match env("XDG_CONFIG_HOME").filter(|v| !v.is_empty()) {
                Some(x) => x,
                None => format!("{}/.config", need("HOME")?.trim_end_matches('/')),
            };
            let rel = match flavour {
                Flavour::Chrome => "google-chrome",
                Flavour::Chromium => "chromium",
            };
            format!("{}/{rel}", base.trim_end_matches('/'))
        }
    })
}

/// `Default` 在前，`Profile N` 按数字排（`Profile 10` 在 `Profile 2` 之后），其余按名字。
/// 面板按这个顺序列，和用户在 Chrome 的 profile 选单里看到的创建顺序一致。
fn sort_key(dir: &str) -> (u8, u64, String) {
    if dir == "Default" {
        return (0, 0, String::new());
    }
    if let Some(n) = dir.strip_prefix("Profile ").and_then(|n| n.parse::<u64>().ok()) {
        return (1, n, String::new());
    }
    (2, 0, dir.to_string())
}

fn non_empty(v: Option<&Value>) -> Option<String> {
    v.and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string)
}

/// 解析 `Local State`：`profile.info_cache.<dir>` 的 `name` / `user_name`（Google 邮箱，没登录时是空串）/
/// `gaia_name`，以及 `profile.last_active_profiles`（spike S4 确认的字段）。
///
/// 没有 `info_cache` 是错误而不是空列表：一个正常用过的 Chrome 至少有 `Default`，读出空表只会让面板
/// 说「这台机器没有 profile」，而真因是读错了文件。
pub fn parse_local_state(user_data_dir: &str, text: &str) -> Result<Profiles, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("local-state-invalid: Local State 不是合法 JSON（{e}）"))?;
    let profile = v.get("profile");
    let cache = profile
        .and_then(|p| p.get("info_cache"))
        .and_then(|c| c.as_object())
        .ok_or_else(|| "local-state-invalid: Local State 里没有 profile.info_cache——这不是 Chrome 的用户数据目录？".to_string())?;
    let mut profiles: Vec<ProfileInfo> = cache
        .iter()
        .map(|(dir, info)| ProfileInfo {
            dir: dir.clone(),
            name: non_empty(info.get("name")).unwrap_or_else(|| dir.clone()),
            gaia_email: non_empty(info.get("user_name")),
            gaia_name: non_empty(info.get("gaia_name")),
            has_extension: None,
        })
        .collect();
    profiles.sort_by_key(|p| sort_key(&p.dir));
    let last_active = profile
        .and_then(|p| p.get("last_active_profiles"))
        .and_then(|a| a.as_array())
        .map(|a| a.iter().filter_map(|d| d.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    Ok(Profiles { user_data_dir: user_data_dir.to_string(), profiles, last_active })
}

/// 一份偏好文件里 `extensions.settings.<id>` 怎么说：`Ok(None)` = 没有这一项，`Ok(Some(启用))`，
/// `Err` = 不是 JSON（当作读不到）。
///
/// 停用的判法（新旧 Chrome 都写过）：`disable_reasons` 是非空数组或非零位掩码，或老式的 `state: 0`。
/// unpacked 装载是 `location: 4` 带 `path`，商店装的是别的 `location`——都算装了，不看来源。
pub fn extension_entry(text: &str, id: &str) -> Result<Option<bool>, ()> {
    let v: Value = serde_json::from_str(text).map_err(|_| ())?;
    let Some(e) = v.get("extensions").and_then(|x| x.get("settings")).and_then(|x| x.get(id)) else {
        return Ok(None);
    };
    let disabled_by_reasons = match e.get("disable_reasons") {
        Some(Value::Array(a)) => !a.is_empty(),
        Some(Value::Number(n)) => n.as_u64() != Some(0),
        _ => false,
    };
    let disabled_by_state = e.get("state").and_then(|s| s.as_u64()) == Some(0);
    Ok(Some(!(disabled_by_reasons || disabled_by_state)))
}

/// 这个 profile 里装没装扩展。先读 `Secure Preferences`（Windows / macOS 把扩展记在这里，2026-10-23
/// Cortana 实测），没有这一项再读 `Preferences`（Linux 记在这里）。两份都读得到、都没有这一项 = 没装；
/// 两份都读不到 = 不知道。profile 目录名带分隔符就不读：拼出来的路径会出用户数据目录。
fn profile_has_extension(
    dir: &str,
    profile: &str,
    sep: char,
    id: &str,
    read: &mut dyn FnMut(&Path) -> std::io::Result<String>,
) -> Option<bool> {
    if profile.is_empty() || profile.contains(['/', '\\', '\0']) || profile == "." || profile == ".." {
        return None;
    }
    let mut readable = false;
    for file in ["Secure Preferences", "Preferences"] {
        let path = PathBuf::from(format!("{dir}{sep}{profile}{sep}{file}"));
        match read(&path).ok().map(|t| extension_entry(&t, id)) {
            Some(Ok(Some(enabled))) => return Some(enabled),
            Some(Ok(None)) => readable = true,
            _ => {}
        }
    }
    readable.then_some(false)
}

/// `browser.profiles`：定位用户数据目录、读 `Local State`、解析，再逐个 profile 看扩展装没装。只读，Chrome
/// 开着也能读（Chrome 写这些文件是先写临时文件再改名，读不到半份）。
pub fn profiles(
    spec: &ProfilesSpec,
    os: &str,
    env: &dyn Fn(&str) -> Option<String>,
    read: &mut dyn FnMut(&Path) -> std::io::Result<String>,
) -> Result<Profiles, String> {
    let dir = match spec.user_data_dir.as_deref().filter(|d| !d.trim().is_empty()) {
        Some(d) => d.to_string(),
        None => default_user_data_dir(os, flavour_of(spec.exe.as_deref()), env)?,
    };
    let sep = if os == "windows" { '\\' } else { '/' };
    let root = dir.trim_end_matches(['/', '\\']).to_string();
    let file = PathBuf::from(format!("{root}{sep}Local State"));
    let text = read(&file).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("local-state-missing: {} 不存在——Chrome 没装在默认位置？传 `userDataDir` 指明", file.display())
        } else {
            format!("local-state-unreadable: 读 {} 失败（{e}）", file.display())
        }
    })?;
    let mut list = parse_local_state(&dir, &text)?;
    let id = spec.extension_id.as_deref().filter(|i| !i.is_empty()).unwrap_or(STREAM_EXTENSION_ID);
    for p in &mut list.profiles {
        p.has_extension = profile_has_extension(&root, &p.dir, sep, id, read);
    }
    Ok(list)
}

/// `browser.claim` 的入参。
#[derive(Debug, Clone, Deserialize)]
pub struct ClaimSpec {
    #[serde(rename = "profileDirectory")]
    pub profile_directory: String,
    pub url: String,
    #[serde(default)]
    pub exe: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ClaimOutcome {
    /// 命令发出去了。**不代表页面打开了**：Chrome 已在运行时这次调用会转给已有进程，进程立刻退出；
    /// 页面开没开、扩展在不在，只有 `nonce` 交没交回能回答（后端 20 秒的等待就是为此）。
    pub launched: bool,
}

/// 命令行：`--profile-directory=<dir> <url>`。**不带 `--no-startup-window`**：要的正是一扇开着认领页的
/// 窗口；认领由用户在面板上点出来，他在场，开窗是预期的。
///
/// `url` 只收 `chrome-extension://`：认领只需要打开扩展自己的页面。「在任意 profile 里打开任意网址」是
/// 更大的一份能力，不顺手给出去；顺带也保证这一格不会以 `-` 开头被 Chrome 当成开关。
/// `profileDirectory` 不许带路径分隔符：它是用户数据目录下的一个目录名，带了分隔符就指到别处去了。
pub fn claim_args(spec: &ClaimSpec) -> Result<Vec<String>, String> {
    let dir = spec.profile_directory.trim();
    if dir.is_empty() || dir.contains(['/', '\\', '\0']) || dir == "." || dir == ".." {
        return Err(format!("bad-profile-directory: {:?} 不是一个 profile 目录名", spec.profile_directory));
    }
    if !spec.url.starts_with("chrome-extension://") {
        return Err("bad-claim-url: browser.claim 只打开扩展自己的页面（chrome-extension://）".to_string());
    }
    Ok(vec![format!("--profile-directory={dir}"), spec.url.clone()])
}

/// 按 profile 打开认领页。可执行文件的定位与 `ensureApp` 同一套（`resolve_exe`：显式 `exe` 采信，
/// 否则平台常见位置）。**不判"Chrome 在不在跑"**：在跑时这次调用正是要转给已有进程（spike S1 实测
/// 「Opening in existing browser session」），不在跑时它就把 Chrome 连同那个 profile 一起拉起来。
pub fn claim<W: ProcessWorld>(spec: &ClaimSpec, world: &mut W) -> Result<ClaimOutcome, String> {
    let args = claim_args(spec)?;
    let exe = world.locate_exe(&LaunchSpec { exe: spec.exe.clone(), ..Default::default() })?;
    world.spawn(&exe, &args)?;
    Ok(ClaimOutcome { launched: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let m: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| m.get(k).cloned()
    }

    #[test]
    fn default_user_data_dir_per_platform() {
        let env = env_of(&[("LOCALAPPDATA", r"C:\Users\J\AppData\Local"), ("HOME", "/home/j")]);
        assert_eq!(default_user_data_dir("windows", Flavour::Chrome, &env).unwrap(), r"C:\Users\J\AppData\Local\Google\Chrome\User Data");
        assert_eq!(default_user_data_dir("macos", Flavour::Chrome, &env).unwrap(), "/home/j/Library/Application Support/Google/Chrome");
        assert_eq!(default_user_data_dir("linux", Flavour::Chrome, &env).unwrap(), "/home/j/.config/google-chrome");
        assert_eq!(default_user_data_dir("windows", Flavour::Chromium, &env).unwrap(), r"C:\Users\J\AppData\Local\Chromium\User Data");
        assert_eq!(default_user_data_dir("linux", Flavour::Chromium, &env).unwrap(), "/home/j/.config/chromium");
    }

    #[test]
    fn linux_honours_xdg_config_home() {
        let env = env_of(&[("HOME", "/home/j"), ("XDG_CONFIG_HOME", "/cfg/")]);
        assert_eq!(default_user_data_dir("linux", Flavour::Chrome, &env).unwrap(), "/cfg/google-chrome");
    }

    /// 缺环境变量要说出下一步，不能拼出一个 `\Google\Chrome\User Data` 去读。
    #[test]
    fn a_missing_env_var_is_an_actionable_error() {
        let e = default_user_data_dir("windows", Flavour::Chrome, &env_of(&[])).unwrap_err();
        assert!(e.contains("LOCALAPPDATA") && e.contains("userDataDir"), "{e}");
    }

    #[test]
    fn flavour_follows_the_exe_name() {
        assert_eq!(flavour_of(None), Flavour::Chrome);
        assert_eq!(flavour_of(Some(r"C:\Program Files\Google\Chrome\Application\chrome.exe")), Flavour::Chrome);
        assert_eq!(flavour_of(Some("/usr/bin/chromium-browser")), Flavour::Chromium);
        assert_eq!(flavour_of(Some(r"C:\X\Chromium\chrome.exe")), Flavour::Chrome, "只看文件名，不看目录");
    }

    const LOCAL_STATE: &str = r#"{
      "browser": { "enabled_labs_experiments": [] },
      "profile": {
        "info_cache": {
          "Profile 10": { "name": "十号", "user_name": "", "gaia_name": "" },
          "Profile 2": { "name": "个人", "user_name": "me@example.com", "gaia_name": "Me" },
          "Default": { "name": "工作", "user_name": "w@example.com", "gaia_name": "Work" },
          "Guest Profile": { "user_name": "" }
        },
        "last_active_profiles": ["Default", "Profile 2"]
      }
    }"#;

    #[test]
    fn local_state_parses_into_sorted_profiles() {
        let p = parse_local_state("/u", LOCAL_STATE).unwrap();
        let dirs: Vec<&str> = p.profiles.iter().map(|x| x.dir.as_str()).collect();
        assert_eq!(dirs, vec!["Default", "Profile 2", "Profile 10", "Guest Profile"]);
        assert_eq!(p.profiles[0], ProfileInfo { dir: "Default".into(), name: "工作".into(), gaia_email: Some("w@example.com".into()), gaia_name: Some("Work".into()), has_extension: None });
        // 空串 = 没登录 Chrome，不带这两格
        assert_eq!(p.profiles[2].gaia_email, None);
        assert_eq!(p.profiles[2].gaia_name, None);
        // 没有 name 的退回目录名，面板总有东西可显示
        assert_eq!(p.profiles[3].name, "Guest Profile");
        assert_eq!(p.last_active, vec!["Default", "Profile 2"]);
        assert_eq!(p.user_data_dir, "/u");
    }

    /// 跨进程的字段名没有编译器管：后端读的是 camelCase、缺席就是键不在。
    #[test]
    fn profiles_go_out_under_their_wire_names() {
        let j = serde_json::to_value(parse_local_state("/u", LOCAL_STATE).unwrap()).unwrap();
        assert_eq!(j["userDataDir"], "/u");
        assert_eq!(j["lastActive"], serde_json::json!(["Default", "Profile 2"]));
        assert_eq!(j["profiles"][0]["gaiaEmail"], "w@example.com");
        assert_eq!(j["profiles"][0]["gaiaName"], "Work");
        assert!(j["profiles"][2].get("gaiaEmail").is_none(), "{j}");
    }

    #[test]
    fn last_active_is_optional() {
        let p = parse_local_state("/u", r#"{"profile":{"info_cache":{"Default":{"name":"A"}}}}"#).unwrap();
        assert!(p.last_active.is_empty());
    }

    #[test]
    fn a_file_without_info_cache_is_an_error_not_an_empty_list() {
        assert!(parse_local_state("/u", "{}").unwrap_err().starts_with("local-state-invalid:"));
        assert!(parse_local_state("/u", "not json").unwrap_err().starts_with("local-state-invalid:"));
    }

    #[test]
    fn profiles_reads_local_state_under_the_resolved_dir() {
        let env = env_of(&[("LOCALAPPDATA", r"C:\L")]);
        let mut seen = Vec::new();
        let p = profiles(&ProfilesSpec::default(), "windows", &env, &mut |path| {
            seen.push(path.to_string_lossy().into_owned());
            Ok(LOCAL_STATE.to_string())
        })
        .unwrap();
        assert_eq!(seen[0], r"C:\L\Google\Chrome\User Data\Local State");
        assert_eq!(p.user_data_dir, r"C:\L\Google\Chrome\User Data");
        assert_eq!(p.profiles.len(), 4);
    }

    #[test]
    fn an_explicit_user_data_dir_wins() {
        let mut seen = Vec::new();
        profiles(
            &ProfilesSpec { user_data_dir: Some("/opt/u/".into()), exe: Some("/usr/bin/chromium".into()), ..Default::default() },
            "linux",
            &env_of(&[]),
            &mut |path| {
                seen.push(path.to_string_lossy().into_owned());
                Ok(LOCAL_STATE.to_string())
            },
        )
        .unwrap();
        assert_eq!(seen[0], "/opt/u/Local State");
    }

    #[test]
    fn a_missing_local_state_says_what_to_do() {
        let e = profiles(&ProfilesSpec::default(), "linux", &env_of(&[("HOME", "/h")]), &mut |_| {
            Err(std::io::Error::from(std::io::ErrorKind::NotFound))
        })
        .unwrap_err();
        assert!(e.starts_with("local-state-missing:") && e.contains("userDataDir"), "{e}");
    }

    const EXT: &str = "dmhlfkdjljnilhnfajjpaobehenbokij";

    /// Windows 真机（2026-10-23 Cortana）`Secure Preferences` 里的那一项，删到只剩判定用得上的几格。
    fn prefs_with(entry: &str) -> String {
        format!(r#"{{"extensions":{{"settings":{{"aaaabbbbccccddddeeeeffffgggghhhh":{{"state":1}},"{EXT}":{entry}}}}}}}"#)
    }

    #[test]
    fn an_unpacked_install_counts_as_installed() {
        let e = r#"{"location":4,"path":"\\\\wsl.localhost\\Ubuntu\\x\\data\\extension","creation_flags":38,"from_webstore":false,
            "granted_permissions":{"explicit_host":["<all_urls>"]},"active_permissions":{"explicit_host":["<all_urls>"]}}"#;
        assert_eq!(extension_entry(&prefs_with(e), EXT), Ok(Some(true)));
        // 新版 Chrome 写空的 disable_reasons 数组：照样是启用
        assert_eq!(extension_entry(&prefs_with(r#"{"location":4,"path":"x","disable_reasons":[]}"#), EXT), Ok(Some(true)));
        assert_eq!(extension_entry(&prefs_with(r#"{"location":1,"state":1}"#), EXT), Ok(Some(true)));
    }

    #[test]
    fn a_disabled_install_counts_as_not_installed() {
        for e in [r#"{"location":4,"path":"x","disable_reasons":[1]}"#, r#"{"location":4,"path":"x","disable_reasons":1}"#, r#"{"location":4,"path":"x","state":0}"#] {
            assert_eq!(extension_entry(&prefs_with(e), EXT), Ok(Some(false)), "{e}");
        }
    }

    #[test]
    fn no_entry_is_absent_and_bad_json_is_unreadable() {
        assert_eq!(extension_entry(r#"{"extensions":{"settings":{}}}"#, EXT), Ok(None));
        assert_eq!(extension_entry(r#"{"profile":{}}"#, EXT), Ok(None));
        assert!(extension_entry("not json", EXT).is_err());
    }

    /// 每个 profile 先读 `Secure Preferences`（Windows / macOS 把扩展记在这里），没有这一项再读 `Preferences`（Linux）。
    #[test]
    fn profiles_report_the_extension_per_profile() {
        let files: HashMap<String, String> = [
            ("/u/Local State", LOCAL_STATE.to_string()),
            ("/u/Default/Secure Preferences", prefs_with(r#"{"location":4,"path":"x"}"#)),
            ("/u/Profile 2/Secure Preferences", r#"{"extensions":{"settings":{}}}"#.to_string()),
            ("/u/Profile 2/Preferences", prefs_with(r#"{"location":4,"path":"x","disable_reasons":[1]}"#)),
            ("/u/Profile 10/Preferences", r#"{"extensions":{"settings":{}}}"#.to_string()),
            // Guest Profile：两份都读不到 → 不知道
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();
        let p = profiles(&ProfilesSpec { user_data_dir: Some("/u".into()), ..Default::default() }, "linux", &env_of(&[]), &mut |path| {
            files.get(&path.to_string_lossy().into_owned()).cloned().ok_or_else(|| std::io::Error::from(std::io::ErrorKind::NotFound))
        })
        .unwrap();
        let got: Vec<(&str, Option<bool>)> = p.profiles.iter().map(|x| (x.dir.as_str(), x.has_extension)).collect();
        assert_eq!(got, vec![("Default", Some(true)), ("Profile 2", Some(false)), ("Profile 10", Some(false)), ("Guest Profile", None)]);
        let j = serde_json::to_value(&p).unwrap();
        assert_eq!(j["profiles"][0]["hasExtension"], true);
        assert!(j["profiles"][3].get("hasExtension").is_none(), "{j}");
    }

    #[test]
    fn profiles_check_the_extension_id_they_are_given_and_use_windows_separators() {
        let mut seen = Vec::new();
        let p = profiles(
            &ProfilesSpec { user_data_dir: Some(r"C:\U".into()), extension_id: Some("otherid".into()), ..Default::default() },
            "windows",
            &env_of(&[]),
            &mut |path| {
                let k = path.to_string_lossy().into_owned();
                seen.push(k.clone());
                if k.ends_with("Local State") {
                    Ok(r#"{"profile":{"info_cache":{"Default":{"name":"A"}}}}"#.to_string())
                } else {
                    Ok(prefs_with(r#"{"location":4,"path":"x"}"#))
                }
            },
        )
        .unwrap();
        assert_eq!(seen, vec![r"C:\U\Local State", r"C:\U\Default\Secure Preferences", r"C:\U\Default\Preferences"]);
        assert_eq!(p.profiles[0].has_extension, Some(false), "装的是我们的扩展，不是 otherid");
    }

    /// `Local State` 里的键带分隔符就不拼路径去读——那会读到用户数据目录之外。
    #[test]
    fn a_profile_key_with_a_separator_is_not_read() {
        let mut seen = Vec::new();
        let p = profiles(&ProfilesSpec { user_data_dir: Some("/u".into()), ..Default::default() }, "linux", &env_of(&[]), &mut |path| {
            let k = path.to_string_lossy().into_owned();
            seen.push(k.clone());
            if k.ends_with("Local State") {
                Ok(r#"{"profile":{"info_cache":{"../x":{"name":"A"}}}}"#.to_string())
            } else {
                Ok(String::new())
            }
        })
        .unwrap();
        assert_eq!(seen, vec!["/u/Local State"]);
        assert_eq!(p.profiles[0].has_extension, None);
    }

    fn spec(dir: &str, url: &str) -> ClaimSpec {
        ClaimSpec { profile_directory: dir.into(), url: url.into(), exe: None }
    }
    const URL: &str = "chrome-extension://dmhlfkdjljnilhnfajjpaobehenbokij/claim.html#n=abc";

    #[test]
    fn claim_args_are_profile_then_url() {
        assert_eq!(claim_args(&spec("Profile 1", URL)).unwrap(), vec!["--profile-directory=Profile 1", URL]);
    }

    #[test]
    fn claim_only_opens_extension_pages() {
        assert!(claim_args(&spec("Default", "https://example.com/")).unwrap_err().starts_with("bad-claim-url:"));
        assert!(claim_args(&spec("Default", "--user-data-dir=/tmp/x")).is_err());
    }

    #[test]
    fn claim_rejects_a_directory_that_is_not_a_name() {
        for bad in ["", "  ", "../Default", r"..\Default", "a/b", ".."] {
            assert!(claim_args(&spec(bad, URL)).unwrap_err().starts_with("bad-profile-directory:"), "{bad:?}");
        }
    }

    struct FakeWorld {
        spawns: Vec<(PathBuf, Vec<String>)>,
        located: Vec<Option<String>>,
    }
    impl ProcessWorld for FakeWorld {
        fn pid_of(&mut self, _stem: &str) -> Option<u32> {
            Some(1)
        }
        fn locate_exe(&mut self, spec: &LaunchSpec) -> Result<PathBuf, String> {
            self.located.push(spec.exe.clone());
            Ok(PathBuf::from("/fake/chrome"))
        }
        fn spawn(&mut self, exe: &Path, args: &[String]) -> Result<(), String> {
            self.spawns.push((exe.to_path_buf(), args.to_vec()));
            Ok(())
        }
        fn dwell(&mut self, _ms: u64) {}
    }

    /// Chrome 在跑也照样 spawn：这次调用就是要转给已有进程，在那个 profile 里开一扇窗。
    #[test]
    fn claim_spawns_even_when_chrome_is_running() {
        let mut w = FakeWorld { spawns: Vec::new(), located: Vec::new() };
        let out = claim(&ClaimSpec { exe: Some("C:/c/chrome.exe".into()), ..spec("Default", URL) }, &mut w).unwrap();
        assert_eq!(out, ClaimOutcome { launched: true });
        assert_eq!(w.located, vec![Some("C:/c/chrome.exe".to_string())]);
        assert_eq!(w.spawns, vec![(PathBuf::from("/fake/chrome"), vec!["--profile-directory=Default".to_string(), URL.to_string()])]);
    }

    #[test]
    fn a_bad_claim_never_spawns() {
        let mut w = FakeWorld { spawns: Vec::new(), located: Vec::new() };
        assert!(claim(&spec("Default", "https://x/"), &mut w).is_err());
        assert!(w.spawns.is_empty());
    }
}
