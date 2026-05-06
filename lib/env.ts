import { readFileSync, existsSync } from "node:fs";

const path = ".env.local";

if (existsSync(path)) {
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}
