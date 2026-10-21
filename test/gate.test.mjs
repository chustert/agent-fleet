import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ROOT } from "../lib/install.mjs";

const GATE = path.join(ROOT, "lib/gate.mjs");

function sh(cwd, cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", ...options });
  if (options.check !== false && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

const git = (cwd, ...args) => sh(cwd, "git", args).stdout.trim();

/** Run gate.mjs with arguments and optional hook input; returns { code, out, err }. */
function gate(cwd, args, input, env = {}) {
  const result = spawnSync(process.execPath, [GATE, ...args], {
    cwd, encoding: "utf8", input: input === undefined ? "" : JSON.stringify(input), env: { ...process.env, ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const hook = (cwd, name, input, ...extra) => gate(cwd, ["hook", name, ...extra], { cwd, ...input });
const denied = (result) => result.out.includes('"permissionDecision":"deny"');
const bash = (cwd, command) => ({ cwd, tool_input: { command } });
const fingerprintOf = (cwd, ...flags) => JSON.parse(gate(cwd, ["fingerprint", ...flags]).out).fingerprint;

// Claude Code runs the gate's hooks in a POSIX shell, Git Bash on Windows, where commands carry
// forward-slash paths. These tests build commands from native paths, so they run on Linux and macOS.
describe("verification gate", { skip: process.platform === "win32" }, () => {
  let dir;
  let repo;
  let report;
  const env = { AGENT_GATE_BASE: "" };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-gate-"));
    sh(dir, "git", ["init", "-q", "--bare", "-b", "main", "origin.git"]);
    repo = path.join(dir, "app");
    sh(dir, "git", ["init", "-q", "-b", "main", "app"]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "remote", "add", "origin", path.join(dir, "origin.git"));
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "m.py"), "x = 1\nif x:\n    y = 2\nreturn_value = y\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.claude/agent-memory-local/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "switch", "-q", "-c", "feature/1-test");
    report = path.join(dir, "report.md");
    fs.writeFileSync(report, "report\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const record = (verdict = "PASS", blocking = "0") =>
    ["record", "--verdict", verdict, "--blocking", blocking, "--issue", "https://example.com/1", "--report", report];
  const recordCommand = (verdict, blocking) => `node .agents/scripts/gate.mjs ${record(verdict, blocking).join(" ")}`;
  const authorize = (agent, command = recordCommand()) => hook(repo, "authorize-record", { agent_id: agent, ...bash(repo, command) });

  test("an empty patch has the empty fingerprint", () => {
    assert.equal(fingerprintOf(repo), "empty");
  });

  test("the patch leaves out ignored files and agent memory, and --exclude leaves out more", () => {
    fs.appendFileSync(path.join(repo, "a.txt"), "change\n");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    fs.writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    fs.mkdirSync(path.join(repo, ".claude/agent-memory-local"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".claude/agent-memory-local/x.md"), "note\n");
    const patch = gate(repo, ["diff"], undefined, env).out;
    assert.match(patch, /\+change/);
    assert.match(patch, /b\.txt/);
    assert.doesNotMatch(patch, /SECRET/);
    assert.doesNotMatch(patch, /agent-memory/);
    fs.writeFileSync(path.join(repo, "creds.pem"), "PRIVATE\n");
    assert.doesNotMatch(gate(repo, ["diff", "--exclude", "*.pem"]).out, /PRIVATE/);
    fs.rmSync(path.join(repo, "creds.pem"));
  });

  test("whitespace changes the fingerprint", () => {
    const before = fingerprintOf(repo);
    const file = path.join(repo, "m.py");
    const original = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, original.replace("return_value", "    return_value"));
    assert.notEqual(fingerprintOf(repo), before);
    fs.writeFileSync(file, original);
  });

  test("only the verifier can record, and only while its session is live", () => {
    assert.notEqual(gate(repo, record()).code, 0, "no token");
    authorize("stranger");
    assert.notEqual(gate(repo, record()).code, 0, "token without a verifier session");
  });

  test("a verifier can't stop without a verdict, and records only for the patch it started on", () => {
    hook(repo, "verifier-start", { agent_id: "v1" });
    assert.equal(hook(repo, "verifier-stop", { agent_id: "v1" }).code, 2);
    assert.ok(denied(authorize("v1", `${recordCommand()} && echo hi`)), "record must run on its own");
    fs.appendFileSync(path.join(repo, "b.txt"), "late\n");
    authorize("v1");
    assert.notEqual(gate(repo, record()).code, 0, "patch changed during verification");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    authorize("v1");
    assert.notEqual(gate(repo, record("PASS", "1")).code, 0, "PASS with blocking findings");
    authorize("v1");
    const recorded = gate(repo, record());
    assert.equal(recorded.code, 0, recorded.err);
    assert.equal(hook(repo, "verifier-stop", { agent_id: "v1" }).code, 0);
  });

  test("agent memory updates keep the verdict; the committed check needs the commit", () => {
    fs.appendFileSync(path.join(repo, ".claude/agent-memory-local/x.md"), "more\n");
    assert.equal(gate(repo, ["check"]).code, 0);
    assert.notEqual(gate(repo, ["check", "--committed"]).code, 0);
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "work");
    assert.equal(gate(repo, ["check", "--committed"]).code, 0);
  });

  test("a ready pull request needs the verified patch, committed and pushed", () => {
    const create = bash(repo, "gh pr create --title t --body-file body.md");
    assert.ok(denied(hook(repo, "bash-guard", create)), "not pushed");
    git(repo, "push", "-q", "-u", "origin", "feature/1-test");
    assert.equal(hook(repo, "bash-guard", create).out, "");
  });

  test("a clean rebase keeps the verdict; a new commit loses it", () => {
    const create = bash(repo, "gh pr create --title t --body-file body.md");
    git(repo, "switch", "-q", "main");
    fs.writeFileSync(path.join(repo, "c.txt"), "upstream\n");
    git(repo, "add", "c.txt");
    git(repo, "commit", "-qm", "upstream");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "switch", "-q", "feature/1-test");
    git(repo, "rebase", "-q", "main");
    git(repo, "push", "-q", "-f", "origin", "feature/1-test");
    assert.equal(hook(repo, "bash-guard", create).out, "", "rebase");
    fs.appendFileSync(path.join(repo, "a.txt"), "more\n");
    git(repo, "commit", "-qam", "more");
    git(repo, "push", "-q", "origin", "feature/1-test");
    assert.ok(denied(hook(repo, "bash-guard", create)), "new commit");
  });

  test("the pull request gate can't be sidestepped", () => {
    for (const command of [
      "gh pr create --draft --title t && gh pr ready",
      "gh pr ready 99; gh pr ready 1 --undo",
      "gh -R o/r pr create --title t",
      'gh pr create --title t --body "see -d flag"',
      "cd sub && gh pr create -t x -b y",
      "echo $(gh pr ready 5)",
      "gh pr edit 5 --base main",
      "gh api repos/o/r/pulls -f title=t -f head=x",
    ]) {
      assert.ok(denied(hook(repo, "bash-guard", bash(repo, command))), command);
    }
    for (const command of ["gh pr create --draft --title t", "gh pr view 12", "gh pr ready 3 --undo", "gh api repos/o/r/pulls"]) {
      assert.equal(hook(repo, "bash-guard", bash(repo, command)).out, "", command);
    }
  });

  test("the review's bypasses are closed", () => {
    for (const command of [
      "gh pr create --draft=false --title t",
      "gh pr ready 3 --undo=false",
      'bash -c "gh pr create -t x -b y"',
      "sh -lc 'gh pr ready 4'",
      "gh api graphql --input query.json",
    ]) {
      assert.ok(denied(hook(repo, "bash-guard", bash(repo, command))), command);
    }
  });

  test("nobody but gate.mjs writes the verdict state", () => {
    const runDir = JSON.parse(gate(repo, ["paths"]).out).runDir;
    const runs = path.dirname(runDir);
    for (const file of [path.join(runDir, "latest.json"), path.join(runDir, "verdicts.jsonl"), path.join(runs, "_tokens", "record-x.json"),
      path.join(runs, "_locks", "verifier-x.lock")]) {
      assert.ok(denied(hook(repo, "write-scope", { tool_input: { file_path: file } })), `write-scope: ${file}`);
      assert.ok(denied(hook(repo, "state-guard", { tool_input: { file_path: file } })), `state-guard: ${file}`);
    }
    assert.equal(hook(repo, "state-guard", { tool_input: { file_path: path.join(runDir, "round-1", "verification.md") } }).out, "");
    for (const command of [`echo '{}' > ${path.join(runs, "_tokens", "record-x.json")}`, `cp fake.json ${path.join(runDir, "latest.json")}`,
      "printf x > .git/agent-runs/_locks/verifier-x.lock"]) {
      assert.ok(denied(hook(repo, "bash-guard", bash(repo, command))), command);
    }
    assert.equal(hook(repo, "bash-guard", bash(repo, `cat ${path.join(runDir, "round-1", "verification.md")}`)).out, "");
  });

  test("nobody pushes the default branch", () => {
    for (const command of ["git push origin HEAD:main", "git push origin main", "git push -f origin +feature/1-test:main",
      "git push --all origin", "git push origin refs/heads/main"]) {
      assert.ok(denied(hook(repo, "bash-guard", bash(repo, command))), command);
    }
    for (const command of ["git push -u origin feature/1-test", "git push"]) {
      assert.equal(hook(repo, "bash-guard", bash(repo, command)).out, "", command);
    }
  });

  test("observe-only can't be pointed back at the checkout", () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-wt-"));
    for (const command of [
      `git -C ${outside} --git-dir=${path.join(repo, ".git")} --work-tree=${repo} commit -m x`,
      `GIT_DIR=${path.join(repo, ".git")} git -C ${outside} commit -m x`,
      `git worktree remove --force ${repo}`,
      "git worktree prune",
    ]) {
      assert.ok(denied(hook(repo, "observe-only", bash(repo, command))), command);
    }
    assert.equal(hook(repo, "observe-only", bash(repo, `git worktree remove ${outside}`)).out, "");
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("verifiers and reviewers only observe", () => {
    const observe = (command) => hook(repo, "observe-only", bash(repo, command));
    for (const command of ["git commit -m x", "git -c a=b commit -m x", "git --no-pager commit -m x", "gh pr checkout 3",
      "gh pr comment 1 --body x", "gh api repos/o/r/issues -f title=x", "git stash", "git branch -D x", "git push origin HEAD"]) {
      assert.ok(denied(observe(command)), command);
    }
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-wt-"));
    for (const command of ['grep -r "git push" docs', "git stash list", "git tag -l", "git diff main",
      "git worktree add --detach /tmp/w HEAD", `git -C ${outside} checkout main`, "gh issue view 3",
      "gh api repos/o/r/pulls/3", "git branch --show-current"]) {
      assert.equal(observe(command).out, "", command);
    }
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test("writes stay in the run directory and agent memory", () => {
    const write = (file) => hook(repo, "write-scope", { tool_input: { file_path: file } });
    const runDir = JSON.parse(gate(repo, ["paths"]).out).runDir;
    assert.equal(write(path.join(runDir, "round-1", "verification.md")).out, "");
    assert.equal(write(path.join(repo, ".claude/agent-memory-local/verifier/MEMORY.md")).out, "");
    assert.ok(denied(write(path.join(repo, "a.txt"))));
  });

  test("the verifier spawns only its listed agents", () => {
    const spawn = (type) => hook(repo, "agent-scope", { tool_input: { subagent_type: type } }, "reviewer", "Explore");
    assert.equal(spawn("reviewer").out, "");
    assert.ok(denied(spawn("developer")));
  });
});
