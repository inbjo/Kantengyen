import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "npm run setup:turn -- --domain turn.example.com --public-ip 203.0.113.10 [--private-ip 10.0.0.10] [--output-dir PATH]";

try {
  const options = new Map();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      const value = args[index + 1];
      if (!["--domain", "--public-ip", "--private-ip", "--output-dir"].includes(key) || !value || value.startsWith("--") || options.has(key)) {
        throw new Error(usage);
      }
      options.set(key, value);
    }
    const domain = options.get("--domain");
    const publicIp = options.get("--public-ip");
    const privateIp = options.get("--private-ip");
    if (!domain || domain.length > 253 || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)) || !domain.includes(".")) {
      throw new Error("--domain 必须是有效域名，例如 turn.example.com");
    }
    if (isIP(publicIp ?? "") !== 4 || (privateIp && isIP(privateIp) !== 4)) {
      throw new Error("--public-ip 和可选 --private-ip 必须是 IPv4 地址");
    }
    const output = resolve(options.get("--output-dir") ?? root);
    const envPath = resolve(output, ".env");
    const configPath = resolve(output, "deploy/turnserver.conf");
    // Exclusive creation prevents accidentally rotating a live TURN secret.
    const secret = randomBytes(32).toString("hex");
    let env;
    try {
      env = await readFile(envPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      env = await readFile(resolve(root, ".env.example"), "utf8");
    }
    const values = {
      VOICE_ICE_SERVERS: JSON.stringify([{ urls: `stun:${domain}:3478` }]),
      VOICE_TURN_URLS: `turn:${domain}:3478?transport=udp,turn:${domain}:3478?transport=tcp`,
      VOICE_TURN_SECRET: secret,
      // Match the config file owner so a mode-0600 bind mount stays readable.
      COTURN_UID: String(process.getuid?.() ?? 65534),
      COTURN_GID: String(process.getgid?.() ?? 65534),
    };
    for (const [key, value] of Object.entries(values)) {
      const line = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=.*$`, "gm");
      env = line.test(env) ? env.replace(line, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
    }
    let config = await readFile(resolve(root, "deploy/turnserver.conf.example"), "utf8");
    config = config.replaceAll("turn.example.com", domain)
      .replace("REPLACE_WITH_A_LONG_RANDOM_SHARED_SECRET", secret)
      .replace("# external-ip=PUBLIC_IP/PRIVATE_IP", `external-ip=${publicIp}${privateIp ? `/${privateIp}` : ""}`);
    await mkdir(resolve(output, "deploy"), { recursive: true });
    await writeFile(configPath, config, { flag: "wx", mode: 0o600 });
    await writeFile(envPath, env, { mode: 0o600 });
    await chmod(envPath, 0o600);
    console.log(`已生成 ${configPath} 并更新 ${envPath}，共享密钥未输出。`);
    console.log("检查域名、公网 IP 和防火墙后，在仓库根目录运行：docker compose -f compose.turn.yaml up -d");
    console.log("已有游戏容器还需运行 docker compose up -d game 以载入新配置；这会清空现有房间。");
  }
} catch (error) {
  console.error(error.code === "EEXIST"
    ? "deploy/turnserver.conf 已存在，为避免覆盖运行配置已停止。修改现有配置，或备份移走后重新生成。"
    : error.message);
  process.exitCode = 1;
}
