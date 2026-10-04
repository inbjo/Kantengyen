# 房间语音与内置 TURN

2–6 人房间语音使用 WebRTC audio mesh，每对成员独立协商。Rust 的 `/api/voice` WSS 只转发同房间、在线且主动开启语音成员的信令；浏览器使用 DTLS-SRTP 传输音频。直连时音频在浏览器间传输，使用内置 TURN 时加密媒体包经过同一个 Rust 服务进程转发。服务没有录音功能。

公网 Docker 部署参见 **[Docker 公网部署页](DOCKER.md)**：只启动游戏与 Caddy，TURN 已内置，无需另外部署 coturn。

## 玩家操作

点击牌桌“房间语音”，再点击“开启房间语音”并允许麦克风。可分别静音麦克风和扬声器，折叠面板不会退出通话。退出、游戏结束、断线与页面关闭会释放麦克风及连接；刷新后需要主动重新开启，不会自动申请麦克风。

麦克风需要可信 HTTPS，本机 `http://127.0.0.1` 可用于测试，普通局域网 HTTP 不满足安全上下文要求。Caddy 的 `Permissions-Policy` 允许 `microphone=(self)`；其他代理/CDN 不应返回 `microphone=()`。参考 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## 内置 TURN 配置

直接运行二进制时默认 `TURN_ENABLED=false`，本地开发不占用额外端口。Compose 公网部署默认启用，必须配置服务器真实公网 IPv4。

```sh
export TURN_ENABLED=true
export TURN_PUBLIC_IP='你的服务器真实公网IPv4'
export TURN_PUBLIC_HOST='turn.your-domain.com'
# 可选：至少 32 字节随机共享密钥；留空则每次启动自动生成
export VOICE_TURN_SECRET='你生成的长随机密钥'
export VOICE_ICE_POLICY=all
BIND_ADDR=127.0.0.1:3000 ./kantengyen-server
```

域名 A 记录指向该公网 IP。`TURN_PUBLIC_HOST` 可省略，客户端会使用公网 IP。不需手写内置 STUN/TURN URL；后端自动下发 `stun:host:3478` 与 `turn:host:3478?transport=udp`。实际分配的中继候选使用 `TURN_PUBLIC_IP`。

默认放行 **3478 UDP、49160–49200 UDP**，NAT 必须按原端口映射；Caddy 只代理 HTTPS/WSS，不能代理 TURN UDP。宿主机二进制可通过 `TURN_RELAY_IP` 绑定特定本地网卡，默认 `0.0.0.0`。Docker 应保持容器内 `0.0.0.0`，不要绑定宿主机公网/内网 IP。

| 变量 | 默认值 | 含义 |
| --- | --- | --- |
| `TURN_ENABLED` | 原生 `false`，Compose `true` | 是否启动内置服务 |
| `TURN_PUBLIC_IP` | 无 | 启用时必填，服务器真实公网 IPv4 |
| `TURN_PUBLIC_HOST` | 公网 IP | 客户端访问 TURN 的域名或 IPv4 |
| `TURN_BIND_ADDR` | `0.0.0.0:3478` | 本地 UDP 监听地址 |
| `TURN_RELAY_IP` | `0.0.0.0` | 分配中继 socket 的本地网卡地址 |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | `49160` / `49200` | 包含两端的中继端口范围 |
| `TURN_MAX_ALLOCATIONS` | `32` | 同时存在的 allocation 数量上限，最多 1024 |
| `TURN_BYTES_PER_SECOND` | `128000` | 单个 allocation 每方向带宽上限，字节/秒 |
| `VOICE_TURN_SECRET` | 启用内置时自动生成 | 至少 32 字节；密钥不下发浏览器 |
| `VOICE_ICE_POLICY` | `all` | `all` 优先直连，`relay` 强制中继 |

Compose 固定映射默认 UDP 范围。修改原生端口配置时也要同步防火墙；修改容器范围时需要一起修改 Compose 的环境变量与 `ports` 映射。相同服务的中继 allocation 在进程内映射到已分配的本地 UDP 端口，可支持云 NAT 和容器桥接网络，无需同机客户端访问服务器公网 IP 的 hairpin 功能。

systemd 部署将上述变量写入 `/etc/kantengyen.env`，不加 `export`，然后重启服务。Compose 从根目录 `.env` 读取；直接运行二进制不会自动加载 `.env`。

## 认证与资源限制

Rust 服务给开启房间语音的玩家签发一小时有效的 `到期时间:玩家UUID` 和 HMAC-SHA1 临时凭证，中继验证 realm、玩家 UUID、到期时间及消息完整性。持续通话每二十分钟更新 ICE 配置并重新协商。过期凭证不能继续认证，维护任务每 15 秒移除其活动 allocation；主动退出后的 allocation 也会通过客户端关闭/协议生命周期回收。

全局 allocation 上限和有限 UDP 端口限制并发；单个 allocation 双向分别限制带宽。拒绝向内网、回环、共享地址、组播、云元数据及非 IPv4 目标转发；同机特殊路由只允许已分配的中继端口，不能访问其他本机服务。监听入口限制来源 IP 控制请求/数据包速率与总入站字节数，认证 nonce 缓存限制为 4096 并清理过期项。

目前没有按账号计费或强账号认证，公网运营仍应监控服务器带宽、CPU、内存和请求量。UDP 泛洪超出进程能处理的范围时，需要云平台/网络层防护；房间与语音仍面向小规模部署。

## 网络能力与外部 TURN

内置 [`turn` 0.17.2](https://docs.rs/turn/0.17.2/turn/server/index.html) 本版支持 **IPv4/UDP**。未实现 TURN/TCP、TURN/TLS 或 IPv6；客户端网络完全禁止 UDP 时，可接入外部 TURN/TCP/TLS 服务作补充。

使用支持临时凭证的外部服务时配置：

```sh
# 仅用外部服务时禁用内置 TURN；同时使用时保留 TURN_ENABLED=true
export TURN_ENABLED=false
export VOICE_TURN_URLS='turn:turn.your-domain.com:3478?transport=tcp,turns:turn.your-domain.com:5349?transport=tcp'
export VOICE_TURN_SECRET='与外部TURN服务配置一致的至少32字节共享密钥'
```

同时使用内外 TURN 时共用 `VOICE_TURN_SECRET`，必须与外部服务相同。外部 URL 不为空时必须显式配置共享密钥，不能使用内置自动生成的密钥。只有供应商静态账号时，改用 `VOICE_ICE_SERVERS` JSON，其中 `urls`、`username`、`credential` 会交给浏览器；不要放入供应商管理 API 密钥。

## 验证

```sh
cargo test --workspace --locked
# 需要另一个终端启动游戏服务
npm run test:voice
npx playwright install chromium
npm run test:ui -- --grep 'WebRTC|microphone permission'
```

Rust 测试运行实际 UDP STUN/TURN：验证错误密码被拒绝、凭证过期检查、分配与双向转发、地址/端口范围、并发限额、内网地址限制、带宽预算与关闭释放。浏览器测试使用模拟麦克风，验证实际 inbound RTP、静音、重入及结束清理，不采集机器真实麦克风。

以 `VOICE_ICE_POLICY=relay` 启动配置好的内置服务，再设置 `EXPECT_TURN_RELAY=1` 运行三人语音测试，会额外检查每个已选 candidate-pair 的本地与远端候选均为 relay。

本机自动测试不能证明公网防火墙或运营商路径可达。上线时仍需两台设备在 Wi-Fi 与移动网络之间强制 relay，确认实际双向声音与 RTP 数据后恢复 `all`。部署步骤和排障见 [Docker 公网部署页](DOCKER.md)。
