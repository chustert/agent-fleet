#!/usr/bin/env node
/**
 * Second-opinion review from a model of another family, for the reviewer agent.
 *
 *     node .agents/scripts/second-opinion.mjs <base-commit> <worktree-path> <issue-url> <output-file>
 *
 * Writes the exact patch, untracked files included and protected files left
 * out, next to the output file. Then it runs the `Command` row under
 * `Cross-model review` in `docs/agents/autonomy.md` from the repository root,
 * with PROMPT (the review request, which points at the patch file) and OUT
 * (where the reply must end up) in its environment. The command uses POSIX
 * shell syntax; on Windows it runs in Git Bash.
 *
 * Prints SECOND_OPINION_UNAVAILABLE and exits 0 when no command is configured,
 * the program is missing, or it fails, so the review continues single-model.
 * Node.js 20+, standard library only.
 */

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Secret files that never leave the machine, whatever the profile lists.
const SECRET_GLOBS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx", "**/*.keystore",
  "**/*.jks", "**/*.mobileprovision", "**/*.tfvars", "**/*service-account*.json", "**/credentials*.json",
  "**/GoogleService-Info.plist", "**/google-services.json", "**/id_rsa*", "**/id_ed25519*"];

const unavailable = (reason) => {
  console.log(`SECOND_OPINION_UNAVAILABLE: ${reason}`);
  process.exit(0);
};

/** The backticked value of the first `| Command | ... |` row, or null. */
export function configuredCommand(text) {
  const match = /^\|\s*Command\s*\|\s*`(.+)`\s*\|/m.exec(text);
  return match ? match[1].trim() : null;
}

/** The backticked paths listed as bullets under `## Protected files`, without TODO entries. */
export function protectedPaths(text) {
  const section = /^## Protected files\s*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const paths = [];
  for (const line of section.split("\n").filter((l) => /^\s*- /.test(l))) {
    for (const [, value] of line.matchAll(/`([^`]+)`/g)) {
      if (!/^todo\b/i.test(value) && value !== "None") paths.push(value);
    }
  }
  return paths;
}

function hasProgram(name) {
  const probe = process.platform === "win32" ? ["where", [name]] : ["sh", ["-c", `command -v "${name}"`]];
  return spawnSync(probe[0], probe[1], { stdio: "ignore" }).status === 0;
}

function main(argv) {
  if (argv.length !== 4) {
    console.error("Usage: second-opinion.mjs <base-commit> <worktree-path> <issue-url> <output-file>");
    return 1;
  }
  const [base, worktree, issue, outArg] = argv;
  const out = path.resolve(outArg);
  const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: worktree, encoding: "utf8" }).trim();
  const policy = path.join(root, "docs/agents/autonomy.md");
  const command = fs.existsSync(policy) ? configuredCommand(fs.readFileSync(policy, "utf8")) : null;
  if (!command || command === "None") unavailable("no Command under Cross-model review in docs/agents/autonomy.md");
  const program = command.split(/\s+/)[0];
  if (!hasProgram(program)) unavailable(`'${program}' is not installed or not on PATH`);

  const verification = path.join(root, "docs/agents/verification.md");
  const listed = fs.existsSync(verification) ? protectedPaths(fs.readFileSync(verification, "utf8")) : [];
  const excludes = [...SECRET_GLOBS, ...listed.flatMap((p) => [p, `**/${p}`])].flatMap((p) => ["--exclude", p]);
  const gate = path.join(path.dirname(fileURLToPath(import.meta.url)), "gate.mjs");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const patchFile = out.replace(/\.[^./\\]+$/, "") + ".patch";
  const patch = execFileSync(process.execPath, [gate, "diff", ...excludes], {
    cwd: worktree, encoding: "utf8", env: { ...process.env, AGENT_GATE_BASE: base }, maxBuffer: 512 * 1024 * 1024,
  });
  if (!patch.trim()) unavailable(`the patch from ${base} is empty`);
  fs.writeFileSync(patchFile, patch);

  const prompt = [
    `You are an independent senior code reviewer. Review only the change in the patch file ${patchFile}, a unified diff `
      + `from base commit ${base} in the repository at ${root}. The requirement source is ${issue}; read it with `
      + "'gh issue view' if you can. Read surrounding code only to understand contracts and callers. Modify no file, run "
      + "no command that writes, and contact no online service other than reading the issue.",
    "Report two separate sections: 'Specification' (missing, partial, incorrect or unrequested behaviour against the "
      + "issue) and 'Engineering' (correctness, security, reliability, error handling, concurrency, compatibility, "
      + "maintainability, and tests that do not prove the behaviour).",
    "For each finding use exactly this shape:\n[P0|P1|P2|P3] Title\nLocation: path:line\nEvidence: what the code shows\n"
      + "Impact: the concrete consequence\nFix: the smallest change that removes the risk",
    "P0 = severe harm, exploitable, data loss, cannot ship. P1 = likely incorrect behaviour or broken contract. "
      + "P2 = material weakness to fix before or soon after merge. P3 = localized improvement. Use P0 or P1 only with a "
      + "reachable path or violated contract you can point to. Put unconfirmed concerns under 'Unverified risks'. No style "
      + "comments unless they cause real cost. End with one line: 'Open P0-P2: <count>'.",
  ].join("\n\n");

  const shell = process.platform === "win32" ? "bash" : "/bin/sh";
  const result = spawnSync(shell, ["-c", command], {
    cwd: root, env: { ...process.env, PROMPT: prompt, OUT: out }, stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.status !== 0) unavailable("the configured command failed; see its output above");
  if (!fs.existsSync(out) || !fs.statSync(out).size) unavailable(`the command wrote nothing to ${out}`);
  console.log(`Second opinion written to ${out}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
