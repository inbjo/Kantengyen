import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const usage = "npm run setup:turn -- --public-ip YOUR_PUBLIC_IP [--domain turn.example.com] [--output-dir PATH]";
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage);
  } else {
    const options = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index], value = args[index + 1];
      if (!["--domain", "--public-ip", "--output-dir"].includes(key) || !value || value.startsWith("--") || options.has(key)) throw new Error(usage);
      options.set(key, value);
    }
    const ip = options.get("--public-ip");
    if (isIP(ip ?? "") !== 4) throw new Error("--public-ip 必须是服务器公网 IPv4");
    const domain = options.get("--domain") ?? ip;
    if (domain.length > 253 || !domain.split(".").every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label))) throw new Error("--domain 必须是域名，不能带协议或端口");
    const output = resolve(options.get("--output-dir") ?? root);
    const envPath = resolve(output, ".env");
    let env;
    try { env = await readFile(envPath, "utf8"); }
    catch (error) { if (error.code !== "ENOENT") throw error; env = await readFile(resolve(root, ".env.example"), "utf8"); }
    const existing = env.match(/^[\t ]*(?:export[\t ]+)?VOICE_TURN_SECRET[\t ]*=[\t ]*(.*)$/m)?.[1].trim().replace(/^(['"])(.*)\1$/, "$2");
    if (existing && existing.length < 32) throw new Error("现有 VOICE_TURN_SECRET 少于 32 字节，请先手动配置更长的随机密钥");
    const values = {
      TURN_ENABLED: "true", TURN_PUBLIC_IP: ip, TURN_PUBLIC_HOST: domain,
      VOICE_TURN_SECRET: existing || randomBytes(32).toString("hex"),
    };
    for (const [key, value] of Object.entries(values)) {
      const line = new RegExp(`^[\\t ]*(?:export[\\t ]+)?${key}[\\t ]*=.*$`, "gm");
      env = line.test(env) ? env.replace(line, `${key}=${value}`) : `${env.trimEnd()}\n${key}=${value}\n`;
    }
    await mkdir(output, { recursive: true });
    await writeFile(envPath, env, { mode: 0o600 });
    await chmod(envPath, 0o600);
    console.log(`内置 TURN 配置已写入 ${envPath}，密钥未输出，重复执行保留已有密钥。`);
    console.log("设置 SITE_ADDRESS、检查 DNS 和 UDP 端口后，运行：docker compose up -d --build");
    console.log("如果从独立 coturn 迁移，请先停止它以释放 3478 和中继端口；清除 .env 中不再使用的外部 VOICE_TURN_URLS。");
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
