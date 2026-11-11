import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ROOT } from "../lib/install.mjs";

const GATE = path.join(ROOT, "lib/gate.mjs");

// When this suite runs inside an agent session, that session's git and gh wrappers are on PATH. The fixtures below
// push their default branches and start sessions of their own, so they run without the outer session's wrappers.
process.env.PATH = process.env.PATH.split(path.delimiter).filter((dir) => path.basename(dir) !== "agent-fleet-shims").join(path.delimiter);

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

// Five review rounds of a smarter reader each brought back something the first reader caught. So the reader stays as
// it shipped in 2.2.0, and what it can't see is the wrappers' to check. Changing it on purpose means changing this hash.
test("the hook's reader of shell text is the one that shipped in 2.2.0", () => {
  const source = fs.readFileSync(GATE, "utf8").replace(/\r\n/g, "\n");
  const reader = source.slice(source.indexOf("// ---------------------------------------------------------------- shell parsing"),
    source.indexOf("// ---------------------------------------------------------------- wrappers"));
  assert.equal(crypto.createHash("sha256").update(reader).digest("hex"), "5a76690ef62772522c6965fad7dba920f4a8a8a21e6ead5c70fbb43eae5fb7df");
});

/** A stand-in for gh on PATH: it records each call, and answers the two lookups the gate's gh wrapper makes. */
function fakeGh(dir) {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), [
    "#!/bin/sh",
    'case "$1 $2" in',
    '  "alias list") echo "prc: pr create"; exit 0 ;;',
    '  "fails ") exit 4 ;;',
    // Pull request 7 proposes the session's branch; any other one proposes somebody else's.
    '  "pr view") case "$3" in *7) head=$GH_PR_HEAD ;; *) head=someone-elses ;; esac',
    // With GH_PR_BASE set, the branch has an open pull request against that base.
    '    base=; [ -n "$GH_PR_BASE" ] && base=",\\"baseRefName\\":\\"$GH_PR_BASE\\",\\"state\\":\\"OPEN\\""',
    '    echo "{\\"headRefName\\":\\"$head\\",\\"isCrossRepository\\":false$base}"; exit 0 ;;',
    "esac",
    // What an `api` call receives on standard input, as the installer's GraphQL calls send their query.
    '[ "$1" = api ] && cat >> "$GH_LOG.in"',
    // One line for each call, whatever its arguments hold.
    'printf "%s\\n" "$(echo "$PWD :: $*" | tr "\\n" " ")" >> "$GH_LOG"',
    "",
  ].join("\n"), { mode: 0o755 });
  // A Git extension, as `git subtree` or a release tool is one: Git runs it, and it pushes.
  fs.writeFileSync(path.join(bin, "git-pushes"), "#!/bin/sh\nexec git push origin HEAD:main\n", { mode: 0o755 });
  return { bin, log: path.join(dir, "gh.log") };
}

let sessions = 0;

/**
 * An agent session as the harness runs one: the session-start hook once, then for each command the bash-guard hook
 * and, unless that refuses, the command itself in a shell with the gate's wrappers on PATH. The checks below look at
 * what a command did, the pushed branch and the calls gh received, not at how it was read.
 */
function startSession(project, gh, prHead, { gateFile = GATE, before = [] } = {}) {
  const id = `session-${++sessions}`;
  const envFile = path.join(path.dirname(gh.bin), `${id}.env.sh`);
  const env = { ...process.env, PATH: [...before, gh.bin, process.env.PATH].join(path.delimiter), GH_LOG: gh.log, GH_PR_HEAD: prHead };
  const started = spawnSync(process.execPath, [gateFile, "hook", "session-env"], {
    cwd: project, encoding: "utf8", input: JSON.stringify({ session_id: id, cwd: project }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: project, CLAUDE_ENV_FILE: envFile },
  });
  assert.equal(started.status, 0, started.stderr);
  const calls = () => (fs.existsSync(gh.log) ? fs.readFileSync(gh.log, "utf8").split("\n").filter(Boolean) : []);
  const unguarded = (cwd, command) => spawnSync("sh", ["-c", command], { cwd, encoding: "utf8", env });
  const run = (cwd, command, { agent = null } = {}) => {
    const guard = gate(cwd, ["hook", "bash-guard"], { session_id: id, ...(agent ? { agent_id: agent } : {}), cwd, tool_input: { command } });
    if (denied(guard)) return { refusedBy: "hook", output: guard.out };
    const result = spawnSync("sh", ["-c", `. "${envFile}"\n${command}`], { cwd, encoding: "utf8", env });
    return { refusedBy: result.stderr.includes("Verification gate:") ? "wrapper" : null, code: result.status, output: result.stdout + result.stderr };
  };
  const refAt = (origin, ref) => sh(origin, "git", ["rev-parse", "-q", "--verify", `refs/heads/${ref}`], { check: false }).stdout.trim() || null;
  return {
    id,
    env,
    envFile,
    calls,
    run,
    /** The command runs, and gh receives one more call. */
    opens(cwd, command) {
      const before = calls().length;
      const attempt = run(cwd, command);
      assert.equal(attempt.refusedBy, null, `${command}\n${attempt.output}`);
      assert.equal(calls().length, before + 1, `${command}\n${attempt.output}`);
    },
    /** With nothing in its way the command reaches gh; in the session it doesn't. Returns what refused it. */
    holdsPr(cwd, command) {
      fs.rmSync(gh.log, { force: true });
      unguarded(cwd, command);
      assert.ok(calls().length > 0, `unguarded, this reaches gh: ${command}`);
      fs.rmSync(gh.log, { force: true });
      const attempt = run(cwd, command);
      assert.equal(calls().length, 0, `${command}\n${attempt.output}`);
      assert.ok(attempt.refusedBy, `${command}\n${attempt.output}`);
      return attempt.refusedBy;
    },
    /** With nothing in its way the command moves `ref` at `origin`; in the session it doesn't. Returns what refused it. */
    holdsPush(cwd, command, origin, ref = "main") {
      const before = refAt(origin, ref);
      unguarded(cwd, command);
      assert.notEqual(refAt(origin, ref), before, `unguarded, this pushes ${ref}: ${command}`);
      sh(origin, "git", before ? ["update-ref", `refs/heads/${ref}`, before] : ["update-ref", "-d", `refs/heads/${ref}`]);
      const attempt = run(cwd, command);
      assert.equal(refAt(origin, ref), before, `${command}\n${attempt.output}`);
      assert.ok(attempt.refusedBy, `${command}\n${attempt.output}`);
      return attempt.refusedBy;
    },
  };
}

// Claude Code runs the gate's hooks in a POSIX shell, Git Bash on Windows, where commands carry
// forward-slash paths. These tests build commands from native paths, so they run on Linux and macOS.
describe("verification gate", { skip: process.platform === "win32" }, () => {
  let dir;
  let repo;
  let other;
  let origin;
  let report;
  let gh;
  let session;
  const env = { AGENT_GATE_BASE: "" };

  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-fleet-gate-"));
    sh(dir, "git", ["init", "-q", "--bare", "-b", "main", "origin.git"]);
    repo = path.join(dir, "app");
    sh(dir, "git", ["init", "-q", "-b", "main", "app"]);
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "test");
    git(repo, "config", "core.autocrlf", "false");
    // A file:// URL stands in for the hosting service. The wrappers leave a remote given as a plain directory path alone.
    git(repo, "remote", "add", "origin", `file://${path.join(dir, "origin.git")}`);
    fs.writeFileSync(path.join(repo, "a.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "m.py"), "x = 1\nif x:\n    y = 2\nreturn_value = y\n");
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env\n.claude/agent-memory-local/\n");
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "init");
    git(repo, "push", "-q", "origin", "main");
    git(repo, "switch", "-q", "-c", "feature/1-test");
    origin = path.join(dir, "origin.git");
    // A clone next door that nobody verified, on the default branch, with a commit the origin lacks.
    sh(dir, "git", ["clone", "-q", `file://${origin}`, "other"]);
    other = path.join(dir, "other");
    git(other, "config", "user.email", "test@example.com");
    git(other, "config", "user.name", "test");
    fs.writeFileSync(path.join(other, "unverified.txt"), "unverified\n");
    git(other, "add", ".");
    git(other, "commit", "-qm", "unverified");
    gh = fakeGh(dir);
    session = startSession(repo, gh, "feature/1-test");
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

  test("--exclude leaves a file out in any case, so naming it in another case doesn't get it past", () => {
    fs.appendFileSync(path.join(repo, "a.txt"), "case change\n");
    fs.mkdirSync(path.join(repo, "Config"));
    fs.writeFileSync(path.join(repo, "Config/Secrets.yml"), "pw: hunter2\n");
    try {
      // Before, the exclusion compared case exactly and the file went into the patch.
      const patch = gate(repo, ["diff", "--exclude", "config/secrets.yml"]).out;
      assert.match(patch, /\+case change/);
      assert.doesNotMatch(patch, /hunter2/);
      assert.match(gate(repo, ["diff"]).out, /hunter2/, "without --exclude the file is in the patch");
    } finally {
      fs.rmSync(path.join(repo, "Config"), { recursive: true, force: true });
    }
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

  test("a verifier in any tool records through a round the lead opens", () => {
    const opened = gate(repo, ["round", "open"]);
    assert.equal(opened.code, 0, opened.err);
    const { key, fingerprint } = JSON.parse(opened.out);
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(fingerprint, fingerprintOf(repo));
    const rounds = path.join(path.dirname(JSON.parse(gate(repo, ["paths"]).out).runDir), "_rounds");
    assert.ok(fs.readdirSync(rounds).every((name) => !fs.readFileSync(path.join(rounds, name), "utf8").includes(key)),
      "the round keeps only the key's digest");
    const withKey = (k, verdict = "PASS") => [...record(verdict), "--key", k, "--verifier", "gpt-5.6-sol xhigh"];
    assert.match(gate(repo, withKey("0".repeat(32))).err, /no open verification round has this key/);
    assert.notEqual(gate(repo, [...record(), "--key"]).code, 0, "a bare --key");
    // The patch changes while the verifier works: its evidence covers the earlier patch.
    fs.appendFileSync(path.join(repo, "a.txt"), "during verification\n");
    assert.match(gate(repo, withKey(key)).err, /patch changed while you were verifying/);
    git(repo, "checkout", "--", "a.txt");
    const recorded = gate(repo, withKey(key));
    assert.equal(recorded.code, 0, recorded.err);
    const entry = JSON.parse(recorded.out);
    assert.deepEqual([entry.via, entry.verifier, entry.fingerprint], ["round", "gpt-5.6-sol xhigh", fingerprint]);
    assert.match(gate(repo, withKey(key)).err, /each key records one verdict/);
    assert.equal(gate(repo, ["check", "--committed"]).code, 0);
    // Without a key, only the team's verifier agent can record, through its hooks. A record with a key mints no
    // token for anyone to use without one.
    hook(repo, "verifier-start", { agent_id: "team-verifier" });
    authorize("team-verifier", `${recordCommand()} --key ${"1".repeat(32)}`);
    assert.match(gate(repo, record()).err, /only a verifier may record a verdict/);
  });

  test("where the gate's hooks run, the agent that opened a round can't record its verdict", () => {
    // Run for real in a session: the session opens a round, can't record with its key, and a subagent it starts can.
    const opened = session.run(repo, `node ${GATE} round open`);
    assert.equal(opened.code, 0, opened.output);
    const { key } = JSON.parse(opened.output);
    const recordWith = (k) => `node ${GATE} ${record().join(" ")} --key ${k} --verifier "gpt-5.6-sol xhigh"`;
    const before = gate(repo, ["show"]).out;
    const self = session.run(repo, recordWith(key));
    assert.equal(self.refusedBy, "hook", self.output);
    assert.match(self.output, /opened this verification round can't record/);
    assert.equal(gate(repo, ["show"]).out, before, "nothing was recorded");
    // Nor through a variable, which the hook can't read.
    assert.equal(session.run(repo, `K=${key}; node ${GATE} ${record().join(" ")} --key "$K"`).refusedBy, "hook");
    const verifier = session.run(repo, recordWith(key), { agent: "verifier-1" });
    assert.equal(verifier.code, 0, verifier.output);
    assert.equal(JSON.parse(gate(repo, ["show"]).out).verifier, "gpt-5.6-sol xhigh");
    // A verifier in a session of its own records too, and a developer that opens a round for itself can't.
    const open = `node ${GATE} round open`;
    const lead = { session_id: "session-lead" };
    hook(repo, "bash-guard", { ...lead, ...bash(repo, open) });
    const second = JSON.parse(gate(repo, ["round", "open"]).out).key;
    assert.equal(hook(repo, "bash-guard", { session_id: "session-verifier", ...bash(repo, recordWith(second)) }).out, "");
    const developer = { session_id: "session-lead", agent_id: "developer-1" };
    hook(repo, "bash-guard", { ...developer, ...bash(repo, open) });
    const own = JSON.parse(gate(repo, ["round", "open"]).out).key;
    assert.ok(denied(hook(repo, "bash-guard", { ...developer, ...bash(repo, `node .agents/scripts/gate.mjs record --key=${own} --verdict PASS`) })));
    // Parallel issues share the round directory, one checkout each: a round belongs to its own checkout's opener.
    const parallel = path.join(dir, "parallel");
    git(repo, "worktree", "add", "-q", "-b", "parallel", parallel, "HEAD");
    try {
      hook(repo, "bash-guard", { ...lead, ...bash(repo, open) });
      hook(parallel, "bash-guard", { session_id: "session-parallel", ...bash(parallel, open) });
      const mine = JSON.parse(gate(repo, ["round", "open"]).out).key;
      assert.ok(denied(hook(repo, "bash-guard", { ...lead, ...bash(repo, recordWith(mine)) })), "the opener of this checkout's round");
      assert.equal(hook(repo, "bash-guard", { session_id: "session-parallel", ...bash(repo, recordWith(mine)) }).out, "");
    } finally {
      git(repo, "worktree", "remove", "--force", parallel);
      git(repo, "branch", "-q", "-D", "parallel");
    }
    // The round's state is the gate's own.
    assert.ok(denied(hook(repo, "bash-guard", bash(repo, "rm -rf .git/agent-runs/_rounds"))));
  });

  test("publish posts the passing verdict as the status of the exact pushed commit", () => {
    const env = { PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, GH_LOG: gh.log };
    const statuses = () => (fs.existsSync(gh.log) ? fs.readFileSync(gh.log, "utf8").split("\n").filter((line) => line.includes(":: api ")) : []);
    fs.rmSync(gh.log, { force: true });
    const published = gate(repo, ["publish"], undefined, env);
    assert.equal(published.code, 0, published.err);
    const head = git(repo, "rev-parse", "HEAD");
    const [call] = statuses();
    assert.ok(call.startsWith(`${fs.realpathSync(repo)} :: `), call);
    assert.match(call, new RegExp(`api -X POST repos/\\{owner\\}/\\{repo\\}/statuses/${head} -f state=success -f context=agent-fleet/verdict `
      + "-f description=PASS from gpt-5.6-sol xhigh for patch [0-9a-f]{12} -f target_url=https://example.com/1"));
    // Against another base, the pull request's patch is not the verified one.
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/stack");
    try {
      assert.match(gate(repo, ["publish", "--base", "stack"], undefined, env).err, /patch against stack .* is not the verified patch/);
    } finally {
      git(repo, "push", "-q", "origin", "--delete", "stack");
    }
    assert.match(gate(repo, ["publish", "--base", "nowhere"], undefined, env).err, /origin\/nowhere is not known/);
    // With a pull request open, its base is the one that counts.
    assert.match(gate(repo, ["publish", "--base", "stack"], undefined, { ...env, GH_PR_BASE: "main" }).err, /open pull request targets main, not stack/);
    // A commit after verification has no verdict to post, pushed or not.
    fs.appendFileSync(path.join(repo, "a.txt"), "after verification\n");
    git(repo, "commit", "-qam", "unverified");
    try {
      assert.match(gate(repo, ["publish"], undefined, env).err, /differs from the committed patch.*Nothing was posted/);
    } finally {
      git(repo, "reset", "-q", "--hard", "HEAD~1");
    }
    assert.equal(statuses().length, 1, "only the first call posted");
  });

  test("a pull request command is judged in the repository it really runs in", () => {
    // This repository's pull request passes. The hook reads a command against the directory the session is in, so it
    // lets each of these through, and the wrapper refuses them where they run or for the repository they name.
    const script = path.join(dir, "open.sh");
    const mutation = path.join(dir, "mutation.json");
    const status = path.join(dir, "status.json");
    fs.writeFileSync(status, JSON.stringify({ state: "success", context: "agent-fleet/verdict" }));
    const escaped = path.join(dir, "escaped.json");
    fs.writeFileSync(escaped, '{"state":"success","context":"agent-fleet\\/verdict"}');
    fs.writeFileSync(mutation, JSON.stringify({ query: "mutation { createPullRequest(input: {}) { clientMutationId } }" }));
    for (const command of [
      `cd ${other} && gh pr create --title t`,
      `(cd ${other} && gh pr ready)`,
      `D=${other}; cd $D; gh pr create -t t`,
      `sh -c 'cd ${other}; gh pr create -t t'`,
      `cd ${other} && echo "pr create -t t" | xargs gh`,
      `printf 'cd ${other} && gh pr create -t t\\n' > ${script}; sh ${script}`,
      `cd ${other} && gh pr new -t t`,
      `cd ${other} && gh prc -t t`,
      "gh pr create --title t -R o/r",
      "GH_REPO=o/r gh pr create --title t",
      "gh pr create --title t --head feature/1-test --head unverified",
      "gh pr ready 8",
      "gh pr ready https://github.com/o/r/pull/7",
      `cd ${other} && X=edit; gh pr $X 7 --base main`,
      `cd ${other} && gh pr edit 7 -Bmain`,
      // gh reads `--draft` here as the title, so this opens a ready pull request.
      `cd ${other} && gh pr create --title --draft`,
      "A=api; gh $A repos/o/r/pulls -f title=t -f head=x",
      // A GraphQL request from a file, which the hook can't read and the wrapper can.
      `A=api; gh $A graphql --input ${mutation}`,
      `A=api; gh $A --input ${mutation} graphql`,
      `A=api; gh $A graphql -F query=@${mutation}`,
      `A=api; cat ${mutation} | gh $A graphql --input -`,
      // The verdict's status, which only gate.mjs posts, after checking the verdict.
      "gh api repos/o/r/statuses/abc123 -f state=success -f context=agent-fleet/verdict",
      `gh api -X POST repos/o/r/statuses/abc123 --input ${status}`,
      "gh api repos/o/r/statuses/abc123 -fstate=success -fcontext=agent-fleet/verdict",
      `gh api repos/o/r/statuses/abc123 --input ${escaped}`,
      "gh api repos/o/r/pulls -ftitle=t -fhead=x -fbase=main",
    ]) {
      assert.equal(session.holdsPr(repo, command), "wrapper", command);
    }
    for (const command of [
      "gh pr create --title t",
      `cd ${repo} && gh pr create --title t`,
      "gh pr new --title t",
      "gh prc --title t",
      "gh pr ready 7",
      "gh pr create --title t --body \"$(cat <<'EOF'\nAll \"done\" (see step 2); run:\n```sh\nnpm test\n```\nEOF\n)\"",
      `cd ${other} && gh pr create --draft --title t`,
      `cd ${other} && gh issue view 3`,
    ]) {
      session.opens(repo, command);
    }
    // Any other GraphQL request passes, with its standard input, as the installer and the sprint scripts send theirs.
    session.opens(repo, `A=api; echo '{"query":"query { viewer { login } }"}' | gh $A graphql --input -`);
    session.opens(repo, "gh api repos/o/r/statuses/abc123 -f state=success -f context=ci/build");
    session.opens(repo, "gh api repos/o/r/commits/abc123/statuses --jq '.[] | select(.context == \"agent-fleet/verdict\")'");
    // A new base gives the pull request another patch than the verified one.
    git(repo, "push", "-q", "origin", "HEAD:refs/heads/stack");
    try {
      assert.equal(session.holdsPr(repo, "gh pr edit 7 --base stack"), "wrapper");
      session.opens(repo, "gh pr edit 7 --base main");
    } finally {
      git(repo, "push", "-q", "origin", "--delete", "stack");
    }
    assert.match(fs.readFileSync(`${gh.log}.in`, "utf8"), /viewer \{ login \}/);
  });

  test("a push to the default branch is held however it is spelled", () => {
    const script = path.join(dir, "push.sh");
    const included = path.join(dir, "included.cfg");
    fs.writeFileSync(included, "[core]\n\thooksPath = /dev/null\n");
    // A submodule of the clone, whose own default branch a command run in it could push.
    git(other, "-c", "protocol.file.allow=always", "submodule", "add", "-q", `file://${origin}`, "sub");
    const sub = path.join(other, "sub");
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    git(sub, "add", ".");
    git(sub, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "in the submodule");
    for (const [command, by] of [
      [`git -C ${other} push origin main`, "hook"],
      [`cd ${other} && git push origin HEAD:refs/heads/main`, "hook"],
      [`cd ${other} && git push --all`, "hook"],
      // The hook reads the rest against this repository's issue branch, or can't read them at all.
      [`cd ${other} && git push`, "wrapper"],
      [`git -C ${other} push`, "wrapper"],
      [`cd ${other} && git push origin HEAD`, "wrapper"],
      [`cd ${other} && git push origin @`, "wrapper"],
      [`cd ${other} && git push origin 'refs/heads/ma*'`, "wrapper"],
      [`B=main; cd ${other} && git push origin $B`, "wrapper"],
      [`cd ${other} && git push origin "$(echo main)"`, "wrapper"],
      [`cd ${other} && echo main | xargs git push origin`, "wrapper"],
      [`cd ${other} && git config alias.p "push origin main" && git p`, "wrapper"],
      [`cd ${other} && git -c alias.x='!git push origin main' x`, "wrapper"],
      [`git -C "\`echo ${other}\`" push origin HEAD`, "wrapper"],
      [`(cd ${other}; eval "git push origin ma""in")`, "wrapper"],
      [`printf 'cd ${other} && git push origin main\\n' > ${script}; sh ${script}`, "wrapper"],
      [`cd ${other} && node -e "require('child_process').execSync('git push origin main')"`, "wrapper"],
      [`cd ${other} && GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.origin.push GIT_CONFIG_VALUE_0=HEAD:main git push`, "wrapper"],
      // Ways to skip the check itself.
      [`cd ${other} && git push --no-verify`, "wrapper"],
      [`cd ${other} && git push --no-verif`, "wrapper"],
      [`cd ${other} && git -c core.hooksPath=/dev/null push`, "wrapper"],
      [`cd ${other} && git send-pack ${origin} main`, "wrapper"],
      [`cd ${other} && git -c include.path=${included} push`, "wrapper"],
      [`cd ${other} && git config alias.q '-c core.hooksPath=/dev/null push' && git q origin main`, "wrapper"],
      [`cd ${other} && git -c alias.y='!git push --no-verify origin main' y`, "wrapper"],
      // Commands Git starts itself, which never meet the wrapper: the check reaches them through the environment.
      [`cd ${other} && git submodule foreach 'git -c protocol.file.allow=always push origin HEAD:main'`, "wrapper"],
      [`cd ${other} && git pushes`, "wrapper"],
      [`cd ${other} && git -c help.autocorrect=immediate psuh`, "wrapper"],
    ]) {
      assert.equal(session.holdsPush(repo, command, origin), by, command);
    }
  });

  test("ordinary commands pass through the wrappers, and a repository's own hooks still run", () => {
    const plain = session.run(repo, "command -v git && git status -sb && git log --oneline -1 >/dev/null && git push -q origin feature/1-test");
    assert.equal(plain.refusedBy, null, plain.output);
    assert.equal(plain.code, 0, plain.output);
    assert.match(plain.output, /agent-fleet-shims\/git\n## feature\/1-test/);
    // A push runs with Git's hooks path pointed at the gate's directory. The repository's own hooks still run there.
    const ran = path.join(dir, "hooks-ran");
    const hooksDir = path.join(other, ".git", "hooks");
    const hookFile = (file, body) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    // Git also runs a hook that has no `#!` line, with the shell.
    fs.writeFileSync(path.join(hooksDir, "pre-push"), `echo pre-push >> ${ran}\n`, { mode: 0o755 });
    hookFile(path.join(hooksDir, "pre-commit"), `echo pre-commit >> ${ran}`);
    git(other, "switch", "-q", "-c", "topic");
    try {
      const pushed = session.run(repo, `cd ${other} && git push -q -u origin topic`);
      assert.equal(pushed.refusedBy, null, pushed.output);
      assert.equal(pushed.code, 0, pushed.output);
      assert.equal(git(origin, "rev-parse", "topic"), git(other, "rev-parse", "topic"));
      // A shell alias runs with the same hooks path, and a commit inside it still meets pre-commit.
      const aliased = session.run(repo, `cd ${other} && echo n > n.txt && git add n.txt && git -c alias.c='!git commit -qm n' c`);
      assert.equal(aliased.code, 0, aliased.output);
      assert.deepEqual(fs.readFileSync(ran, "utf8").trim().split("\n"), ["pre-push", "pre-commit"]);
      // A hooks path of the repository's own is honoured, and its pre-push hook can still stop a push.
      const custom = path.join(dir, "custom-hooks");
      fs.mkdirSync(custom);
      hookFile(path.join(custom, "pre-push"), `echo custom >> ${ran}; exit 1`);
      git(other, "config", "core.hooksPath", custom);
      const stopped = session.run(repo, `cd ${other} && git push -q origin topic`);
      assert.notEqual(stopped.code, 0, stopped.output);
      assert.notEqual(git(origin, "rev-parse", "topic"), git(other, "rev-parse", "topic"));
      assert.match(fs.readFileSync(ran, "utf8"), /custom/);
      // --no-verify still skips the repository's own hook, as it always did, and only that.
      const skipped = session.run(repo, `cd ${other} && git push -q --no-verify origin topic`);
      assert.equal(skipped.code, 0, skipped.output);
      assert.equal(git(origin, "rev-parse", "topic"), git(other, "rev-parse", "topic"));
    } finally {
      sh(other, "git", ["config", "--unset", "core.hooksPath"], { check: false });
      fs.rmSync(path.join(hooksDir, "pre-push"), { force: true });
      fs.rmSync(path.join(hooksDir, "pre-commit"), { force: true });
      git(other, "switch", "-q", "main");
    }
  });
  test("the wrappers pass a command's result through, and keep working when the checkout's gate is gone", () => {
    // Exit status and output are the tool's own.
    const failed = session.run(repo, "gh fails; echo status=$?");
    assert.match(failed.output, /status=4/);
    // An alias for a plain built-in is that built-in, whatever its arguments say.
    const aliased = session.run(repo, `cd ${other} && git -c alias.ci=commit ci --no-verify --allow-empty -qm "about core.hooksPath"`);
    assert.equal(aliased.code, 0, aliased.output);
    // The wrappers run a copy of the gate kept beside them. Here the project's own copy disappears, as it does
    // after switching to a commit from before the installation.
    const installed = path.join(dir, "installed-gate.mjs");
    fs.copyFileSync(GATE, installed);
    const orphan = startSession(repo, gh, "feature/1-test", { gateFile: installed });
    fs.rmSync(installed);
    assert.equal(orphan.holdsPush(repo, `cd ${other} && git push`, origin), "wrapper");
    assert.equal(orphan.holdsPr(repo, `cd ${other} && gh pr create --title t`), "wrapper");
    // A Git too old to take settings from the environment would run the push without the check, so it is refused.
    const oldBin = path.join(dir, "old-git");
    fs.mkdirSync(oldBin);
    const realGit = sh(dir, "sh", ["-c", "command -v git"]).stdout.trim();
    fs.writeFileSync(path.join(oldBin, "git"), `#!/bin/sh\nunset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0\nexec ${realGit} "$@"\n`, { mode: 0o755 });
    const old = startSession(repo, gh, "feature/1-test", { before: [oldBin] });
    const refused = old.run(repo, `cd ${other} && git push`);
    assert.match(refused.output, /needs Git 2\.31 or later/);
    assert.equal(old.holdsPush(repo, `cd ${other} && git push`, origin), "wrapper");
  });

  test("the wrappers leave a scratch repository alone, survive a second session, and say when they are missing", () => {
    // A test suite pushes `main` to a repository it made in a folder. That is not the project's default branch.
    sh(dir, "git", ["init", "-q", "--bare", "-b", "main", "scratch.git"]);
    sh(dir, "git", ["init", "-q", "-b", "main", "scratch"]);
    const scratch = path.join(dir, "scratch");
    git(scratch, "remote", "add", "origin", path.join(dir, "scratch.git"));
    fs.writeFileSync(path.join(scratch, "s.txt"), "s\n");
    git(scratch, "add", ".");
    git(scratch, "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-qm", "scratch");
    const suite = path.join(dir, "suite.sh");
    fs.writeFileSync(suite, `cd ${scratch} && git push -q origin main\n`);
    const ran = session.run(repo, `sh ${suite}`);
    assert.equal(ran.code, 0, ran.output);
    assert.equal(git(path.join(dir, "scratch.git"), "rev-parse", "main"), git(scratch, "rev-parse", "main"));
    // Two sessions' wrappers on one PATH, as when a session starts another: each must skip the other's.
    const second = startSession(other, gh, "main");
    const both = spawnSync("sh", ["-c", `. "${session.envFile}"; . "${second.envFile}"; git status -sb && gh issue view 3 && echo finished`],
      { cwd: repo, encoding: "utf8", env: session.env, timeout: 30000 });
    assert.equal(both.status, 0, both.stderr);
    assert.match(both.stdout, /finished/);
    // A tool that gives the session-start hook no way to set PATH: the agent is told the wrappers are missing.
    const none = gate(repo, ["hook", "session-env"], { session_id: "no-env-file", cwd: repo }, { CLAUDE_PROJECT_DIR: repo, CLAUDE_ENV_FILE: "" });
    assert.match(none.out, /wrappers are not active in this session/);
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
      path.join(runs, "_locks", "verifier-x.lock"), path.join(runDir, "workspace.json"),
      path.join(runs, "_shims", "x", "agent-fleet-shims", "git"), path.join(runs, "_sessions", "session-1")]) {
      assert.ok(denied(hook(repo, "write-scope", { tool_input: { file_path: file } })), `write-scope: ${file}`);
      assert.ok(denied(hook(repo, "state-guard", { tool_input: { file_path: file } })), `state-guard: ${file}`);
    }
    assert.equal(hook(repo, "state-guard", { tool_input: { file_path: path.join(runDir, "round-1", "verification.md") } }).out, "");
    for (const command of [`echo '{}' > ${path.join(runs, "_tokens", "record-x.json")}`, `cp fake.json ${path.join(runDir, "latest.json")}`,
      "printf x > .git/agent-runs/_locks/verifier-x.lock", `cd ${runDir} && cp /tmp/fake.json latest.json`,
      "cd .git/agent-runs/feature__1-test && cp /tmp/w.json workspace.json", "rm -rf .git/agent-runs/_shims",
      "touch .git/agent-runs/_sessions/another-session"]) {
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
  let gh;
  let session;
  const child = (name) => path.join(ws, name);
  const origin = (name) => path.join(dir, "acme", `${name}.git`);
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
    git(cwd, "remote", "add", "origin", `file://${origin}`);
  };
  const record = (verdict = "PASS") =>
    ["record", "--verdict", verdict, "--blocking", "0", "--issue", "https://example.com/7", "--report", report];
  const verify = (cwd, agent, verdict = "PASS") => {
    hook(cwd, "verifier-start", { agent_id: agent });
    hook(cwd, "authorize-record", { agent_id: agent, ...bash(cwd, `node .agents/scripts/gate.mjs ${record(verdict).join(" ")}`) });
    return gate(cwd, record(verdict));
  };
  const allowed = (cwd, command) => hook(cwd, "bash-guard", { session_id: session.id, ...bash(cwd, command) }).out === "";

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
      git(child(name), "push", "-q", "-u", "origin", "main");
    }
    for (const name of ["a", "b"]) git(child(name), "switch", "-q", "-c", "feature/7-across");
    // c keeps its default branch checked out, with a commit its origin lacks.
    fs.appendFileSync(path.join(child("c"), "app.txt"), "unverified\n");
    commit(child("c"), "unverified");
    gh = fakeGh(dir);
    session = startSession(ws, gh, "feature/7-across");
    report = path.join(dir, "report.md");
    fs.writeFileSync(report, "report\n");
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  test("a verdict for the workspace's own empty patch no longer passes a member's pull request", () => {
    // The way around the gate before workspaces: verify the workspace repository, whose patch is empty because it
    // ignores its children, then open a child's pull request from the workspace root. The hook reads the command
    // against the workspace repository and lets it through. The wrapper judges the child it really runs in.
    assert.equal(verify(ws, "v0").code, 0);
    fs.appendFileSync(path.join(child("a"), "app.txt"), "change\n");
    commit(child("a"), "work");
    git(child("a"), "push", "-q", "-u", "origin", "feature/7-across");
    for (const command of ["cd a && gh pr create --title t", "cd a; gh pr ready", "(cd a && gh pr create --title t)"]) {
      assert.equal(session.holdsPr(ws, command), "wrapper", command);
    }
    assert.ok(session.holdsPr(ws, "gh -R acme/a pr create --title t"), "named from the root");
    assert.ok(session.holdsPr(child("a"), "gh pr create --title t"), "from the member itself");
    // The same for a push: c has its default branch checked out.
    for (const command of ["cd c && git push", "git -C c push", "cd c; git push origin HEAD"]) {
      assert.equal(session.holdsPush(ws, command, origin("c")), "wrapper", command);
    }
    const pushed = session.run(ws, "cd a && git push");
    assert.equal(pushed.refusedBy, null, pushed.output);
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
    // However the command reaches the member: from its directory, after a cd from the root, or by naming it.
    for (const [cwd, command] of [
      [child("a"), "gh pr create --title t"],
      [ws, "cd a && gh pr create --title t"],
      [ws, "gh pr create --repo acme/a --head feature/7-across --title t"],
      [ws, "gh -R acme/a pr create --title t"],
      [ws, "gh pr create -Racme/a -Hfeature/7-across --title t"],
      [child("b"), "cd ../a && gh pr ready 7"],
      [child("a"), "gh pr ready https://github.com/acme/a/pull/7"],
      [child("a"), "gh pr create --title t --body 'Part of https://github.com/acme/b/pull/2'"],
      [child("a"), "gh pr create --title t --body \"$(cat <<'EOF'\nA \"quoted\" body (with a paren; and a semicolon)\nEOF\n)\""],
    ]) {
      session.opens(cwd, command);
    }
    for (const [cwd, command, why] of [
      [ws, "gh -R acme/a pr create --head other --title t", "--head must be the branch the gate checks"],
      [ws, "gh pr create --repo acme/c --head main --title t", "c is not a member"],
      [ws, "gh pr create --repo acme/a --repo acme/c --title t", "gh uses the last --repo"],
      [child("a"), "GH_REPO=acme/c gh pr create --title t", "GH_REPO names another repository"],
      [child("a"), "gh pr ready 8", "another branch's pull request"],
      [child("a"), "gh pr ready https://github.com/acme/c/pull/7", "a URL of another repository"],
      [child("a"), "gh pr edit https://github.com/acme/c/pull/7 --base main", "retarget by URL elsewhere"],
      [ws, "cd b && gh pr create --title t", "b is not pushed"],
      [child("a"), "cd ../b && gh pr create --title t", "b is not pushed, whatever a's state"],
      [ws, "cd c && gh pr create --title t", "c is not a member, and has no verdict of its own"],
      [ws, "gh pr create --title t", "the workspace repository is not a member"],
    ]) {
      assert.equal(session.holdsPr(cwd, command), "wrapper", `${command}: ${why}`);
    }
    fs.appendFileSync(path.join(child("b"), "app.txt"), "after verification\n");
    commit(child("b"), "late");
    assert.ok(session.holdsPr(child("a"), "gh pr create --title t"), "b changed after verification");
    git(child("b"), "reset", "-q", "--hard", "HEAD~1");
    session.opens(child("a"), "gh pr create --title t");
  });
  test("a round covers every member, and publish posts each member's status", () => {
    const opened = JSON.parse(gate(child("a"), ["round", "open"]).out);
    assert.deepEqual(opened.repos.map((r) => r.path), ["a", "b"]);
    const recorded = gate(ws, [...record(), "--key", opened.key, "--verifier", "gpt-5.6-sol xhigh"]);
    assert.equal(recorded.code, 0, recorded.err);
    assert.equal(JSON.parse(recorded.out).fingerprint, opened.fingerprint);
    const env = { PATH: `${gh.bin}${path.delimiter}${process.env.PATH}`, GH_LOG: gh.log };
    fs.rmSync(gh.log, { force: true });
    const published = gate(ws, ["publish", "--repo", "a"], undefined, env);
    assert.equal(published.code, 0, published.err);
    const [call] = fs.readFileSync(gh.log, "utf8").split("\n").filter((line) => line.includes(":: api "));
    assert.ok(call.startsWith(`${fs.realpathSync(child("a"))} :: `), call);
    assert.match(call, new RegExp(`statuses/${git(child("a"), "rev-parse", "HEAD")} .*description=PASS from gpt-5.6-sol xhigh for patch [0-9a-f]{12}, with b`));
    assert.match(gate(ws, ["publish", "--repo", "b"], undefined, env).err, /no pushed counterpart.*Nothing was posted/);
  });

  test("without the wrappers, nothing in a workspace pushes or opens a pull request", () => {
    // Which repository a command acts on depends on where it runs, and only the wrappers see that. A session whose
    // session-start hook didn't run has none, so the hook refuses there what it would otherwise leave to them.
    const bare = (cwd, command) => hook(cwd, "bash-guard", { session_id: "another-session", ...bash(cwd, command) });
    for (const [cwd, command] of [
      [ws, "cd a && gh pr create --title t"],
      [child("a"), "gh pr create --title t"],
      [ws, "git -C a push -u origin feature/7-across"],
      [child("a"), "git push"],
    ]) {
      assert.match(bare(cwd, command).out, /This session has none/, command);
      assert.ok(denied(hook(cwd, "bash-guard", bash(cwd, command))), `no session at all: ${command}`);
    }
    for (const command of ["git status", "gh pr create --draft --title t", "gh pr view 3"]) {
      assert.equal(bare(ws, command).out, "", command);
    }
    // Outside a workspace nothing changes: c answers to no workspace, and the hook judges it as it always did.
    assert.equal(bare(child("c"), "git push -u origin topic").out, "");
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

  test("in a workspace, a push is checked in the repository it runs in", () => {
    for (const [command, by] of [
      ["git -C c push origin main", "hook"],
      ["git -C c push", "wrapper"],
      ["cd c && git push", "wrapper"],
      ["git -C c push -u origin HEAD", "wrapper"],
      ["GIT_DIR=c/.git git push", "wrapper"],
      ["git --git-dir=c/.git --work-tree=c push", "wrapper"],
      ["X=c; git -C $X push", "wrapper"],
    ]) {
      assert.equal(session.holdsPush(ws, command, origin("c")), by, command);
    }
    for (const [cwd, command] of [
      [ws, "git -C a push -u origin feature/7-across"],
      [ws, "cd a && git push"],
      [ws, "git push origin feature/7-across"],
      [child("a"), "git push"],
      [child("a"), 'git push -u origin "$(git branch --show-current)"'],
    ]) {
      const pushed = session.run(cwd, command);
      assert.equal(pushed.refusedBy, null, `${command}\n${pushed.output}`);
      assert.equal(pushed.code, 0, `${command}\n${pushed.output}`);
    }
    // A member's own default branch is protected too, whatever its name.
    git(child("a"), "update-ref", "refs/remotes/origin/trunk", "HEAD");
    git(child("a"), "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    try {
      assert.equal(session.holdsPush(ws, "git -C a push origin feature/7-across:trunk", origin("a"), "trunk"), "wrapper");
      assert.equal(session.holdsPush(child("b"), "cd ../a && git push origin HEAD:trunk", origin("a"), "trunk"), "wrapper");
    } finally {
      git(child("a"), "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
      git(child("a"), "update-ref", "-d", "refs/remotes/origin/trunk");
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
    assert.equal(session.holdsPr(child("a"), "gh pr create --title t"), "hook");
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

  test("verifiers can't write to another member, and --repo takes its value either way", () => {
    for (const command of ["git -C ../b reset --hard HEAD~1", "git -C ../b commit -am x"]) {
      assert.ok(denied(hook(child("a"), "observe-only", bash(child("a"), command))), command);
    }
    const b = JSON.parse(gate(ws, ["fingerprint", "--repo", "b"]).out).fingerprint;
    assert.equal(JSON.parse(gate(ws, ["fingerprint", "--repo=b"]).out).fingerprint, b);
    assert.equal(JSON.parse(gate(ws, ["set-base", git(child("b"), "rev-parse", "main"), "--repo=b"]).out).path, "b");
    assert.notEqual(gate(ws, ["fingerprint", "--repo"]).code, 0, "a bare --repo is an error");
  });

  test("a member nested in another member is still a member", () => {
    const sub = path.join(child("a"), "sub");
    init(sub, path.join(dir, "acme", "sub.git"));
    fs.writeFileSync(path.join(sub, "s.txt"), "s\n");
    commit(sub, "init");
    try {
      assert.equal(gate(ws, ["workspace", "set", "a", "b", "a/sub"]).code, 0);
      assert.equal(fs.realpathSync(JSON.parse(gate(sub, ["paths"]).out).root), fs.realpathSync(ws));
    } finally {
      assert.equal(gate(ws, ["workspace", "set", "a", "b"]).code, 0);
      fs.rmSync(sub, { recursive: true, force: true });
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
