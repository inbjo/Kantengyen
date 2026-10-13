# 2026-10-13 生产部署

目标：`root@moyu.ge` 的 `kantengyen.service`，公网 `https://kantengyen.moyu.ge`。

按用户要求直接覆盖旧程序，未创建程序、配置或状态备份。现有 systemd 配置、环境文件、TURN 配置和 `/var/lib/kantengyen/state.json` 保留。

## 构建与覆盖

```bash
CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
RUSTFLAGS='-C target-feature=+crt-static -C link-self-contained=yes' \
cargo build --locked --release -p kantengyen-server --target x86_64-unknown-linux-musl
node scripts/verify-static.mjs target/x86_64-unknown-linux-musl/release/kantengyen-server
```

Linux x64 静态 ELF 校验通过，无动态链接器或共享库依赖。上传新程序并校验 SHA-256 后，停止服务，直接原位替换 `/opt/kantengyen/kantengyen-server`，保持 `root:root`、`0755`，启动服务。

部署 SHA-256：`ed81b2db47a4d853b70fe9be767c7bc584525b23ef040b5373ed1145e0e1db8f`。

服务启动时间：2026-10-13 00:54:45 UTC（台北时间 08:54:45），PID `3721414`。systemd 为 `active/running`，本机 `127.0.0.1:3001/api/health` 返回 `200`、`ok=true`，线上程序哈希与本地产物一致。状态文件格式 1、访客身份 10 个、房间 0 个，在重启前后保持；TURN UDP/TCP 随新程序正常启动。

## 验证

本地实现验证与 3,218,920 局模拟结果见 [策略实验报告](strategy-experiments.md)。线上页面资源及真实对局验证结果见随附 `production-verification.json`。

公网首页、JS、CSS、WASM 和 Service Worker 均与本地构建匹配。已移除的催牌音频返回 404，Chrome 页面无运行错误。真实两人桌（一个机器人、一位托管玩家，赢家先手、一局结束）完成结算，两方均实际出牌，累计得分零和；观察到自动回合剩余等待约 913–1915 毫秒。测试结束后已退出并清理测试房间。
