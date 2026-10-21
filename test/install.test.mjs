import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import * as checks from "../lib/check-skills.mjs";
import { main, parseArgs, UsageError } from "../lib/cli.mjs";
import { agentNames, compareVersions, markdownTables, missingSettings, ROOT, skillNames, version } from "../lib/install.mjs";
import { FakeGitHub } from "./fake-github.mjs";

const SKILLS = skillNames();

/** Run the command line with scripted answers against a fake GitHub. Resolves to { code, output, asked }. */
async function run(argv, { cwd, interactive = false, answers = {}, github = new FakeGitHub() } = {}) {
  let output = "";
  const sink = { write: (text) => { output += text; } };
  const asked = [];
  const prompts = {
    checkbox: async ({ message, choices }) => {
      asked.push(message);
      return answers.tools ?? choices.filter((c) => c.checked).map((c) => c.value);
    },
    confirm: async ({ message, initial }) => {
      asked.push(message);
      if (message.includes("AGENTS.md")) return answers.instructions ?? initial;
      if (message.includes("Overwrite")) return answers.overwrite ?? false;
      if (message.includes("Install gh")) return answers.installGh ?? initial;
      if (message.includes("Log in")) return answers.login ?? initial;
      if (message.includes("scope")) return answers.refresh ?? initial;
      if (message.includes("needs changes")) return answers.repair ?? initial;
      if (message.includes("Create the project board")) return answers.create ?? initial;
      return initial;
    },
    select: async ({ message, choices }) => {
      asked.push(message);
      return answers.board ? answers.board(choices) : choices[0].value;
    },
  };
  const io = { cwd: cwd ?? process.cwd(), stdout: sink, stderr: sink, interactive, prompts, github: github.io() };
  const code = await main(argv, io);
  return { code, output, asked };
}

/** A temporary folder that is a Git repository with a GitHub origin, unless remote is null. */
function tempProject(name = "project", remote = `https://github.com/acme/${name}.git`) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-"));
  const project = path.join(dir, name);
  fs.mkdirSync(project);
  if (remote !== null) {
    spawnSync("git", ["init", "-q", project]);
    if (remote) spawnSync("git", ["-C", project, "remote", "add", "origin", remote]);
  }
  return { dir, project };
}

/** A fake GitHub whose repository already has a linked board the workflow can use as it is. */
function readyGitHub(nameWithOwner = "acme/project") {
  const github = new FakeGitHub();
  github.addBoard({ title: "Sprints", linkedTo: nameWithOwner, statuses: ["Todo", "In progress", "In review", "Done"],
    iteration: "Sprint" });
  return github;
}

const read = (project, relative) => fs.readFileSync(path.join(project, relative), "utf8");
const exists = (project, relative) => fs.existsSync(path.join(project, relative));
const write = (project, relative, text) => {
  fs.mkdirSync(path.dirname(path.join(project, relative)), { recursive: true });
  fs.writeFileSync(path.join(project, relative), text);
};
const template = (name) => fs.readFileSync(path.join(ROOT, "skills/setup-project/templates", name), "utf8");

describe("install", () => {
  let dir;
  let project;
  beforeEach(() => ({ dir, project } = tempProject()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Each run gets a new fake GitHub, so --yes lets it create the board again.
  const install = (...argv) => run(["install", project, "--yes", ...argv]);

  test("writes skills, references, adapters, the checker, and the manifest", async () => {
    const { code, output } = await install();
    assert.equal(code, 0, output);
    for (const name of SKILLS) {
      assert.ok(exists(project, `.agents/skills/${name}/SKILL.md`));
      assert.ok(exists(project, `.claude/skills/${name}/SKILL.md`));
      assert.ok(exists(project, `.cursor/skills/${name}/SKILL.md`));
    }
    assert.equal(exists(project, ".kiro"), false);
    assert.ok(exists(project, ".agents/references/platforms/game.md"));
    assert.ok(exists(project, ".agents/scripts/check-skills.mjs"));
    assert.equal(read(project, ".agents/agent-fleet-LICENSE"), fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8"));
    for (const name of SKILLS.filter((skill) => fs.existsSync(path.join(ROOT, "skills", skill, "LICENSE")))) {
      assert.ok(exists(project, `.agents/skills/${name}/LICENSE`), name);
    }
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    assert.deepEqual(manifest.harnesses, ["claude", "cursor"]);
    assert.equal(manifest.instructions, true);
    assert.deepEqual(checks.check(project), []);
    assert.match(output, /setup-project/);
  });

  test("writes only the tracker settings in the profile", async () => {
    await install();
    assert.deepEqual(fs.readdirSync(path.join(project, "docs/agents")), ["issue-tracker.md"]);
  });

  test("scripts stay executable", { skip: process.platform === "win32" }, async () => {
    await install();
    const mode = fs.statSync(path.join(project, ".agents/skills/sprint-status/scripts/sprint-data.mjs")).mode;
    assert.ok(mode & 0o100);
  });

  test("a second install changes nothing", async () => {
    await install();
    const { code, output } = await install();
    assert.equal(code, 0, output);
    assert.match(output, /: \d+ unchanged\./);
    assert.doesNotMatch(output, /does not manage/);
  });

  test("adapters copy only the fields each tool reads", async () => {
    await install("--claude", "--cursor", "--kiro");
    const claude = read(project, ".claude/skills/sprint-status/SKILL.md");
    assert.match(claude, /allowed-tools:/);
    assert.doesNotMatch(read(project, ".cursor/skills/sprint-status/SKILL.md"), /allowed-tools:/);
    assert.doesNotMatch(read(project, ".kiro/skills/sprint-status/SKILL.md"), /allowed-tools:/);
    assert.ok(claude.endsWith(
      "Read `../../../.agents/skills/sprint-status/SKILL.md` and follow that canonical workflow in full.\n"));
  });

  test("a local change to a fleet file blocks the update until forced", async () => {
    await install();
    const edited = path.join(project, ".agents/skills/tdd/SKILL.md");
    fs.appendFileSync(edited, "\nLocal edit.\n");
    const blocked = await install();
    assert.equal(blocked.code, 1);
    assert.match(blocked.output, /changed since the fleet installed it/);
    assert.match(fs.readFileSync(edited, "utf8"), /Local edit\./);
    assert.ok(checks.check(project).some((e) => e.includes("tdd/SKILL.md")));
    const forced = await install("--force");
    assert.equal(forced.code, 0);
    assert.doesNotMatch(fs.readFileSync(edited, "utf8"), /Local edit\./);
    assert.doesNotMatch(forced.output, /had not installed/);
  });

  test("never overwrites skills from another workflow", async () => {
    const foreign = path.join(project, ".agents/skills/start-issue/SKILL.md");
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(foreign, "---\nname: start-issue\ndescription: A project's own version.\n---\n\nBody.\n");
    const { code, output } = await install();
    assert.equal(code, 1);
    assert.match(output, /was not installed by the fleet/);
    assert.match(fs.readFileSync(foreign, "utf8"), /A project's own version\./);
    assert.equal(exists(project, checks.MANIFEST), false);
    assert.equal(exists(project, ".agents/skills/tdd"), false);
  });

  test("--force names the files it replaced that the fleet had not installed", async () => {
    write(project, ".agents/skills/start-issue/SKILL.md",
      "---\nname: start-issue\ndescription: A project's own version.\n---\n\nBody.\n");
    const { code, output } = await install("--force");
    assert.equal(code, 0, output);
    assert.match(output, /replaced these files, which the fleet had not installed:\n {2}\.agents\/skills\/start-issue\/SKILL\.md\n/);
    assert.match(output, /previous versions remain in Git/);
    assert.match(output, /setup-project next\. It reads them to carry any project facts into docs\/agents\//);
  });

  test("dropping a tool removes its adapters", async () => {
    await install("--claude", "--kiro");
    assert.ok(exists(project, ".kiro/skills/tdd/SKILL.md"));
    const { code, output } = await install("--claude");
    assert.equal(code, 0, output);
    assert.equal(exists(project, ".kiro"), false);
    assert.ok(exists(project, ".claude/skills/tdd/SKILL.md"));
    assert.deepEqual(checks.check(project), []);
  });

  test("an update keeps the installed tools", async () => {
    await install("--cursor");
    await run(["update", project, "--yes"]);
    assert.equal(exists(project, ".claude"), false);
    assert.ok(exists(project, ".cursor/skills/tdd/SKILL.md"));
  });

  test("an installation whose check fails still names the next steps", async () => {
    write(project, ".agents/skills/House_Style/SKILL.md", "---\nname: House_Style\ndescription: Mine.\n---\n\nBody.\n");
    const { code, output } = await install();
    assert.equal(code, 1, output);
    assert.match(output, /found problems:\n- House_Style: name must be lowercase words/);
    assert.match(output, /Next:.*setup-project/);
  });

  test("an update notes paths in .agents/skills/ that the fleet does not manage", async () => {
    await install();
    write(project, ".agents/skills/sprint-status/scripts/old-collector.mjs", "// left over\n");
    write(project, ".agents/skills/house-notes/notes.md", "Notes.\n");
    write(project, ".agents/skills/house-style/SKILL.md", "---\nname: house-style\ndescription: The project's own skill.\n---\n\nBody.\n");
    const { code, output } = await run(["update", project, "--yes"]);
    assert.equal(code, 0, output);
    assert.match(output, /the fleet does not manage these skill paths:\n {2}\.agents\/skills\/house-notes\/\n {2}\.agents\/skills\/house-style\/\n {2}\.agents\/skills\/sprint-status\/scripts\/old-collector\.mjs\n/);
    assert.match(output, /A path left over from an earlier copy of the fleet can be deleted\. A project's own skill can stay, unless it does the same job as a fleet skill, which setup-project checks\. In \.agents\/skills\/, its frontmatter and links are checked like the fleet's\./);
    assert.doesNotMatch(output, /found problems/);
    assert.ok(exists(project, ".agents/skills/sprint-status/scripts/old-collector.mjs"));
    assert.equal(exists(project, ".claude/skills/house-style"), false);
  });

  test("refuses to run over an installation by a newer version, unless forced", async () => {
    await install();
    const [major, minor] = version().split(".").map(Number);
    // Newer by number. While the minor version is below 10, it sorts first as a string, as 1.14.0 does before 1.4.0.
    const newer = `${major}.${minor + 10}.0`;
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    fs.writeFileSync(path.join(project, checks.MANIFEST), JSON.stringify({ ...manifest, version: newer }));
    const recorded = read(project, checks.MANIFEST);
    for (const [command, argv, cwd] of [["install", [project], dir], ["update", [], project]]) {
      const github = new FakeGitHub();
      const { code, output } = await run([command, ...argv, "--yes"], { github, cwd });
      assert.equal(code, 1, output);
      assert.ok(output.includes(`installed with agent-fleet ${newer}, which is newer than this agent-fleet ${version()}`));
      const again = [command, ...argv].join(" ");
      assert.ok(output.includes(`Run npx agent-fleet@${newer} ${again}, or npx agent-fleet@latest ${again} once ${newer} is published`),
        output);
      assert.deepEqual(github.calls, []);
    }
    assert.equal(read(project, checks.MANIFEST), recorded);
    const forced = await install("--force");
    assert.equal(forced.code, 0, forced.output);
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).version, version());
  });

  test("an installation by an older version updates", async () => {
    await install();
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    fs.writeFileSync(path.join(project, checks.MANIFEST), JSON.stringify({ ...manifest, version: "0.9.0" }));
    const { code, output } = await install();
    assert.equal(code, 0, output);
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).version, version());
  });

  test("next steps name the profile settings the templates have and the project lacks", async () => {
    // verification.md: a second component section that lacks a row the template has.
    const verification = template("verification.md").replaceAll("TODO", "Filled");
    const [settings] = markdownTables(template("verification.md")).filter((t) => t.header[0] === "Setting");
    const setting = settings.rows[1][0];
    const first = verification.slice(verification.indexOf("### "), verification.indexOf("\n## ", verification.indexOf("### ")));
    const second = first.replace(/^### .*$/m, "### Worker (`worker/`)").split("\n")
      .filter((line) => !line.startsWith(`| ${setting} |`)).join("\n");
    write(project, "docs/agents/verification.md", verification.replace(first, `${first}\n${second}`));
    // domain.md: a boundaries table without the template's last column.
    const boundaries = markdownTables(template("domain.md")).find((t) => t.section === "Boundaries");
    const column = boundaries.header.at(-1);
    write(project, "docs/agents/domain.md", template("domain.md").replaceAll("TODO", "Filled").split("\n")
      .map((line) => (line.startsWith(`| ${boundaries.header[0]} |`) ? `| ${boundaries.header.slice(0, -1).join(" | ")} |` : line))
      .join("\n"));
    // issue-tracker.md: no Labels row, and a routing table with only its first and last columns.
    const routing = markdownTables(template("issue-tracker.md")).find((t) => t.section === "Routing").header;
    write(project, "docs/agents/issue-tracker.md", template("issue-tracker.md").replaceAll("TODO", "Filled").split("\n")
      .filter((line) => !line.startsWith("| Labels |"))
      .map((line) => (line.startsWith(`| ${routing[0]} |`) ? `| ${routing[0]} | ${routing.at(-1)} |` : line))
      .join("\n"));
    const { code, output } = await install();
    assert.equal(code, 0, output);
    assert.ok(output.includes(
      `  - add the settings missing from docs/agents/verification.md: the ${setting} row under Worker (\`worker/\`)\n`), output);
    assert.ok(output.includes(
      `  - add the settings missing from docs/agents/domain.md: the Boundaries table's ${column} column\n`), output);
    assert.ok(output.includes("  - add the settings missing from docs/agents/issue-tracker.md: the Labels row; "
      + `the Routing table's ${routing[1]} and ${routing[2]} columns\n`), output);
    // A domain.md without a Boundaries section is asked for the whole table, and one that records None is not.
    const domain = read(project, "docs/agents/domain.md");
    write(project, "docs/agents/domain.md", domain.replace(/^## Boundaries\n[\s\S]*?(?=^## )/m, ""));
    const without = await run(["update", project, "--yes"]);
    assert.equal(without.code, 0, without.output);
    assert.ok(without.output.includes("  - add the settings missing from docs/agents/domain.md: the Boundaries table\n"),
      without.output);
    write(project, "docs/agents/domain.md", domain.replace(/^## Boundaries\n[\s\S]*?(?=^## )/m, "## Boundaries\n\nNone.\n\n"));
    const none = await run(["update", project, "--yes"]);
    assert.equal(none.code, 0, none.output);
    assert.doesNotMatch(none.output, /missing from docs\/agents\/domain\.md/);
  });

  test("update stops when nothing is installed", async () => {
    const { code, output } = await run(["update", project]);
    assert.equal(code, 1);
    assert.match(output, /not installed/);
  });

  test("a dry run writes nothing", async () => {
    const { code, output } = await install("--dry-run");
    assert.equal(code, 0);
    assert.match(output, /would create/);
    assert.deepEqual(fs.readdirSync(project), [".git"]);
  });

  test("refuses to install into the fleet itself", async () => {
    const { code, output } = await run(["install", path.join(ROOT, "skills")]);
    assert.equal(code, 1);
    assert.match(output, /not into the agent fleet itself/);
  });

  test("the project defaults to the current directory", async () => {
    const { code } = await run(["--yes"], { cwd: project });
    assert.equal(code, 0);
    assert.ok(exists(project, ".agents/skills/tdd/SKILL.md"));
  });

  test("takes over a project that skill-fleet installed", async () => {
    await install();
    // Recreate what skill-fleet 1.5.1 left: its manifest, its licence copy, and its markers.
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    const licence = fs.readFileSync(path.join(ROOT, "LICENSE"));
    fs.renameSync(path.join(project, ".agents/agent-fleet-LICENSE"), path.join(project, ".agents/skill-fleet-LICENSE"));
    delete manifest.files[".agents/agent-fleet-LICENSE"];
    manifest.files[".agents/skill-fleet-LICENSE"] = checks.sha256(licence);
    fs.writeFileSync(path.join(project, checks.LEGACY_MANIFEST),
      JSON.stringify({ ...manifest, fleet: "skill-fleet", version: "9.9.9" }));
    fs.rmSync(path.join(project, checks.MANIFEST));
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      write(project, name, read(project, name).replaceAll("agent-fleet:", "skill-fleet:"));
    }
    const { code, output } = await run(["update", project, "--yes"]);
    assert.equal(code, 0, output);
    assert.match(output, /takes the installation over/);
    assert.equal(exists(project, checks.LEGACY_MANIFEST), false);
    assert.equal(exists(project, ".agents/skill-fleet-LICENSE"), false);
    assert.ok(exists(project, ".agents/agent-fleet-LICENSE"));
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).fleet, "agent-fleet");
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      assert.doesNotMatch(read(project, name), /skill-fleet:/, name);
      assert.match(read(project, name), /<!-- agent-fleet:begin/, name);
    }
    assert.deepEqual(checks.check(project), []);
  });

  test("a takeover names the old manifest in a dry run, and stops on a corrupt one", async () => {
    await install();
    fs.renameSync(path.join(project, checks.MANIFEST), path.join(project, checks.LEGACY_MANIFEST));
    const dry = await run(["update", project, "--yes", "--dry-run"]);
    assert.match(dry.output, /would delete \.agents\/skill-fleet\.json/);
    write(project, checks.LEGACY_MANIFEST, "{ broken");
    const broken = await run(["update", project, "--yes"]);
    assert.equal(broken.code, 1);
    assert.match(broken.output, /skill-fleet\.json is not valid JSON/);
  });

  test("upgrades a project installed by the Python version of the fleet", async () => {
    await install();
    // Recreate the files the Python installer wrote, recorded in its manifest.
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    delete manifest.instructions;
    const old = {
      ".agents/scripts/check_skills.py": "# old checker\n",
      ".agents/skills/sprint-status/scripts/sprint_data.py": "# old collector\n",
      ".agents/skills/sprint-recap/scripts/test_sprint_recap.py": "# old tests\n",
    };
    for (const [relative, content] of Object.entries(old)) {
      fs.writeFileSync(path.join(project, relative), content);
      manifest.files[relative] = checks.sha256(content);
    }
    fs.writeFileSync(path.join(project, checks.MANIFEST), JSON.stringify(manifest));
    const { code, output } = await install();
    assert.equal(code, 0, output);
    for (const relative of Object.keys(old)) assert.equal(exists(project, relative), false, relative);
    assert.deepEqual(checks.check(project), []);
  });
});

describe("agent team", () => {
  let dir;
  let project;
  beforeEach(() => ({ dir, project } = tempProject()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const install = (...argv) => run(["install", project, "--yes", ...argv]);
  const settings = () => JSON.parse(read(project, ".claude/settings.json"));
  const hookCommands = (value) => JSON.stringify(value.hooks ?? {});

  test("Claude Code gets the agents, the gate, the automations, and the merged settings", async () => {
    const { code, output } = await install();
    assert.equal(code, 0, output);
    for (const name of agentNames()) assert.ok(exists(project, `.claude/agents/${name}.md`), name);
    for (const file of ["gate.mjs", "second-opinion.mjs"]) assert.ok(exists(project, `.agents/scripts/${file}`), file);
    assert.ok(exists(project, ".claude/automations/README.md"));
    assert.equal(read(project, ".claude/agent-memory-local/.gitignore"), "*\n!.gitignore\n");
    assert.match(hookCommands(settings()), /gate\.mjs hook bash-guard/);
    assert.ok(settings().permissions.deny.includes("Bash(gh pr merge *)"));
    assert.ok(JSON.parse(read(project, checks.MANIFEST)).settings.owned.length > 10);
    assert.match(checks.findBlock(read(project, "AGENTS.md")), /claude --agent engineering-lead/);
    assert.match(output, /create [^\n]*docs\/agents\/autonomy\.md/);
    assert.deepEqual(checks.check(project), []);
  });

  test("without Claude Code there is no team", async () => {
    const { code, output } = await install("--cursor");
    assert.equal(code, 0, output);
    for (const relative of [".claude", ".agents/scripts/gate.mjs"]) assert.equal(exists(project, relative), false, relative);
    assert.doesNotMatch(output, /autonomy\.md/);
    assert.doesNotMatch(checks.findBlock(read(project, "AGENTS.md")), /engineering-lead/);
  });

  test("the team's settings merge with the project's own, and leave with Claude Code", async () => {
    write(project, ".claude/settings.json", JSON.stringify({
      model: "opus",
      permissions: { allow: ["Bash(npm test)"], deny: ["Bash(gh pr merge *)"] },
      hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "npm run lint" }] }] },
    }, null, 2));
    assert.equal((await install()).code, 0);
    let merged = settings();
    assert.equal(merged.model, "opus");
    assert.ok(merged.permissions.allow.includes("Bash(npm test)"));
    assert.equal(merged.permissions.deny.filter((rule) => rule === "Bash(gh pr merge *)").length, 1);
    assert.match(hookCommands(merged), /npm run lint/);
    assert.match(hookCommands(merged), /hook verifier-stop/);
    const again = await install();
    assert.match(again.output, /: \d+ unchanged\./);

    const { code, output } = await install("--cursor");
    assert.equal(code, 0, output);
    merged = settings();
    assert.equal(merged.model, "opus");
    assert.deepEqual(merged.permissions, { allow: ["Bash(npm test)"], deny: ["Bash(gh pr merge *)"] });
    assert.doesNotMatch(hookCommands(merged), /gate\.mjs/);
    assert.match(hookCommands(merged), /npm run lint/);
    assert.equal(exists(project, ".claude/agents"), false);
    assert.deepEqual(checks.check(project), []);
  });

  test("an entry removed by hand stays out until forced, and the checker reports it", async () => {
    await install();
    const edited = settings();
    edited.hooks.SubagentStop = [];
    write(project, ".claude/settings.json", JSON.stringify(edited, null, 2));
    assert.match(checks.check(project).join("\n"), /lacks 1 of the agent team's entries/);
    const { code, output } = await install();
    assert.equal(code, 0, output);
    assert.match(output, /removed by hand, so they stay out/);
    assert.doesNotMatch(hookCommands(settings()), /verifier-stop/);
    assert.deepEqual(checks.check(project), []);
    await install("--force");
    assert.match(hookCommands(settings()), /verifier-stop/);
  });

  test("a yes to the conflicts overwrites files but restores nothing the project removed", async () => {
    await install();
    const edited = settings();
    edited.hooks.SubagentStop = [];
    write(project, ".claude/settings.json", JSON.stringify(edited, null, 2));
    write(project, ".agents/skills/tdd/SKILL.md", "changed by hand\n");
    const { code, output } = await run(["install", project], { interactive: true, answers: { overwrite: true } });
    assert.equal(code, 0, output);
    assert.notEqual(read(project, ".agents/skills/tdd/SKILL.md"), "changed by hand\n");
    assert.doesNotMatch(hookCommands(settings()), /verifier-stop/);
  });

  test("a fresh clone that ignores agent memory checks out", async () => {
    write(project, ".gitignore", ".claude/agent-memory-local/\n");
    await install();
    fs.rmSync(path.join(project, ".claude/agent-memory-local"), { recursive: true });
    assert.deepEqual(checks.check(project), []);
  });

  test("dropping Claude Code points out leftover memory and hooks", async () => {
    await install();
    write(project, ".claude/agent-memory-local/verifier/MEMORY.md", "notes\n");
    const edited = settings();
    edited.hooks.PreToolUse[0].hooks[0].timeout = 30;
    write(project, ".claude/settings.json", JSON.stringify(edited, null, 2));
    const { code, output } = await install("--cursor");
    assert.equal(code, 0, output);
    assert.match(output, /agent-memory-local\/ still holds/);
    assert.match(output, /still has a hook that calls gate\.mjs/);
  });

  test("invalid settings are left alone with a note", async () => {
    write(project, ".claude/settings.json", "{ not json");
    const { output } = await install();
    assert.match(output, /not valid JSON/);
    assert.equal(read(project, ".claude/settings.json"), "{ not json");
  });
});

describe("AGENTS.md and CLAUDE.md", () => {
  let dir;
  let project;
  beforeEach(() => ({ dir, project } = tempProject("demo-game")));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const install = (...argv) => run(["install", project, "--yes", ...argv]);

  test("new files name the project from its Git remote", async () => {
    spawnSync("git", ["-C", project, "remote", "set-url", "origin", "git@github.com:acme/space-game.git"]);
    const { code, output } = await install();
    assert.equal(code, 0, output);
    const agents = read(project, "AGENTS.md");
    assert.ok(agents.startsWith("# space-game\n"));
    assert.ok(agents.includes("[`acme/space-game`](https://github.com/acme/space-game)"));
    const block = checks.findBlock(agents);
    assert.match(block, /## Agent workflow/);
    assert.ok(block.includes("When the board is missing or incomplete, or the fleet's files need an update, ask the "
      + "user to run `npx agent-fleet@latest update --dry-run` and then `npx agent-fleet@latest update` in their own "
      + "terminal. Do not run it yourself without the user's approval. If the user asks you to run it, run "
      + "`npx agent-fleet@latest update --dry-run --yes` and show the user the plan it prints. Run "
      + "`npx agent-fleet@latest update --yes` only after the user approves that exact plan, with the same flags"), block);
    assert.match(block, /Adding `--force`, which overwrites files changed by hand, needs its own approval\./);
    assert.match(block, /Do not edit by hand the files that `\.agents\/agent-fleet\.json` records/);
    assert.match(block, /Put a project's own skill in its own folder under `\.agents\/skills\/`, and add nothing inside a fleet skill's folder or `\.agents\/references\/`\./);
    assert.match(output, /fill the TODOs in AGENTS\.md/);
    assert.equal(checks.findBlock(read(project, "CLAUDE.md")), "@AGENTS.md\n");
    assert.deepEqual(checks.check(project), []);
  });

  test("an existing AGENTS.md keeps its content", async () => {
    fs.writeFileSync(path.join(project, "AGENTS.md"), "# Mine\n\nKeep this rule.\n");
    for (const name of ["issue-tracker.md", "domain.md", "verification.md", "autonomy.md"]) {
      write(project, `docs/agents/${name}`, template(name).replaceAll("TODO", "Filled"));
    }
    const first = await install();
    let agents = read(project, "AGENTS.md");
    assert.ok(agents.startsWith("# Mine\n\nKeep this rule.\n\n<!-- agent-fleet:begin"));
    assert.doesNotMatch(first.output, /Next:/);
    const { code, output } = await install("--claude", "--cursor", "--kiro");
    assert.equal(code, 0, output);
    agents = read(project, "AGENTS.md");
    assert.match(checks.findBlock(agents), /`\.kiro\/skills\/`/);
    assert.ok(agents.startsWith("# Mine\n\nKeep this rule.\n"));
    assert.equal(agents.split("agent-fleet:begin").length, 2);
  });

  test("a hand-edited section blocks the update until forced", async () => {
    await install();
    const edited = read(project, "AGENTS.md").replace("## Agent workflow", "## Agent workflow, edited");
    fs.writeFileSync(path.join(project, "AGENTS.md"), edited);
    const blocked = await install("--claude");
    assert.equal(blocked.code, 1);
    assert.match(blocked.output, /AGENTS\.md: its agent-fleet section was edited by hand/);
    assert.equal(read(project, "AGENTS.md"), edited);
    assert.ok(exists(project, ".cursor"));
    assert.ok(checks.check(project).some((e) => e.includes("changed since install")));
    assert.equal((await install("--force")).code, 0);
    assert.doesNotMatch(read(project, "AGENTS.md"), /edited/);
  });

  test("a removed section stays removed", async () => {
    await install();
    fs.writeFileSync(path.join(project, "AGENTS.md"), checks.withoutBlock(read(project, "AGENTS.md")));
    const { code, output } = await install();
    assert.equal(code, 0, output);
    assert.match(output, /removed by hand, so it stays out/);
    assert.equal(checks.findBlock(read(project, "AGENTS.md")), null);
    assert.deepEqual(checks.check(project), []);
    await install("--force");
    assert.notEqual(checks.findBlock(read(project, "AGENTS.md")), null);
  });

  test("an existing Claude import is left alone", async () => {
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "@AGENTS.md\n\nMy notes.\n");
    await install();
    assert.equal(read(project, "CLAUDE.md"), "@AGENTS.md\n\nMy notes.\n");
    assert.deepEqual(checks.check(project), []);
  });

  test("a CLAUDE.md without the import gets it first", async () => {
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "# Old Claude notes\n");
    await install();
    const claude = read(project, "CLAUDE.md");
    assert.ok(claude.startsWith("<!-- agent-fleet:begin"));
    assert.ok(claude.endsWith("\n# Old Claude notes\n"));
  });

  test("without Claude Code no CLAUDE.md is written", async () => {
    await install("--cursor");
    assert.equal(exists(project, "CLAUDE.md"), false);
    const block = checks.findBlock(read(project, "AGENTS.md"));
    assert.match(block, /`\.cursor\/skills\/` holds thin adapters/);
    assert.doesNotMatch(block, /CLAUDE\.md/);
  });

  test("--no-instructions leaves both files alone and is remembered", async () => {
    await install("--no-instructions");
    assert.equal(exists(project, "AGENTS.md"), false);
    assert.equal(exists(project, "CLAUDE.md"), false);
    assert.deepEqual(checks.check(project), []);
    await run(["update", project, "--yes"]);
    assert.equal(exists(project, "AGENTS.md"), false);
  });

  test("the checker reports a lost Claude import", async () => {
    await install();
    fs.writeFileSync(path.join(project, "CLAUDE.md"), "Nothing here.\n");
    const errors = checks.check(project);
    assert.ok(errors.includes("the agent-fleet section in CLAUDE.md is missing. Reinstall to restore it."));
    assert.ok(errors.some((e) => e.includes("does not import AGENTS.md")));
  });
});

describe("questions", () => {
  let dir;
  let project;
  beforeEach(() => ({ dir, project } = tempProject()));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ask = (answers, ...argv) => run(["install", project, ...argv], { interactive: true, answers });

  test("the chosen tools decide the adapters", async () => {
    const { code, asked } = await ask({ tools: ["kiro"] });
    assert.equal(code, 0);
    assert.ok(asked[0].startsWith("Which coding tools"));
    assert.ok(exists(project, ".kiro/skills/tdd/SKILL.md"));
    assert.equal(exists(project, ".claude"), false);
    assert.equal(exists(project, "CLAUDE.md"), false);
  });

  test("declining the instruction files leaves them alone", async () => {
    await ask({ instructions: false });
    assert.equal(exists(project, "AGENTS.md"), false);
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).instructions, false);
  });

  test("flags skip their questions", async () => {
    const { asked } = await run(["install", project, "--cursor", "--no-instructions"],
      { interactive: true, github: readyGitHub() });
    assert.deepEqual(asked, []);
  });

  test("--yes asks nothing", async () => {
    const { asked, code } = await ask({}, "--yes");
    assert.equal(code, 0);
    assert.deepEqual(asked, []);
  });

  test("a conflict asks before overwriting", async () => {
    await ask({});
    const edited = path.join(project, ".agents/skills/tdd/SKILL.md");
    fs.appendFileSync(edited, "\nLocal edit.\n");
    const refused = await ask({ overwrite: false });
    assert.equal(refused.code, 1);
    assert.match(fs.readFileSync(edited, "utf8"), /Local edit\./);
    const accepted = await ask({ overwrite: true });
    assert.equal(accepted.code, 0);
    assert.doesNotMatch(fs.readFileSync(edited, "utf8"), /Local edit\./);
  });

  test("a folder that is not a GitHub repository stops with instructions", async () => {
    for (const remote of [null, "", "https://gitlab.com/acme/app.git"]) {
      const { dir: other, project: plain } = tempProject("plain", remote);
      try {
        const { code, output } = await run(["install", plain], { interactive: true });
        assert.equal(code, 1, String(remote));
        assert.match(output, /must be a GitHub repository/);
        assert.match(output, /gh repo create --source \. --private --push/);
        assert.equal(exists(plain, ".agents"), false);
      } finally {
        fs.rmSync(other, { recursive: true, force: true });
      }
    }
  });
});

describe("GitHub setup", () => {
  let dir;
  let project;
  beforeEach(() => ({ dir, project } = tempProject("space-game")));
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const install = (github, options = {}, ...argv) => run(["install", project, ...argv], { github, ...options });
  const board = (github) => github.boards[0];
  const field = (b, name) => b.fields.find((f) => f.name === name);

  test("creates a linked board with the workflow's statuses and sprints", async () => {
    const github = new FakeGitHub();
    const { code, output } = await install(github, {}, "--yes");
    assert.equal(code, 0, output);
    assert.match(output, /How the workflow runs/);
    assert.match(output, /Created the project board "space-game Sprints"/);
    const created = board(github);
    assert.ok(github.repo("acme/space-game").linked.has(created.id));
    assert.deepEqual(field(created, "Status").options.map((o) => o.name), ["Todo", "In progress", "In review", "Done"]);
    const sprint = field(created, "Sprint");
    assert.equal(sprint.dataType, "ITERATION");
    assert.equal(sprint.configuration.duration, 14);
    assert.equal(sprint.configuration.startDate, "2026-09-21");
    assert.equal(sprint.configuration.iterations.length, 6);
    assert.equal(sprint.configuration.iterations[1].startDate, "2026-10-05");
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    assert.deepEqual(manifest.github, { repository: "acme/space-game",
      board: { owner: "acme", number: 1, title: "space-game Sprints", url: created.url } });
    const tracker = read(project, "docs/agents/issue-tracker.md");
    assert.match(tracker, /^\| Project board \| `space-game Sprints` owned by `acme`: https:\/\/github\.com\/users\/acme\/projects\/1 \|$/m);
    assert.match(tracker, /^\| Lifecycle statuses \| new → `Todo`; started → `In progress`; in review → `In review`; done → `Done`\. \|$/m);
    assert.match(tracker, /^\| Iteration field \| `Sprint`\. \|$/m);
    assert.match(tracker, /^\| Sprint time zone \| `Europe\/Berlin`\. \|$/m);
    assert.match(tracker, /^\| Owner type \| `User`\. \|$/m);
    assert.match(tracker, /^## Routing/m);
  });

  test("a second install reuses the board and changes nothing on GitHub", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const before = github.mutations().length;
    const { code, output } = await install(github);
    assert.equal(code, 0, output);
    assert.equal(github.boards.length, 1);
    assert.equal(github.mutations().length, before);
    assert.doesNotMatch(output, /How the workflow runs/);
  });

  test("without a terminal or --yes, a board change stops before anything is written", async () => {
    const github = new FakeGitHub();
    const created = await install(github);
    assert.equal(created.code, 1);
    assert.match(created.output, /makes them only with your consent:\n {2}- create the project board "space-game Sprints" owned by acme/);
    assert.ok(created.output.includes("Nothing was written, on GitHub or on disk. To go on, rerun in a terminal to be "
      + "asked first, rerun with --yes to make the changes, or name an existing board with --board <number or title>.\n"));
    const repair = new FakeGitHub();
    repair.addBoard({ title: "Roadmap", linkedTo: "acme/space-game" });
    const repaired = await install(repair);
    assert.equal(repaired.code, 1);
    assert.match(repaired.output, /- add In review to the Status field on "Roadmap"/);
    assert.match(repaired.output, /To go on, rerun in a terminal to be asked first, or rerun with --yes to make the changes\.\n/);
    const named = new FakeGitHub();
    named.addBoard({ title: "Team board" });
    const linked = await install(named, {}, "--board", "Team board");
    assert.equal(linked.code, 1);
    assert.match(linked.output, /- link the project board "Team board" to acme\/space-game/);
    assert.match(linked.output, /- add a Sprint field with 2-week sprints on "Team board"/);
    for (const fake of [github, repair, named]) assert.equal(fake.mutations().length, 0);
    assert.deepEqual(fs.readdirSync(project), [".git"]);
  });

  test("--yes creates or repairs the board without a terminal", async () => {
    const github = new FakeGitHub();
    const roadmap = github.addBoard({ title: "Roadmap", linkedTo: "acme/space-game" });
    const { code, output, asked } = await install(github, {}, "--yes");
    assert.equal(code, 0, output);
    assert.deepEqual(asked, []);
    assert.match(output, /Updated the project board "Roadmap"/);
    assert.ok(field(roadmap, "Status").options.some((o) => o.name === "In review"));
  });

  test("an interactive run asks before it creates a board", async () => {
    const github = new FakeGitHub();
    const declined = await install(github, { interactive: true, answers: { create: false } });
    assert.equal(declined.code, 1);
    assert.ok(declined.asked.some((q) => q.startsWith(
      'No project board is linked to acme/space-game. Create the project board "space-game Sprints"')));
    assert.match(declined.output, /needs a project board\. Nothing was written\. To use a board of your own, create or reopen it on GitHub/);
    assert.equal(github.mutations().length, 0);
    assert.deepEqual(fs.readdirSync(project), [".git"]);
    const accepted = await install(github, { interactive: true });
    assert.equal(accepted.code, 0, accepted.output);
    assert.equal(github.boards.length, 1);
  });

  test("an existing linked board is repaired without losing its options", async () => {
    const github = new FakeGitHub();
    const existing = github.addBoard({ title: "Roadmap", linkedTo: "acme/space-game", statuses: ["Todo", "In Progress", "Done"] });
    const ids = field(existing, "Status").options.map((o) => o.id);
    const { code, output, asked } = await install(github, { interactive: true });
    assert.equal(code, 0, output);
    assert.ok(asked.some((q) => q.includes('"Roadmap" needs changes')));
    const options = field(existing, "Status").options;
    assert.deepEqual(options.map((o) => o.name), ["Todo", "In Progress", "Done", "In review"]);
    assert.deepEqual(options.slice(0, 3).map((o) => o.id), ids);
    assert.equal(field(existing, "Sprint").dataType, "ITERATION");
    assert.equal(github.boards.length, 1);
    assert.match(read(project, "docs/agents/issue-tracker.md"), /started → `In Progress`/);
  });

  test("an existing iteration field is kept under its own name", async () => {
    const github = new FakeGitHub();
    github.addBoard({ title: "Board", linkedTo: "acme/space-game", statuses: ["Todo", "In progress", "In review", "Done"],
      iteration: "Iteration" });
    const { code } = await install(github);
    assert.equal(code, 0);
    assert.equal(github.mutations().length, 0);
    assert.match(read(project, "docs/agents/issue-tracker.md"), /^\| Iteration field \| `Iteration`\. \|$/m);
  });

  test("declining the repair stops before writing anything", async () => {
    const github = new FakeGitHub();
    github.addBoard({ title: "Roadmap", linkedTo: "acme/space-game" });
    const { code, output } = await install(github, { interactive: true, answers: { repair: false } });
    assert.equal(code, 1);
    assert.match(output, /needs those changes/);
    assert.equal(github.mutations().length, 0);
    assert.equal(exists(project, ".agents"), false);
  });

  test("several linked boards need a choice", async () => {
    const github = new FakeGitHub();
    github.addBoard({ title: "One", linkedTo: "acme/space-game" });
    github.addBoard({ title: "Two", linkedTo: "acme/space-game" });
    const refused = await install(github);
    assert.equal(refused.code, 1);
    assert.match(refused.output, /Choose one with --board: #1 "One", #2 "Two"/);
    const chosen = await install(github, { interactive: true, answers: { board: (choices) => choices[1].value } });
    assert.equal(chosen.code, 0, chosen.output);
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).github.board.title, "Two");
  });

  test("--board links one of the owner's boards, without --yes", async () => {
    const github = new FakeGitHub();
    const other = github.addBoard({ title: "Team board", statuses: ["Todo", "In progress", "In review", "Done"],
      iteration: "Sprint" });
    const { code, output } = await install(github, {}, "--board", "Team board");
    assert.equal(code, 0, output);
    assert.ok(github.repo("acme/space-game").linked.has(other.id));
    assert.match(output, /Linked the project board "Team board"/);
    assert.equal(github.boards.length, 1);
  });

  test("with no linked board, a user can pick one of the owner's boards", async () => {
    const github = new FakeGitHub();
    const other = github.addBoard({ title: "Team board", statuses: ["Todo", "In progress", "In review", "Done"],
      iteration: "Sprint" });
    const { code, asked } = await install(github, { interactive: true,
      answers: { board: (choices) => choices.find((c) => c.value?.title === "Team board").value } });
    assert.equal(code, 0);
    assert.ok(asked.some((q) => q.startsWith("No project board is linked")));
    assert.ok(github.repo("acme/space-game").linked.has(other.id));
  });

  test("an update links the recorded board again instead of creating a second one", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const recorded = board(github);
    github.repo("acme/space-game").linked.clear();
    const update = (...argv) => run(["update", project, ...argv], { github });
    const preview = await update("--dry-run");
    assert.equal(preview.code, 0, preview.output);
    assert.match(preview.output, /#1, is no longer linked to acme\/space-game/);
    assert.match(preview.output, /would link the project board "space-game Sprints" to acme\/space-game/);
    assert.doesNotMatch(preview.output, /would create the project board/);
    const refused = await update();
    assert.equal(refused.code, 1);
    assert.match(refused.output, /- link the project board "space-game Sprints" to acme\/space-game\n/);
    assert.match(refused.output, /or rerun with --board 1 to link that board\.\n/);
    const before = github.mutations().length;
    const { code, output } = await update("--yes");
    assert.equal(code, 0, output);
    const mutations = github.mutations().slice(before);
    assert.equal(mutations.length, 1);
    assert.match(mutations[0].query, /linkProjectV2ToRepository/);
    assert.ok(github.repo("acme/space-game").linked.has(recorded.id));
    assert.deepEqual(github.boards.map((b) => b.title), ["space-game Sprints"]);
    assert.doesNotMatch(output, /does not name the board/);
  });

  test("the --board hint for a recorded board that also needs repairs adds --yes", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const recorded = board(github);
    github.repo("acme/space-game").linked.clear();
    recorded.fields = recorded.fields.filter((f) => f.name !== "Sprint");
    const refused = await run(["update", project], { github });
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /- add a Sprint field with 2-week sprints on "space-game Sprints"\n/);
    assert.match(refused.output, /or rerun with --board 1 --yes to link that board and make the repairs\.\n/);
    assert.equal((await run(["update", project, "--board", "1"], { github })).code, 1);
    const { code, output } = await run(["update", project, "--board", "1", "--yes"], { github });
    assert.equal(code, 0, output);
    assert.ok(github.repo("acme/space-game").linked.has(recorded.id));
    assert.ok(recorded.fields.some((f) => f.name === "Sprint"));
  });

  test("a closed recorded board is named as closed, and never replaced by a board with its title", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const recorded = board(github);
    // Closed, but still linked to the repository.
    recorded.closed = true;
    const update = (...argv) => run(["update", project, ...argv], { github });
    const refused = await update("--yes");
    assert.equal(refused.code, 1, refused.output);
    assert.match(refused.output, /The board recorded at the last installation, #1 "space-game Sprints", is closed\. To use it again, reopen it on GitHub and rerun agent-fleet\.\n/);
    assert.doesNotMatch(refused.output, /no longer linked/);
    assert.match(refused.output, /agent-fleet does not replace it with a new board\. Nothing was written\. Reopen it on GitHub and rerun agent-fleet, or name another board with --board <number or title>\.\n/);
    const preview = await update("--dry-run", "--yes");
    assert.equal(preview.code, 1, preview.output);
    assert.match(preview.output, /The run would stop at the project board: The board recorded at the last installation, #1 "space-game Sprints", is closed/);
    assert.doesNotMatch(preview.output, /would create the project board/);
    // In a terminal, another board can be chosen, but no choice creates one.
    const roadmap = github.addBoard({ title: "Roadmap", statuses: ["Todo", "In progress", "In review", "Done"],
      iteration: "Sprint" });
    let choices;
    const chosen = await run(["update", project], { github, interactive: true,
      answers: { board: (offered) => { choices = offered; return offered[0].value; } } });
    assert.equal(chosen.code, 0, chosen.output);
    assert.deepEqual(choices.map((c) => c.label), ["Roadmap"]);
    assert.ok(github.repo("acme/space-game").linked.has(roadmap.id));
    const named = await install(github, {}, "--board", "1");
    assert.equal(named.code, 1, named.output);
    assert.match(named.output, /acme's project board #1 "space-game Sprints" is closed\. Reopen it on GitHub, then rerun with --board 1\./);
    assert.equal(github.boards.filter((b) => b.title === "space-game Sprints").length, 1);
  });

  test("a deleted recorded board is named as gone, and --yes creates a new one", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    github.deleteBoard(board(github).id);
    const { code, output } = await run(["update", project, "--yes"], { github });
    assert.equal(code, 0, output);
    assert.match(output, /The board recorded at the last installation, #1, is no longer on GitHub, or this account cannot see it\.\n/);
    assert.match(output, /Created the project board "space-game Sprints"/);
    assert.deepEqual(github.boards.map((b) => b.number), [2]);
    assert.equal(JSON.parse(read(project, checks.MANIFEST)).github.board.number, 2);
  });

  test("the recorded board is linked again next to another board with the workflow's title, with a warning", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const recorded = board(github);
    github.repo("acme/space-game").linked.clear();
    const twin = github.addBoard({ title: "space-game Sprints" });
    const preview = await run(["update", project, "--dry-run", "--yes"], { github });
    assert.equal(preview.code, 0, preview.output);
    assert.match(preview.output, /would link the project board "space-game Sprints" to acme\/space-game/);
    const { code, output } = await run(["update", project, "--yes"], { github });
    assert.equal(code, 0, output);
    assert.ok(github.repo("acme/space-game").linked.has(recorded.id));
    assert.equal(github.repo("acme/space-game").linked.has(twin.id), false);
    assert.equal(github.boards.length, 2);
    assert.match(output, /acme has another open project board titled "space-game Sprints", #2\. The sprint skills find the board by its title, so they stop while two open boards have it\. Rename or close #2 on GitHub\.\n/);
  });

  test("in a terminal, the recorded board is the first choice", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    github.addBoard({ title: "Roadmap" });
    github.repo("acme/space-game").linked.clear();
    let choices;
    const { code, output } = await install(github, { interactive: true,
      answers: { board: (offered) => { choices = offered; return offered[0].value; } } });
    assert.equal(code, 0, output);
    assert.deepEqual(choices.map((c) => c.label), ["space-game Sprints", "Roadmap"]);
    assert.match(choices[0].hint, /recorded at the last installation/);
    assert.ok(github.repo("acme/space-game").linked.has(board(github).id));
    assert.equal(github.boards.length, 2);
  });

  test("refuses to create a board whose title an open board of the owner has", async () => {
    const github = new FakeGitHub();
    const namesake = github.addBoard({ title: "space-game Sprints" });
    const refused = await install(github, {}, "--yes");
    assert.equal(refused.code, 1);
    assert.match(refused.output, /acme already has an open project board titled "space-game Sprints", #1, that is not linked/);
    assert.match(refused.output, /which find the board by its title\. Nothing was written\. To use that board, rerun with --board 1\.\n/);
    assert.equal(github.mutations().length, 0);
    assert.equal(exists(project, ".agents"), false);
    // The dry run an agent shows the user names the same stop, still lists the files, and fails.
    const preview = await install(github, {}, "--dry-run", "--yes");
    assert.equal(preview.code, 1, preview.output);
    assert.match(preview.output, /! The run would stop at the project board: acme already has an open project board titled "space-game Sprints", #1, that is not linked to acme\/space-game\. .* To use that board, rerun with --board 1\.\n/);
    assert.match(preview.output, /would create \.agents\/skills\/tdd\/SKILL\.md\n/);
    assert.doesNotMatch(preview.output, /would create the project board/);
    assert.match(preview.output, /Nothing was written, on GitHub or on disk\.\nThe run would stop at the project board, as described above\.\n$/);
    assert.equal(github.mutations().length, 0);
    assert.equal(exists(project, ".agents"), false);
    let choices;
    const chosen = await install(github, { interactive: true,
      answers: { board: (offered) => { choices = offered; return offered[0].value; } } });
    assert.equal(chosen.code, 0, chosen.output);
    assert.ok(!choices.some((c) => c.value === null), "no choice creates a board");
    assert.ok(github.repo("acme/space-game").linked.has(namesake.id));
    assert.equal(github.boards.length, 1);
  });

  test("finds the recorded board and a board with the workflow's title among more than 20 boards", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    const recorded = board(github);
    github.repo("acme/space-game").linked.clear();
    // 25 boards updated since, so the recorded one is not among the 20 most recent.
    for (let index = 0; index < 25; index += 1) github.addBoard({ title: `space-game Sprints ${index}` });
    const { code, output } = await run(["update", project, "--yes"], { github });
    assert.equal(code, 0, output);
    assert.ok(github.repo("acme/space-game").linked.has(recorded.id));
    assert.equal(github.boards.filter((b) => b.title === "space-game Sprints").length, 1);
    // Without a record, the board with the workflow's title stops the run instead of getting a twin.
    const { dir: otherDir, project: other } = tempProject("space-game");
    try {
      const fresh = new FakeGitHub();
      const namesake = fresh.addBoard({ title: "space-game Sprints" });
      for (let index = 0; index < 25; index += 1) fresh.addBoard({ title: `Team board ${index}` });
      const refused = await run(["install", other, "--yes"], { github: fresh });
      assert.equal(refused.code, 1, refused.output);
      assert.match(refused.output, new RegExp(`titled "space-game Sprints", #${namesake.number}, that is not linked`));
      assert.equal(fresh.mutations().length, 0);
      const named = await run(["install", other, "--yes", "--board", String(namesake.number)], { github: fresh });
      assert.equal(named.code, 0, named.output);
      assert.ok(fresh.repo("acme/space-game").linked.has(namesake.id));
      assert.equal(fresh.boards.length, 26);
    } finally {
      fs.rmSync(otherDir, { recursive: true, force: true });
    }
  });

  test("--board finds a board by its title among more than 20 boards, and refuses a title two boards share", async () => {
    const github = new FakeGitHub();
    const wanted = github.addBoard({ title: "Team board", statuses: ["Todo", "In progress", "In review", "Done"],
      iteration: "Sprint" });
    for (let index = 0; index < 25; index += 1) github.addBoard({ title: `Team board ${index}` });
    const { code, output } = await install(github, {}, "--board", "Team board");
    assert.equal(code, 0, output);
    assert.ok(github.repo("acme/space-game").linked.has(wanted.id));
    github.repo("acme/space-game").linked.clear();
    const twin = github.addBoard({ title: "Team board" });
    const refused = await install(github, {}, "--board", "Team board");
    assert.equal(refused.code, 1, refused.output);
    assert.ok(refused.output.includes(`acme has 2 open project boards titled "Team board": #${twin.number} and `
      + `#${wanted.number}. Name one by its number with --board.`), refused.output);
  });

  test("a dry run that meets a conflict still lists the board and file changes, and fails", async () => {
    const github = new FakeGitHub();
    await install(github, {}, "--yes");
    fs.appendFileSync(path.join(project, ".agents/skills/tdd/SKILL.md"), "\nLocal edit.\n");
    fs.rmSync(path.join(project, ".agents/skills/teach/SKILL.md"));
    const created = board(github);
    created.fields = created.fields.filter((f) => f.name !== "Sprint");
    const before = github.mutations().length;
    const { code, output } = await run(["update", project, "--dry-run"], { github, interactive: true });
    assert.equal(code, 1, output);
    assert.match(output, /so the run would stop before writing anything:\n {2}\.agents\/skills\/tdd\/SKILL\.md: changed since the fleet installed it\n/);
    assert.match(output, /would add a Sprint field with 2-week sprints on "space-game Sprints"/);
    assert.match(output, /would create \.agents\/skills\/teach\/SKILL\.md/);
    assert.match(output, /Nothing was written, on GitHub or on disk\.\nThe run would stop at the conflicts above\. Resolve them, or rerun with --force to overwrite them\.\n/);
    assert.equal(github.mutations().length, before);
    assert.equal(exists(project, ".agents/skills/teach/SKILL.md"), false);
  });

  test("a tracker that names another board's URL gets a note, even with the same title", async () => {
    write(project, "docs/agents/issue-tracker.md", "| Setting | Value |\n| --- | --- |\n"
      + "| Project board | `space-game Sprints` owned by `acme`: https://github.com/users/acme/projects/7 |\n");
    const { code, output } = await install(new FakeGitHub(), {}, "--yes");
    assert.equal(code, 0, output);
    assert.match(output, /does not name the board "space-game Sprints"\. Set its Project board row to:\n {2}`space-game Sprints` owned by `acme`: https:\/\/github\.com\/users\/acme\/projects\/1\n/);
  });

  test("a dry run changes nothing on GitHub, and needs no consent", async () => {
    const github = new FakeGitHub();
    const { code, output } = await install(github, {}, "--dry-run");
    assert.equal(code, 0);
    assert.match(output, /would create the project board "space-game Sprints" owned by acme, linked to acme\/space-game/);
    assert.match(output, /would create docs\/agents\/issue-tracker\.md/);
    assert.equal(github.mutations().length, 0);
    assert.equal(exists(project, ".agents"), false);
  });

  test("an existing tracker file is left alone, with a note when it names another board", async () => {
    fs.mkdirSync(path.join(project, "docs/agents"), { recursive: true });
    fs.writeFileSync(path.join(project, "docs/agents/issue-tracker.md"), "# Mine\n");
    const { code, output } = await install(new FakeGitHub(), {}, "--yes");
    assert.equal(code, 0);
    assert.equal(read(project, "docs/agents/issue-tracker.md"), "# Mine\n");
    assert.match(output, /does not name the board "space-game Sprints"/);
  });

  test("a missing gh stops with the install command, or installs it when accepted", async () => {
    const refused = await install(new FakeGitHub({ installed: false }));
    assert.equal(refused.code, 1);
    assert.match(refused.output, /Install the GitHub CLI with brew install gh/);
    assert.equal(exists(project, ".agents"), false);
    const github = new FakeGitHub({ installed: false });
    const accepted = await install(github, { interactive: true });
    assert.equal(accepted.code, 0, accepted.output);
    assert.deepEqual(github.runs, [["brew", "install", "gh"]]);
    const linux = await install(new FakeGitHub({ installed: false, platform: "linux", programs: [] }), { interactive: true });
    assert.equal(linux.code, 1);
    assert.match(linux.output, /follow https:\/\/cli\.github\.com/);
    assert.ok(!linux.asked.some((q) => q.includes("Install gh")));
  });

  test("winget installs gh on Windows", async () => {
    const github = new FakeGitHub({ installed: false, platform: "win32", programs: ["winget"] });
    assert.equal((await install(github, { interactive: true })).code, 0);
    assert.deepEqual(github.runs[0].slice(0, 4), ["winget", "install", "--id", "GitHub.cli"]);
  });

  test("a missing login stops, or logs in when accepted", async () => {
    const refused = await install(new FakeGitHub({ loggedIn: false }));
    assert.equal(refused.code, 1);
    assert.match(refused.output, /gh auth login --scopes project/);
    const github = new FakeGitHub({ loggedIn: false });
    const accepted = await install(github, { interactive: true });
    assert.equal(accepted.code, 0, accepted.output);
    assert.ok(github.calls.some((c) => c.args.slice(0, 2).join(" ") === "auth login"));
  });

  test("a login without the project scope is refreshed when accepted", async () => {
    const refused = await install(new FakeGitHub({ scopes: ["repo", "read:org"] }));
    assert.equal(refused.code, 1);
    assert.match(refused.output, /gh auth refresh --scopes project/);
    const github = new FakeGitHub({ scopes: ["repo", "read:org"] });
    const accepted = await install(github, { interactive: true });
    assert.equal(accepted.code, 0, accepted.output);
    assert.ok(github.scopes.includes("project"));
  });

  test("an organization records that issue types exist", async () => {
    await install(new FakeGitHub({ ownerType: "Organization" }), {}, "--yes");
    const tracker = read(project, "docs/agents/issue-tracker.md");
    assert.match(tracker, /^\| Owner type \| `Organization`\. \|$/m);
    assert.match(tracker, /^\| Issue types \| `Resolve from GitHub`\. \|$/m);
  });
});

describe("check and list", () => {
  let dir;
  let project;
  beforeEach(async () => {
    ({ dir, project } = tempProject());
    await run(["install", project, "--yes"]);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("the installed checker runs on its own", () => {
    const result = spawnSync(process.execPath, [path.join(project, ".agents/scripts/check-skills.mjs")],
      { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /skills, adapters for claude, cursor, and links check out/);
  });

  test("check notes paths the fleet does not manage, without changing its result", async () => {
    write(project, ".agents/skills/tdd/scripts/old-helper.mjs", "// left over\n");
    write(project, ".agents/skills/house-style/SKILL.md", "---\nname: house-style\ndescription: The project's own skill.\n---\n\nBody.\n");
    assert.deepEqual(checks.check(project), []);
    assert.deepEqual(checks.unmanaged(project), [".agents/skills/house-style/", ".agents/skills/tdd/scripts/old-helper.mjs"]);
    const passed = await run(["check", project]);
    assert.equal(passed.code, 0, passed.output);
    assert.match(passed.output, /^Note: the fleet does not manage these skill paths:$/m);
    assert.match(passed.output, /^ {2}\.agents\/skills\/house-style\/$/m);
    assert.match(passed.output, /^A path left over from an earlier copy of the fleet can be deleted\. A project's own skill can stay, unless it does the same job as a fleet skill, which setup-project checks\. In \.agents\/skills\/, its frontmatter and links are checked like the fleet's\.$/m);
    const standalone = spawnSync(process.execPath, [path.join(project, ".agents/scripts/check-skills.mjs")],
      { encoding: "utf8" });
    assert.equal(standalone.status, 0, standalone.stderr);
    assert.match(standalone.stdout, /^ {2}\.agents\/skills\/tdd\/scripts\/old-helper\.mjs$/m);
    fs.unlinkSync(path.join(project, ".cursor/skills/tdd/SKILL.md"));
    const failed = await run(["check", project]);
    assert.equal(failed.code, 1);
    assert.match(failed.output, /does not manage these skill paths/);
    assert.match(failed.output, /missing cursor adapter for tdd/);
  });

  test("a project's own skill may have adapters of its own, in any form", () => {
    write(project, ".agents/skills/house-style/SKILL.md", "---\nname: house-style\ndescription: The project's own skill.\n---\n\nBody.\n");
    write(project, ".claude/skills/house-style/SKILL.md", "---\nname: house-style\n---\n\nRead the canonical skill.\n");
    write(project, ".claude/skills/house-style/notes.md", "Notes.\n");
    assert.deepEqual(checks.check(project), []);
    fs.unlinkSync(path.join(project, checks.MANIFEST));
    // Without a manifest, every skill is checked as the fleet's.
    assert.ok(checks.check(project).includes("claude adapter for house-style differs from the canonical skill"));
    assert.ok(checks.check(project).includes("missing cursor adapter for house-style"));
  });

  test("adapter drift is reported", () => {
    const adapter = path.join(project, ".cursor/skills/implement/SKILL.md");
    fs.writeFileSync(adapter, fs.readFileSync(adapter, "utf8").replace("canonical workflow", "workflow"));
    assert.ok(checks.check(project).includes("cursor adapter for implement differs from the canonical skill"));
  });

  test("missing and stray adapters are reported, and a skill only a tool has and leftovers get a note", () => {
    fs.unlinkSync(path.join(project, ".claude/skills/teach/SKILL.md"));
    // A stray adapter the manifest records, such as one for a skill the fleet dropped, and a recorded extra file.
    write(project, ".claude/skills/old-skill/SKILL.md", "stray");
    write(project, ".claude/skills/implement/extra.md", "extra");
    const manifest = JSON.parse(read(project, checks.MANIFEST));
    manifest.files[".claude/skills/old-skill/SKILL.md"] = checks.sha256("stray");
    manifest.files[".claude/skills/implement/extra.md"] = checks.sha256("extra");
    fs.writeFileSync(path.join(project, checks.MANIFEST), JSON.stringify(manifest));
    // Files beside a fleet adapter that the manifest does not record, such as leftovers of an earlier full copy.
    write(project, ".claude/skills/tdd/notes.md", "Notes.\n");
    write(project, ".claude/skills/tdd/references/mocking.md", "[gone](../missing.md)\n");
    write(project, ".claude/skills/deploy-notes/SKILL.md", "---\nname: deploy-notes\ndescription: Claude only.\n---\n\nBody.\n");
    const errors = checks.check(project);
    assert.ok(errors.includes("missing claude adapter for teach"));
    assert.ok(errors.includes("unexpected claude skill file: .claude/skills/old-skill/SKILL.md"));
    assert.ok(errors.includes("unexpected claude skill file: .claude/skills/implement/extra.md"));
    assert.ok(!errors.some((e) => e.includes("deploy-notes") || e.includes(".claude/skills/tdd/")), errors.join("\n"));
    assert.deepEqual(checks.unmanaged(project), [".claude/skills/deploy-notes/", ".claude/skills/tdd/notes.md",
      ".claude/skills/tdd/references/mocking.md"]);
  });

  test("links are checked in a project's own skills, not in files left in a fleet skill's folder", () => {
    write(project, ".agents/skills/tdd/old/readme.md", "[gone](../../../docs/missing.md)\n");
    assert.deepEqual(checks.check(project), []);
    write(project, ".agents/skills/house-style/SKILL.md",
      "---\nname: house-style\ndescription: The project's own skill.\n---\n\n[gone](../../../docs/missing.md)\n");
    assert.deepEqual(checks.check(project), [".agents/skills/house-style/SKILL.md: broken link to ../../../docs/missing.md"]);
  });

  test("a broken reference link is reported", () => {
    fs.unlinkSync(path.join(project, ".agents/references/github-references.md"));
    assert.ok(checks.check(project).some((e) => e.includes("broken link to ../../references/github-references.md")));
  });

  test("frontmatter rules are enforced", () => {
    const skill = path.join(project, ".agents/skills/bad-skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: other\ndescription: x\n---\n\nBody.\n");
    assert.ok(checks.check(project).includes('bad-skill: frontmatter name "other" does not match its folder'));
  });

  test("check and list run from the command line", async () => {
    assert.equal((await run(["check", project])).code, 0);
    const { code, output } = await run(["list"]);
    assert.equal(code, 0);
    for (const name of SKILLS) assert.match(output, new RegExp(`^${name} `, "m"));
  });
});

describe("arguments and frontmatter", () => {
  test("tools come from flags or a list", () => {
    assert.deepEqual(parseArgs(["--cursor", "--claude"]).tools, ["cursor", "claude"]);
    assert.deepEqual(parseArgs(["--tools", "claude,kiro"]).tools, ["claude", "kiro"]);
    assert.deepEqual(parseArgs(["--tools=none"]).tools, []);
    assert.throws(() => parseArgs(["--tools", "codex"]), UsageError);
  });

  test("the command and project are positional", () => {
    assert.equal(parseArgs([]).command, "install");
    assert.equal(parseArgs(["./app"]).project, "./app");
    assert.deepEqual([parseArgs(["update", "./app"]).command, parseArgs(["update", "./app"]).project],
      ["update", "./app"]);
    assert.throws(() => parseArgs(["check", "--force"]), UsageError);
    assert.throws(() => parseArgs(["--nope"]), UsageError);
  });

  test("quoted and plain frontmatter values", () => {
    const [fields, body] = checks.splitFrontmatter(
      '---\nname: a\ndescription: "Say \\"hi\\"; ok"\nallowed-tools: Bash, Read\n---\n\nBody\n');
    const values = Object.fromEntries(fields.map(([key, raw]) => [key, checks.scalar(raw)]));
    assert.equal(values.description, 'Say "hi"; ok');
    assert.equal(values["allowed-tools"], "Bash, Read");
    assert.equal(body, "\nBody\n");
  });

  test("missing frontmatter is an error", () => {
    assert.throws(() => checks.splitFrontmatter("# No frontmatter\n"));
  });
});

describe("versions and profile settings", () => {
  test("versions compare by number, not as strings", () => {
    assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
    assert.equal(compareVersions("2.0.0", "10.0.0"), -1);
    assert.equal(compareVersions("1.4.0", "v1.4.0"), 0);
    assert.equal(compareVersions("1.5.0-beta.1", "1.5.0"), -1);
    assert.equal(compareVersions("1.5.0-beta.2", "1.5.0-beta.10"), -1);
    assert.equal(compareVersions("1.5.0-1", "1.5.0-alpha"), -1);
    assert.equal(compareVersions("1.5.0+build.7", "1.5.0"), 0);
    assert.equal(compareVersions("next", "1.0.0"), null);
    assert.equal(compareVersions(undefined, "1.0.0"), null);
  });

  test("profile settings come from the template's settings, routing, and boundaries tables", () => {
    const templateText = [
      "## Settings", "", "| Setting | Value |", "| --- | --- |", "| Platform | TODO |", "| Deploys | TODO |",
      "| TODO component | TODO |", "",
      "## Boundaries", "", "| Boundary | Producer | Local check |", "| --- | --- | --- |", "| TODO | TODO | TODO |", "",
      "## Services", "", "| Service | Rule |", "| --- | --- |", "| TODO | Ask first. |", "",
    ].join("\n");
    const partial = "| Setting | Value |\n| --- | --- |\n| **Platform** | `web` |\n\n"
      + "| Boundary | Producer |\n| --- | --- |\n| API | web |\n";
    assert.deepEqual(missingSettings(templateText, partial), {
      rows: [{ name: "Deploys", component: null }],
      columns: [{ table: "Boundaries", name: "Local check" }],
      tables: [],
    });
    const settings = "| Setting | Value |\n| --- | --- |\n| Platform | web |\n| Deploys | None |\n";
    assert.deepEqual(missingSettings(templateText, `${settings}\n## Boundaries\n\nNone.\n`), { rows: [], columns: [], tables: [] });
    assert.deepEqual(missingSettings(templateText, settings), { rows: [], columns: [], tables: ["Boundaries"] });
  });

  test("a repeated component section is checked in each copy", () => {
    const table = "| Setting | Value |\n| --- | --- |\n";
    const templateText = `## Components\n\n### TODO component (\`path/\`)\n\n${table}| Platform | TODO |\n| Deploys | TODO |\n`;
    const text = `## Components\n\n### Web (\`web/\`)\n\n${table}| Platform | web |\n| Deploys | None |\n\n`
      + `### Worker (\`worker/\`)\n\n${table}| Platform | service |\n\n## Local stack\n\nNone.\n`;
    assert.deepEqual(missingSettings(templateText, text).rows, [{ name: "Deploys", component: "Worker (`worker/`)" }]);
    // Without component sections, the file as a whole counts.
    assert.deepEqual(missingSettings(templateText, `${table}| Platform | web |\n`).rows, [{ name: "Deploys", component: null }]);
  });

  test("tables read as GitHub renders them, without outer pipes and outside code fences", () => {
    const table = "| Setting | Value |\n| --- | --- |\n";
    const templateText = `## Components\n\n### TODO component (\`path/\`)\n\n${table}| Platform | TODO |\n| Deploys | TODO |\n`;
    const bare = "Setting | Value\n--- | ---\nPlatform | web\nDeploys | None\n";
    assert.deepEqual(missingSettings(templateText, bare).rows, []);
    const open = "| Setting | Value\n| --- | ---\n| Platform | web\n";
    assert.deepEqual(missingSettings(templateText, open).rows, [{ name: "Deploys", component: null }]);
    const fenced = `## Components\n\n### Web\n\n${table}| Platform | web |\n| Deploys | None |\n\n`
      + "```md\n## Example\n\n| Setting | Value |\n| --- | --- |\n| Deploys | None |\n```\n\n"
      + `### Worker\n\n${table}| Platform | service |\n`;
    assert.deepEqual(missingSettings(templateText, fenced).rows, [{ name: "Deploys", component: "Worker" }]);
    const domain = "## Boundaries\n\n| Boundary | Producer\n| --- | ---\n| API | web\n";
    const boundaries = "## Boundaries\n\n| Boundary | Producer | Local check |\n| --- | --- | --- |\n| TODO | TODO | TODO |\n";
    assert.deepEqual(missingSettings(boundaries, domain).columns, [{ table: "Boundaries", name: "Local check" }]);
  });

  test("components written as sections of their own are checked one by one", () => {
    const table = "| Setting | Value |\n| --- | --- |\n";
    const templateText = `## Components\n\n### TODO component (\`path/\`)\n\n${table}| Platform | TODO |\n| Deploys | TODO |\n`;
    const text = `## Web (\`web/\`)\n\n${table}| Platform | web |\n| Deploys | None |\n\n`
      + `## Worker (\`worker/\`)\n\n${table}| Platform | service |\n`;
    assert.deepEqual(missingSettings(templateText, text).rows, [{ name: "Deploys", component: "Worker (`worker/`)" }]);
    // One table under the template's own heading counts for the whole file.
    assert.deepEqual(missingSettings(templateText, `## Components\n\n${table}| Platform | web |\n`).rows,
      [{ name: "Deploys", component: null }]);
  });

  test("a Setting table is a component only when it shares a row with the template's and no template heading names it", () => {
    const verification = template("verification.md");
    const [component] = markdownTables(verification).filter((t) => t.header[0] === "Setting");
    const rows = component.rows.map(([name]) => `| ${name} | Filled |`);
    const last = component.rows.at(-1)[0];
    const section = (heading, lines) => `${heading}\n\n| Setting | Value |\n| --- | --- |\n${lines.join("\n")}\n\n`;
    const local = ["| Services | A database in a container |", "| Health check | A request to the local API |"];
    const own = section("## Web (`web/`)", rows) + section("## Worker (`worker/`)", rows.slice(0, -1))
      + section("## Local stack", local) + section("## Release notes", ["| Owner | The release manager |"]);
    assert.deepEqual(missingSettings(verification, own).rows, [{ name: last, component: "Worker (`worker/`)" }]);
    const nested = "## Components\n\n" + section("### Web (`web/`)", rows) + section("### Worker (`worker/`)", rows.slice(0, -1))
      + section("### Local stack", local);
    assert.deepEqual(missingSettings(verification, nested).rows, [{ name: last, component: "Worker (`worker/`)" }]);
  });

  test("the templates yield the settings to look for, and lack none of them", () => {
    const rows = (missing) => missing.rows.map((row) => row.name);
    assert.ok(rows(missingSettings(template("issue-tracker.md"), "")).includes("Default repository"));
    assert.ok(rows(missingSettings(template("verification.md"), "")).includes("Platform"));
    const boundary = missingSettings(template("domain.md"), "| Boundary |\n| --- |\n");
    assert.ok(boundary.columns.some((column) => column.name === "Producer"));
    assert.deepEqual(missingSettings(template("domain.md"), "# Domain\n").tables, ["Boundaries"]);
    for (const name of ["issue-tracker.md", "domain.md", "verification.md"]) {
      assert.deepEqual(missingSettings(template(name), template(name)), { rows: [], columns: [], tables: [] }, name);
    }
  });
});
