#!/usr/bin/env node
// Monta a página local (splash/offline) em dist/: compila o TS e copia HTML, CSS e o ícone.
// Sem bundler: são três arquivos estáticos servidos pelo protocolo do Tauri.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");
const result = spawnSync(process.execPath, [tsc, "-p", join(root, "tsconfig.build.json")], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

copyFileSync(join(root, "src", "index.html"), join(dist, "index.html"));
copyFileSync(join(root, "src", "styles.css"), join(dist, "styles.css"));
copyFileSync(join(root, "src-tauri", "icons", "128x128.png"), join(dist, "icon.png"));
console.log("frontend local pronto em dist/");
