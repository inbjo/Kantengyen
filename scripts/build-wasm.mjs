import { spawnSync } from "node:child_process";
import { mkdir, copyFile } from "node:fs/promises";
const result = spawnSync(
  "cargo",
  [
    "build",
    "--locked",
    "-p",
    "kantengyen-core",
    "--target",
    "wasm32-unknown-unknown",
    "--release",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
await mkdir("web/public", { recursive: true });
await copyFile(
  "target/wasm32-unknown-unknown/release/kantengyen_core.wasm",
  "web/public/rules.wasm",
);
console.log("Rust 规则 WASM 已生成 → web/public/rules.wasm");
