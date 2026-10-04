//! 找到 Stream 的 `data/` 目录，并从里面读出 `ext-relay-token`。
//!
//! **为什么这块必须存在**：token 以前是人手喂进环境变量的（README 那段 `WSLENV=... STREAM_HOST_TOKEN=$(< …)`）。
//! 一旦 Chrome 通过 native messaging 拉起本进程，就没有人能在中间喂环境变量了——Chrome 只给
//! 一个可执行文件路径。所以"token 从哪来"必须由 agent 自己回答。
//!
//! 这也正是整条链路的安全支点：token 住在只有本用户读得到的文件里，扩展读不了文件、
//! 只能通过 native messaging 拉起这个可执行文件来拿。抢到 8900 端口的别的进程拿不到它。
//!
//! 全部逻辑都写成对注入的 [`Env`] + [`Fs`] 的纯函数，所以在 Linux 上 `cargo test` 就能钉住
//! 优先级顺序，不依赖机器上真的有一份 Stream 部署。

use std::path::{Path, PathBuf};

/// 文件系统的最小接口——只为让优先级顺序可被单测钉住。
pub trait Fs {
    fn exists(&self, path: &Path) -> bool;
    fn read_to_string(&self, path: &Path) -> Option<String>;
}

/// 真实文件系统。
pub struct RealFs;

impl Fs for RealFs {
    fn exists(&self, path: &Path) -> bool {
        path.exists()
    }
    fn read_to_string(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }
}

/// 进程环境的快照（env 变量 + cwd + 可执行文件所在目录）。
#[derive(Debug, Clone, Default)]
pub struct Env {
    /// `STREAM_DATA_DIR`
    pub data_dir: Option<String>,
    /// `STREAM_CONFIG`
    pub config: Option<String>,
    /// `STREAM_HOST_TOKEN` —— 显式喂进来的 token，优先于任何文件解析。
    pub host_token: Option<String>,
    /// 进程当前工作目录。**Chrome 拉起时它是 Chrome 的 cwd，基本没用**——所以它排在最后。
    pub cwd: Option<PathBuf>,
    /// 可执行文件所在目录。native messaging 下这是唯一还有意义的锚点。
    pub exe_dir: Option<PathBuf>,
    /// 用户家目录。**native messaging 下这才是最有用的锚点**——见 [`DATADIR_POINTER`]。
    pub home: Option<PathBuf>,
}

impl Env {
    /// 从真实进程环境取一份快照。
    pub fn from_process() -> Env {
        Env {
            data_dir: std::env::var("STREAM_DATA_DIR").ok().filter(|s| !s.is_empty()),
            config: std::env::var("STREAM_CONFIG").ok().filter(|s| !s.is_empty()),
            host_token: std::env::var("STREAM_HOST_TOKEN").ok().filter(|s| !s.trim().is_empty()),
            cwd: std::env::current_dir().ok(),
            exe_dir: std::env::current_exe()
                .ok()
                .and_then(|p| p.parent().map(Path::to_path_buf)),
            home: std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from),
        }
    }
}

/// `~/.stream/datadir` —— **登记 native messaging 清单时顺手写下的那份 data 目录路径**。
///
/// 为什么非有不可：Chrome 拉起 native messaging host 时给的是**干净环境**——没有
/// `STREAM_DATA_DIR`，cwd 是 Chrome 的，而 exe 住在 DSH 引擎的 `node_modules` 深处。于是
/// 下面那几档"在 exe / cwd 旁边找 `data/`"全部落空，agent 找不到 token，扩展永远连不上中继。
///
/// **这对每一个正式安装都成立**（data 目录是用户选的，exe 在引擎里），只有真装一次才撞得到。
/// 实测 2026-08-31（win-test）：候选列表一路从 `…\desktop-win32-x64\bin\data` 试到 `C:\data`，
/// 而真正的 `C:\Users\xiaomi\stream-data\data` 一次都没被问过。
///
/// 指针写在**清单旁边**（`~/.stream/`）不是随便挑的：清单本身就住那儿，而家目录是这个进程在
/// 干净环境下唯一还认得的锚点。NM 清单格式里既不能带 env 也不能带 argv——这是仅剩的那条路。
pub const DATADIR_POINTER: &str = "datadir";

/// 指针文件的绝对路径（`~/.stream/datadir`）。
pub fn pointer_path(home: &Path) -> PathBuf {
    home.join(".stream").join(DATADIR_POINTER)
}

/// token 文件名——与后端 `src/http/secrets.ts` 的 `loadOrCreateSecret(dir, 'ext-relay-token')` 同名。
pub const TOKEN_FILE: &str = "ext-relay-token";

/// 从一份 `config.yaml` 文本里抠出顶层 `item_db:` 的值。
///
/// **故意不引 YAML 解析器**：这里只需要一个顶层标量键，为它拉一个新 crate（以及一次联网拉依赖）
/// 不划算。规则收得很紧——只认顶层（零缩进）的 `item_db:`，值去掉引号和行尾注释。
pub fn parse_item_db(yaml: &str) -> Option<String> {
    for line in yaml.lines() {
        // 顶层键必须顶格。缩进的同名键属于别的 mapping，不是我们要的那个。
        if line.starts_with(char::is_whitespace) {
            continue;
        }
        // 不是这个键就看下一行——这里写 `?` 会在遇到第一个别的顶层键时直接返回 None，
        // 于是"item_db 不是文件第一行"就永远解析不出来。
        let Some(rest) = line.strip_prefix("item_db:") else { continue };
        let v = rest.trim();
        // 引号包着的值：取到**配对的收引号**为止，之后的东西（行尾注释）全丢。
        // 没引号的值：`" #"` 之后是注释；不剥就会把注释当成路径的一部分。
        let v = match v.chars().next() {
            Some(q @ ('"' | '\'')) => v[1..].split(q).next().unwrap_or("").trim(),
            _ => match v.find(" #") {
                Some(hash) => v[..hash].trim(),
                None => v,
            },
        };
        if v.is_empty() {
            return None;
        }
        return Some(v.to_string());
    }
    None
}

/// 从某个起点向上找 `config.yaml`（最多 6 层——再深就是在猜了）。
fn find_config_upwards<F: Fs>(fs: &F, start: &Path) -> Option<PathBuf> {
    let mut cur = Some(start);
    for _ in 0..6 {
        let dir = cur?;
        let candidate = dir.join("config.yaml");
        if fs.exists(&candidate) {
            return Some(candidate);
        }
        cur = dir.parent();
    }
    None
}

/// 本次解析选中的 `config.yaml`（如果有）。
pub fn resolve_config_path<F: Fs>(fs: &F, env: &Env) -> Option<PathBuf> {
    if let Some(c) = &env.config {
        let p = PathBuf::from(c);
        if fs.exists(&p) {
            return Some(p);
        }
    }
    if let Some(d) = &env.data_dir {
        let p = PathBuf::from(d).join("config.yaml");
        if fs.exists(&p) {
            return Some(p);
        }
    }
    if let Some(cwd) = &env.cwd {
        if let Some(p) = find_config_upwards(fs, cwd) {
            return Some(p);
        }
    }
    if let Some(exe) = &env.exe_dir {
        if let Some(p) = find_config_upwards(fs, exe) {
            return Some(p);
        }
    }
    None
}

/// 候选 data 目录，**按优先级从高到低**。调用方取第一个"确实存在"的。
///
/// 顺序（与 README 的表一致，改这里就要改那里）：
/// 1. `STREAM_DATA_DIR`
/// 2. `config.yaml` 里 `item_db` 所在目录（相对路径按 config.yaml 自己的目录解析）
/// 3. 可执行文件旁边的常规位置：`<exe>/data`、`<exe>/../data`、`<exe>/../../data` …
/// 4. cwd 及其祖先里的 `data/`
pub fn candidate_data_dirs<F: Fs>(fs: &F, env: &Env) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let push = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if !out.contains(&p) {
            out.push(p);
        }
    };

    if let Some(d) = &env.data_dir {
        // **两种含义都收**：后端把 `STREAM_DATA_DIR` 当"根"（token 落在 `<根>/data/` 下，
        // 见 `run-stream.cmd` 里 `STREAM_DATA_DIR=C:\Users\xiaomi\stream-data`），而这里的
        // 文档一直把它读成"就是 data 目录"。一个名字两种含义，两边各自自洽、合起来错——
        // 实测 2026-08-31（win-test）：指针写下的是根，于是 token 就在隔壁一层却找不到。
        // 与其挑一边对、让另一边静默失败，不如两个都问一遍：多一次 `exists` 而已。
        push(PathBuf::from(d), &mut out);
        push(PathBuf::from(d).join("data"), &mut out);
    }

    // 登记时写下的那份指针（见 `DATADIR_POINTER`）。排在环境变量之后、其余之前：显式给定的
    // 优先，但它比"在 exe 旁边猜"可靠得多——native messaging 那条路上，它通常是唯一对的答案。
    if let Some(home) = &env.home {
        if let Some(text) = fs.read_to_string(&pointer_path(home)) {
            let p = text.trim();
            if !p.is_empty() {
                // 同上：指针可能记的是根，也可能记的是 data 目录本身。
                push(PathBuf::from(p), &mut out);
                push(PathBuf::from(p).join("data"), &mut out);
            }
        }
    }

    if let Some(cfg) = resolve_config_path(fs, env) {
        if let Some(text) = fs.read_to_string(&cfg) {
            if let Some(item_db) = parse_item_db(&text) {
                // `./data/items.db` 里的 `./` 必须先剥掉：Path::join 会把它原样留在中间，
                // 拼出 `/repo/./data`——那是个能用但不等于 `/repo/data` 的字符串，
                // 一路传下去就变成"日志里印的路径和实际比对的路径长得不一样"。
                let item_db = PathBuf::from(item_db.trim_start_matches("./"));
                // 相对路径按 config.yaml 所在目录解析——后端跑起来时 cwd 就是仓库根，
                // 而 config.yaml 也在那儿，两者同解。Chrome 拉起我们时 cwd 是 Chrome 的，
                // 拿它当基准会指到一个完全无关的地方。
                let abs = if item_db.is_absolute() {
                    item_db
                } else {
                    cfg.parent().unwrap_or(Path::new(".")).join(item_db)
                };
                if let Some(parent) = abs.parent() {
                    push(parent.to_path_buf(), &mut out);
                }
            }
        }
    }

    for anchor in [env.exe_dir.as_ref(), env.cwd.as_ref()].into_iter().flatten() {
        let mut cur = Some(anchor.as_path());
        for _ in 0..6 {
            let Some(dir) = cur else { break };
            push(dir.join("data"), &mut out);
            cur = dir.parent();
        }
    }

    out
}

/// 选中的 data 目录：候选里**第一个存在**的。
pub fn resolve_data_dir<F: Fs>(fs: &F, env: &Env) -> Option<PathBuf> {
    candidate_data_dirs(fs, env).into_iter().find(|p| fs.exists(p))
}

/// token 文件的位置：候选目录里**第一个真的躺着 `ext-relay-token` 的**。
///
/// 注意这和 [`resolve_data_dir`] 不是同一个判据，而且这个更严：一个存在但还没生成 token 的
/// `data/`（比如某个 worktree 里的空壳）会让前者停在那儿，然后读出一个"文件不存在"。
pub fn resolve_token_path<F: Fs>(fs: &F, env: &Env) -> Option<PathBuf> {
    candidate_data_dirs(fs, env)
        .into_iter()
        .map(|d| d.join(TOKEN_FILE))
        .find(|p| fs.exists(p))
}

/// 读出 token。失败一律是 `Err(人话)` —— 这个字符串会原样进 native messaging 的响应体，
/// 所以它要能让扩展那边的人看懂"我该去哪儿找"。
pub fn read_token<F: Fs>(fs: &F, env: &Env) -> Result<String, String> {
    // 环境变量优先：桌面控制插件 spawn 的那条路已经在喂它了，别让文件解析去覆盖一个显式给定的值。
    if let Some(t) = env.host_token.as_ref().filter(|s| !s.trim().is_empty()) {
        return Ok(t.trim().to_string());
    }
    let Some(path) = resolve_token_path(fs, env) else {
        let tried = candidate_data_dirs(fs, env)
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ");
        return Err(format!(
            "找不到 {TOKEN_FILE}：设置 STREAM_DATA_DIR 指向 Stream 的 data 目录，或让 config.yaml 可见。已试过 [{tried}]"
        ));
    };
    match fs.read_to_string(&path) {
        Some(s) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(_) => Err(format!("{} 是空的——后端起过一次就会写上", path.display())),
        None => Err(format!("{} 读不出来（权限？）", path.display())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeFs(HashMap<String, String>);
    impl FakeFs {
        fn with(files: &[(&str, &str)]) -> FakeFs {
            FakeFs(files.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
        }
    }
    impl Fs for FakeFs {
        fn exists(&self, path: &Path) -> bool {
            let p = path.to_string_lossy().to_string();
            self.0.contains_key(&p) || self.0.keys().any(|k| k.starts_with(&format!("{p}/")))
        }
        fn read_to_string(&self, path: &Path) -> Option<String> {
            self.0.get(&path.to_string_lossy().to_string()).cloned()
        }
    }

    /// Chrome 拉起 native messaging host 时的**真实处境**：环境干净（没有 `STREAM_DATA_DIR`）、
    /// cwd 是 Chrome 的、exe 埋在引擎的 node_modules 里。唯一还认得的锚点是家目录里那份指针。
    ///
    /// 活体（2026-08-31，win-test）：没有这一档时，候选一路从 `…\bin\data` 试到 `C:\data`，
    /// 真正的 data 目录一次都没被问过——扩展装上了却永远连不上中继，而两端各自都"正常"。
    #[test]
    fn the_pointer_is_the_only_anchor_chrome_leaves_us() {
        let fs = FakeFs::with(&[
            ("/home/u/.stream/datadir", "/opt/stream-data/data\n"),
            ("/opt/stream-data/data/ext-relay-token", "tok-from-pointer"),
        ]);
        let env = Env {
            home: Some(PathBuf::from("/home/u")),
            exe_dir: Some(PathBuf::from("/engine/node_modules/@streamapp/desktop-win32-x64/bin")),
            cwd: Some(PathBuf::from("/c/Program Files/Chrome")),
            ..Default::default()
        };
        assert_eq!(read_token(&fs, &env).unwrap(), "tok-from-pointer");
    }

    /// `STREAM_DATA_DIR` 一个名字两种含义：后端把它当"根"（token 在 `<根>/data/`），本模块的
    /// 文档把它当"就是 data 目录"。两边各自自洽、合起来错——所以两层都要问。
    #[test]
    fn a_data_dir_setting_may_mean_the_root_or_the_data_dir_itself() {
        let root = FakeFs::with(&[("/srv/stream-data/data/ext-relay-token", "tok")]);
        let env = Env { data_dir: Some("/srv/stream-data".into()), ..Default::default() };
        assert_eq!(read_token(&root, &env).unwrap(), "tok");

        let itself = FakeFs::with(&[("/srv/stream-data/ext-relay-token", "tok2")]);
        assert_eq!(read_token(&itself, &env).unwrap(), "tok2");
    }

    /// 指针同理——登记那一刻解析出来的可能是根。
    #[test]
    fn the_pointer_may_also_name_the_root() {
        let fs = FakeFs::with(&[
            ("/home/u/.stream/datadir", "/srv/stream-data"),
            ("/srv/stream-data/data/ext-relay-token", "tok"),
        ]);
        let env = Env { home: Some(PathBuf::from("/home/u")), ..Default::default() };
        assert_eq!(read_token(&fs, &env).unwrap(), "tok");
    }

    /// 显式给定的 `STREAM_DATA_DIR` 仍然排在指针前面——后端 spawn 的那条路是喂了值的，
    /// 别让一份可能过期的指针把它盖掉。
    #[test]
    fn an_explicit_data_dir_still_wins_over_the_pointer() {
        let fs = FakeFs::with(&[
            ("/home/u/.stream/datadir", "/stale/data"),
            ("/stale/data/ext-relay-token", "stale"),
            ("/explicit/ext-relay-token", "explicit"),
        ]);
        let env = Env {
            data_dir: Some("/explicit".into()),
            home: Some(PathBuf::from("/home/u")),
            ..Default::default()
        };
        assert_eq!(read_token(&fs, &env).unwrap(), "explicit");
    }

    #[test]
    fn item_db_is_read_off_a_top_level_key() {
        assert_eq!(parse_item_db("item_db: ./data/items.db\n").as_deref(), Some("./data/items.db"));
        assert_eq!(parse_item_db("vault_root: x\nitem_db: /srv/d/i.db\n").as_deref(), Some("/srv/d/i.db"));
        assert_eq!(parse_item_db("item_db: \"./data/i.db\"  # 注释\n").as_deref(), Some("./data/i.db"));
        assert_eq!(parse_item_db("item_db: ./d/i.db # 注释\n").as_deref(), Some("./d/i.db"));
    }

    /// 缩进的 `item_db` 属于别的 mapping，不是顶层配置——吃了它会指到一个错的目录。
    #[test]
    fn an_indented_item_db_is_not_the_top_level_one() {
        assert_eq!(parse_item_db("something:\n  item_db: ./nope.db\n"), None);
        assert_eq!(parse_item_db("# 只有注释\n"), None);
    }

    #[test]
    fn stream_data_dir_wins_over_everything_else() {
        let fs = FakeFs::with(&[
            ("/repo/config.yaml", "item_db: ./data/items.db\n"),
            ("/repo/data/ext-relay-token", "from-config"),
            ("/explicit/ext-relay-token", "from-env"),
        ]);
        let env = Env {
            data_dir: Some("/explicit".into()),
            cwd: Some("/repo".into()),
            ..Default::default()
        };
        assert_eq!(resolve_data_dir(&fs, &env).unwrap(), PathBuf::from("/explicit"));
        assert_eq!(read_token(&fs, &env).unwrap(), "from-env");
    }

    #[test]
    fn config_yaml_item_db_names_the_data_dir() {
        let fs = FakeFs::with(&[
            ("/repo/config.yaml", "vault_root: ./v\nitem_db: ./data/items.db\n"),
            ("/repo/data/ext-relay-token", "tok-abc"),
        ]);
        let env = Env { cwd: Some("/repo/src/deep".into()), ..Default::default() };
        assert_eq!(resolve_data_dir(&fs, &env).unwrap(), PathBuf::from("/repo/data"));
        assert_eq!(read_token(&fs, &env).unwrap(), "tok-abc");
    }

    /// config.yaml 里的相对路径按 **config.yaml 自己的目录**解析，不是 cwd——Chrome 拉起我们时
    /// cwd 是 Chrome 的，拿它当基准会指到一个无关的地方。
    #[test]
    fn a_relative_item_db_resolves_against_the_config_file_not_the_cwd() {
        let fs = FakeFs::with(&[
            ("/repo/config.yaml", "item_db: ./data/items.db\n"),
            ("/repo/data/ext-relay-token", "tok"),
        ]);
        let env = Env {
            config: Some("/repo/config.yaml".into()),
            cwd: Some("/some/where/else".into()),
            ..Default::default()
        };
        assert_eq!(resolve_data_dir(&fs, &env).unwrap(), PathBuf::from("/repo/data"));
    }

    /// 没有 config 时靠可执行文件旁边的 `data/` —— native messaging 下这是唯一还有意义的锚点。
    #[test]
    fn the_exe_dir_is_the_last_usable_anchor() {
        let fs = FakeFs::with(&[("/opt/stream/data/ext-relay-token", "tok-exe")]);
        let env = Env { exe_dir: Some("/opt/stream/bin".into()), ..Default::default() };
        assert_eq!(read_token(&fs, &env).unwrap(), "tok-exe");
    }

    /// 一个存在但空的 `data/` 不该把解析卡死在那儿——token 该继续往下一个候选找。
    #[test]
    fn an_empty_data_dir_does_not_shadow_the_one_that_has_the_token() {
        let fs = FakeFs::with(&[
            ("/wt/data/.keep", ""),
            ("/repo/config.yaml", "item_db: /repo/data/items.db\n"),
            ("/repo/data/ext-relay-token", "tok-real"),
        ]);
        let env = Env {
            data_dir: Some("/wt/data".into()),
            cwd: Some("/repo".into()),
            ..Default::default()
        };
        assert_eq!(resolve_data_dir(&fs, &env).unwrap(), PathBuf::from("/wt/data"));
        assert_eq!(resolve_token_path(&fs, &env).unwrap(), PathBuf::from("/repo/data/ext-relay-token"));
    }

    /// 找不到就是找不到——要给一句能照着做的话，而不是 panic 或空串。
    #[test]
    fn a_missing_token_is_a_readable_error() {
        let fs = FakeFs::default();
        let env = Env { cwd: Some("/nowhere".into()), ..Default::default() };
        let err = read_token(&fs, &env).unwrap_err();
        assert!(err.contains(TOKEN_FILE), "{err}");
        assert!(err.contains("STREAM_DATA_DIR"), "{err}");
    }

    #[test]
    fn an_empty_token_file_is_an_error_not_an_empty_token() {
        let fs = FakeFs::with(&[("/d/ext-relay-token", "   \n")]);
        let env = Env { data_dir: Some("/d".into()), ..Default::default() };
        assert!(read_token(&fs, &env).unwrap_err().contains("空"));
    }
}
