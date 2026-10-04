import { spawnSync } from "node:child_process";
import { X509Certificate, createPrivateKey, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, chmod, chown } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
function docker(args) {
  const result = spawnSync("docker", ["compose", "exec", "-T", "caddy", ...args], { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("无法读取 Caddy 证书；请确认 Caddy 已运行且证书申请成功。");
  return result.stdout;
}
try {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--domain" || !/^[a-z0-9.-]+$/i.test(args[1])) throw new Error("用法：node scripts/export-turn-cert.mjs --domain play.example.com");
  if (process.platform !== "win32" && process.getuid() !== 0) throw new Error("请使用 sudo node 运行，以便把证书权限授予容器 UID 10001。");
  const domain = args[1].toLowerCase();
  const paths = docker(["find", "/data/caddy/certificates", "-type", "f"]).split(/\r?\n/).filter(path => path.endsWith(".crt") && !path.includes("staging"));
  let material;
  for (const path of paths) {
    const cert = docker(["cat", path]);
    const leaf = new X509Certificate(cert);
    if (!leaf.checkHost(domain) || Date.parse(leaf.validFrom) > Date.now() || Date.parse(leaf.validTo) <= Date.now()) continue;
    const key = docker(["cat", path.slice(0, -4) + ".key"]);
    if (!leaf.checkPrivateKey(createPrivateKey(key))) continue;
    material = { "fullchain.pem": cert, "privkey.pem": key };
    break;
  }
  if (!material) throw new Error("没有找到覆盖该域名的有效 Caddy 证书；TURN_PUBLIC_HOST 应使用 Caddy 已申请证书的域名。");
  const output = resolve(root, "deploy/turn-certs");
  await mkdir(output, { recursive: true, mode: 0o750 });
  if (process.platform !== "win32") { await chown(output, 10001, 10001); await chmod(output, 0o750); }
  for (const [name, data] of Object.entries(material)) {
    const destination = resolve(output, name), temporary = `${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary, data, { mode: 0o640 });
    if (process.platform !== "win32") await chown(temporary, 10001, 10001);
    await rename(temporary, destination);
  }
  console.log(`已导出 ${domain} 的证书到 deploy/turn-certs；私钥未输出。`);
  console.log("首次启用：docker compose -f compose.yaml -f compose.tls.yaml up -d game");
  console.log("续期后再次运行此脚本；TURN 每 60 秒检查并重载证书，无需重启游戏。");
} catch (error) { console.error(error.message); process.exitCode = 1; }
