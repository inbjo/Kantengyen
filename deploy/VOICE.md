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

`turnserver.conf.example` 是配置模板，必须替换域名、密钥、公网 IP。建议独立域名，TURN 和 Caddy 可在不同服务器，不能把普通 HTTP 反向代理当作 TURN 代理。

需要放行 3478 UDP/TCP 与配置的 UDP relay 端口（模板为 49160–49200）。限制较多的网络可额外配置 `turns:域名:5349?transport=tcp`，需要 coturn 使用有效 TLS 证书并开放 5349；若使用 TCP 443，需要独立 IP/部署规划，不能和同 IP 的 Caddy HTTPS 监听直接冲突。

coturn 若位于 NAT 后，需要正确配置 `external-ip=公网IP/内网IP` 并映射 relay 端口。检查防火墙、云安全组与 egress。请设置分配数量和带宽限制，避免临时凭证被滥用；本游戏匿名身份不等同于强账号认证，公网长期运行还需按 IP 的入口限流与监控。

## 验证

```sh
npm run test:voice
npm run test:ui -- --grep 'WebRTC|microphone permission'
```

浏览器测试使用模拟麦克风（不采集机器真实麦克风），检查多人 mesh 和实际 inbound RTP 音频包、静音、重新加入、结束后 track.stop/连接清理，以及权限拒绝。

上线前必须用两台真实设备，在 Wi-Fi 与移动网络之间验证；临时设置 `VOICE_ICE_POLICY=relay`，通过浏览器 WebRTC 诊断确认 candidate-pair 为 relay，证明 TURN 确实工作，再恢复所需策略。当前仓库没有公网 TURN 地址/凭证，测试不能验证你的中继线路或手机听感。
