import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

function pwaWorker(): Plugin {
  const root = fileURLToPath(new URL(".", import.meta.url));
  return {
    name: "kantengyen-pwa", apply: "build", enforce: "post",
    generateBundle(_, bundle) {
      const template = readFileSync(resolve(root, "service-worker.js"), "utf8");
      const hash = createHash("sha256").update(template);
      const urls: string[] = [];
      for (const name of Object.keys(bundle).sort()) {
        const asset = bundle[name];
        hash.update(name).update(asset.type === "chunk" ? asset.code : asset.source);
        urls.push(`/${name}`);
      }
      const publicDir = resolve(root, "public");
      const collect = (folder: string) => {
        for (const entry of readdirSync(folder, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
          const path = resolve(folder, entry.name);
          if (entry.isDirectory()) collect(path);
          else {
            const name = relative(publicDir, path).replaceAll("\\", "/");
            hash.update(name).update(readFileSync(path));
            urls.push(`/${name}`);
          }
        }
      };
      collect(publicDir);
      this.emitFile({ type: "asset", fileName: "sw.js", source: template
        .replace("__CACHE_VERSION__", JSON.stringify(`kantengyen-pwa-${hash.digest("hex").slice(0, 16)}`))
        .replace("__PRECACHE_URLS__", JSON.stringify(urls)) });
    },
  };
}

export default defineConfig({
  plugins: [react(), pwaWorker()],
  server: { proxy: { "/api": { target: "http://127.0.0.1:3000", ws: true } } },
});
