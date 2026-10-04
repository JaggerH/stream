# 落地：Stream 自己写镜像的后端容器（tier 1 的另一半）

tier 1 有两种后端，分界线是**谁做的镜像**：

- **设施自己发布的第三方镜像**（带 `/openapi.json` 的抓取器容器，如 douyin-tiktok-download-api）→ `via-external-backend.md`。Stream **不打包**，只声明 + 声明式路由。
- **Stream 自己写 Dockerfile 的后端**（ML 模型服务：diarization / embedding / docparse，如 `voiceprint`=sherpa-onnx）→ **本文**。这类往往不是内容源，而是 **Provider 能力**（transcribe Provider 成员），但镜像构建的坑和源后端一样，都在这。

**这类包住哪**：只声明容器、不带 Source 也不带凭证的包**不进 stream 仓库的内置层**，住
`github.com/JaggerH/stream-packages`（本机 `~/projects/stream-packages`）：一目录 = `Dockerfile` + `app.py` +
`package.json#stream.backend`，tag `<name>-v<版本>` 让 workflow 同时构建推 ghcr 与 `npm publish` 清单；用户
`stream add @streamapp/<name>`，容器在 `manage_containers: true` 时由后端建出来（`docs/PACKAGE.md` §4 开头、
§7.2）。清单**不能带 `backend.dev`**（用户层的钳制拒它，源码也不在 stream 仓库里）；`gpu` / 大 `mem` 照单
收下、不钳（§6.2），但 README 要写明 GPU 包没装 nvidia toolkit 起不来。stream 仓库里没有 `containers/` 目录——自建镜像的源码一律住 stream-packages；
仍内置的容器包（alist / 抖音解析 / pansou）用的是各自上游发布的镜像，不在这里建。

`docs/PACKAGE.md` 是描述符/槽位/compose/凭证标准；本文是它未覆盖的运维半边：**怎么把一个自建 GPU 模型服务镜像建出来、不再撞同一堵墙**。下面每条都是真踩过的失败 + 正解。

## 能力型后端的标准形状：长活切片、容器只算单片

如果这个后端服务的是**能力**（ASR/diarization/embedding/docparse 这类，非内容源），设计端点时把
「长活」拆成「后端切片 + 容器逐片短调用」，别把长计算一股脑塞进一次请求——容器端点必须**秒级、
无状态、可重放**（不长算、不存结果、同输入可重发），这是新增的硬不变量，全文 + why 见
`docs/PACKAGE.md` §4.2；切片器（planner）/装配器（assembler）落在 Stream 侧、账本管断点续跑与
回收，voiceprint 是 worked example（`stream-packages/voiceprint/app.py` 单窗纯函数 +
`src/media/audio-windows.ts`/`src/voiceprint/windowed.ts`）。设计全文：
`internal design record`。

## Gotcha 库（每条一个真实调试循环）

| Gotcha | Fix |
|---|---|
| **运行时从容器里下模型 FAILS。** 从容器内拉 HF 走的是不稳的路径——容器 NAT 拿不到宿主代理的域名直连规则，落到不稳链路（SSL EOF）。 | **模型烤进镜像。** `fetch-model.sh` 在**宿主**下到 build context，Dockerfile `COPY`，`models/` git-ignore（仓库只存脚本）。自包含、确定、零运行时网络。 |
| **多 GB `model.bin` 反复截断**（partial file / SSL EOF）——过代理/国际链路即使 `--retry`/`-C -` 也断；从另一台机器 rsync 一样卡最后一跳。 | **用就近/国内镜像源 + HTTP 断点续传。** 受限网络下 HF 模型走 ModelScope（阿里魔搭）国内 CDN——直连、快、可续（确认 `206`）。小 metadata 文件哪都行；只有 GB 权重需要可靠源。 |
| **模型加载报 cryptic "Cannot load the vocabulary"。** 下了"模型"但漏了必需 metadata，或名字错（CTranslate2 要 `vocabulary.json` **不是** `.txt`；Systran 的 HF 仓两者都不作为独立文件发，镜像源才有）。 | **靠真在容器里 LOAD 一遍验证文件集**，不是"下了模型就行"。要知道 runtime 到底要哪些文件。 |
| **单体 `nvidia/cuda:*-cudnn-*` base 镜像拉不下来**（它 ~670MB 那层过代理截断）。 | **slim base + pip CUDA wheel。** `pip install nvidia-cudnn-cu12 nvidia-cublas-cu12`，`LD_LIBRARY_PATH` 指到 wheel 的 lib 目录；`libcuda.so` 由 `--gpus` 从宿主驱动来（WSL：`/usr/lib/wsl/lib`）。更小 + 绕开那个不稳大层。大 wheel 走国内 pip 源（清华）。 |
| **`/health` 报 `cuda` 实则悄悄跑 CPU。** CPU-only ML wheel *接受* `device="cuda"` 却不报错，所以"试 cuda→catch→回落"默认会**谎报**设备。 | **设备 opt-in,不是 try-and-fallback。** 默认 CPU；显式 env（`USE_CUDA=1`）开 GPU；`/health` 报**实际用的**设备。 |
| **`docker compose up` 在 CPU-only 主机硬崩。** `gpu: true` 生成不可满足的 nvidia 设备预留——不降级。 | `gpu:` 匹配**镜像真实能力**（CPU-wheel 镜像 + `gpu:true` 预留了它用不了的 GPU）。CPU 部署：`gpu:false` + device=cpu env。 |
| **容器永远 `unhealthy`。** 生成的 healthcheck 是 `wget -qO- .../health`；slim base 既无 `wget` 也无 `curl`。 | 给镜像加 `wget`（对齐生成的命令）——放**末尾一层**,别冲掉 cuDNN/模型缓存。（depends_on 是普通列表时纯 badge，但仍是瑕疵；`docker inspect --format '{{.State.Health.Status}}'` 验。） |
| **改 Dockerfile 就重下 cuDNN + 重 COPY GB 模型。** | **贵层在前、volatile 在后：** cuDNN wheel + `COPY models/` 在 app 代码 + wget 之前。base 已在本地而 registry manifest 检查抖动（"TLS handshake timeout"）时,`--pull=false` build。 |
| **推理单测通过但管线 500。** 你走了客户端网关 `/_p/<plugin>/...`；网关可能不代理大 multipart POST（网关侧 500，容器根本没收到请求）。 | 后端走**容器 DNS** `http://<service>:<port>`,不是网关。测那条：`docker run --rm --network <project>_<net> ... curl http://<service>:80/...`。compose 网络名是 `<project>_<network>`（如 `stream_stream`），不是裸 `stream`。确认模型真在镜像里：`docker run --rm --entrypoint ls <image> /models/...`。 |
| **首个 `/transcribe` 像卡死（>100s）。** 模型首调 lazy 加载。 | 预期：首调 = 模型加载 + CUDA 初始化,之后快。GPU 显存上升 = 在加载,不是卡死。 |
| **改了容器源码不会自动生效。** stream-packages 里的包没有 bind-mount，改了 `app.py` 就得重建镜像；worktree 里更没法活体测容器。 | 容器活按：分支里提交文件,`fetch-model.sh` + `docker build` + GPU 冒烟在 stream-packages 主检出做；发版走 tag。 |

## build → verify 序列

**可选容器包（stream-packages）**——镜像与清单同一目录：

```bash
cd ~/projects/stream-packages/<id>
bash fetch-model.sh                                     # 有的话：宿主侧下模型（国内镜像源）
docker build --pull=false -t <image>:<版本> .           # 烤模型 + cuDNN wheel；<image> 读 package.json#stream.backend.image
docker push <image>:<版本>                              # 或走 tag 让 workflow 推（PR 只 build 不 push）
# 清单的 image 指到这个版本 → 改 package.json version → 提交 → git tag <id>-v<版本> && git push --tags
#   workflow 推 ghcr + npm publish
# 验：装进一份冒烟后端（独立 STREAM_PORT + STREAM_DATA_DIR、manage_containers: true）
stream add @streamapp/<id>            # 重启后端 → 宿主接管建容器（docker ps 里 stream-<id>）
#   已有容器时宿主只比 image 字符串：清单指 `:latest` 而你刚推了新的 `:latest`，它不会自己重拉——
#   `docker rm -f stream-<id>` 再重启后端才走 pull + create
docker inspect stream-<id> --format '{{.State.Health.Status}}'   # 要 healthy
curl -s 127.0.0.1:<port>/_p/<id>/health                          # 经后端那扇门可达 = pluginTarget 解析成功
nvidia-smi --query-gpu=memory.used --format=csv,noheader         # 打一次 <endpoint> 后 +VRAM 证明真 GPU 推理
```

**内置容器包（alist / 抖音解析 / pansou，镜像来自上游）**——不在这里建镜像；改了 `stream.backend` 声明后：

```bash
pnpm plugins compose > docker-compose.yml               # 重新生成（gitignore 的生成物，最容易忘）
docker compose up -d <id>
docker inspect stream-<id>-1 --format '{{.State.Health.Status}}'   # 要 healthy
# 真实路径（不是网关）：容器到容器
docker run --rm --network stream_stream curlimages/curl -s http://<id>:<port>/health
```

**起容器只有两条路：生成的 compose，或 `manage_containers` 下的宿主接管**（PACKAGE.md §7）；建**镜像**是合法前提——"禁止手写 docker run/build"那条针对的是 RUN（网络/health/broker 接线），不是产出 Stream 自建镜像。
