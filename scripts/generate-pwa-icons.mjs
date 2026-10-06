import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// Render the existing vector mark; generated PNGs are committed, not built on deploy.
const source = await readFile(new URL("../web/public/favicon.svg", import.meta.url), "utf8");
const folder = new URL("../web/public/icons/", import.meta.url);
await mkdir(folder, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH });
try {
  const page = await browser.newPage();
  for (const [name, size, maskable] of [["icon-192.png", 192, false], ["icon-512.png", 512, false], ["apple-touch-icon.png", 180, false], ["icon-maskable-512.png", 512, true]]) {
    const png = await page.evaluate(async ({ source, size, maskable }) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const context = canvas.getContext("2d");
      context.fillStyle = "#153e33";
      context.fillRect(0, 0, size, size);
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
      await image.decode();
      const inset = maskable ? size * 0.15 : 0;
      context.drawImage(image, inset, inset, size - inset * 2, size - inset * 2);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { source, size, maskable });
    await writeFile(new URL(name, folder), Buffer.from(png, "base64"));
  }
} finally { await browser.close(); }
