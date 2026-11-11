import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import * as checks from "../lib/check-skills.mjs";
import { agentNames, desiredFiles, ROOT, skillNames } from "../lib/install.mjs";
import { configuredCommand, findWorkspace, patternsInMember, protectedPaths } from "../lib/second-opinion.mjs";

/** Mark a folder as an agent-fleet installation, with the manifest fields the workspace lookup reads. */
function install(root, fields = {}) {
  fs.mkdirSync(path.join(root, ".agents"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agents/agent-fleet.json"), JSON.stringify({ fleet: "agent-fleet", ...fields }));
}

/** The workspace root findWorkspace() finds around a repository, or null. */
const workspaceRoot = (root) => findWorkspace(root)?.root ?? null;

/** Run second-opinion.mjs on a repository and return its output and the patch it wrote. */
function secondOpinion(dir, base, repo) {
  const out = path.join(dir, "evidence", "second-opinion.md");
  const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, repo, "https://example.com/1", out],
    { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const patchFile = path.join(dir, "evidence", "second-opinion.patch");
  return { stdout: result.stdout, reply: fs.existsSync(out) ? fs.readFileSync(out, "utf8") : null,
    patch: fs.existsSync(patchFile) ? fs.readFileSync(patchFile, "utf8") : "" };
}

const AGENTS = agentNames();
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");
const field = (frontmatter, key) => {
  const raw = Object.fromEntries(frontmatter)[key];
  return raw === undefined ? undefined : checks.scalar(raw);
};
const GATE_HOOKS = ["bash-guard", "session-env", "state-guard", "verifier-start", "verifier-stop", "observe-only", "authorize-record", "write-scope", "agent-scope"];
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
    for (const sub of ["bash-guard", "state-guard", "session-env", "verifier-start", "verifier-stop"]) assert.ok(commands.includes(`hook ${sub}`), sub);
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

  test("a workspace's protected paths are translated into each member", () => {
    assert.deepEqual(patternsInMember("app/config/secrets.yml", "app"), ["config/secrets.yml"]);
    assert.deepEqual(patternsInMember("*/Signing.local", "app"), ["Signing.local"]);
    assert.deepEqual(patternsInMember("other/x", "app"), []);
    // A pattern that matches the member itself protects every file in it; before, it protected none.
    for (const pattern of ["vendor/*", "vendor/**", "vendor/keys", "**"]) {
      assert.deepEqual(patternsInMember(pattern, "vendor/keys"), ["**"], pattern);
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
      install(ws);
      fs.writeFileSync(path.join(ws, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      // The workspace profile names the file by its path from the workspace root.
      fs.writeFileSync(path.join(ws, "docs/agents/verification.md"), "## Protected files\n\n- `app/config/secrets.yml`\n- `*/Signing.local`\n");
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
      fs.writeFileSync(path.join(app, "Signing.local"), "key: swordfish\n");
      fs.mkdirSync(path.join(app, "docs"));
      fs.writeFileSync(path.join(app, "docs/secrets.yml"), "public notes\n");
      const out = path.join(dir, "evidence", "second-opinion.md");
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, app, "https://example.com/7", out],
        { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /Second opinion written/);
      assert.equal(fs.readFileSync(out, "utf8"), "WORKSPACE REVIEW\n");
      const patch = fs.readFileSync(path.join(dir, "evidence", "second-opinion.patch"), "utf8");
      assert.match(patch, /\+member change/);
      assert.doesNotMatch(patch, /hunter2|swordfish/);
      assert.match(patch, /public notes/, "a file that only shares a protected file's name stays in");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worktree kept inside a member leaves out the workspace's protected files for that member", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-wt-"));
    try {
      const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      const ws = path.join(dir, "ws");
      const app = path.join(ws, "app");
      for (const repo of [ws, app]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
      }
      const fake = path.join(dir, "fake-reviewer.mjs");
      fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'REVIEW\\n');\n");
      install(ws);
      fs.mkdirSync(path.join(ws, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(ws, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      fs.writeFileSync(path.join(ws, "docs/agents/verification.md"), "## Protected files\n\n- `app/config/secrets.yml`\n");
      fs.writeFileSync(path.join(ws, ".gitignore"), "/app/\n");
      fs.writeFileSync(path.join(app, ".gitignore"), ".claude/\n");
      fs.writeFileSync(path.join(app, "a.txt"), "base\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "init");
      const worktree = path.join(app, ".claude", "worktrees", "w");
      assert.equal(git(app, "worktree", "add", "-q", "-b", "w", worktree).status, 0);
      const found = findWorkspace(worktree);
      assert.equal(fs.realpathSync(found.root), fs.realpathSync(ws));
      assert.equal(fs.realpathSync(found.member), fs.realpathSync(app));
      const base = git(worktree, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(worktree, "a.txt"), "worktree change\n");
      fs.mkdirSync(path.join(worktree, "config"));
      fs.writeFileSync(path.join(worktree, "config/secrets.yml"), "pw: hunter2\n");
      const out = path.join(dir, "evidence", "second-opinion.md");
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, worktree, "https://example.com/8", out],
        { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const patch = fs.readFileSync(path.join(dir, "evidence", "second-opinion.patch"), "utf8");
      assert.match(patch, /\+worktree change/);
      assert.doesNotMatch(patch, /hunter2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("only an agent-fleet installation makes a workspace, and a member cloned on its own counts for a repository in it", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-which-"));
    try {
      const ws = path.join(dir, "ws");
      const app = path.join(ws, "app");
      const alone = path.join(dir, "alone");
      const plugin = path.join(alone, "plugin");
      for (const repo of [ws, app, alone, plugin]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
      }
      // A .agents folder is how several coding tools find skills, so it alone is no installation.
      fs.mkdirSync(path.join(ws, ".agents/skills/mine"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".agents/skills/mine/SKILL.md"), "---\nname: mine\ndescription: Mine.\n---\n");
      assert.equal(workspaceRoot(app), null);
      install(ws);
      assert.equal(fs.realpathSync(workspaceRoot(app)), fs.realpathSync(ws));
      assert.equal(findWorkspace(app).alone, false);
      install(alone, { workspace: { repository: "acme/ws", path: "alone" } });
      assert.equal(fs.realpathSync(workspaceRoot(plugin)), fs.realpathSync(alone));
      // Its profile applies, but the installer doesn't make the repository a member of a member.
      assert.equal(findWorkspace(plugin).alone, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repository installed on its own inside a workspace doesn't use the workspace's profile", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-alone-"));
    try {
      const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      const ws = path.join(dir, "ws");
      const app = path.join(ws, "app");
      for (const repo of [ws, app]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
      }
      install(ws);
      fs.mkdirSync(path.join(ws, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(ws, "docs/agents/autonomy.md"), "| Command | `node ./reviewer.mjs` |\n");
      install(app, { workspace: false });
      fs.writeFileSync(path.join(app, "a.txt"), "base\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "init");
      const base = git(app, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(app, "a.txt"), "change\n");
      const result = spawnSync(process.execPath, [path.join(ROOT, "lib/second-opinion.mjs"), base, app, "https://example.com/9",
        path.join(dir, "evidence", "out.md")], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SECOND_OPINION_UNAVAILABLE: no Command/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the workspace root skips an installed member around a repository and a worktree of the repository itself", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-root-"));
    try {
      const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      const ws = path.join(dir, "ws");
      const member = path.join(ws, "a");
      const nested = path.join(member, "sub");
      for (const repo of [ws, member, nested]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
      }
      install(ws);
      install(member, { workspace: { repository: "acme/ws", path: "a" } });
      const real = (p) => fs.realpathSync(p);
      assert.equal(real(workspaceRoot(nested)), real(ws));
      assert.equal(real(workspaceRoot(member)), real(ws));
      assert.equal(workspaceRoot(ws), null);
      // A worktree kept inside its own main checkout belongs to that repository, not to a workspace around it.
      fs.writeFileSync(path.join(ws, ".gitignore"), "/a/\n.claude/\n");
      git(ws, "add", ".gitignore");
      git(ws, "commit", "-qm", "init");
      const worktree = path.join(ws, ".claude", "worktrees", "w");
      assert.equal(git(ws, "worktree", "add", "-q", "-b", "w", worktree).status, 0);
      assert.equal(workspaceRoot(worktree), null);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repository installed on its own inside a workspace still leaves out the workspace's protected files", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-alone-safe-"));
    try {
      const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      const ws = path.join(dir, "ws");
      const app = path.join(ws, "app");
      for (const repo of [ws, app]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
      }
      install(ws);
      fs.mkdirSync(path.join(ws, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(ws, "docs/agents/verification.md"), "## Protected files\n\n- `app/config/secrets.yml`\n");
      install(app, { workspace: false });
      const fake = path.join(dir, "fake-reviewer.mjs");
      fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'OWN REVIEW\\n');\n");
      fs.mkdirSync(path.join(app, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(app, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      fs.writeFileSync(path.join(app, "a.txt"), "base\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "init");
      const base = git(app, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(app, "a.txt"), "change\n");
      fs.mkdirSync(path.join(app, "config"));
      fs.writeFileSync(path.join(app, "config/secrets.yml"), "pw: hunter2\n");
      const { reply, patch } = secondOpinion(dir, base, app);
      assert.equal(reply, "OWN REVIEW\n");
      assert.match(patch, /\+change/);
      assert.doesNotMatch(patch, /hunter2/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a worktree kept inside its main checkout leaves out the files that checkout's profile protects", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-main-"));
    try {
      const git = (cwd, ...args) => spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" });
      const app = path.join(dir, "app");
      fs.mkdirSync(app, { recursive: true });
      spawnSync("git", ["init", "-q", "-b", "main", app]);
      install(app);
      const fake = path.join(dir, "fake-reviewer.mjs");
      fs.writeFileSync(fake, "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'REVIEW\\n');\n");
      fs.mkdirSync(path.join(app, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(app, "docs/agents/autonomy.md"), `| Command | \`node ${fake}\` |\n`);
      fs.writeFileSync(path.join(app, ".gitignore"), ".claude/\n");
      fs.writeFileSync(path.join(app, "a.txt"), "base\n");
      git(app, "add", ".");
      git(app, "commit", "-qm", "init");
      // The main checkout's profile protects a file that the worktree's commit doesn't list yet.
      fs.writeFileSync(path.join(app, "docs/agents/verification.md"), "## Protected files\n\n- `config/prod.yml`\n");
      const worktree = path.join(app, ".claude", "worktrees", "w");
      assert.equal(git(app, "worktree", "add", "-q", "-b", "w", worktree).status, 0);
      const base = git(worktree, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(worktree, "a.txt"), "worktree change\n");
      fs.mkdirSync(path.join(worktree, "config"));
      fs.writeFileSync(path.join(worktree, "config/prod.yml"), "db: swordfish\n");
      const { patch } = secondOpinion(dir, base, worktree);
      assert.match(patch, /\+worktree change/);
      assert.doesNotMatch(patch, /swordfish/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a member nested in another member finds the workspace's profile and runs its command from there", { skip: process.platform === "win32" }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-so-nested-"));
    try {
      const ws = path.join(dir, "ws");
      const outer = path.join(ws, "a");
      const sub = path.join(outer, "sub");
      const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });
      for (const repo of [ws, outer, sub]) {
        fs.mkdirSync(repo, { recursive: true });
        spawnSync("git", ["init", "-q", "-b", "main", repo]);
        git(repo, "config", "user.email", "test@example.com");
        git(repo, "config", "user.name", "test");
      }
      // The command is a path relative to the workspace root, where it is installed.
      fs.writeFileSync(path.join(ws, "reviewer.mjs"), "import fs from 'node:fs';\nfs.writeFileSync(process.env.OUT, 'NESTED REVIEW\\n');\n");
      fs.mkdirSync(path.join(ws, "docs/agents"), { recursive: true });
      install(ws);
      fs.writeFileSync(path.join(ws, "docs/agents/autonomy.md"), "| Command | `node ./reviewer.mjs` |\n");
      fs.writeFileSync(path.join(ws, "docs/agents/verification.md"), "## Protected files\n\n- `a/sub/config/secrets.yml`\n");
      fs.writeFileSync(path.join(outer, ".gitignore"), "/sub/\n");
      // The member around it protects a file of its own, which stays out of the patch too.
      install(outer, { workspace: { repository: "acme/ws", path: "a" } });
      fs.mkdirSync(path.join(outer, "docs/agents"), { recursive: true });
      fs.writeFileSync(path.join(outer, "docs/agents/verification.md"), "## Protected files\n\n- `sub/keys/token.txt`\n");
      fs.writeFileSync(path.join(sub, "s.txt"), "base\n");
      git(sub, "add", ".");
      git(sub, "commit", "-qm", "init");
      const base = git(sub, "rev-parse", "HEAD").stdout.trim();
      fs.appendFileSync(path.join(sub, "s.txt"), "nested change\n");
      fs.mkdirSync(path.join(sub, "config"));
      fs.writeFileSync(path.join(sub, "config/secrets.yml"), "pw: hunter2\n");
      fs.mkdirSync(path.join(sub, "keys"));
      fs.writeFileSync(path.join(sub, "keys/token.txt"), "s3cret\n");
      const { stdout, reply, patch } = secondOpinion(dir, base, sub);
      assert.match(stdout, /Second opinion written/);
      assert.equal(reply, "NESTED REVIEW\n");
      assert.match(patch, /\+nested change/);
      assert.doesNotMatch(patch, /hunter2|s3cret/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
