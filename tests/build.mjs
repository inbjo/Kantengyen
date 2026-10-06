import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { verifyStaticElf } from "../scripts/verify-static.mjs";

test("static artifact guard rejects wrong architecture and dynamic dependencies", () => {
  const elf = Buffer.alloc(256);
  elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  elf.writeUInt16LE(2, 16);
  elf.writeUInt16LE(62, 18);
  elf.writeBigUInt64LE(64n, 32);
  elf.writeUInt16LE(56, 54);
  elf.writeUInt16LE(1, 56);
  elf.writeUInt32LE(1, 64);
  assert.doesNotThrow(() => verifyStaticElf(elf));
  const interpreter = Buffer.from(elf);
  interpreter.writeUInt32LE(3, 64);
  assert.throws(() => verifyStaticElf(interpreter), /PT_INTERP/);
  const dynamic = Buffer.from(elf);
  dynamic.writeUInt32LE(2, 64);
  dynamic.writeBigUInt64LE(128n, 72);
  dynamic.writeBigUInt64LE(32n, 96);
  dynamic.writeBigInt64LE(1n, 128);
  assert.throws(() => verifyStaticElf(dynamic), /DT_NEEDED/);
  const arm = Buffer.from(elf);
  arm.writeUInt16LE(183, 18);
  assert.throws(() => verifyStaticElf(arm), /x64/);
  assert.throws(() => verifyStaticElf(Buffer.from("not an ELF")), /ELF64/);
});

test("binary serves embedded frontend and WASM from an empty working directory", { timeout: 20_000 }, async () => {
  const portProbe = createServer();
  await new Promise(resolve => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const cwd = await mkdtemp(join(tmpdir(), "kantengyen-embedded-"));
  const binary = resolve("target/debug/kantengyen-server" + (process.platform === "win32" ? ".exe" : ""));
  const child = spawn(binary, [], { cwd, env: { ...process.env, BIND_ADDR: `127.0.0.1:${port}` }, stdio: "ignore" });
  let spawnError;
  child.on("error", error => { spawnError = error; });
  const closed = new Promise(resolve => child.on("close", resolve));
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (spawnError) throw spawnError;
      try { ready = (await fetch(base + "/api/health")).ok; } catch {}
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, "需要先运行 cargo build -p kantengyen-server");
    const page = await fetch(base + "/?room=1234");
    const html = await page.text();
    assert.match(html, /<div id="root">/);
    const asset = html.match(/src="([^"]+\.js)"/)[1];
    const js = await fetch(base + asset);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("cache-control"), /immutable/);
    const cached = await fetch(base + asset, { headers: { "If-None-Match": js.headers.get("etag") } });
    assert.equal(cached.status, 304);
    const wasm = await fetch(base + "/rules.wasm");
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    const { instance } = await WebAssembly.instantiate(await wasm.arrayBuffer());
    assert.notEqual(instance.exports.check_play(1, 0, 0, 0, 0), 0);
    const manifest = await fetch(base + "/manifest.webmanifest");
    assert.match(manifest.headers.get("content-type"), /application\/manifest\+json/);
    const metadata = await manifest.json();
    assert.equal(metadata.id, "/");
    assert.equal(metadata.start_url, "/");
    assert.equal(metadata.display, "standalone");
    for (const icon of [...metadata.icons, { src: "/icons/apple-touch-icon.png", sizes: "180x180" }]) {
      const response = await fetch(base + icon.src);
      assert.equal(response.headers.get("content-type"), "image/png");
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
    }
    const worker = await fetch(base + "/sw.js");
    assert.equal(worker.status, 200);
    assert.match(worker.headers.get("content-type"), /javascript/);
    assert.equal(worker.headers.get("cache-control"), "no-cache");
    assert.equal((await fetch(base + "/missing.js")).status, 404);
    assert.equal((await fetch(base + "/api/missing")).status, 404);
    const head = await fetch(base + asset, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
  } finally {
    child.kill("SIGINT");
    await closed;
    await rmdir(cwd);
  }
});
