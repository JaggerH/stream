//! `--register` / `--unregister`：把这个可执行文件登记成 Chrome 的 **native messaging host**。
//!
//! 登记有两半，缺一不可：
//! 1. 一份 **manifest JSON**（host 名字 / 可执行文件路径 / `allowed_origins`）。
//! 2. 让浏览器找到它 —— Linux/mac 是"放进它约定的目录"，Windows 是"往注册表写一个指向它的键"。
//!
//! `allowed_origins` 是这条链路唯一的准入闸门：只有列在里面的 extension id 能拉起我们。
//! **所以它必须由调用方显式给出**（`--extension-id` / `STREAM_EXTENSION_ID`），代码里绝不
//! 硬编码一个猜的 id —— 猜错的后果不是报错，是给了错的扩展一把能拿 token 的钥匙。

use std::path::{Path, PathBuf};

use crate::datadir;

/// 默认的 host 名字。Chrome 要求 `[a-z0-9._]+`，且扩展那边 `connectNative()` 用的就是这个字符串。
pub const DEFAULT_HOST_NAME: &str = "com.stream.desktop";

/// 落地平台。`--register` 的目标不一定是本进程所在的平台 —— WSL 里跑的 Linux 进程要给
/// **Windows** Chrome 登记，这是本项目的实际场景。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Linux,
    MacOs,
    Windows,
}

/// Chrome 家族里我们认得的那几个浏览器：(展示名, Linux 配置目录名, macOS 目录名, Windows 注册表根)。
const BROWSERS: &[(&str, &str, &str, &str)] = &[
    ("Chrome", "google-chrome", "Google/Chrome", r"Software\Google\Chrome"),
    ("Chromium", "chromium", "Chromium", r"Software\Chromium"),
    ("Edge", "microsoft-edge", "Microsoft Edge", r"Software\Microsoft\Edge"),
];

/// manifest 该放进哪些目录（Linux/macOS）。返回 (浏览器名, 浏览器配置根, NativeMessagingHosts 目录)。
///
/// 返回**全部**已知浏览器；要不要真写由调用方按"这个浏览器的配置根在不在"决定 —— 不去给
/// 一个没装的浏览器凭空造目录。
pub fn manifest_dirs(target: Target, home: &Path) -> Vec<(&'static str, PathBuf, PathBuf)> {
    BROWSERS
        .iter()
        .map(|(label, linux, mac, _)| match target {
            Target::Linux => {
                let root = home.join(".config").join(linux);
                (*label, root.clone(), root.join("NativeMessagingHosts"))
            }
            Target::MacOs => {
                let root = home.join("Library").join("Application Support").join(mac);
                (*label, root.clone(), root.join("NativeMessagingHosts"))
            }
            // Windows 不靠目录找 manifest，靠注册表；这里只回一个"manifest 文件放哪"的位置。
            Target::Windows => {
                let root = home.join(".stream").join("NativeMessagingHosts");
                (*label, root.clone(), root)
            }
        })
        .collect()
}

/// Windows 注册表键的完整路径（`HKCU\...\NativeMessagingHosts\<host>`）。
pub fn registry_keys(host_name: &str) -> Vec<(&'static str, String)> {
    BROWSERS
        .iter()
        .map(|(label, _, _, root)| (*label, format!(r"HKCU\{root}\NativeMessagingHosts\{host_name}")))
        .collect()
}

/// `reg.exe` 的 argv。默认值(`/ve`)存的就是 manifest 文件的 **Windows** 路径 —— 这是 Chrome
/// 在 Windows 上找 manifest 的唯一途径。
pub fn registry_add_command(key: &str, manifest_windows_path: &str) -> Vec<String> {
    vec![
        "reg.exe".into(),
        "add".into(),
        key.into(),
        "/ve".into(),
        "/t".into(),
        "REG_SZ".into(),
        "/d".into(),
        manifest_windows_path.into(),
        "/f".into(),
    ]
}

/// `reg.exe` 删键的 argv。
pub fn registry_delete_command(key: &str) -> Vec<String> {
    vec!["reg.exe".into(), "delete".into(), key.into(), "/f".into()]
}

/// host 名字的文法（Chrome 定的）：小写字母、数字、`.`、`_`，不能以 `.` 开头/结尾、不能有连续 `.`。
pub fn validate_host_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("host name 不能为空".into());
    }
    if !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '_') {
        return Err(format!("host name「{name}」含非法字符：只允许 a-z 0-9 . _"));
    }
    if name.starts_with('.') || name.ends_with('.') || name.contains("..") {
        return Err(format!("host name「{name}」的点号位置非法"));
    }
    Ok(())
}

/// extension id 的文法：32 个 `a`–`p` 的字母（Chrome 的 base16 变体编码）。
///
/// 这一条不是洁癖：写歪一个字符的 id 不会报错，只会让 `connectNative` 在运行期被静默拒绝，
/// 而两边看着都"配好了"。
pub fn validate_extension_id(id: &str) -> Result<(), String> {
    if id.len() == 32 && id.chars().all(|c| ('a'..='p').contains(&c)) {
        Ok(())
    } else {
        Err(format!("extension id「{id}」不像一个 Chrome 扩展 id（应为 32 个 a–p 的字母）"))
    }
}

/// manifest 的正文。
pub fn manifest_json(host_name: &str, exe_path: &str, extension_ids: &[String]) -> String {
    let origins: Vec<String> = extension_ids.iter().map(|id| format!("chrome-extension://{id}/")).collect();
    let value = serde_json::json!({
        "name": host_name,
        "description": "Stream host agent — hands the local ext-relay token to the Stream extension",
        "path": exe_path,
        "type": "stdio",
        "allowed_origins": origins,
    });
    serde_json::to_string_pretty(&value).unwrap_or_default()
}

/// 本进程是不是跑在 WSL 里（据此决定 `--register` 默认打 Linux 还是 Windows Chrome）。
pub fn is_wsl(proc_version: &str) -> bool {
    let v = proc_version.to_ascii_lowercase();
    v.contains("microsoft") || v.contains("wsl")
}

/// 本机默认的登记目标。
pub fn default_target() -> Target {
    if cfg!(windows) {
        Target::Windows
    } else if cfg!(target_os = "macos") {
        Target::MacOs
    } else if std::fs::read_to_string("/proc/version").map(|v| is_wsl(&v)).unwrap_or(false) {
        // WSL：**用户的 Chrome 装在 Windows 上**，给 WSL 里的 ~/.config 写 manifest 等于写给
        // 一个没人用的浏览器。默认打 Windows，`--target linux` 可以按回去。
        Target::Windows
    } else {
        Target::Linux
    }
}

// ───────────────────────────── CLI ─────────────────────────────

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opts {
    pub host_name: String,
    pub extension_ids: Vec<String>,
    pub exe: Option<String>,
    pub manifest_dir: Option<String>,
    pub target: Option<Target>,
}

/// 解析 `--register` / `--unregister` 的参数。环境变量做兜底：`STREAM_EXTENSION_ID`（逗号分隔）、
/// `STREAM_NM_HOST_NAME`。
pub fn parse_opts(args: &[String], env_ext_ids: Option<&str>, env_host_name: Option<&str>) -> Result<Opts, String> {
    let mut o = Opts {
        host_name: env_host_name.unwrap_or(DEFAULT_HOST_NAME).to_string(),
        extension_ids: env_ext_ids
            .map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect())
            .unwrap_or_default(),
        exe: None,
        manifest_dir: None,
        target: None,
    };
    let mut i = 0usize;
    while i < args.len() {
        let a = args[i].as_str();
        let take = |i: &mut usize| -> Result<String, String> {
            *i += 1;
            args.get(*i).cloned().ok_or_else(|| format!("{a} 后面缺一个值"))
        };
        match a {
            "--extension-id" => {
                let v = take(&mut i)?;
                o.extension_ids = v.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
            }
            "--host-name" => o.host_name = take(&mut i)?,
            "--exe" => o.exe = Some(take(&mut i)?),
            "--manifest-dir" => o.manifest_dir = Some(take(&mut i)?),
            "--target" => {
                o.target = Some(match take(&mut i)?.as_str() {
                    "linux" => Target::Linux,
                    "macos" | "mac" | "darwin" => Target::MacOs,
                    "windows" | "win" => Target::Windows,
                    other => return Err(format!("--target 只认 linux|macos|windows，收到「{other}」")),
                })
            }
            "--register" | "--unregister" => {}
            other => return Err(format!("不认识的参数：{other}")),
        }
        i += 1;
    }
    validate_host_name(&o.host_name)?;
    Ok(o)
}

// ───────────────────────── 落地（有副作用的那半） ─────────────────────────

/// 把一个 WSL 路径转成 Windows 路径（`wslpath -w`）。
fn wslpath_w(p: &Path) -> Option<String> {
    let out = std::process::Command::new("wslpath").arg("-w").arg(p).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Windows 用户目录在 WSL 里的挂载点（`cmd.exe /c echo %USERPROFILE%` → `wslpath -u`）。
fn windows_home_from_wsl() -> Option<PathBuf> {
    // cwd 显式设成 `/`：从一个 WSL 目录里起 cmd.exe 会先吐一段「UNC 路径不受支持」的告警
    // （走 stderr，不污染 stdout，但没必要留着）。
    let out = std::process::Command::new("cmd.exe")
        .args(["/c", "echo %USERPROFILE%"])
        .current_dir("/")
        .output()
        .ok()?;
    // 取最后一行非空输出：万一将来哪个 shim 往 stdout 多写一行，也不会把告警当成路径。
    let win = String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty())
        .next_back()?
        .to_string();
    // 变量没展开时 cmd 会把 `%USERPROFILE%` 原样回显——那不是路径，是"取失败了"。
    if win.contains('%') {
        return None;
    }
    let out = std::process::Command::new("wslpath").arg("-u").arg(&win).output().ok()?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { None } else { Some(PathBuf::from(p)) }
}

fn run(argv: &[String]) -> Result<String, String> {
    let out = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .output()
        .map_err(|e| format!("{} 起不来：{e}", argv[0]))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    if out.status.success() {
        Ok(stdout)
    } else {
        Err(format!("{} 失败（{}）：{}", argv[0], out.status, if stderr.is_empty() { stdout } else { stderr }))
    }
}

/// 要登记的可执行文件路径。
///
/// **WSL → Windows 那一跳是这里唯一的真陷阱**：本进程是个 Linux ELF，Windows Chrome 执行不了它。
/// 必须指向交叉编译出来的 `.exe`，而且路径得是 Windows 够得着的。这里只做默认推断 + 说清楚，
/// 拿不准就要求显式 `--exe`。
fn resolve_exe(target: Target, opts: &Opts) -> Result<String, String> {
    if let Some(e) = &opts.exe {
        // 显式给的路径：在 WSL 上如果给的是 Linux 路径，转成 Windows 路径再写进 manifest。
        let p = PathBuf::from(e);
        if target == Target::Windows && !cfg!(windows) {
            if e.contains(":\\") || e.starts_with(r"\\") {
                return Ok(e.clone());
            }
            return wslpath_w(&p).ok_or_else(|| format!("把 {e} 转成 Windows 路径失败（wslpath 不可用？）"));
        }
        return Ok(p.display().to_string());
    }
    let me = std::env::current_exe().map_err(|e| format!("取不到自己的路径：{e}"))?;
    if target != Target::Windows || cfg!(windows) {
        return Ok(me.display().to_string());
    }
    // WSL 给 Windows Chrome 登记：找交叉编译产物。
    let crate_dir = me.parent().and_then(|p| p.parent()).and_then(|p| p.parent()); // target/<profile>/ → target/ → crate
    let candidates: Vec<PathBuf> = crate_dir
        .into_iter()
        .flat_map(|d| {
            ["release", "debug"].iter().map(move |p| {
                d.join("target").join("x86_64-pc-windows-gnu").join(p).join("stream-desktop.exe")
            })
        })
        .collect();
    let found = candidates.iter().find(|p| p.exists()).ok_or_else(|| {
        "WSL 里给 Windows Chrome 登记需要一个 Windows 可执行文件：先 `cargo build --release \
         --target x86_64-pc-windows-gnu`，或用 --exe 显式指一个 .exe"
            .to_string()
    })?;
    wslpath_w(found).ok_or_else(|| format!("把 {} 转成 Windows 路径失败", found.display()))
}

/// 把**当前**这个进程解析出来的 data 目录写进 `~/.stream/datadir`，给将来被 Chrome 拉起的
/// 那个实例用（它的环境是干净的，见 [`datadir::DATADIR_POINTER`]）。
///
/// 解析走的是和读 token 同一条 `resolve_data_dir`——**不能只认 `STREAM_DATA_DIR`**：开发机上
/// 它常常不设，data 目录是从 config.yaml / 仓库布局推出来的，而那台机器同样要能装扩展。
fn write_datadir_pointer() -> Result<String, String> {
    let env = datadir::Env::from_process();
    let home = env.home.clone().ok_or("取不到用户目录")?;
    let dir = datadir::resolve_data_dir(&datadir::RealFs, &env).ok_or_else(|| {
        "这个进程自己也没找到 data 目录（STREAM_DATA_DIR 没设，config.yaml 也不可见）".to_string()
    })?;
    let file = datadir::pointer_path(&home);
    if let Some(parent) = file.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建 {} 失败：{e}", parent.display()))?;
    }
    std::fs::write(&file, dir.display().to_string()).map_err(|e| format!("写 {} 失败：{e}", file.display()))?;
    Ok(format_datadir_pointer_report(&dir, &file))
}

/// 这一行报告要回答的问题只有一个：**扩展将拿到谁的 token**。答案是指针的**内容**（刚写进去的
/// 那个 data 目录），不是指针文件的路径——后者在每台机器上都是 `~/.stream/datadir`，是个常量，
/// 印它等于什么都没说。
///
/// 单独抽成函数不是为了复用，是为了让它**可测**：这个二进制交叉编译给 Windows、在 WSL 下跑不
/// 起来，活体只能靠人眼看输出；抽出来之后本机 `cargo test` 就能钉住「归属值必须在这行里」。
///
/// 为什么值得较真：配对失败时人就是读这一行去找归属的。它**看起来**在回答，于是人就不再往下
/// 查了——这正是"注释把 bug 说成设计意图"那类缺陷的运行期版本，比没有这行更坏。
fn format_datadir_pointer_report(dir: &Path, file: &Path) -> String {
    format!("datadir pointer → {}（归属；写在 {}）", dir.display(), file.display())
}

/// `--register` 的落地。返回给人看的报告行。
pub fn register(opts: &Opts) -> Result<Vec<String>, String> {
    if opts.extension_ids.is_empty() {
        return Err("必须给 --extension-id（或 STREAM_EXTENSION_ID）：allowed_origins 是这条链路唯一的准入闸门，\
                    代码里不会替你猜一个 id"
            .into());
    }
    for id in &opts.extension_ids {
        validate_extension_id(id)?;
    }
    let target = opts.target.unwrap_or_else(default_target);
    let exe = resolve_exe(target, opts)?;
    let body = manifest_json(&opts.host_name, &exe, &opts.extension_ids);
    let mut report = vec![format!("target={target:?} host={} exe={exe}", opts.host_name)];

    // data 目录的指针。**登记这一刻是唯一还知道 data 目录在哪的时机**：现在这个进程是后端
    // spawn 的（`STREAM_DATA_DIR` 在环境里），而将来 Chrome 拉起的那个实例什么都没有——
    // NM 清单格式里既不能带 env 也不能带 argv。写不成不中断登记（清单本身仍然有用），但要
    // 在报告里说出来，否则"扩展装上了却连不上"会变成一个查不动的静默失败。见 `DATADIR_POINTER`。
    report.push(match write_datadir_pointer() {
        // 报告行由 `format_datadir_pointer_report` 自己拼全（含"归属"那个值）——这里别再套一层
        // 前缀，否则又变成只印路径的老样子。
        Ok(line) => line,
        Err(e) => format!("datadir pointer 没写成（Chrome 拉起时可能找不到 token）：{e}"),
    });

    if target == Target::Windows {
        // manifest 落在 Windows 用户目录下（Chrome 要能读到它），注册表默认值指向它。
        let home = match &opts.manifest_dir {
            Some(d) => PathBuf::from(d),
            None if cfg!(windows) => dirs_home().ok_or("取不到用户目录")?.join(".stream").join("NativeMessagingHosts"),
            None => windows_home_from_wsl()
                .ok_or("取不到 Windows 用户目录（cmd.exe/wslpath 不可用？）用 --manifest-dir 显式指一个")?
                .join(".stream")
                .join("NativeMessagingHosts"),
        };
        std::fs::create_dir_all(&home).map_err(|e| format!("建 {} 失败：{e}", home.display()))?;
        let file = home.join(format!("{}.json", opts.host_name));
        std::fs::write(&file, &body).map_err(|e| format!("写 {} 失败：{e}", file.display()))?;
        report.push(format!("manifest → {}", file.display()));

        let win_manifest = if cfg!(windows) {
            file.display().to_string()
        } else {
            wslpath_w(&file).ok_or_else(|| format!("把 {} 转成 Windows 路径失败", file.display()))?
        };
        for (label, key) in registry_keys(&opts.host_name) {
            match run(&registry_add_command(&key, &win_manifest)) {
                Ok(_) => report.push(format!("registry [{label}] → {key}")),
                Err(e) => report.push(format!("registry [{label}] 失败：{e}")),
            }
        }
        return Ok(report);
    }

    let home = dirs_home().ok_or("取不到用户目录（HOME 没设？）")?;
    let dirs: Vec<(&str, PathBuf, PathBuf)> = match &opts.manifest_dir {
        Some(d) => vec![("显式", PathBuf::from(d), PathBuf::from(d))],
        None => manifest_dirs(target, &home),
    };
    let mut wrote = 0;
    for (label, root, dir) in &dirs {
        // 没装的浏览器不给它凭空造配置目录。
        if opts.manifest_dir.is_none() && !root.exists() {
            report.push(format!("skip [{label}]（{} 不存在，大概没装）", root.display()));
            continue;
        }
        std::fs::create_dir_all(dir).map_err(|e| format!("建 {} 失败：{e}", dir.display()))?;
        let file = dir.join(format!("{}.json", opts.host_name));
        std::fs::write(&file, &body).map_err(|e| format!("写 {} 失败：{e}", file.display()))?;
        report.push(format!("manifest [{label}] → {}", file.display()));
        wrote += 1;
    }
    if wrote == 0 {
        return Err("一个 Chrome 家族的配置目录都没找到——用 --manifest-dir 显式指一个".into());
    }
    Ok(report)
}

/// 把 register 写下的 datadir 指针删掉。**`register` 里每多写一样东西，这里就得多删一样**——
/// 一个装完能卸干净的工具，判据不是"卸载跑通了"，是"卸完之后 register 写过的东西一个不剩"。
fn remove_datadir_pointer(home: Option<PathBuf>) -> Option<String> {
    let file = datadir::pointer_path(&home?);
    if !file.exists() {
        return None;
    }
    Some(match std::fs::remove_file(&file) {
        Ok(()) => format!("datadir pointer 已删 {}", file.display()),
        Err(e) => format!("datadir pointer 删不掉 {}：{e}", file.display()),
    })
}

/// 把 `~/.stream` 下**空掉的**那两级目录收走（`NativeMessagingHosts/` 和 `.stream/` 本身）。
///
/// 用 `remove_dir`（只删空目录）而不是 `remove_dir_all` 是**故意的、也是必须的**：`~/.stream`
/// 同时是 CLI 的默认数据目录（`src/install/cli.ts` 的 `defaultDataDir`），里面装着用户的库。
/// 递归删等于卸个扩展把人家的数据一起端了。空就收、不空就留，判据由文件系统自己给。
fn prune_empty_stream_dirs(home: Option<PathBuf>) -> Vec<String> {
    let Some(home) = home else { return vec![] };
    let root = home.join(".stream");
    let mut out = vec![];
    for dir in [root.join("NativeMessagingHosts"), root] {
        if dir.is_dir() && std::fs::remove_dir(&dir).is_ok() {
            out.push(format!("空目录已收 {}", dir.display()));
        }
    }
    out
}

/// `--unregister` 的落地：把 register 写下的东西删掉。
pub fn unregister(opts: &Opts) -> Result<Vec<String>, String> {
    let target = opts.target.unwrap_or_else(default_target);
    let mut report = vec![format!("target={target:?} host={}", opts.host_name)];
    report.extend(remove_datadir_pointer(datadir::Env::from_process().home));

    if target == Target::Windows {
        for (label, key) in registry_keys(&opts.host_name) {
            match run(&registry_delete_command(&key)) {
                Ok(_) => report.push(format!("registry [{label}] 已删 {key}")),
                // 本来就没有也算干净（reg delete 找不到键会非 0 退出）。
                Err(e) => report.push(format!("registry [{label}]：{e}")),
            }
        }
        let home = match &opts.manifest_dir {
            Some(d) => Some(PathBuf::from(d)),
            None if cfg!(windows) => dirs_home().map(|h| h.join(".stream").join("NativeMessagingHosts")),
            None => windows_home_from_wsl().map(|h| h.join(".stream").join("NativeMessagingHosts")),
        };
        if let Some(dir) = home {
            let file = dir.join(format!("{}.json", opts.host_name));
            if file.exists() {
                std::fs::remove_file(&file).map_err(|e| format!("删 {} 失败：{e}", file.display()))?;
                report.push(format!("manifest 已删 {}", file.display()));
            }
        }
        report.extend(prune_empty_stream_dirs(datadir::Env::from_process().home));
        return Ok(report);
    }

    let home = dirs_home().ok_or("取不到用户目录（HOME 没设？）")?;
    let dirs: Vec<(&str, PathBuf, PathBuf)> = match &opts.manifest_dir {
        Some(d) => vec![("显式", PathBuf::from(d), PathBuf::from(d))],
        None => manifest_dirs(target, &home),
    };
    for (label, _root, dir) in &dirs {
        let file = dir.join(format!("{}.json", opts.host_name));
        if file.exists() {
            std::fs::remove_file(&file).map_err(|e| format!("删 {} 失败：{e}", file.display()))?;
            report.push(format!("manifest [{label}] 已删 {}", file.display()));
        }
    }
    report.extend(prune_empty_stream_dirs(datadir::Env::from_process().home));
    Ok(report)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn the_manifest_pins_allowed_origins_to_the_given_ids() {
        let ids = vec!["a".repeat(32), "b".repeat(32)];
        let m: Value = serde_json::from_str(&manifest_json("com.stream.desktop", "/opt/x", &ids)).unwrap();
        assert_eq!(m["name"], "com.stream.desktop");
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], "/opt/x");
        assert_eq!(
            m["allowed_origins"],
            serde_json::json!([format!("chrome-extension://{}/", ids[0]), format!("chrome-extension://{}/", ids[1])])
        );
    }

    #[test]
    fn linux_manifests_land_in_the_dot_config_native_messaging_hosts_dirs() {
        let dirs = manifest_dirs(Target::Linux, Path::new("/home/u"));
        let paths: Vec<String> = dirs.iter().map(|(_, _, d)| d.display().to_string()).collect();
        assert!(paths.contains(&"/home/u/.config/google-chrome/NativeMessagingHosts".to_string()), "{paths:?}");
        assert!(paths.contains(&"/home/u/.config/chromium/NativeMessagingHosts".to_string()), "{paths:?}");
    }

    #[test]
    fn macos_manifests_land_under_application_support() {
        let dirs = manifest_dirs(Target::MacOs, Path::new("/Users/u"));
        let paths: Vec<String> = dirs.iter().map(|(_, _, d)| d.display().to_string()).collect();
        assert!(
            paths.contains(
                &"/Users/u/Library/Application Support/Google/Chrome/NativeMessagingHosts".to_string()
            ),
            "{paths:?}"
        );
    }

    #[test]
    fn windows_uses_the_registry_not_a_well_known_dir() {
        let keys = registry_keys("com.stream.desktop");
        assert_eq!(keys[0].1, r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.stream.desktop");
        let cmd = registry_add_command(&keys[0].1, r"C:\Users\u\.stream\NativeMessagingHosts\com.stream.desktop.json");
        assert_eq!(cmd[0], "reg.exe");
        assert!(cmd.contains(&"/ve".to_string()), "默认值才是 Chrome 要读的那一项");
        assert_eq!(cmd.last().unwrap(), "/f");
        assert_eq!(registry_delete_command(&keys[0].1), vec!["reg.exe", "delete", &keys[0].1, "/f"]);
    }

    #[test]
    fn host_names_and_extension_ids_are_checked_before_anything_is_written() {
        assert!(validate_host_name("com.stream.desktop").is_ok());
        assert!(validate_host_name("Com.Stream").is_err(), "大写非法");
        assert!(validate_host_name("com..stream").is_err());
        assert!(validate_host_name("").is_err());

        assert!(validate_extension_id(&"a".repeat(32)).is_ok());
        assert!(validate_extension_id(&"a".repeat(31)).is_err());
        assert!(validate_extension_id(&"z".repeat(32)).is_err(), "只有 a–p 合法");
    }

    #[test]
    fn opts_come_from_flags_with_env_as_the_fallback() {
        let args: Vec<String> = ["--register", "--extension-id", &"a".repeat(32), "--target", "linux"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let o = parse_opts(&args, Some(&"b".repeat(32)), None).unwrap();
        assert_eq!(o.extension_ids, vec!["a".repeat(32)], "flag 覆盖 env");
        assert_eq!(o.host_name, DEFAULT_HOST_NAME);
        assert_eq!(o.target, Some(Target::Linux));

        let o = parse_opts(&["--register".into()], Some(&"b".repeat(32)), Some("com.other")).unwrap();
        assert_eq!(o.extension_ids, vec!["b".repeat(32)]);
        assert_eq!(o.host_name, "com.other");

        assert!(parse_opts(&["--wat".into()], None, None).is_err());
        assert!(parse_opts(&["--extension-id".into()], None, None).is_err(), "缺值要报错");
    }

    /// 不给 id 就不许写任何东西 —— 那样写出去的 manifest 是一把没锁的门。
    #[test]
    fn registering_without_an_extension_id_is_refused() {
        let o = Opts {
            host_name: DEFAULT_HOST_NAME.into(),
            extension_ids: vec![],
            exe: None,
            manifest_dir: None,
            target: Some(Target::Linux),
        };
        assert!(register(&o).unwrap_err().contains("--extension-id"));
    }

    #[test]
    fn wsl_is_recognised_from_proc_version() {
        assert!(is_wsl("Linux version 5.15.167.4-microsoft-standard-WSL2"));
        assert!(!is_wsl("Linux version 6.1.0-13-amd64 (debian-kernel@lists.debian.org)"));
    }

    /// register/unregister 真写盘的那条路：写进一个临时目录再删掉，确认文件名和内容都对。
    #[test]
    fn register_writes_and_unregister_removes_the_manifest() {
        let dir = std::env::temp_dir().join(format!("stream-nm-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let o = Opts {
            host_name: DEFAULT_HOST_NAME.into(),
            extension_ids: vec!["a".repeat(32)],
            exe: Some("/opt/stream/stream-desktop".into()),
            manifest_dir: Some(dir.display().to_string()),
            target: Some(Target::Linux),
        };
        register(&o).unwrap();
        let file = dir.join(format!("{DEFAULT_HOST_NAME}.json"));
        let m: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(m["path"], "/opt/stream/stream-desktop");

        unregister(&o).unwrap();
        assert!(!file.exists(), "unregister 之后 manifest 必须没了");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 这行报告是配对失败时人用来找归属的那一行。**它必须印出指针的内容**（那个 data 目录）——
    /// 只印指针文件的路径（`~/.stream/datadir`，每台机器都一样）等于给了一个看起来像答案的常量，
    /// 读的人以为查过了就不再往下查。2026-09-01 活体配对撞到的就是这个。
    #[test]
    fn the_pointer_report_states_the_owning_data_dir_not_just_the_pointer_file() {
        let line = format_datadir_pointer_report(
            Path::new("/opt/stream-pair/plugin-data"),
            Path::new("/home/who/.stream/datadir"),
        );
        assert!(line.contains("/opt/stream-pair/plugin-data"), "归属值必须在这行里：{line}");
        // 顺带钉住"归属排在文件路径前面"——两个路径都在的时候，先读到的那个才是人会当成答案的。
        let owner_at = line.find("/opt/stream-pair/plugin-data").unwrap();
        let file_at = line.find("/home/who/.stream/datadir").unwrap();
        assert!(owner_at < file_at, "归属得排在指针文件路径前面：{line}");
    }

    /// `register` 写下的**每一样**东西都得有人来删。datadir 指针是后加的那一样，加的时候只补了
    /// 写、没补删——于是卸载跑通、`~/.stream/datadir` 还躺在那儿，而没有任何一处会喊。
    #[test]
    fn unregister_removes_the_datadir_pointer() {
        let home = std::env::temp_dir().join(format!("stream-ptr-test-{}", std::process::id()));
        let file = datadir::pointer_path(&home);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "/whatever/data").unwrap();

        let line = remove_datadir_pointer(Some(home.clone())).expect("有指针就该报一行");
        assert!(line.contains("已删"), "{line}");
        assert!(!file.exists(), "unregister 之后 datadir 指针必须没了");
        // 本来就没有 = 干净，不报行也不报错（重复卸载不该像出了错）。
        assert_eq!(remove_datadir_pointer(Some(home.clone())), None);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// 收空目录只能收**空的**。`~/.stream` 同时是 CLI 的默认数据目录——递归删等于卸载时
    /// 把用户的库一起端了，所以"里面还有东西就原地不动"这一条必须有测试钉着。
    #[test]
    fn pruning_never_touches_a_stream_dir_that_still_has_data() {
        let home = std::env::temp_dir().join(format!("stream-prune-test-{}", std::process::id()));
        let nm = home.join(".stream").join("NativeMessagingHosts");
        std::fs::create_dir_all(&nm).unwrap();
        std::fs::write(home.join(".stream").join("items.db"), "user data").unwrap();

        let lines = prune_empty_stream_dirs(Some(home.clone()));
        assert!(!nm.exists(), "空的 NativeMessagingHosts 该收走：{lines:?}");
        assert!(home.join(".stream").exists(), "还装着数据的 .stream 一个字节都不许动");
        assert!(home.join(".stream").join("items.db").exists());

        // 数据搬走之后再卸一次，这时 .stream 才该跟着消失
        std::fs::remove_file(home.join(".stream").join("items.db")).unwrap();
        prune_empty_stream_dirs(Some(home.clone()));
        assert!(!home.join(".stream").exists(), "空掉的 .stream 该收走");
        let _ = std::fs::remove_dir_all(&home);
    }
}
