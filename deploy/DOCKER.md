# Docker 公网部署：游戏 + 内置 TURN + HTTPS

本项目的 Rust 服务同时运行游戏 API、WebSocket、前端和 **IPv4/UDP STUN/TURN**，无需额外 coturn 容器。Compose 只启动 `game` 与 `caddy`。当前游戏镜像为 Linux amd64，请使用 x86_64 公网服务器、Docker Engine 和 Compose 插件。

## 1. 准备域名与端口

准备真实公网 IPv4。云主机网卡只有内网 IP 时，`TURN_PUBLIC_IP` 仍填云平台分配的公网 IP；不要填网卡内网 IP、Docker 容器 IP 或域名。

- 游戏域名，例如 `play.your-domain.com`，A 记录指向服务器公网 IP。
- TURN 可用相同域名，也可使用 `turn.your-domain.com`，A 记录指向同一公网 IP。
- 没有可用 IPv6 时，删除相关 AAAA 记录；内置 TURN 当前只支持 IPv4。

在主机防火墙与云安全组放行：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 80 | TCP | Caddy 证书验证、HTTP 跳转 |
| 443 | TCP | HTTPS 页面、API、WSS 信令 |
| 443 | UDP | 可选 HTTP/3 |
| 3478 | UDP | 内置 STUN/TURN 客户端入口 |
| 49160–49200 | UDP | TURN 媒体中继，必须整个范围可达 |

3000 只在 Compose 网络内供 Caddy 访问，不映射到公网。3478 和中继端口直接映射到游戏容器，不能经过 Caddy、HTTP CDN 或普通 HTTP 反向代理。域名若使用 CDN，应为 TURN 域名关闭 HTTP 代理，使用 DNS-only 解析。

若服务器位于路由器后面，额外配置公网到服务器的上述端口转发；UDP 中继端口必须保持相同端口号。公网 IP 变化后更新 DNS 和 `.env`，重新创建游戏容器。

## 2. 获取源码并配置

```sh
git clone https://github.com/inbjo/Kantengyen.git
cd Kantengyen
cp .env.example .env
```

编辑 `.env` 至少设置：

```dotenv
SITE_ADDRESS=play.your-domain.com
TURN_ENABLED=true
TURN_PUBLIC_IP=你的真实公网IPv4
TURN_PUBLIC_HOST=turn.your-domain.com
VOICE_ICE_POLICY=all
```

`TURN_PUBLIC_HOST` 可省略，客户端将使用公网 IP；STUN/TURN URL 由后端自动生成。默认不用额外配置 `VOICE_ICE_SERVERS`、`VOICE_TURN_URLS`。

`VOICE_TURN_SECRET` 可留空，由服务每次启动自动生成随机密钥；也可填入至少 32 字节随机字符串。它只用于签发和校验临时凭证，不会发送给浏览器。固定密钥便于管理，但服务重启仍会关闭中继连接及游戏房间。

如果配置机装有 Node.js 22+，可以使用辅助脚本生成固定密钥（无需安装 npm 依赖）：

```sh
npm run setup:turn -- --public-ip 你的真实公网IPv4 --domain turn.your-domain.com
# 再编辑 .env 中的 SITE_ADDRESS
chmod 600 .env
```

脚本不输出密钥，重复执行保留已有密钥与其他设置；不再生成 coturn 配置。没有 Node.js 的部署机直接编辑 `.env` 即可，运行镜像不需要 Node.js 或 Rust。

## 3. 构建并启动

```sh
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 game caddy
curl -fsS https://play.your-domain.com/api/health
```

首次构建会下载 Rust、Node.js 和依赖；后续复用 Docker 构建缓存。镜像是 scratch 非 root 运行环境，内含静态二进制、前端/WASM 与许可证。启用 TURN 但缺失公网 IP、配置无效或端口无法绑定时，服务启动失败并写入日志；不要把反复重启的容器当作部署成功。

日志中应出现“内置 TURN UDP 已启动”和游戏监听信息。Caddy 自动申请并续期 HTTPS 证书，证书数据保存在 `caddy_data`、`caddy_config` 卷中。第一次申请证书可能需要等待片刻。

## 4. 验证真实中继

两台真实设备分别使用 Wi-Fi 与移动网络，打开游戏 HTTPS 地址，加入同一房间并主动开启语音。

为了证明音频确实经过内置 TURN，而非刚好直连：

1. 在 `.env` 临时设置 `VOICE_ICE_POLICY=relay`。
2. `docker compose up -d game` 重新创建游戏容器。这会清空房间，请先结束对局。
3. 两台设备重新入房并开启语音，检查双向听感；用浏览器 WebRTC 诊断查看选中的 candidate-pair 类型为 `relay`，同时检查 RTP 收包。
4. 需要优先直连时恢复 `all` 并重新创建游戏容器。

## 5. 容量与网络限制

默认最多 32 个同时存在的 TURN allocation，每个 allocation 的收发方向各限制为 128000 字节/秒；超额媒体包丢弃，不积压。49160–49200 共有 41 个中继端口，实际并发受可用端口及 allocation 上限共同限制。每个浏览器到其他成员的 PeerConnection 可能需要单独 allocation，6 人 mesh 大约需要 30 个，默认容量面向小规模部署。

`.env` 中可调整 `TURN_MAX_ALLOCATIONS`、`TURN_BYTES_PER_SECOND`。增加中继端口范围时，同时修改 Compose 中 `TURN_MIN_PORT`、`TURN_MAX_PORT`、`ports` 映射、Dockerfile 声明及防火墙，保持容器与公网端口一致。内置服务还限制每个来源 IP 的控制请求与包速率、总入站速率；多个玩家共享同一 NAT 时共用来源 IP 配额。

内置服务拒绝向内网、回环、共享地址、组播和云元数据地址中继；同一服务的活动中继端口通过内部路由互通，无需公网 NAT hairpin。临时凭证一小时有效，每 15 秒清理已过期凭证对应的 allocation；客户端持续通话会刷新凭证和重新协商。

**当前内置 TURN 仅支持 IPv4/UDP，不支持 TURN/TCP、TURN/TLS 或 IPv6。** 如果客户端网络完全封锁 UDP，房间语音可能无法建立；可配置外部 TURN/TCP/TLS 作为补充，见 [语音指南](VOICE.md)。HTTPS 加密的是网页和信令；WebRTC 音频本身仍使用 DTLS-SRTP，普通 `turn:` 不代表明文音频。

## 6. 运维与迁移

```sh
# 查看日志
docker compose logs -f --tail=100 game caddy
# 更新源码并重建
git pull --ff-only
docker compose up -d --build
# 停止，保留 HTTPS 证书卷
docker compose down
```

升级、回滚和重新创建游戏容器都会清空房间并断开内置中继；在无对局时维护。不要使用 `down -v` 删除证书卷，备份 `.env` 和 Caddy 数据卷。内置 TURN 与游戏在同一进程，不能独立重启中继。

从旧的独立 coturn 部署迁移时，更新代码前先停止旧 TURN 服务，释放 3478 和中继端口，再设置新 `.env`。删除不再使用的旧 `VOICE_TURN_URLS` / `VOICE_ICE_SERVERS`，避免向浏览器发布过期入口；保留至少 32 字节密钥可继续使用。旧的 `deploy/turnserver.conf` 不再读取，请自行安全保存或删除。

证书失败、502、房间连接问题可参考 [总部署指南](README.md)；语音不通优先检查 UDP 端口、安全组、真实公网 IP、DNS-only 配置，以及客户端是否封锁 UDP。
