# 房间语音部署

实现为 2–6 人 WebRTC 音频 mesh：麦克风必须由玩家主动开启，Rust 的独立 `/api/voice` WebSocket 仅转发同房间已开启语音成员的信令。HTTPS 下自动使用 WSS，已有 Caddy 配置无需新增路由。音频不会经过游戏服务，也没有录音功能；使用 TURN 时音频会经过中继。

Caddy 的 `Permissions-Policy` 已允许本站使用麦克风（`microphone=(self)`），摄像头仍禁用。已有部署需要同步更新该配置并重新加载 Caddy；其他反向代理/CDN 也不能返回 `microphone=()`，否则即使 HTTPS 和用户权限正常，浏览器仍会拒绝采集音频。

## 玩家操作

牌桌顶部“语音”打开控制面板，点击“开启房间语音”并允许麦克风。支持麦克风静音、扬声器静音、退出语音；折叠面板不退出通话。只申请音频，不申请摄像头。房间结束、暂时离开、掉线、标签页关闭都会清理连接和麦克风；刷新不自动申请或恢复麦克风，需要重新开启。

HTTPS 满足麦克风安全上下文要求，本机 `http://127.0.0.1` 也可测试。普通局域网 HTTP 不支持麦克风。参考 [MDN getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## 公网需要 STUN/TURN

不配置时 `iceServers=[]`，仅供本机/可直连网络测试。HTTPS 不等于可以穿透 NAT，正式部署需要自建或获得授权的 STUN/TURN。不能仅凭本机联通测试保证移动网络联通。协议和协商模式参考 [MDN WebRTC signaling](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Signaling_and_video_calling) 与 [perfect negotiation](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Perfect_negotiation)。

推荐通过 coturn 的共享密钥签发临时凭证，密钥只存在于游戏服务和 coturn，不下发前端：

```sh
export VOICE_TURN_URLS='turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp'
export VOICE_TURN_SECRET='与coturn的static-auth-secret一致的长随机密钥'
# 可选配置自有 STUN
export VOICE_ICE_SERVERS='[{"urls":"stun:turn.example.com:3478"}]'
# all 优先直连；relay 强制中继，避免向其他玩家提供直接连接候选地址
export VOICE_ICE_POLICY=all
BIND_ADDR=127.0.0.1:3000 ./kantengyen-server
```

Compose 部署时在根目录 `.env` 中设置同名变量即可，不能把密钥提交到仓库。浏览器仅获得一小时有效的 TURN 用户名和 HMAC-SHA1 凭证；持续通话每二十分钟刷新配置并重新协商 ICE。实现遵循 [coturn 的临时凭证机制](https://github.com/coturn/coturn/blob/master/README.turnserver)。

如果供应商只支持静态用户名/密码，可使用 `VOICE_ICE_SERVERS` 的 TURN 项（`urls`、`username`、`credential`），但这些凭证会交给浏览器，不能把供应商管理 API 密钥或共享密钥放进去。推荐临时凭证而非长期通用密码。

## 自建 coturn

### Docker Compose 快速部署

仓库提供独立的 [compose.turn.yaml](../compose.turn.yaml)，可以和游戏运行在同一台 Linux 服务器，也可以单独部署。使用官方 `coturn/coturn:4.18.0-r0` 固定版本和 host 网络，参见 [coturn 官方 Docker 文档](https://github.com/coturn/coturn/blob/master/docker/coturn/README.md)。host 网络直接使用宿主机端口，适用于 Linux；这里不以 Docker Desktop 作为公网部署环境。

1. 设置 `turn.example.com` 的 DNS A 记录指向 TURN 服务器的公网 IPv4。这是独立域名，可以与游戏域名指向同一 IP。若没有部署 IPv6，不要设置 AAAA 记录。
2. 在 Linux 部署机克隆仓库，用 Node.js 22+ 生成配置（替换为实际域名/IP）：

```sh
npm run setup:turn -- --domain turn.example.com --public-ip 203.0.113.10
# 云主机网卡只有内网 IP 时，改用下面的命令（两者选一）：
# npm run setup:turn -- --domain turn.example.com --public-ip 203.0.113.10 --private-ip 10.0.0.10
```

脚本生成 256 位随机共享密钥，写入 `deploy/turnserver.conf` 与 `.env`，不输出密钥；同步设置 STUN/TURN URL 和 coturn 运行 UID/GID。文件在 Linux 下为 `0600`，已在 Git/Docker 忽略列表中。现有 `.env` 的游戏域名及其他变量保留，ICE server 列表和 TURN URL/密钥更新为这台 coturn；已有 coturn 配置时拒绝覆盖，避免误轮换密钥。配置使用实际网卡用户的 UID/GID，容器才能读取私有配置；如果之后变更文件所属用户，更新 `.env` 中的 `COTURN_UID`、`COTURN_GID`。在 Windows 生成后复制到 Linux 时，也需按文件实际所有者设置这两个值。

3. 放行云安全组和主机防火墙的 **3478 UDP/TCP、49160–49200 UDP**，允许中继出站。Ubuntu/UFW 示例（已启用 UFW 时执行）：

```sh
sudo ufw allow 3478/udp
sudo ufw allow 3478/tcp
sudo ufw allow 49160:49200/udp
```

`203.0.113.10` 是文档示例地址，不能直接使用。host 网络不需要 Compose `ports` 映射；NAT/云公网 IP 映射必须覆盖这些端口。

4. 在仓库根目录启动并查看日志：

```sh
docker compose -f compose.turn.yaml config --quiet
docker compose -f compose.turn.yaml up -d
docker compose -f compose.turn.yaml ps
docker compose -f compose.turn.yaml logs -f --tail=100 coturn
# 游戏使用同一仓库的 Compose 时，重新创建游戏容器以加载 .env
docker compose up -d game
```

游戏容器重建会清空房间，请在无对局时操作。coturn 使用 stdout 日志，无需数据库持久化；配置由宿主机提供。游戏服务与 coturn 可以独立更新。

游戏若使用 systemd 二进制部署，将 `.env` 中 `VOICE_ICE_SERVERS`、`VOICE_TURN_URLS`、`VOICE_TURN_SECRET` 的值写入 `/etc/kantengyen.env`。JSON 值应使用 systemd 的单引号包围，例如 `VOICE_ICE_SERVERS='[{"urls":"stun:turn.example.com:3478"}]'`，避免双引号被移除；其他变量按部署指南设置。执行 `sudo systemctl restart kantengyen`。

如果 coturn 在另一台服务器，只将游戏需要的 `VOICE_*` 配置通过安全方式同步到游戏机，不要向浏览器或仓库公开共享密钥。

5. 按下文“验证”执行跨网络设备测试。可以临时将游戏配置 `VOICE_ICE_POLICY=relay` 并重启游戏，确认 TURN 中继成功后恢复 `all`。生成脚本保留已有策略，不会自动改变这个值。

### 手动配置与 TLS

`turnserver.conf.example` 是配置模板，必须替换域名、密钥、公网 IP。建议独立域名，TURN 和 Caddy 可在不同服务器，不能把普通 HTTP 反向代理当作 TURN 代理。

需要放行 3478 UDP/TCP 与配置的 UDP relay 端口（模板为 49160–49200）。限制较多的网络可额外配置 `turns:域名:5349?transport=tcp`，需要 coturn 使用有效 TLS 证书并开放 5349；若使用 TCP 443，需要独立 IP/部署规划，不能和同 IP 的 Caddy HTTPS 监听直接冲突。

coturn 若位于 NAT 后，需要正确配置 `external-ip=公网IP/内网IP` 并映射 relay 端口。检查防火墙、云安全组与 egress。请设置分配数量和带宽限制，避免临时凭证被滥用；本游戏匿名身份不等同于强账号认证，公网长期运行还需按 IP 的入口限流与监控。

默认模板只启用 `turn:` UDP/TCP，未启用 `turns:` TLS；网页的 HTTPS 与 TURN TLS 是不同配置。需要 TLS 时移除 `no-tls`，设置 `tls-listening-port=5349`、`cert`、`pkey`，给 coturn 容器增加只读证书挂载，确保运行 UID/GID 能读证书，再开放 5349 TCP，添加 `turns:turn.example.com:5349?transport=tcp` 到游戏 URL。证书续期后重启 coturn；它不会自动读取 Caddy 数据卷中的证书。

### Rust 内嵌方案

Rust 有可嵌入的 [`turn` crate](https://docs.rs/turn/latest/turn/server/index.html)，提供 TURN `Server`，可以与 Tokio 游戏服务集成；另有独立的 [`turn-rs`](https://github.com/mycrl/turn-rs) 服务。纯 Rust 不会消除公网地址、NAT 映射、中继端口或带宽需求。

当前项目的 Rust 服务已经实现 coturn 临时凭证签发与房间信令，尚未内嵌 TURN 转发。选择独立 coturn 是当前工程取舍：凭证机制可以直接使用现有实现，中继带宽和游戏逻辑可独立管理，重启游戏服务不必同时重启 TURN。若后续内嵌 Rust TURN，还需实现认证回调、临时凭证过期校验、内部网段访问限制、配额、TLS、生命周期及真实设备兼容性验证，不能仅添加一个依赖就替代这些工作。

## 验证

```sh
npm run test:voice
npm run test:ui -- --grep 'WebRTC|microphone permission'
```

浏览器测试使用模拟麦克风（不采集机器真实麦克风），检查多人 mesh 和实际 inbound RTP 音频包、静音、重新加入、结束后 track.stop/连接清理，以及权限拒绝。

上线前必须用两台真实设备，在 Wi-Fi 与移动网络之间验证；临时设置 `VOICE_ICE_POLICY=relay`，通过浏览器 WebRTC 诊断确认 candidate-pair 为 relay，证明 TURN 确实工作，再恢复所需策略。当前仓库没有公网 TURN 地址/凭证，测试不能验证你的中继线路或手机听感。
