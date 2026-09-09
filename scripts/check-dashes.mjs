// Fail lint when an em dash or en dash lands in any tracked text file. The
// style guide for everything that reaches GitHub forbids both, and a lint
// check is the only thing that catches one pasted in from a terminal.
//
// The two characters are built from their code points rather than written
// out, so this file does not report itself.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);

const files = execSync("git ls-files", { encoding: "utf8" }).split("\n").filter(Boolean);
const bad = [];
for (const f of files) {
  if (/\.(png|jpg|gif|ico|lock)$/.test(f)) continue;
  const text = readFileSync(f, "utf8");
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM) || line.includes(EN)) bad.push(`${f}:${i + 1}`);
  });
}
if (bad.length > 0) {
  console.error("em or en dash found in:\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`no em or en dashes in ${files.length} tracked files`);
