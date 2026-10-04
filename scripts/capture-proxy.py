#!/usr/bin/env python3
"""一个只为「看清一条请求长什么样」而存在的最小 HTTP 代理。

为什么不是 mitmproxy：要看的目标（荔枝音频 CDN）是**明文 HTTP**，不需要解密、不需要证书、
不需要在手机上装 CA。装一套 mitm 只会引入证书信任这一整类新问题，而它解决的问题我们没有。

行为：
  - 普通 HTTP 请求（绝对 URI）→ 转发，并把**请求头与响应头原样记下来**（body 不记，音频几十 MB）。
  - CONNECT（HTTPS）→ 盲转发，只记一行「到哪个 host」。不解密、看不到内容，这是有意的。

用法：
    python3 scripts/capture-proxy.py [监听端口，默认 8888] [--filter 子串]
    --filter 只记录 host 含该子串的请求（如 lizhi），其余照常转发但不落日志。

日志同时写 stdout 和 `capture-proxy.log`（在 cwd）。Ctrl-C 停。
"""
import argparse
import select
import socket
import socketserver
import sys
import threading
import time
from urllib.parse import urlsplit

LOG_LOCK = threading.Lock()
LOG_FILE = None
FILTER = None


def log(msg: str) -> None:
    line = f"{time.strftime('%H:%M:%S')} {msg}"
    with LOG_LOCK:
        print(line, flush=True)
        if LOG_FILE:
            LOG_FILE.write(line + "\n")
            LOG_FILE.flush()


def read_headers(sock_file):
    """读到空行为止。返回 (请求/状态行, [头行...], 原始字节)。连接断了返回 (None, [], b'')。"""
    raw = b""
    first = sock_file.readline()
    if not first:
        return None, [], b""
    raw += first
    headers = []
    while True:
        line = sock_file.readline()
        if not line or line in (b"\r\n", b"\n"):
            raw += line
            break
        raw += line
        headers.append(line.decode("latin-1").rstrip("\r\n"))
    return first.decode("latin-1").rstrip("\r\n"), headers, raw


def header_value(headers, name):
    low = name.lower() + ":"
    for h in headers:
        if h.lower().startswith(low):
            return h.split(":", 1)[1].strip()
    return None


def pipe(a: socket.socket, b: socket.socket) -> None:
    """双向盲转发,任一端关闭即收摊。"""
    socks = [a, b]
    try:
        while True:
            r, _, x = select.select(socks, [], socks, 60)
            if x or not r:
                break
            for s in r:
                data = s.recv(65536)
                if not data:
                    return
                (b if s is a else a).sendall(data)
    except OSError:
        pass


class Handler(socketserver.StreamRequestHandler):
    timeout = 120

    def handle(self):  # noqa: C901 — 一条直线的协议处理,拆开反而更难读
        try:
            line, headers, _ = read_headers(self.rfile)
        except OSError:
            return
        if not line:
            return
        parts = line.split()
        if len(parts) < 3:
            return
        method, target, version = parts[0], parts[1], parts[2]

        if method == "CONNECT":
            host, _, port = target.partition(":")
            self._connect_tunnel(host, int(port or 443))
            return

        split = urlsplit(target)
        host = split.hostname
        if not host:
            return
        port = split.port or 80
        path = split.path or "/"
        if split.query:
            path += "?" + split.query

        watched = FILTER is None or FILTER in host
        if watched:
            log(f"→ {method} http://{host}{path}")
            for h in headers:
                log(f"    | {h}")

        try:
            up = socket.create_connection((host, port), timeout=20)
        except OSError as e:
            if watched:
                log(f"  ✗ 连不上 {host}:{port} — {e}")
            return

        # 转发成 origin-form(相对路径)——上游是普通 web 服务器,不是代理。
        out = f"{method} {path} {version}\r\n".encode("latin-1")
        for h in headers:
            if h.lower().startswith("proxy-"):
                continue
            out += h.encode("latin-1") + b"\r\n"
        out += b"\r\n"
        try:
            up.sendall(out)
            body_len = header_value(headers, "content-length")
            if body_len and body_len.isdigit():
                remaining = int(body_len)
                while remaining > 0:
                    chunk = self.rfile.read(min(65536, remaining))
                    if not chunk:
                        break
                    up.sendall(chunk)
                    remaining -= len(chunk)

            upf = up.makefile("rb")
            status, rheaders, raw = read_headers(upf)
            if status is None:
                return
            if watched:
                log(f"← {status}")
                for h in rheaders:
                    if h.split(":", 1)[0].lower() in (
                        "content-type", "content-length", "content-range", "accept-ranges",
                        "x-cache", "x-ser", "server", "location", "age", "via", "set-cookie",
                    ):
                        log(f"    | {h}")
            self.wfile.write(raw)
            self.wfile.flush()
            pipe(self.connection, up)
        except OSError:
            pass
        finally:
            up.close()

    def _connect_tunnel(self, host: str, port: int) -> None:
        if FILTER is None or FILTER in host:
            log(f"⇢ CONNECT {host}:{port}  (TLS,盲转发,看不到内容)")
        try:
            up = socket.create_connection((host, port), timeout=20)
        except OSError as e:
            log(f"  ✗ CONNECT 连不上 {host}:{port} — {e}")
            self.wfile.write(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        try:
            self.wfile.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            self.wfile.flush()
            pipe(self.connection, up)
        finally:
            up.close()


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> None:
    global LOG_FILE, FILTER
    ap = argparse.ArgumentParser()
    ap.add_argument("port", nargs="?", type=int, default=8888)
    ap.add_argument("--filter", default=None, help="只记录 host 含该子串的请求")
    ap.add_argument("--log", default="capture-proxy.log")
    args = ap.parse_args()
    FILTER = args.filter
    LOG_FILE = open(args.log, "a", encoding="utf-8")
    log(f"代理监听 0.0.0.0:{args.port}" + (f"，只记 host 含 '{FILTER}' 的请求" if FILTER else ""))
    log("手机设 WiFi 代理指到本机即可；HTTPS 走盲隧道,不需要装证书。")
    try:
        Server(("0.0.0.0", args.port), Handler).serve_forever()
    except KeyboardInterrupt:
        log("停了")
        sys.exit(0)


if __name__ == "__main__":
    main()
