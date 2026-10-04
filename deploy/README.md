# 部署指南

服务端内嵌前端和规则 WASM，不需要数据库或 Node.js 运行环境。发布构建目前仅支持 **Linux x86_64（amd64）**，ARM64 机器不能直接运行。房间、身份、手牌和积分全部存放在内存中；每次重启、升级或回滚都会清空，建议在无对局时维护。部署一个游戏服务实例即可。

## 方式一：下载每夜版或 CI 二进制

1. 在 [nightly Release](https://github.com/inbjo/Kantengyen/releases/tag/nightly) 下载 `.tar.gz` 和 `.sha256` 两个附件。每次推送默认分支并通过验证后覆盖同名附件；发布说明记录源码提交与构建链接。该 Release 是预发行，历史每夜版不会保留，需回滚时请自行备份旧包。
2. 也可在 **Actions → Build server → 成功的运行 → Artifacts** 下载 `kantengyen-server-linux-x64`，解压 ZIP 得到上述两文件。各次构建的 Actions 产物保留 30 天，包括其他分支和 PR 的构建。将两文件复制到 Linux x64 服务器临时目录。
3. 校验并解包（校验失败时不要继续安装）：

```sh
sha256sum -c kantengyen-server-linux-x64.tar.gz.sha256
mkdir -p kantengyen-release
tar -xzf kantengyen-server-linux-x64.tar.gz -C kantengyen-release
cd kantengyen-release
sha256sum -c SHA256SUMS
chmod +x kantengyen-server
BIND_ADDR=127.0.0.1:3000 ./kantengyen-server
```

也可以直接下载固定 URL：

```sh
curl -fLO https://github.com/inbjo/Kantengyen/releases/download/nightly/kantengyen-server-linux-x64.tar.gz
curl -fLO https://github.com/inbjo/Kantengyen/releases/download/nightly/kantengyen-server-linux-x64.tar.gz.sha256
sha256sum -c kantengyen-server-linux-x64.tar.gz.sha256
```

如果下载过程中发生覆盖更新导致校验失败，重新下载两个文件。`nightly` 发布 job 使用内置 `GITHUB_TOKEN` 的 `contents: write` 权限，无需新增 PAT；仓库规则若禁止更新该标签，需要为滚动 `nightly` 标签配置允许的规则。

另开终端执行 `curl -fsS http://127.0.0.1:3000/api/health`，应返回成功响应。程序默认监听 `127.0.0.1:3000`。临时局域网测试可设置 `BIND_ADDR=0.0.0.0:3000` 并放行 3000；公网建议通过 HTTPS 代理访问。

### systemd 常驻运行

以下适用于使用 systemd 的 Linux。先停止上面的前台测试进程，并从仓库取得 `deploy/kantengyen.service`：

```sh
# 创建专用用户（只在首次部署执行）
sudo useradd --system --user-group --home-dir /opt/kantengyen --shell /usr/sbin/nologin kantengyen
sudo install -d -m 755 /opt/kantengyen
sudo install -m 755 kantengyen-server /opt/kantengyen/kantengyen-server
sudo cp -r LICENSE THIRD_PARTY_NOTICES.md licenses /opt/kantengyen/
# 在仓库根目录执行下面的 unit 安装命令
sudo install -m 644 deploy/kantengyen.service /etc/systemd/system/kantengyen.service
sudo install -m 600 /dev/null /etc/kantengyen.env
sudoedit /etc/kantengyen.env
sudo systemctl daemon-reload
sudo systemctl enable --now kantengyen
sudo systemctl status kantengyen --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```

`/etc/kantengyen.env` 每行写 `变量=值`，不要加 `export`。没有语音中继时可以留空；已有文件不要再次执行创建空文件的命令，以免覆盖配置。日志和重启：

```sh
sudo journalctl -u kantengyen -f
sudo systemctl restart kantengyen
```

### 配置 HTTPS

把域名的 A 记录指向服务器公网 IPv4；如果有 AAAA 记录，IPv6 也必须能访问这台服务器。放行防火墙和云安全组的 TCP 80、443；UDP 443 可用于 HTTP/3。游戏服务的 3000 保持仅监听本机。

按 [Caddy 官方安装文档](https://caddyserver.com/docs/install) 安装 Caddy，将仓库的 `deploy/Caddyfile.binary` 复制为 `/etc/caddy/Caddyfile`，把 `{$SITE_ADDRESS:play.example.com}` 改成实际域名，例如 `play.your-domain.com`。此模板用于宿主机二进制部署，代理到 `127.0.0.1:3000`。

```sh
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
curl -fsS https://play.your-domain.com/api/health
```

Caddy 自动申请和续期证书并代理 WebSocket。两台设备访问 HTTPS 地址，创建房间、打开邀请链接、完成一局并刷新，确认对局及重连正常。麦克风还需要下文的 TURN 配置。

## 方式二：Docker Compose

服务器需要 Docker Engine 和 Compose 插件，支持 Linux amd64 容器；首次构建会下载 Rust、Node.js 和依赖。**完整操作步骤见 [Docker 公网部署页](DOCKER.md)**，包含游戏与内置 TURN、域名、端口和强制中继验证。克隆仓库后，在仓库根目录执行：

```sh
cp .env.example .env
# 编辑 .env，设置真实 SITE_ADDRESS 和服务器 TURN_PUBLIC_IP
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs -f --tail=100 game caddy
curl -fsS https://你的域名/api/health
```

HTTPS 域名和端口要求与上面相同，还需放行 3478 UDP/TCP 和 49160–49200 UDP；启用 TLS 时另放行 5349 TCP；TURN 由同一个游戏容器内的 Rust 服务运行，直接发布 TURN TCP/TLS 入口与 UDP 中继端口。Compose 的 `deploy/Caddyfile` 代理到容器服务名 `game:3000`，不要替换成宿主机模板。游戏容器以非 root 用户运行，3000 不映射到宿主机；Caddy 的证书保存在 `caddy_data`、`caddy_config` 卷中。

`.env` 仅用于 Compose 变量替换，直接运行二进制不会自动读取它。不要提交真实 `.env` 或 TURN 密钥。使用 `SITE_ADDRESS=localhost` 时 Caddy 使用本地证书，其他设备通常不信任它；公网部署应使用真实域名。

```sh
# 停止服务，保留证书卷
docker compose down
# 拉取新源码后重新构建并启动
docker compose up -d --build
```

不要在正常维护时使用 `docker compose down -v`，它会删除证书卷。

## 自行构建发布产物

在仓库根目录执行，需要 Node.js 22+：

```sh
# 使用 Docker 构建；Windows 需 Docker Desktop 的 Linux 容器
npm run build:release

# Linux x64 本机构建，需要 Rust/rustup 和 musl-tools
# Debian/Ubuntu: sudo apt-get install musl-tools
npm run build:release -- --native
npm run verify:static
```

本机构建脚本会执行 `npm ci`、安装 WASM/musl 目标、构建前端和服务端。Docker 模式在构建阶段安装依赖。输出位于 `dist/`，包括服务端、`SHA256SUMS`、MIT 许可证、第三方说明与头像许可证。脚本验证 ELF 架构，拒绝包含动态链接器或共享库依赖的产物。CI 使用 Rust 1.96.1、Node.js 24，压缩包保留二进制执行权限。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIND_ADDR` | `127.0.0.1:3000` | 服务监听地址；容器设置为 `0.0.0.0:3000` |
| `RUST_LOG` | `kantengyen_server=info,tower_http=info` | 日志过滤，例如 `kantengyen_server=debug` |
| `SITE_ADDRESS` | Compose 为 `localhost` | Caddy 域名，游戏进程不读取 |
| `VOICE_ICE_SERVERS` | `[]` | ICE server JSON 数组 |
| `VOICE_ICE_POLICY` | `all` | `all` 优先直连；`relay` 强制 TURN 中继 |
| `VOICE_TURN_URLS` | 空 | 逗号分隔的 `turn:` / `turns:` URL |
| `VOICE_TURN_SECRET` | 空 | 内置 TURN 自动生成，可指定至少 32 字节密钥；外部 TURN 需与其共享密钥一致 |
| `TURN_ENABLED` | 原生 `false`，Compose `true` | 内置 IPv4 STUN/TURN，支持 UDP/TCP/TLS |
| `TURN_PUBLIC_IP` | 无 | 启用内置 TURN 时必填，真实公网 IPv4 |
| `TURN_PUBLIC_HOST` | 公网 IP | 内置 TURN 对外域名或 IPv4 |
| `TURN_MAX_ALLOCATIONS` | `32` | 同时存在的中继 allocation 上限 |
| `TURN_BYTES_PER_SECOND` | `128000` | 每个 allocation 每方向带宽上限 |

## 房间语音

HTTPS 是麦克风使用条件，跨运营商或移动网络通话还需中继。Rust 服务已内置 TURN；Compose 默认启用，原生二进制需设置 `TURN_ENABLED=true` 和 `TURN_PUBLIC_IP`。ICE URL 自动生成，空的 `VOICE_TURN_SECRET` 会在启动时生成随机密钥。更多配置与限制见 [语音部署指南](VOICE.md)。TURN 不通过 Caddy 的 HTTP 代理转发。

`npm run setup:turn -- --domain turn.example.com --public-ip 公网IPv4` 可写入私有 `.env` 并保留/生成固定密钥，此辅助命令需要 Node.js 22+；没有 Node.js 时手动编辑配置即可。原生/systemd 启动不会读取 `.env`，应将对应变量写入 `/etc/kantengyen.env`。内置中继与游戏同进程，服务重启会同时关闭中继。

## 升级、回滚和运维

- 二进制升级：校验新产物，备份旧二进制，`sudo systemctl stop kantengyen` 后安装新文件及许可证，再启动服务并检查 `/api/health`。回滚同样先停止服务再恢复旧文件。保留 `/etc/kantengyen.env`。
- Compose 升级：保存当前源码版本，更新源码后执行 `docker compose up -d --build`；回滚到旧版本后重新构建。每次重新创建游戏容器都会丢失内存房间。
- 备份配置、TURN 密钥及 Caddy 数据卷；本项目没有可备份的对局数据库。使用外部监控定期检查 HTTPS `/api/health`，并监控进程退出、内存、CPU 和 TURN 带宽。
- 公网长期运营前，需要按实际规模补齐持久化、入口限流和监控。四位房间号方便邀请，不能当作密码；目前也没有账号鉴权或多实例房间路由。

## 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| `Exec format error` | 服务器必须是 Linux x64，不能直接用于 ARM64 或 Windows |
| `Permission denied` | 执行 `chmod +x`，并确认安装目录所在文件系统没有 `noexec` |
| 编译提示“前端未构建” | 先 `npm ci && npm run build`，再执行 Cargo 构建 |
| Caddy 返回 502 | 检查游戏服务是否启动、监听地址，以及所用 Caddy 模板的代理目标 |
| 证书申请失败 | 检查域名 A/AAAA、80/443 安全组和防火墙、端口占用、Caddy 日志 |
| 页面能打开但无法加入房间 | 检查反向代理/CDN 是否支持 WebSocket，查看浏览器网络面板和服务日志 |
| 手机麦克风不可用 | 使用可信 HTTPS，允许麦克风，检查 `Permissions-Policy` |
| 语音在同一 Wi-Fi 可用，移动网络不可用 | 检查内置 TURN 启用状态、公网 IP、3478 UDP 和中继端口；强制 `relay` 验证；客户端禁 UDP 时使用内置 TCP/TLS，检查相应入口与证书 |
| 更新后房间消失 | 当前内存存储的预期行为，需要重新创建房间 |
