import { spawnSync } from "node:child_process";
import { mkdir, copyFile, readFile, writeFile, chmod, cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { verifyStaticElf } from "./verify-static.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist");
const args = process.argv.slice(2);
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: "inherit" });
  if (result.error) throw new Error(`无法运行 ${command}：${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} 构建失败（${result.status}）`);
}
function npm(args) {
  if (!process.env.npm_execpath) throw new Error("请通过 npm run build:release 调用构建脚本");
  run(process.execPath, [process.env.npm_execpath, ...args]);
}
try {
  if (args.some(arg => arg !== "--native")) throw new Error("用法：npm run build:release [-- --native]");
  await mkdir(output, { recursive: true });
  if (args.includes("--native")) {
    if (process.platform !== "linux" || process.arch !== "x64") throw new Error("--native 仅支持 Linux x64；其他系统请使用默认 Docker 构建");
    run("musl-gcc", ["--version"]);
    npm(["ci", "--ignore-scripts"]);
    run("rustup", ["target", "add", "wasm32-unknown-unknown", "x86_64-unknown-linux-musl"], {
      ...process.env,
    });
    npm(["run", "build"]);
    run("cargo", ["build", "--locked", "--release", "-p", "kantengyen-server", "--target", "x86_64-unknown-linux-musl"], {
      ...process.env,
      CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER: "musl-gcc",
      RUSTFLAGS: "-C target-feature=+crt-static",
    });
    await copyFile(resolve(root, "target/x86_64-unknown-linux-musl/release/kantengyen-server"), resolve(output, "kantengyen-server"));
  } else {
    run("docker", ["build", "--platform", "linux/amd64", "--target", "artifact", "--output", `type=local,dest=${output}`, "."]);
  }
  const binary = await readFile(resolve(output, "kantengyen-server"));
  verifyStaticElf(binary);
  await chmod(resolve(output, "kantengyen-server"), 0o755);
  const sha256 = createHash("sha256").update(binary).digest("hex");
  await writeFile(resolve(output, "SHA256SUMS"), `${sha256}  kantengyen-server\n`);
  await copyFile(resolve(root, "THIRD_PARTY_NOTICES.md"), resolve(output, "THIRD_PARTY_NOTICES.md"));
  await copyFile(resolve(root, "LICENSE"), resolve(output, "LICENSE"));
  await cp(resolve(root, "licenses"), resolve(output, "licenses"), { recursive: true });
  console.log(`构建完成：${resolve(output, "kantengyen-server")}（${(binary.length / 1024 / 1024).toFixed(1)} MiB）\n已验证 Linux x64 静态链接，前端和 WASM 已内嵌。`);
} catch (error) {
  console.error(`构建未完成：${error.message}\n默认方式需要 Docker（Linux 容器）；Linux x64 可安装 musl-tools 后使用 --native。`);
  process.exitCode = 1;
}
