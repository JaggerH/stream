# Stream backend+frontend image (one image, two commands). Bakes in the native deps so nothing
# is installed at runtime: node deps incl. native better-sqlite3 (.node) + esbuild, built during
# `pnpm install` because pnpm-workspace.yaml allowlists them.
#
# NO BROWSER IS INSTALLED HERE, and none should be. This image used to carry chromium system
# libs plus CloakBrowser's own 206 MB chromium binary, because Stream launched a browser inside
# the container. Harvesting now drives the USER'S Chrome, on their machine, over the extension
# relay — the container only speaks CDP down a websocket. Anything that wants to add a browser
# back is re-proposing the architecture that was just retired.
#
# dev bind-mounts the source over /app + anonymous node_modules volumes (so the baked,
# Linux-native install is NOT shadowed by the host tree) and runs tsx watch / vite — see
# docker-compose.override.yml. prod runs the COPY'd source. RSSHub still resolves at
# the configured RSSHub checkout via a dev mount — baking
# RSSHub into the image is a follow-up.
#
# Pin bookworm: node:22-slim tracks debian's default, now trixie; staying on bookworm keeps this
# base predictable across rebuilds.
FROM node:22-bookworm-slim

# ffmpeg/ffprobe: 网盘内嵌字幕/音轨提取(src/media/extract.ts)直接对着 AList 直链做 stream-copy
# 抽取，不转码——同一个 apt 包自带 ffprobe，不需要单独装。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable
WORKDIR /app

# Workspace manifests first (cached dep layer). This is a pnpm workspace (pnpm-workspace.yaml
# lists `app`), so --frozen-lockfile needs the workspace manifest AND every member's package.json
# or it errors on lockfile mismatch. With the manifests present the install succeeds and — thanks
# to onlyBuiltDependencies in pnpm-workspace.yaml — builds better-sqlite3 + esbuild in place.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY app/package.json app/package.json
RUN pnpm install --frozen-lockfile

# prod source; dev overlays a bind-mount + reload command on top of this.
COPY . .

CMD ["pnpm", "exec", "tsx", "src/serve.ts"]
