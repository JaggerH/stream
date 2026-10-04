/**
 * `stream` 这条命令——**一条命令装完就能跑**（`npx @streamapp/stream`）。
 *
 * 它薄得几乎没有自己的逻辑：发行形态的运行契约只有一份——**cwd 设成资源目录、跑 `server.mjs`、
 * `STREAM_PORT` / `STREAM_DATA_DIR` 经 env 传**，这里只是把它包成一条命令。
 *
 * **为什么走 npm 而不是自带运行时的安装包**：原生依赖（better-sqlite3、任务中心的 sqlite 驱动）
 * 本来就得按平台挑，npm 天生干这件事；自带运行时那条路还卡在代码签名/公证上，那是钱和身份的
 * 问题，不是工程问题。代价是用户得先有 Node 20+。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 子命令。**没有 `serve` 这一格**——不给子命令就是起后端那条老路（`CliOptions.command`
 * 整格缺席）。缺席才让"没写"和"写了一个我们认识的"在类型上分得开。
 *
 * 子命令都**不 chdir 到资源目录、不 import server.mjs**（见 `cli-entry.ts`）：`mcp` 是一层
 * stdio 壳，`add` / `remove` / `update` 只碰 `<dataDir>/recipes/`，`restart` 只打后端一个 HTTP，
 * `recipe contribute` 只读 `<dataDir>/recipe-overrides/` 再去 GitHub。
 */
export type CliCommand =
  | { kind: 'mcp' }
  | { kind: 'add'; name: string; version?: string; restart?: RestartFlag }
  | { kind: 'remove'; name: string; restart?: RestartFlag }
  /** `stream update [<包>…] [--yes]`：内置层 + 已装第三方 vs npm 最新。不带包名 = 全查。 */
  | { kind: 'update'; names: string[]; yes: boolean; restart?: RestartFlag }
  /** `stream restart [--force]`：打 `POST /api/restart`。有任务在跑后端会拒（409），`--force` 越过。 */
  | { kind: 'restart'; force: boolean }
  | { kind: 'recipe-contribute'; sourceId: string; step?: string; area?: string }
  /**
   * `stream recipe run <id>`：从命令行跑一条动作 recipe。它是 `POST /api/recipes/action` 的薄壳
   * （见 `recipe-run.ts`）——两步确认、凭据注入、限速全在后端那条路上，这里只负责把参数递过去。
   * `yes` = 跳过"先看会做什么"那一步直接执行（无人值守：调度中心的 `command` 执行体填的就是它）。
   */
  | { kind: 'recipe-run'; sourceId: string; params: Record<string, string>; yes: boolean; json: boolean }

/**
 * 装 / 更 / 卸完要不要重启后端。缺席 = 运行时再决定（有待重启项且 stdin 是终端才问）；
 * `--restart` / `--no-restart` 把「问」跳过去——脚本里没人能答那一句。
 */
export type RestartFlag = 'yes' | 'no'

const SUBCOMMANDS = ['mcp', 'add', 'remove', 'update', 'restart', 'recipe'] as const

/**
 * `<包名>[@<版本>]` 的拆法。**scope 那个 `@` 不是分隔符**——`@streamapp/netdisk` 拆成
 * `@streamapp` + `/netdisk` 的话，后面每一步（registry 请求、目录名）都指到一个不存在的包，
 * 而报错发生在很远的地方。判据只有一条：最后一个 `@`，且它不在第 0 位。
 */
export function parsePackageSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

export interface CliOptions {
  /** 监听端口。缺省 8900——**宿主上唯一那扇门**，别的地方（探针等）都按这个数写死。 */
  port?: number
  /** 可写状态的根（items/settings/cookies/引擎/扩展…）。缺省见 `defaultDataDir`。 */
  dataDir?: string
  help: boolean
  version: boolean
  /** 第一个非 flag 参数认出来的子命令。缺席 = 起后端那条老路。 */
  command?: CliCommand
  /** 子命令自己的用法错误（少了包名、remove 带了版本号）。调用方据此报错退出，**不许当没写**
   *  ——`stream add` 少一个包名却把后端起起来，是这条命令最难查的一种失败。 */
  error?: string
  /** 认不出来的参数原样带出——**不静默吞掉**：打错一个 flag 却照常启动，比报错难查得多。 */
  unknown: string[]
}

export function parseCliArgs(argv: string[]): CliOptions {
  const out: CliOptions = { help: false, version: false, unknown: [] }
  let seenSubcommand = false
  // `--restart` / `--no-restart` / `--force` 只对某几个子命令有意义，但**位置随意**（写在子命令前后
  // 都认）。所以在外层循环先收下，循环结束后按认出来的子命令挂上去；挂不上的（`stream mcp --restart`）
  // 进 unknown——对这条命令没意义的 flag 静默吞掉，用户会以为它生效了。
  let restartFlag: RestartFlag | undefined
  let restartFlagArg: string | undefined
  let force = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const eq = a.indexOf('=')
    const [flag, inline] = eq > 0 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, undefined]
    const take = () => inline ?? argv[++i]
    if (flag === '--help' || flag === '-h') out.help = true
    else if (flag === '--version' || flag === '-v') out.version = true
    else if (flag === '--restart' || flag === '--no-restart') {
      const v: RestartFlag = flag === '--restart' ? 'yes' : 'no'
      // 两个都给是错，不是后者盖前者：脚本里拼出来的命令行两头各带一个，照后者办的结果
      // 和用户的本意有一半概率相反，而且不报错。
      if (restartFlag !== undefined && restartFlag !== v) {
        out.error = `--restart 和 --no-restart 只能给一个`
        continue
      }
      restartFlag = v
      restartFlagArg = a
    } else if (flag === '--force') force = true
    else if (flag === '--port' || flag === '-p') {
      const n = Number(take())
      // NaN 不当没写：`--port abc` 会静默落回 8900，而用户以为自己换了口。
      if (!Number.isInteger(n) || n <= 0 || n > 65535) out.unknown.push(a)
      else out.port = n
    } else if (flag === '--data' || flag === '--data-dir') {
      const v = take()
      if (!v) out.unknown.push(a)
      else out.dataDir = resolve(v)
    } else if (
      !seenSubcommand &&
      !a.startsWith('-') &&
      (SUBCOMMANDS as readonly string[]).includes(a)
    ) {
      // 子命令只认第一个：`stream mcp add x` 里的 `add` 是 `mcp` 的一个多余参数，不是第二个
      // 子命令。认了它就等于让一条命令干两件事，而用户看到的是其中随机一件。
      seenSubcommand = true
      if (a === 'mcp') out.command = { kind: 'mcp' }
      else if (a === 'restart') out.command = { kind: 'restart', force: false } // `--force` 在循环结束后挂上
      else if (a === 'recipe') {
        // 「动词 + 参数」的形状：run（跑一条动作 recipe）/ contribute（贡献落地方式），
        // 以后 list / reset 也落在这里，别再造平级子命令。
        const verb = argv[i + 1]
        const id = argv[i + 2]
        // 一个动词都没给，和给了个不认识的动词，是两件事——答非所问的报错会让人去查错方向。
        if (!verb || verb.startsWith('-')) {
          out.error = `用法：stream recipe run <recipe id> [--param k=v]… [--yes]\n      stream recipe contribute <recipe id> [--step <label> | --area <名字>]`
          continue
        }
        if (verb !== 'contribute' && verb !== 'run') {
          out.error = `recipe 子命令只认 run / contribute：stream recipe run <recipe id> [--param k=v]… [--yes] | stream recipe contribute <recipe id> [--step <label> | --area <名字>]`
          continue
        }
        if (!id || id.startsWith('-')) {
          out.error = verb === 'run'
            ? `用法：stream recipe run <recipe id> [--param 名字=值]… [--yes] [--json]`
            : `用法：stream recipe contribute <recipe id> [--step <label> | --area <名字>]`
          continue
        }
        i += 2
        if (verb === 'run') {
          // 只吃自己认识的三个 flag（--param / --yes / --json），碰到别的就停、交还外层循环——
          // `--port` 对这条命令有意义（打哪个后端），不能在这里被吞成"不认识"。
          const params: Record<string, string> = {}
          let yes = false
          let json = false
          let bad = false
          while (i + 1 < argv.length) {
            const f = argv[i + 1]
            if (f === '--yes' || f === '-y') { yes = true; i++; continue }
            if (f === '--json') { json = true; i++; continue }
            if (f === '--param') {
              const kv = argv[i + 2]
              // `--param name`（没有 =）不当成 `name=''`：空值是一个合法的参数值，而"忘了写值"
              // 不是，两者在 recipe 的 schema 校验里长得一样。
              const eqAt = kv?.indexOf('=') ?? -1
              if (!kv || kv.startsWith('-') || eqAt <= 0) {
                out.error = `--param 要跟 名字=值，例如 --param contact=张三`
                bad = true
                break
              }
              params[kv.slice(0, eqAt)] = kv.slice(eqAt + 1)
              i += 2
              continue
            }
            break
          }
          if (bad) continue
          out.command = { kind: 'recipe-run', sourceId: id, params, yes, json }
          continue
        }
        // `--step` 和 `--area` 各自筛一种落地方式（步骤 / 具名区域）。**同给是错**，不是「后者
        // 覆盖前者」：两个筛子取交集恒为空，照着办的结果是「没有可贡献的」——和真的还没攒够
        // 长得一模一样。
        let step: string | undefined
        let area: string | undefined
        let bad = false
        while (argv[i + 1] === '--step' || argv[i + 1] === '--area') {
          const flag = argv[i + 1]
          const val = argv[i + 2]
          i += 2
          if (!val || val.startsWith('-')) {
            out.error = flag === '--step' ? `--step 要跟一个步骤 label` : `--area 要跟一个区域名字`
            bad = true
            break
          }
          if (flag === '--step') step = val
          else area = val
        }
        if (bad) continue
        if (step !== undefined && area !== undefined) {
          out.error = `--step 和 --area 只能给一个`
          continue
        }
        out.command = { kind: 'recipe-contribute', sourceId: id, ...(step && { step }), ...(area && { area }) }
      } else if (a === 'update') {
        // 包名可以有零到多个，`--yes` 在它们前后都认；碰到别的 flag 就停、交还外层循环
        // （`--data` / `--port` 对这条命令有意义）。
        const names: string[] = []
        let yes = false
        while (i + 1 < argv.length) {
          const n = argv[i + 1]
          // 只认 `--yes`：`-y` 没有在 README 里文档化，别让 update 悄悄多出一个用户查不到的别名。
          if (n === '--yes') { yes = true; i++; continue }
          if (n.startsWith('-')) break
          names.push(n)
          i++
        }
        // 装的永远是 npm 上最新那版：带版本号的诉求是 `stream add <包>@<版本>` 的事，在这里
        // 静默丢掉版本号会让用户以为自己钉住了某一版。
        const versioned = names.find((n) => parsePackageSpec(n).version)
        if (versioned) {
          out.error = `update 不接受版本号（装的永远是 npm 上最新那版）：stream update ${parsePackageSpec(versioned).name}`
          continue
        }
        out.command = { kind: 'update', names, yes }
      } else {
        const next = argv[i + 1]
        if (!next || next.startsWith('-')) {
          out.error = `${a} 要一个包名，例如 stream ${a} @streamapp/netdisk`
          continue
        }
        i++
        const { name, version } = parsePackageSpec(next)
        if (a === 'remove' && version) {
          out.error = `remove 不接受版本号（装着的就那一份）：stream remove ${name}`
          continue
        }
        out.command = a === 'add' ? { kind: 'add', name, ...(version && { version }) } : { kind: 'remove', name }
      }
    } else out.unknown.push(a)
  }
  const cmd = out.command
  if (restartFlag !== undefined) {
    if (cmd && (cmd.kind === 'add' || cmd.kind === 'remove' || cmd.kind === 'update')) cmd.restart = restartFlag
    else out.unknown.push(restartFlagArg!)
  }
  if (force) {
    if (cmd?.kind === 'restart') cmd.force = true
    else out.unknown.push('--force')
  }
  return out
}

/**
 * 可写状态放哪：`~/.stream`。
 *
 * **和已经在用这个目录的东西对齐**，不是随手挑的：native messaging 清单住
 * `~/.stream/NativeMessagingHosts/`，Stream Desktop 找 data 目录的那份指针住 `~/.stream/datadir`
 * （见 `app/host-agent/src/datadir.rs`）。装到别处会让"同一台机器上的 Stream"散成两处。
 *
 * `STREAM_DATA_DIR` 显式给了就听它——容器和自托管那一档一直这么传。
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const explicit = env.STREAM_DATA_DIR
  if (explicit && explicit.trim()) return resolve(explicit)
  return join(home, '.stream')
}

export const HELP = `stream — 自托管的信息流层

用法：
  stream [--port <n>] [--data <dir>]        起后端（界面 + /api + /api/mcp）
  stream mcp                                stdio 的 MCP 入口，转发到后端（没起就替你起一份）
  stream add <包名>[@<版本>]                 装一个能力/recipe 包
  stream remove <包名>                       卸掉它
  stream update [<包名>…] [--yes]            把内置 / 已装的包更到 npm 最新版（不带包名 = 全部；
                                            多了副作用或第三方包要 --yes 才装）
  stream restart [--force]                  重启后端（有任务在跑会拒，--force 越过）
                                            add / remove / update 装完有待重启项会问一句；
                                            脚本里用 --restart / --no-restart 跳过那一问
  stream recipe run <id> [--param 名字=值]… [--yes] [--json]
                                            跑一条动作 recipe（不带 --yes 只打印它会做什么）；
                                            要定时就把这一行填进调度中心的「命令」执行体
  stream recipe contribute <id> [--step <label> | --area <名字>]
                                            把本机学到的落地方式贡献回这份 recipe 的包
                                            （有 gh 就开 PR，没有就开一个预填好的 issue）

  --port, -p <n>     监听端口（默认 8900）——对 mcp / add / remove / update / restart 是它们
                     探 / 打的那个后端的端口
  --data <dir>       可写状态的根目录（默认 ~/.stream）——对 add/remove/update/mcp 同样生效
  --version, -v      打印版本
  --help, -h         这段

装完之后（五步，每步都有判据）：
  1. 打开 http://127.0.0.1:8900，把 Chrome 扩展装上 —— 采集要借你自己浏览器的登录态，
     不装的话小红书/B站/抖音这些站只能拿到游客看得见的东西，而且不报错。
     （扩展要经一个本机小程序拿钥匙，后端自己登记并拉起它：启动日志里那行
      "[stream-desktop] host-agent → <路径>" 就是登记成功。）
       判据  curl -s 127.0.0.1:8900/api/browser-capability   → "state":"ready"
  2. 订一条流，**建流那一句里就带上 channel_id** —— 不属于任何频道的流重启后会从调度里消失。
       判据  curl -s -X POST 127.0.0.1:8900/api/streams/<id>/refresh   → fetched>0 且 written>0
  3. 要转写/认字这类能力就配一把 key（Stream 能替你在自己的 Chrome 里申请，见 README）。
       判据  curl -s 127.0.0.1:8900/api/conversion-kinds     → 那条的 branches/available 为 true
  4. 想用自然语言支使它：宿主那边配一行指向 Stream，此后不用再改。装了 Stream 就有电脑操作；
     想要更多能力就 stream add，工具从同一个口出去（要重启后端才生效）。
       claude mcp add stream -- stream mcp     # Codex 是 config.toml 的 mcp_servers 一行
       stream add @streamapp/netdisk           # 网盘四个动词
     （不走这层壳也行：后端跑着时直接把 http://127.0.0.1:8900/api/mcp 给客户端，工具集一样。）
  5. 用自己的 Claude Code / Codex 的话，把 Stream 的 skill 装给它 —— MCP 给的是工具，
     skill 给的是"什么时候用哪个"。
       curl -s -X POST 127.0.0.1:8900/api/skills/install
       判据  curl -s 127.0.0.1:8900/api/skills          → landings[].mode 都是 "link"

  完整指南（含每一步的判据与常见误判）在这个包的 README 里：
    npm docs @streamapp/stream        # 或 https://www.npmjs.com/package/@streamapp/stream

  数据全在 --data 那个目录里，删掉它就等于重置；卸载就是删掉它 + npm rm -g @streamapp/stream。
`

/** 启动前要塞进环境的那几个值。**独立成函数是为了可测**——"端口/目录到底传没传对"是这条
 *  命令唯一可能出错的地方，而它在活体上的失败样子是"起在了另一个口上"，很难一眼看出。 */
export function envForServer(
  opts: CliOptions,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    STREAM_DATA_DIR: opts.dataDir ?? defaultDataDir(base),
    ...(opts.port ? { STREAM_PORT: String(opts.port) } : {}),
  }
}
