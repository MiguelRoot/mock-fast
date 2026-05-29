// Copies each SKILL.md into dist/, stamping the current package version into
// the `0.0.0-dev` placeholder so the published skill carries its library version.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const skills = ["mock-fast", "mock-fast-spec"];

for (const s of skills) {
  mkdirSync(`dist/${s}`, { recursive: true });
  const md = readFileSync(`${s}/SKILL.md`, "utf8").replaceAll("0.0.0-dev", version);
  writeFileSync(`dist/${s}/SKILL.md`, md);
}

console.log(`[build:skill] stamped v${version} into ${skills.join(", ")}`);
