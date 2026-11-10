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
    // The forms agents use to ship stay open in a single repository.
    for (const command of [
      `cd ${repo} && gh pr create --title t --body "$(cat <<'EOF'\nSee "the plan" (step 2); done.\nEOF\n)"`,
      `cd ${repo} && git push -u origin feature/1-test 2>&1 | tail -3`,
      "gh pr create --title t --body-file - <<'EOF'\nbody\nEOF",
    ]) {
      assert.equal(hook(repo, "bash-guard", bash(repo, command)).out, "", command);
    }
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

  test("the reader skips no text, so nothing hides a push or a pull request", () => {
    // Each hides `git push origin main`, or a command the gate can't place, where the second review found the first
    // reader skipped text: unquoted heredoc bodies, comments, heredocs a shell runs, odd delimiters, arithmetic.
    for (const command of [
      "cat <<EOF\n$(git push origin main)\nEOF",
      "cat <<EOF\n`git push origin main`\nEOF",
      "# note: see <<EOF\ngit push origin main",
      "git status # see <<EOF\ngit push origin main",
      "# don't forget\ngit push origin main",
      "cat <<'EOF' | sh\ngit push origin main\nEOF",
      "<<EOF bash\ngit push origin main\nEOF",
      "bash -c \"$(cat <<'EOF'\ngit push origin main\nEOF\n)\"",
      "bash <<< \"git push origin main\"",
      "cat <<E\"O\"F\nhello\nEOF\ngit push origin main",
      "cat <<END:X\nhello\nEND:X\ngit push origin main",
      "((m = 1<<2))\ngit push origin main",
      "echo ${#x} ; git push origin main",
      "find . -name a.txt -execdir git push origin feature/1-test {} +",
      "echo 'unclosed ; gh pr create --title t",
    ]) {
      assert.ok(denied(hook(repo, "bash-guard", bash(repo, command))), command.replace(/\n/g, "\\n"));
    }
    for (const command of ["git status # it's fine", "echo ${#x}", "git push -u origin feature/1-test # once"]) {
      assert.equal(hook(repo, "bash-guard", bash(repo, command)).out, "", command);
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

// A workspace: a repository whose own Git ignores the independent child repositories in its subfolders.
describe("verification gate in a workspace", { skip: process.platform === "win32" }, () => {
  let dir;
  let ws;
  let report;
  const child = (name) => path.join(ws, name);
  const commit = (cwd, message) => {
    git(cwd, "add", "-A");
    git(cwd, "commit", "-qm", message);
  };
  const init = (cwd, origin) => {
    sh(path.dirname(cwd), "git", ["init", "-q", "-b", "main", path.basename(cwd)]);
    git(cwd, "config", "user.email", "test@example.com");
    git(cwd, "config", "user.name", "test");
    git(cwd, "config", "core.autocrlf", "false");
    sh(dir, "git", ["init", "-q", "--bare", "-b", "main", origin]);
    git(cwd, "remote", "add", "origin", origin);
  };
  const record = (verdict = "PASS") =>
    ["record", "--verdict", verdict, "--blocking", "0", "--issue", "https://example.com/7", "--report", report];
  const verify = (cwd, agent, verdict = "PASS") => {
    hook(cwd, "verifier-start", { agent_id: agent });
    hook(cwd, "authorize-record", { agent_id: agent, ...bash(cwd, `node .agents/scripts/gate.mjs ${record(verdict).join(" ")}`) });
    return gate(cwd, record(verdict));
  };
  const allowed = (cwd, command) => hook(cwd, "bash-guard", bash(cwd, command)).out === "";

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-ws-"));
    fs.mkdirSync(path.join(dir, "acme"));
    ws = path.join(dir, "ws");
    init(ws, path.join(dir, "acme", "ws.git"));
    fs.mkdirSync(path.join(ws, ".agents"));
    fs.writeFileSync(path.join(ws, ".agents", "README.md"), "fleet\n");
    fs.writeFileSync(path.join(ws, ".gitignore"), "/a/\n/b/\n/c/\n");
    commit(ws, "init");
    git(ws, "push", "-q", "origin", "main");
    git(ws, "switch", "-q", "-c", "feature/7-across");
    git(ws, "push", "-q", "-u", "origin", "feature/7-across");
    for (const name of ["a", "b", "c"]) {
      init(child(name), path.join(dir, "acme", `${name}.git`));
      fs.writeFileSync(path.join(child(name), "app.txt"), `${name} base\n`);
      commit(child(name), "init");
      git(child(name), "push", "-q", "origin", "main");
    }
    for (const name of ["a", "b"]) git(child(name), "switch", "-q", "-c", "feature/7-across");
    report = path.join(dir, "report.md");
    fs.writeFileSync(report, "report\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a verdict for the workspace's own empty patch no longer passes a member's pull request", () => {
    // The way around the gate before workspaces: verify the workspace repository, whose patch is empty because it
    // ignores its children, then open a child's pull request from the workspace root.
    assert.equal(verify(ws, "v0").code, 0);
    fs.appendFileSync(path.join(child("a"), "app.txt"), "change\n");
    commit(child("a"), "work");
    git(child("a"), "push", "-q", "-u", "origin", "feature/7-across");
    for (const command of ["cd a && gh pr create --title t", "gh -R acme/a pr create --title t", "cd a; gh pr ready 3"]) {
      assert.ok(!allowed(ws, command), command);
    }
    assert.ok(!allowed(child("a"), "gh pr create --title t"), "from the member itself");
  });

  test("workspace set names members that are repositories of their own", () => {
    assert.notEqual(gate(ws, ["workspace", "set", "../x"]).code, 0, "outside the root");
    assert.notEqual(gate(ws, ["workspace", "set", "nope"]).code, 0, "not a repository");
    fs.mkdirSync(path.join(ws, "plain"));
    assert.notEqual(gate(ws, ["workspace", "set", "plain"]).code, 0, "a folder of the workspace repository");
    const set = gate(ws, ["workspace", "set", "a", "b/"]);
    assert.equal(set.code, 0, set.err);
    assert.deepEqual(JSON.parse(set.out).members.map((m) => m.path), ["a", "b"]);
    for (const name of ["a", "b"]) {
      const base = git(child(name), "rev-parse", "main");
      assert.equal(JSON.parse(gate(ws, ["set-base", base, "--repo", name]).out).base, base);
    }
    const paths = JSON.parse(gate(ws, ["paths"]).out);
    assert.deepEqual(paths.members.map((m) => [m.path, m.branch]), [["a", "feature/7-across"], ["b", "feature/7-across"]]);
  });

  test("the fingerprint covers every member, from the root or from inside a member", () => {
    fs.appendFileSync(path.join(child("b"), "app.txt"), "b change\n");
    const fromRoot = JSON.parse(gate(ws, ["fingerprint"]).out);
    assert.match(fromRoot.fingerprint, /^workspace-/);
    assert.deepEqual(fromRoot.repos.map((r) => r.path), ["a", "b"]);
    assert.equal(JSON.parse(gate(child("a"), ["fingerprint"]).out).fingerprint, fromRoot.fingerprint);
    assert.equal(JSON.parse(gate(ws, ["fingerprint", "--repo", "b"]).out).fingerprint, fromRoot.repos[1].fingerprint);
    assert.match(gate(child("b"), ["diff"]).out, /\+b change/, "diff stays per repository");
    fs.appendFileSync(path.join(child("c"), "app.txt"), "unrelated\n");
    assert.equal(JSON.parse(gate(ws, ["fingerprint"]).out).fingerprint, fromRoot.fingerprint, "a non-member doesn't count");
  });

  test("the verdict records every member, and the committed check needs every commit", () => {
    const recorded = verify(child("a"), "v1");
    assert.equal(recorded.code, 0, recorded.err);
    assert.deepEqual(JSON.parse(recorded.out).repos.map((r) => r.path), ["a", "b"]);
    assert.equal(hook(ws, "verifier-stop", { agent_id: "v1" }).code, 0);
    assert.equal(gate(ws, ["check"]).code, 0);
    assert.notEqual(gate(ws, ["check", "--committed"]).code, 0, "b is not committed");
    commit(child("b"), "b work");
    assert.equal(gate(ws, ["check", "--committed"]).code, 0);
  });

  test("a member's ready pull request needs its own pushed patch and every other member's verified patch", () => {
    assert.ok(allowed(ws, "cd a && gh pr create --title t"), "cd from the root");
    assert.ok(allowed(ws, "gh -R acme/a pr create --head feature/7-across --title t"), "--repo and --head from the root");
    assert.ok(allowed(ws, "gh pr create --repo acme/a --head feature/7-across --title t"), "--repo after the subcommand");
    assert.ok(!allowed(ws, "gh -R acme/a pr create --title t"), "--repo for another repository needs --head");
    assert.ok(!allowed(ws, "gh -R acme/a pr create --head other --title t"), "--head must be the branch the gate checks");
    assert.ok(!allowed(child("a"), "gh pr create --repo acme/b --title t"), "--repo after the subcommand counts");
    assert.ok(!allowed(ws, "gh -R acme/a pr ready 3"), "ready for another repository runs from its directory");
    assert.ok(!allowed(ws, "cd a && gh pr ready https://github.com/acme/c/pull/1"), "a URL of another repository");
    assert.ok(!allowed(child("a"), "gh pr edit https://github.com/acme/c/pull/1 --base main"), "retarget by URL elsewhere");
    assert.ok(allowed(ws, "cd a && gh pr ready https://github.com/acme/a/pull/1"), "a URL of this repository");
    assert.ok(allowed(ws, "cd a && git push -u origin feature/7-across 2>&1 | tail -3"), "a pipe after the leading cd");
    assert.ok(allowed(ws, "cd a && echo $(date) && gh pr create --title t"), "a substitution that changes no directory");
    assert.ok(allowed(ws, "cd a && gh pr create --title t --body \"$(cat <<'EOF'\nA \"quoted\" body (with a paren; and a semicolon), that doesn't end early\nEOF\n)\""),
      "a heredoc body with quotes, parentheses and an apostrophe");
    // The gate reads heredoc bodies as commands, so it fails closed; a body that reads like one goes in a file instead.
    assert.ok(!allowed(ws, "cd a && gh pr create --title t --body \"$(cat <<'EOF'\nFirst run:\ncd elsewhere\nEOF\n)\""),
      "a body line that reads as a directory change");
    assert.ok(allowed(ws, "cd a && gh pr create --title t --body-file /tmp/body.md"), "the body in a file");
    assert.ok(allowed(child("a"), "gh pr create --title t"), "from the member itself");
    assert.ok(allowed(ws, 'cd a && gh pr create --title "Fix (x) & y" 2>&1'), "quotes and redirections don't count");
    assert.ok(!allowed(ws, "cd b && gh pr create --title t"), "b is not pushed");
    assert.ok(!allowed(ws, "cd c && gh pr create --title t"), "c is not a member");
    assert.ok(!allowed(ws, "gh pr create --title t"), "the workspace repository is not a member");
    fs.appendFileSync(path.join(child("b"), "app.txt"), "after verification\n");
    commit(child("b"), "late");
    assert.ok(!allowed(ws, "cd a && gh pr create --title t"), "b changed after verification");
    git(child("b"), "reset", "-q", "--hard", "HEAD~1");
    assert.ok(allowed(ws, "cd a && gh pr create --title t"), "b is back to the verified patch");
  });

  test("a directory change the gate can't follow is refused", () => {
    for (const command of [
      "(cd a) ; gh pr create --title t",
      "cd a & gh pr create --title t",
      "cd $REPO && gh pr create --title t",
      "cd a || gh pr create --title t",
      'bash -c "gh pr create --title t"; cd a',
      "cd a; popd; gh pr create --title t",
      "GH_REPO=acme/a gh pr create --title t",
    ]) {
      assert.ok(!allowed(ws, command), command);
    }
  });

  test("the review's ways of changing directory unseen are closed", () => {
    // Most of these got through the first version of workspace mode: each pushes c's main, or judges a pull request
    // in a repository other than the one it acts on. `timeout` and `sudo -u` hid `gh` from every earlier gate.
    for (const command of [
      'cd c && git push -o "`cd ..`"',
      'cd a && gh pr create --title "x`cd ..`"',
      "if true; then cd c; fi; git push",
      "if true; then cd a; fi; gh pr create --title t",
      "builtin cd a && gh pr create --title t",
      "command cd c; git push",
      "eval 'cd a' && gh pr create --title t",
      "env -C a gh pr create --title t",
      "GIT_DIR=a/.git GIT_WORK_TREE=a gh pr create --title t",
      "git --git-dir=c/.git --work-tree=c push",
      "GIT_DIR=c/.git git push",
      "export GIT_DIR=c/.git; git push",
      "git -C c -C . push",
      "source ./go.sh; gh pr create --title t",
      'bash -c "cd a && gh pr create --title t"',
      "bash <<'EOF'\ncd c\ngit push\nEOF",
      "cd a && true; gh pr create --title t",
      "cd a && gh pr create --title t # ; cd ..",
      "timeout 10 gh pr create --title t",
      "sudo -u me gh pr create --title t",
    ]) {
      assert.ok(!allowed(ws, command), command);
    }
  });

  test("workspace state is protected from a member's directory too", () => {
    const runDir = JSON.parse(gate(ws, ["paths"]).out).runDir;
    const latest = path.join(runDir, "latest.json");
    for (const cwd of [ws, child("a")]) {
      assert.ok(denied(hook(cwd, "state-guard", { tool_input: { file_path: latest } })), `state-guard from ${cwd}`);
      assert.ok(denied(hook(cwd, "write-scope", { tool_input: { file_path: latest } })), `write-scope from ${cwd}`);
      assert.ok(!allowed(cwd, `cp fake.json ${latest}`), `bash-guard from ${cwd}`);
    }
    const evidence = path.join(runDir, "round-1", "verification.md");
    assert.equal(hook(child("a"), "write-scope", { tool_input: { file_path: evidence } }).out, "", "evidence from a member");
  });

  test("workspace commands use the workspace root, even from inside a member", () => {
    assert.deepEqual(JSON.parse(gate(child("a"), ["workspace", "show"]).out).members.map((m) => m.path), ["a", "b"]);
    // A member that also has a workspace file of its own still answers to the workspace's verdict.
    const own = path.join(git(child("a"), "rev-parse", "--absolute-git-dir"), "agent-runs", "feature__7-across");
    fs.mkdirSync(own, { recursive: true });
    fs.writeFileSync(path.join(own, "workspace.json"), JSON.stringify({ members: ["."] }));
    assert.equal(fs.realpathSync(JSON.parse(gate(child("a"), ["paths"]).out).root), fs.realpathSync(ws));
    fs.rmSync(path.join(own, "workspace.json"));
    const base = git(child("b"), "rev-parse", "main");
    assert.equal(JSON.parse(gate(child("a"), ["set-base", base, "--repo", "b"]).out).path, "b");
  });

  test("nobody pushes a member's default branch from the workspace root", () => {
    for (const command of ["git -C c push", "cd c && git push", "git -C c push origin main", "git -C $X push",
      "(cd c) && git push", "cd c && git push origin HEAD"]) {
      assert.ok(!allowed(ws, command), command);
    }
    for (const command of ["git -C a push", "cd a && git push -u origin feature/7-across", "git push"]) {
      assert.ok(allowed(ws, command), command);
    }
  });

  test("a later member change needs a fresh verdict, recorded from the workspace root", () => {
    fs.appendFileSync(path.join(child("a"), "app.txt"), "round two\n");
    assert.notEqual(gate(ws, ["check"]).code, 0);
    hook(ws, "verifier-start", { agent_id: "v2" });
    git(child("a"), "switch", "-q", "-c", "other");
    hook(ws, "authorize-record", { agent_id: "v2", ...bash(ws, `node .agents/scripts/gate.mjs ${record().join(" ")}`) });
    assert.notEqual(gate(ws, record()).code, 0, "a member switched branches during verification");
    git(child("a"), "switch", "-q", "feature/7-across");
    hook(ws, "authorize-record", { agent_id: "v2", ...bash(ws, `node .agents/scripts/gate.mjs ${record().join(" ")}`) });
    const recorded = gate(ws, record());
    assert.equal(recorded.code, 0, recorded.err);
    assert.equal(gate(ws, ["check"]).code, 0);
  });

  test("a member added after the verdict needs a fresh one", () => {
    assert.equal(gate(ws, ["workspace", "set", "a", "b", "c"]).code, 0);
    const check = gate(ws, ["check"]);
    assert.notEqual(check.code, 0);
    assert.match(check.out, /now names a, b, c, but the latest verdict covers a, b/);
    assert.ok(!allowed(ws, "cd a && gh pr create --title t"));
    assert.equal(gate(ws, ["workspace", "set", "a", "b"]).code, 0);
  });

  test("a member the verifier can't snapshot is reported at record time, not as a missing session", () => {
    fs.renameSync(child("b"), path.join(dir, "b-away"));
    try {
      hook(ws, "verifier-start", { agent_id: "v3" });
      hook(ws, "authorize-record", { agent_id: "v3", ...bash(ws, `node .agents/scripts/gate.mjs ${record().join(" ")}`) });
      const recorded = gate(ws, record());
      assert.notEqual(recorded.code, 0);
      assert.match(recorded.err, /could not take the patch when verification started: b is not the root of a Git repository/);
      assert.equal(hook(ws, "verifier-stop", { agent_id: "v3" }).code, 0, "no nagging for a verdict it can't record");
      // The same from a member's directory: the error lock lands where record and verifier-stop look.
      hook(child("a"), "verifier-start", { agent_id: "v4" });
      hook(child("a"), "authorize-record", { agent_id: "v4", ...bash(child("a"), `node .agents/scripts/gate.mjs ${record().join(" ")}`) });
      assert.match(gate(child("a"), record()).err, /could not take the patch when verification started/);
      assert.equal(hook(child("a"), "verifier-stop", { agent_id: "v4" }).code, 0);
    } finally {
      fs.renameSync(path.join(dir, "b-away"), child("b"));
    }
  });

  test("a worktree inside the workspace's main checkout is a workspace of its own", () => {
    const wt = path.join(ws, ".wt", "w9");
    git(ws, "worktree", "add", "-q", "-b", "t3/w9", wt, "main");
    git(child("a"), "worktree", "add", "-q", "-b", "feature/9-nested", path.join(wt, "a"), git(child("a"), "rev-parse", "main"));
    try {
      const set = gate(wt, ["workspace", "set", "a"]);
      assert.equal(set.code, 0, set.err);
      assert.deepEqual(JSON.parse(set.out).members.map((m) => [m.path, m.branch]), [["a", "feature/9-nested"]]);
      assert.equal(fs.realpathSync(JSON.parse(gate(path.join(wt, "a"), ["paths"]).out).root), fs.realpathSync(wt));
      assert.deepEqual(JSON.parse(gate(ws, ["workspace", "show"]).out).members.map((m) => m.path), ["a", "b"], "the main checkout's list stays");
    } finally {
      git(child("a"), "worktree", "remove", "--force", path.join(wt, "a"));
      git(ws, "worktree", "remove", "--force", wt);
    }
  });
});
