import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as checks from "../lib/check-skills.mjs";
import { agentNames, desiredFiles, ROOT, skillNames } from "../lib/install.mjs";
import { configuredCommand, protectedPaths } from "../lib/second-opinion.mjs";

const AGENTS = agentNames();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const field = (frontmatter, key) => {
  const raw = Object.fromEntries(frontmatter)[key];
  return raw === undefined ? undefined : checks.scalar(raw);
};
const GATE_HOOKS = ["bash-guard", "state-guard", "verifier-start", "verifier-stop", "observe-only", "authorize-record", "write-scope", "agent-scope"];
const BRIEFS = checks.listFiles(path.join(ROOT, "skills/lead-issue/briefs")).map((file) => file.replace(/\.md$/, ""));
const LEAD_FILES = ["skills/lead-issue/SKILL.md", ...BRIEFS.map((name) => `skills/lead-issue/briefs/${name}.md`)];
// Vendors, products and accounts that no shipped file may name.
const VENDORS = /\b(Figma|Slack|Discord|Teams|Codex|OpenAI|GPT|Grok|Gemini|Linear|Jira|chustert|Playwright|Cypress|xcrun|adb)\b/;

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
    const found = files.flatMap((file) => read(file).split("\n").map((line, index) => [file, index + 1, line]))
      .filter(([, , line]) => VENDORS.test(line)).map(([file, line, text]) => `${file}:${line}: ${text.trim()}`);
    assert.deepEqual(found, []);
  });

  test("the autonomy template asks first by default for the second opinion", () => {
    const text = read("skills/setup-project/templates/autonomy.md");
    assert.equal(configuredCommand(text), null);
    for (const heading of ["## The lead may", "## Always ask the user", "## Loop limits", "## Cross-model review"]) {
      assert.ok(text.includes(heading), heading);
    }
    assert.doesNotMatch(text, /^## Dispatch/m, "models live in models.md");
  });
});

describe("models", () => {
  const template = read("skills/setup-project/templates/models.md");
  /** The first-column cells of the table under a heading of the models template. */
  const rows = (heading) => {
    const section = template.slice(template.indexOf(heading)).split(/\n## /)[0];
    return [...section.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|$/gm)].map(([, name, value]) => ({ name, value }))
      .filter(({ name }) => name !== "---" && !/^(Role|Task)$/.test(name));
  };
  const named = (text) => [...text.matchAll(/the\s+`([^`]+)`\s+row\s+of\s+`docs\/agents\/models\.md`/g)].map(([, row]) => row);

  test("the template has a row for every role and helper task, defaulting to the lead's model", () => {
    const roles = rows("## Roles");
    const helpers = rows("## Helper subagents");
    assert.deepEqual(roles.map(({ name }) => name),
      ["Developer", "Verifier", "Reviewer", "UX designer", "Spec writer", "Harness keeper"]);
    for (const brief of BRIEFS) {
      const role = brief === "ux-designer" ? "UX designer" : brief[0].toUpperCase() + brief.slice(1).replace("-", " ");
      assert.ok(roles.some(({ name }) => name === role), `${brief} has a row`);
    }
    assert.ok(helpers.length >= 4);
    for (const { name, value } of [...roles, ...helpers]) assert.equal(value, "Same as the lead", name);
  });

  test("every skill that starts a subagent names a row the template has, and every helper row is used", () => {
    const all = new Set([...rows("## Roles"), ...rows("## Helper subagents")].map(({ name }) => name));
    const used = new Set();
    for (const skill of skillNames()) {
      const text = read(`skills/${skill}/SKILL.md`);
      const startsOne = /subagents\.md/.test(text) && skill !== "lead-issue";
      const rowsNamed = named(text);
      if (startsOne) assert.ok(rowsNamed.length > 0, `${skill} starts a subagent but names no models.md row`);
      for (const row of rowsNamed) {
        assert.ok(all.has(row), `${skill}: no row ${row}`);
        used.add(row);
      }
    }
    for (const file of LEAD_FILES) for (const row of named(read(file))) assert.ok(all.has(row), `${file}: no row ${row}`);
    for (const { name } of rows("## Helper subagents")) assert.ok(used.has(name), `no skill uses ${name}`);
  });

  test("the subagent rules define how to choose a model", () => {
    const rules = read("references/subagents.md");
    assert.match(rules, /^## Choose the model$/m);
    for (const phrase of ["`docs/agents/models.md`", "Same as the lead", "stop and ask the user", "Record the choice"]) {
      assert.ok(rules.includes(phrase), phrase);
    }
    assert.match(read("skills/lead-issue/SKILL.md"), /Choose the model/);
  });
});

describe("lead-issue", () => {
  test("the skill links every role brief, and every link has a brief", () => {
    const linked = [...read("skills/lead-issue/SKILL.md").matchAll(/\]\(briefs\/([a-z-]+)\.md\)/g)].map(([, name]) => name);
    assert.deepEqual([...new Set(linked)].sort(), [...BRIEFS].sort());
    for (const role of ["developer", "verifier", "reviewer", "ux-designer", "spec-writer", "harness-keeper"]) {
      assert.ok(BRIEFS.includes(role), role);
    }
  });

  test("each brief names the skills its role runs, and they exist", () => {
    const skills = new Set(skillNames());
    const runs = {
      developer: ["start-issue", "implement", "tdd", "diagnosing-bugs", "prepare-pr"],
      verifier: ["verify-work", "proof-standards"],
      reviewer: ["pr-review"],
      "spec-writer": ["to-spec", "create-issue"],
      "harness-keeper": ["create-verification-harness", "maintain-verification-harness"],
    };
    for (const [role, names] of Object.entries(runs)) {
      const text = read(`skills/lead-issue/briefs/${role}.md`);
      for (const name of names) {
        assert.ok(skills.has(name), `${role}: ${name} is a skill`);
        assert.ok(text.includes(`\`${name}\``), `${role} names ${name}`);
      }
    }
    for (const file of LEAD_FILES) {
      for (const [, skill] of read(file).matchAll(/\.agents\/skills\/([a-z-]+)\//g)) assert.ok(skills.has(skill), `${file}: ${skill}`);
    }
  });

  test("the gate commands and scripts it names exist, and ship without Claude Code", () => {
    const gate = read("lib/gate.mjs");
    const shipped = desiredFiles([]);
    for (const file of LEAD_FILES) {
      const text = read(file);
      for (const [, sub] of text.matchAll(/gate\.mjs ([a-z-]+)/g)) {
        assert.ok(gate.includes(`  ${sub}(`) || gate.includes(`"${sub}"(`), `${file}: gate.mjs ${sub}`);
      }
      for (const [, script] of text.matchAll(/\.agents\/scripts\/([a-z-]+\.mjs)/g)) {
        assert.ok(shipped.has(`.agents/scripts/${script}`), `${file}: ${script}`);
      }
    }
  });

  test("the workspace steps are named where they're needed, in the skill and in the team", () => {
    const flat = (file) => read(file).replace(/\s+/g, " ");
    for (const file of ["skills/lead-issue/SKILL.md", "agents/engineering-lead.md"]) {
      assert.ok(flat(file).includes("node .agents/scripts/gate.mjs workspace set <path>..."), `${file}: workspace set`);
      assert.ok(flat(file).includes("set-base <base-commit> --repo <path>"), `${file}: set-base --repo`);
    }
    for (const file of ["skills/lead-issue/briefs/verifier.md", "agents/verifier.md", "skills/lead-issue/briefs/developer.md"]) {
      assert.ok(flat(file).includes("workspace root"), `${file}: gate commands from the workspace root`);
    }
    assert.ok(flat("skills/start-issue/SKILL.md").includes("worktree add -b <branch> <this-checkout>/<child-path> <base-commit>"));
    assert.ok(flat("skills/lead-issue/briefs/verifier.md").includes("`Local check`"));
  });

  test("it names no coding tool, vendor, product or account", () => {
    const tools = /\b(Claude|Anthropic|T3|Cursor|Kiro|OpenCode)\b/;
    const found = LEAD_FILES.flatMap((file) => read(file).split("\n").map((line, index) => [file, index + 1, line]))
      .filter(([, , line]) => VENDORS.test(line) || tools.test(line))
      .map(([file, line, text]) => `${file}:${line}: ${text.trim()}`);
    assert.deepEqual(found, []);
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

  test("a workspace member without a profile of its own uses the workspace's", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-ws-"));
    try {
      const ws = path.join(dir, "ws");
      const app = path.join(ws, "app");
      const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
      for (const repo of [ws, app]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
        git(repo, "config", "user.email", "test@example.com");
        git(repo, "config", "user.name", "test");
      }
      const fake = path.join(dir, "fake-reviewer.mjs");
      fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'WORKSPACE REVIEW\\n');\n");
      fs.mkdirSync(path.join(ws, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(ws, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      fs.writeFileSync(path.join(ws, "docs/agents/verification.md"), "## Protected files\n\n- `config/secrets.yml`\n");
      fs.writeFileSync(path.join(ws, ".gitignore"), "/app/\n");
      git(ws, "add", ".");
      git(ws, "commit", "-qm", "init");
      fs.writeFileSync(path.join(app, "a.txt"), "base\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "init");
      const base = git(app, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(app, "a.txt"), "member change\n");
      fs.mkdirSync(path.join(app, "config"));
      fs.writeFileSync(path.join(app, "config/secrets.yml"), "pw: hunter2\n");
      const out = path.join(dir, "evidence", "second-opinion.md");
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, app, "https://example.com/7", out],
        { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Second opinion written/);
      assert.equal(fs.readFileSync(out, "utf8"), "WORKSPACE REVIEW\n");
      const patch = fs.readFileSync(path.join(dir, "evidence", "second-opinion.patch"), "utf8");
      assert.match(patch, /\+member change/);
      assert.doesNotMatch(patch, /hunter2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
