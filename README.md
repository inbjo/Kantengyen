# 干瞪眼 · 再来一把

手机横屏优先的多人扑克网页游戏。React + TypeScript、Rust + Axum / Tokio、Rust 编译的浏览器 WASM。支持 PC、平板，以及手机竖屏备用布局。

## 功能

- 首次访问可选新手练习，也可跳过；以后随时可以重练。
- 三局预设手牌教学：单张和 2、顺子、炸弹与万能牌。两位机器人按照同一套 Rust 规则游玩，练习没有出牌时限。教学局只使用部分牌和八张补摸牌，让每课尽快结束；多人局使用完整 54 张牌。
- 自动随机名字和 Multiavatar 头像，可以分别重新随机或手动改名；身份保存在当前标签页，刷新保留，新标签页独立入座。
- “自动过牌”默认勾选，可在牌桌取消并记住选择。服务器确认没有任何合法接牌后，页面稍停 0.8 秒自动过牌；有牌可接或轮到领出时不会自动跳过。
- 房主皇冠标记；炸弹、深水炸弹、2、顺子、对子有轻量出牌特效，过牌和重连不会重复播放。遵循系统减少动态效果设置。
- Web Audio 合成出牌音效，不下载额外音频；首次点击后解锁，可在顶部静音并记住设置。
- 浏览器出牌播报：牌桌“播报开/关”独立控制并记住偏好，服务器确认的新出牌才播报，首次快照、刷新和重复快照不重播；优先使用设备中文声音，无中文声音或 API 不可用时静默降级，不影响普通音效和房间通话。后台页面不播报，新牌会打断旧播报，避免积压。音色和可用性取决于浏览器/设备，并非统一配音；播报文字与播放逻辑独立，后续可替换录制音频。
- 房间语音：主动开启麦克风、麦克风/扬声器静音、成员连接状态、退出及断线清理；HTTPS/WSS + WebRTC 音频 mesh，同房间成员信令校验，支持 TURN 临时凭证。
- 2–6 人创建或加入房间，服务端分配 1000–9999 的四位随机号，并检查碰撞；支持邀请链接。
- 准备、开始、出牌、过牌、提示、积分结算、下一局、房主转移。
- 房主可随时确认“结束游戏”，所有玩家进入总计分页面，展示排名、累计分数和已完成局数；未完成的一局不计分。结束后不能继续开局或加入新玩家，原玩家可刷新查看或返回大厅；总计分不因其他玩家退出而改变。
- 30 秒出牌时限，超时自动过牌；自由领出时超时自动出一种合法牌。
- WebSocket 断线重连和刷新后返回原座位。服务器只向客户端发送本人的手牌。
- WASM 选牌提示与后端共享 Rust 规则；服务端始终进行最终校验。

## 快速开始

需要 **Node.js 22+、Rust 1.96.1+**（项目使用 Rust 2024 edition）。在仓库根目录执行：

```sh
rustup target add wasm32-unknown-unknown
npm ci
npm run build
cargo run --locked -p kantengyen-server
```

打开 **http://127.0.0.1:3000**。Windows PowerShell 如果无法运行 npm.ps1，可将命令中的 `npm` 换成 `npm.cmd`。创建房间后，在新标签页或其他设备打开邀请链接；刷新当前标签页可返回原座位。

前端与 WASM 在编译时内嵌到服务端，首次运行 Cargo 前必须先构建前端。修改前端后重新执行 `npm run build` 并重新编译服务端。开发时保持 Rust 服务运行，在另一个终端执行 `npm run dev`；Vite 将 `/api` 和 WebSocket 请求代理到本地 3000 端口。

局域网测试：Linux/macOS 使用 `BIND_ADDR=0.0.0.0:3000 cargo run --locked -p kantengyen-server`；PowerShell 先执行 `$env:BIND_ADDR='0.0.0.0:3000'`。其他设备访问 `http://电脑局域网IP:3000`，需放行防火墙。房间语音在手机上需要可信 HTTPS。

仓库默认使用官方 npm、Cargo 和 Rust 下载源；如需镜像，请在个人开发环境配置。`Cargo.lock` 与 `package-lock.json` 应保留，以便复现依赖。

## 构建与部署

无需在运行服务器上安装 Node.js、Rust 或复制前端文件。发布产物为 **Linux x64 静态二进制**，内含 HTML/CSS/JS 和 WASM。

```sh
# Docker 构建，支持 Windows 上的 Linux 容器
npm run build:release
# Linux x64 本机构建，需要 Rust/rustup 和 musl-tools
npm run build:release -- --native
npm run verify:static
```

输出位于 `dist/`，包含服务端、SHA-256 校验及许可证。

[GitHub Actions 构建任务](.github/workflows/build.yml) 在 push、pull request 和手动触发时执行：构建前端/WASM/静态服务端，检查 Rust 格式与测试、内嵌资源、游戏和语音信令，再上传 `kantengyen-server-linux-x64` 压缩包。产物在 Actions 运行详情页下载，保留 30 天，不自动发布 Releases。压缩包内保留可执行权限；Artifact 的下载与保留规则见 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。

完整步骤见 **[部署指南](deploy/README.md)**，涵盖二进制安装、校验、systemd、Caddy HTTPS、Docker Compose、配置、升级回滚和排障。跨网络语音见 **[TURN / 语音部署](deploy/VOICE.md)**。

## 开发与验证

```sh
npm ci
npm run build
cargo fmt --all -- --check
cargo test --workspace --locked
cargo build --locked -p kantengyen-server
npm run test:build
# 下列测试需另一个终端运行 cargo run --locked -p kantengyen-server
npm run test:e2e
npm run test:voice
# UI 测试首次使用需安装浏览器
npx playwright install chromium
npm run test:ui
```

可通过 `PLAYWRIGHT_EXECUTABLE_PATH` 指定兼容 Chromium。UI 测试使用模拟麦克风；截图与失败追踪存放在忽略的 `test-results/`。

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `crates/game-core/` | Rust 游戏规则、计分、测试与 WASM 导出 |
| `crates/server/` | Axum API、WebSocket、房间、语音信令、内嵌资源 |
| `web/` | React + TypeScript 界面和浏览器语音 |
| `scripts/` | WASM、发布构建和静态 ELF 校验 |
| `tests/` | 游戏/语音集成测试、内嵌资源及 Playwright UI 测试 |
| `deploy/` | 部署文档、Caddy/systemd/coturn 配置 |
| `.github/workflows/` | GitHub Actions 服务端构建任务 |
| `licenses/` | 随发布产物保留的第三方许可证 |

生成的 `target/`、`node_modules/`、`dist/`、`web/dist/`、`rules.wasm` 和测试报告不提交。真实 `.env`、私钥及本地缓存由忽略规则排除；从 `.env.example` 创建部署配置。

## 验证版的规则选择

玩法以 erizhang/Kantengyen 的 README 为参考，独立编写实现，没有复制该仓库代码或资源。以下是为缺失边界明确选择的 v1 规则，并非所有地区通行规则：

- 一副 54 张：52 张普通牌 + 小王、大王两张万能牌。牌面大小为 3 至 A、2。按显示座位顺序行动，庄家 6 张、其余 5 张。
- 单张和对子只接相同牌型大一级；2 可以接任意较小的同型单张或对子。2 不能进入顺子，不能压炸弹。
- 顺子至少三张，至多十二张，范围 3–A；接牌长度相同且起点大一级。
- 三张同点数为炸弹，四张为深水炸弹；深水炸弹大于普通炸弹，同级炸弹比较点数，不要求只大一级。
- 万能牌必须和至少一张普通牌一起使用，可配对子、顺子、炸弹；不允许纯万能牌组合。歧义组合优先解释为炸弹，其次选择能压上家的顺子起点。
- 其他人都过牌后，最后出牌者摸一张再领出；牌堆耗尽后直接领出。若领出者只剩万能牌，继续补摸到普通牌为止；牌堆空且仍只剩万能牌则和局，积分不变。
- 每张剩余手牌底分 1，三张炸弹累计 ×2、深水炸弹累计 ×4；关死 ×2；庄家首次出牌一手出完六张为天胡，负方再 ×2；赢家获得负方扣分之和。
- 多人局庄家按座位轮换；练习每局由本人先出，三课结束后允许继续练习。

## 当前限制

房间和身份存放在服务进程内存中，服务重启后全部清空。已支持浏览器断线和刷新恢复，尚未实现进程重启恢复。没有数据库、账号系统或跨实例房间路由，当前应部署一个服务实例。

空闲房间一小时后回收；访客身份一天不使用后过期。四位房间号用于邀请，不是访问密码。本局进行时座位保留，允许暂时离开；正式退出需要等本局结束。

公网长期运行前，需要按实际规模补齐持久化、入口限流和监控。维护前告知玩家，升级和回滚都会清空现有房间。

## 房间语音

已实现 WebRTC 音频 mesh，独立语音信令连接不改变牌桌版本、不打断选牌，只有同房间且在线、主动开启语音的玩家能互相协商。结束游戏或离开会释放麦克风，刷新不自动开启。

正式 HTTPS 部署仍需要配置自建或授权使用的 STUN/TURN；默认不使用任何第三方公共服务，仅支持可直连网络测试。支持 `VOICE_TURN_URLS` + `VOICE_TURN_SECRET` 生成 coturn 临时凭证，或 `VOICE_ICE_SERVERS` JSON；可用 `VOICE_ICE_POLICY=relay` 强制中继。部署步骤、配置模板、网络端口和验证方法见 [deploy/VOICE.md](deploy/VOICE.md)。扩到更大房间时再考虑 SFU。

## 许可证与第三方

头像使用 `@multiavatar/multiavatar` 在浏览器本地生成，无需头像 API。界面不显示来源提示，依赖许可与作者说明保留在 `THIRD_PARTY_NOTICES.md`。

本项目原创代码以 [MIT License](LICENSE) 开源。第三方依赖保留各自许可证，MIT 不覆盖或替代它们；完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)，Multiavatar 许可证见 [licenses/Multiavatar-LICENSE.txt](licenses/Multiavatar-LICENSE.txt)。分发服务端或容器时请一并保留许可证和第三方声明。
