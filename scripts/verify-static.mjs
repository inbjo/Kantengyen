import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function verifyStaticElf(bytes) {
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== 62) {
    throw new Error("产物不是 Linux x64 ELF64 二进制");
  }
  if (![2, 3].includes(bytes.readUInt16LE(16))) throw new Error("ELF 不是可执行程序");
  const offset = Number(bytes.readBigUInt64LE(32));
  const size = bytes.readUInt16LE(54);
  const count = bytes.readUInt16LE(56);
  if (size < 56 || count === 0 || offset + count * size > bytes.length) throw new Error("ELF 程序头无效");
  for (let i = 0; i < count; i++) {
    const entry = offset + i * size;
    const type = bytes.readUInt32LE(entry);
    if (type === 3) throw new Error("产物含动态链接器 PT_INTERP，不是独立静态程序");
    if (type === 2) {
      const start = Number(bytes.readBigUInt64LE(entry + 8));
      const length = Number(bytes.readBigUInt64LE(entry + 32));
      if (start + length > bytes.length || length % 16) throw new Error("ELF 动态段无效");
      for (let j = start; j < start + length; j += 16) {
        const tag = bytes.readBigInt64LE(j);
        if (tag === 0n) break;
        if (tag === 1n) throw new Error("产物依赖动态共享库 DT_NEEDED");
      }
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    verifyStaticElf(await readFile(process.argv[2] ?? "dist/kantengyen-server"));
    console.log("静态校验通过：Linux x64，无动态链接器或共享库依赖");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
