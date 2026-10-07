# Docker 公网部署：游戏 + 内置 TURN + HTTPS

本项目的 Rust 服务同时运行游戏 API、WebSocket、前端和 **IPv4 STUN/TURN，支持 UDP、TCP、TLS 客户端入口**，无需额外 coturn 容器。Compose 只启动 `game` 与 `caddy`。当前游戏镜像为 Linux amd64，请使用 x86_64 公网服务器、Docker Engine 和 Compose 插件。

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
| 3478 | UDP/TCP | 内置 STUN/TURN 客户端入口 |
| 5349 | TCP | 可选内置 TURN/TLS，启用 TLS overlay 后开放 |
| 49160–49223 | UDP | TURN 媒体中继，必须整个范围可达 |

3000 只在 Compose 网络内供 Caddy 访问，不映射到公网。3478、5349 和中继端口直接映射到游戏容器，不能经过 Caddy、HTTP CDN 或普通 HTTP 反向代理。域名若使用 CDN，应为 TURN 域名关闭 HTTP 代理，使用 DNS-only 解析。

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

`TURN_PUBLIC_HOST` 可省略，客户端将使用公网 IP；STUN/TURN URL 由后端自动生成。TCP 默认启用，TLS 需按下节挂载证书启用。默认不用额外配置 `VOICE_ICE_SERVERS`、`VOICE_TURN_URLS`。

`VOICE_TURN_SECRET` 可留空，由服务每次启动自动生成随机密钥；也可填入至少 32 字节随机字符串。它只用于签发和校验临时凭证，不会发送给浏览器。固定密钥便于管理；服务重启会断开中继连接，游戏房间从持久化文件恢复。

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

日志中应出现“内置 TURN UDP/TCP/TLS 已启动”（tcp/tls 字段显示实际入口）和游戏监听信息。Caddy 自动申请并续期 HTTPS 证书，证书数据保存在 `caddy_data`、`caddy_config` 卷中。第一次申请证书可能需要等待片刻。

## 4. 启用内置 TURN/TLS

建议 `TURN_PUBLIC_HOST` 使用游戏 HTTPS 域名，例如 `play.your-domain.com`，以复用 Caddy 已申请的证书。TURN 仍直接连接 Rust 的 5349 端口，Caddy 只负责申请/续期网页证书，不代理 TURN 流量。单独使用 `turn.your-domain.com` 时，需另行申请覆盖它的证书。

先按前文启动基础 Compose，确认 HTTPS 证书申请成功。部署机有 Node.js 22+ 时，可以从 Caddy 导出证书（无需 npm 依赖）：

```sh
sudo node scripts/export-turn-cert.mjs --domain play.your-domain.com
# 在 Linux 的 .env 增加下面一行，后续普通 compose 命令自动包含 TLS 配置：
# COMPOSE_FILE=compose.yaml:compose.tls.yaml
docker compose -f compose.yaml -f compose.tls.yaml up -d game
```

`compose.tls.yaml` 挂载 `deploy/turn-certs`，打开 5349 TCP，并设置 Rust TLS 路径。后端自动发布 `turns:play.your-domain.com:5349?transport=tcp`。只在 Caddy 第一次申请证书之后启用，避免游戏因为缺失证书而无法启动。重新创建容器后房间从 `game_data` 卷恢复。

没有 Node.js 或使用自己的 ACME 工具时，将覆盖 `TURN_PUBLIC_HOST` 的完整 PEM 证书链保存为 `deploy/turn-certs/fullchain.pem`，未加密 PEM 私钥保存为 `deploy/turn-certs/privkey.pem`，在 Linux 配置权限：

```sh
sudo chown 10001:10001 deploy/turn-certs deploy/turn-certs/*.pem
sudo chmod 750 deploy/turn-certs
sudo chmod 640 deploy/turn-certs/*.pem
```

证书目录已被 Git 和 Docker 构建忽略；通过只读目录挂载读取，不打入镜像。域名解析必须 DNS-only。浏览器要求证书受信任、未过期、域名匹配且链完整；本地自签名证书不能直接用于真实公网玩家。

Rust 每 60 秒检查文件变化，成功解析并验证密钥匹配后替换 TLS 配置；新连接使用新证书，现有通话不中断。证书与密钥不匹配或读取失败时，保留上次有效证书并记录警告。从 Caddy 导出的文件是副本，Caddy 续期后需再次运行导出脚本；可在 root 的 crontab 加入（替换仓库绝对路径与域名）：

```cron
*/15 * * * * cd /opt/Kantengyen && /usr/bin/node scripts/export-turn-cert.mjs --domain play.your-domain.com >> /var/log/kantengyen-turn-cert.log 2>&1
```

只有 TCP 443 可达的网络可能也封锁 5349。当前 443 TCP 由 Caddy 网页服务占用，不能直接把同一个 IP 的 443 同时映射给 TURN；使用独立公网 IP 或其他经过验证的四层路由方案后，才能把该入口对外放到 443，并设置 `TURN_TLS_PUBLIC_PORT=443`，确保下发 URL 使用外部端口。映射示例为 `第二个公网IP:443:5349/tcp`，同时必须让 Caddy 的 443 只绑定第一个公网 IP，避免通配地址冲突。

## 5. 验证真实中继

两台真实设备分别使用 Wi-Fi 与移动网络，打开游戏 HTTPS 地址，加入同一房间并主动开启语音。

为了证明音频确实经过内置 TURN，而非刚好直连：

1. 在 `.env` 临时设置 `VOICE_ICE_POLICY=relay`。
2. `docker compose up -d game` 重新创建游戏容器。保留 `game_data` 卷，对局重连后可恢复。
3. 两台设备重新入房并开启语音，检查双向听感；用浏览器 WebRTC 诊断查看选中的 candidate-pair 类型为 `relay`，同时检查 RTP 收包。
4. 分别设置 `TURN_TRANSPORT=udp`、`tcp`、`tls` 并重新创建游戏容器。此变量只下发指定入口；检查选中的本地候选 `relayProtocol` 对应 `udp`、`tcp`、`tls`。TLS 测试必须已启用 overlay。
5. 验证后恢复 `TURN_TRANSPORT=all`、`VOICE_ICE_POLICY=all` 并重新创建游戏容器。

## 6. 容量与网络限制

默认最多 64 个同时存在的 TURN allocation，每个 allocation 的收发方向各限制为 128000 字节/秒；超额媒体包丢弃，不积压。49160–49223 共有 64 个中继端口，实际并发受可用端口及 allocation 上限共同限制。每个浏览器到其他成员的 PeerConnection 可能需要单独 allocation，8 人 mesh 大约需要 56 个，默认容量面向小规模部署。

`.env` 中可调整 `TURN_MAX_ALLOCATIONS`、`TURN_BYTES_PER_SECOND`。增加中继端口范围时，同时修改 Compose 中 `TURN_MIN_PORT`、`TURN_MAX_PORT`、`ports` 映射、Dockerfile 声明及防火墙，保持容器与公网端口一致。UDP/TCP/TLS 共用 allocation 上限和全局入站配额；TCP/TLS 共用 `TURN_MAX_CONNECTIONS`（默认 128），含未认证与握手中的连接，每个来源 IP 每个流入口最多 64 个。帧头空闲限时 120 秒、帧体读取与 TLS 握手限时 10 秒、发送限时 5 秒。内置服务还限制每个来源 IP 的控制请求与包速率、总入站速率；多个玩家共享同一 NAT 时共用来源 IP 配额。

内置服务拒绝向内网、回环、共享地址、组播和云元数据地址中继；同一服务的活动中继端口通过内部路由互通，无需公网 NAT hairpin。临时凭证一小时有效，每 15 秒清理已过期凭证对应的 allocation；客户端持续通话会刷新凭证和重新协商。

**内置 TURN 支持 UDP、TCP、TLS 客户端入口，目前仅支持 IPv4 UDP 媒体 allocation。** 客户端封锁 UDP 时可选择 TCP/TLS；服务器仍必须开放 UDP 中继范围。外部服务可作为其他地域或网络能力的补充，见 [语音指南](VOICE.md)。HTTPS 加密的是网页和信令；WebRTC 音频本身仍使用 DTLS-SRTP，普通 `turn:` 不代表明文音频。

## 7. 运维与迁移

```sh
# 查看日志
docker compose logs -f --tail=100 game caddy
# 更新源码并重建
git pull --ff-only
docker compose up -d --build
# 停止，保留 HTTPS 证书卷
docker compose down
```

启用 TLS 后，运维命令应始终包含两个 Compose 文件，或在 `.env` 配置 `COMPOSE_FILE=compose.yaml:compose.tls.yaml`，否则重新创建游戏时会移除 TLS 配置。

升级和重新创建游戏容器会断开内置中继，房间从 `game_data` 卷内的 `/data/state.json` 恢复。不要使用 `down -v` 删除游戏与证书卷；按需保护 `.env`、`game_data` 和 Caddy 数据卷。状态文件包含手牌和访客凭证，不要公开。回滚到不支持持久化的旧版本不能恢复房间。内置 TURN 与游戏在同一进程，不能独立重启中继。

从旧的独立 coturn 部署迁移时，更新代码前先停止旧 TURN 服务，释放 3478 和中继端口，再设置新 `.env`。删除不再使用的旧 `VOICE_TURN_URLS` / `VOICE_ICE_SERVERS`，避免向浏览器发布过期入口；保留至少 32 字节密钥可继续使用。旧的 `deploy/turnserver.conf` 不再读取，请自行安全保存或删除。

证书失败、502、房间连接问题可参考 [总部署指南](README.md)；语音不通优先检查 UDP 端口、安全组、真实公网 IP、DNS-only 配置，以及客户端是否封锁 UDP。
