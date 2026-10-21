import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as checks from "../lib/check-skills.mjs";
import { agentNames, ROOT, skillNames } from "../lib/install.mjs";
import { configuredCommand, protectedPaths } from "../lib/second-opinion.mjs";

const AGENTS = agentNames();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const field = (frontmatter, key) => {
  const raw = Object.fromEntries(frontmatter)[key];
  return raw === undefined ? undefined : checks.scalar(raw);
};
const GATE_HOOKS = ["bash-guard", "state-guard", "verifier-start", "verifier-stop", "observe-only", "authorize-record", "write-scope", "agent-scope"];

describe("agent team", () => {
  test("every agent has a name that matches its file and a description", () => {
    assert.ok(AGENTS.includes("engineering-lead") && AGENTS.includes("verifier"));
    for (const name of AGENTS) {
      const [frontmatter] = checks.splitFrontmatter(read(`agents/${name}.md`));
      assert.equal(field(frontmatter, "name"), name);
      assert.ok(field(frontmatter, "description")?.length > 40, name);
    }
  });

  test("the lead may spawn only agents that exist", () => {
    const [frontmatter] = checks.splitFrontmatter(read("agents/engineering-lead.md"));
    const allowed = /Agent\(([^)]*)\)/.exec(field(frontmatter, "tools"))[1].split(",").map((name) => name.trim());
    const builtIn = new Set(["Explore"]);
    assert.deepEqual(allowed.filter((name) => !AGENTS.includes(name) && !builtIn.has(name)), []);
  });

  test("preloaded skills exist in the fleet", () => {
    const skills = new Set(skillNames());
    for (const name of AGENTS) {
      const text = read(`agents/${name}.md`);
      const block = /^skills:\n((?:\s+- .+\n)+)/m.exec(text)?.[1] ?? "";
      for (const [, skill] of block.matchAll(/- (\S+)/g)) assert.ok(skills.has(skill), `${name}: ${skill}`);
    }
  });

  test("the skills the agents name exist", () => {
    const skills = new Set(skillNames());
    for (const name of AGENTS) {
      for (const [, skill] of read(`agents/${name}.md`).matchAll(/\.agents\/skills\/([a-z-]+)\//g)) {
        assert.ok(skills.has(skill), `${name}: ${skill}`);
      }
    }
  });

  test("hooks call gate subcommands that exist, and scripts the installer ships", () => {
    const gate = read("lib/gate.mjs");
    const texts = [...AGENTS.map((name) => read(`agents/${name}.md`)), read("agents/settings.json")];
    for (const text of texts) {
      for (const [, sub] of text.matchAll(/gate\.mjs hook ([a-z-]+)/g)) {
        assert.ok(GATE_HOOKS.includes(sub), sub);
        assert.ok(gate.includes(`"${sub}"(`), `gate.mjs implements ${sub}`);
      }
      for (const [, script] of text.matchAll(/\.agents\/scripts\/([a-z-]+\.mjs)/g)) {
        assert.ok(fs.existsSync(path.join(ROOT, "lib", script)), script);
      }
    }
  });

  test("the team settings are valid and gate ready pull requests", () => {
    const settings = JSON.parse(read("agents/settings.json"));
    assert.ok(settings.permissions.deny.includes("Bash(gh pr merge *)"));
    assert.ok(settings.permissions.ask.includes("Bash(gh issue create *)"));
    const commands = JSON.stringify(settings.hooks);
    for (const sub of ["bash-guard", "state-guard", "verifier-start", "verifier-stop"]) assert.ok(commands.includes(`hook ${sub}`), sub);
  });

  test("the team names no vendor, product or account", () => {
    const files = [...AGENTS.map((name) => `agents/${name}.md`), "agents/settings.json",
      ...checks.listFiles(path.join(ROOT, "agents/automations")).map((file) => `agents/automations/${file}`),
      ...["proof-standards", "create-verification-harness", "maintain-verification-harness", "triage-report"]
        .map((name) => `skills/${name}/SKILL.md`)];
    const names = /\b(Figma|Slack|Discord|Teams|Codex|OpenAI|GPT|Grok|Gemini|Linear|Jira|chustert|Playwright|Cypress|xcrun|adb)\b/;
    const found = files.flatMap((file) => read(file).split("\n").map((line, index) => [file, index + 1, line]))
      .filter(([, , line]) => names.test(line)).map(([file, line, text]) => `${file}:${line}: ${text.trim()}`);
    assert.deepEqual(found, []);
  });

  test("the autonomy template asks first by default for the second opinion", () => {
    const text = read("skills/setup-project/templates/autonomy.md");
    assert.equal(configuredCommand(text), null);
    for (const heading of ["## The lead may", "## Always ask the user", "## Loop limits", "## Cross-model review"]) {
      assert.ok(text.includes(heading), heading);
    }
  });
});

describe("second opinion", () => {
  test("reads the configured command and the protected paths", () => {
    assert.equal(configuredCommand("| Command | `cli exec -o \"$OUT\" \"$PROMPT\"` |\n"), 'cli exec -o "$OUT" "$PROMPT"');
    assert.equal(configuredCommand("| Command | TODO: such as `cli` |\n"), null);
    const verification = "## Protected files\n\n- `config/secrets.yml`, `TODO: more`\n- `.env.local`\n\n## Review worktree setup\n\n- `node_modules`\n";
    assert.deepEqual(protectedPaths(verification), ["config/secrets.yml", ".env.local"]);
  });

  test("sends the patch without protected files and writes the reply", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-"));
    try {
      const repo = path.join(dir, "app");
      const git = (...args) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
      spawnSync("git", ["init", "-q", "-b", "main", repo]);
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "test");
      fs.mkdirSync(path.join(repo, "docs/agents"), { recursive: true });
      const fake = path.join(dir, "fake-reviewer.mjs");
      fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'REVIEW for ' + process.env.PROMPT.length + '\\n');\n");
      fs.writeFileSync(path.join(repo, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      fs.writeFileSync(path.join(repo, "docs/agents/verification.md"), "## Protected files\n\n- `config/secrets.yml`\n");
      fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
      git("add", ".");
      git("commit", "-qm", "init");
      const base = git("rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(repo, "a.txt"), "change\n");
      fs.mkdirSync(path.join(repo, "config"));
      fs.writeFileSync(path.join(repo, "config/secrets.yml"), "pw: hunter2\n");
      fs.writeFileSync(path.join(repo, ".env.local"), "K=1\n");
      const out = path.join(dir, "evidence", "second-opinion.md");
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, repo, "https://example.com/1", out],
        { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Second opinion written/);
      assert.match(fs.readFileSync(out, "utf8"), /^REVIEW for \d+/);
      const patch = fs.readFileSync(path.join(dir, "evidence", "second-opinion.patch"), "utf8");
      assert.match(patch, /\+change/);
      assert.doesNotMatch(patch, /hunter2|K=1/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
