#!/usr/bin/env node
// Verification gate for the agent dev loop.
//
// A verdict covers one exact patch. This script fingerprints the patch with
// `git patch-id --verbatim` (whitespace counts; line numbers don't, so a clean
// rebase keeps the fingerprint), records verdicts that only the running
// `verifier` subagent may write, and refuses a ready-for-review PR unless the
// latest verdict for the branch is PASS or PASS+NOTES, has no blocking
// findings, and matches the committed and pushed patch. The idea and the
// patch-id rule come from pstack by Lauren Tan (MIT): the
// agent that wrote the code never gets to say it works, and any edit
// invalidates an old verdict.
//
// Commands:
//   gate.mjs fingerprint [--committed]   fingerprint of base..worktree (or base..HEAD)
//   gate.mjs diff [--committed] [--exclude <pathspec>]...   the exact patch
//   gate.mjs paths                       JSON: repo root, branch, base, run directory
//   gate.mjs set-base <commit>           record the branch's base (from start-issue)
//   gate.mjs record --verdict V --blocking N --issue URL --report PATH   (verifier only)
//   gate.mjs show                        latest verdict and whether it still matches
//   gate.mjs check [--committed]         exit 0 when the gate passes, 1 otherwise
//   gate.mjs hook bash-guard             PreToolUse (Bash) in settings.json: ready PRs, verdict state, default branch
//   gate.mjs hook state-guard            PreToolUse (Edit|Write|NotebookEdit) in settings.json
//   gate.mjs hook verifier-start         SubagentStart, matcher ^verifier$
//   gate.mjs hook verifier-stop          SubagentStop, matcher ^verifier$
//   gate.mjs hook observe-only           PreToolUse (Bash) in verifier/reviewer frontmatter
//   gate.mjs hook authorize-record       PreToolUse (Bash) in verifier frontmatter
//   gate.mjs hook write-scope            PreToolUse (Edit|Write|NotebookEdit) in frontmatter
//   gate.mjs hook agent-scope <types..>  PreToolUse (Agent) in frontmatter
//
// Node.js 20+, standard library only. State lives in <git-common-dir>/agent-runs/
// (shared by every worktree, never tracked), or in $AGENT_RUNS_DIR when set.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERDICTS = ["PASS", "PASS+NOTES", "FAIL", "BLOCKED"];
const PASSING = new Set(["PASS", "PASS+NOTES"]);
const LOCK_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const TOKEN_MAX_AGE_MS = 60 * 1000;
// Agent memory is not part of the patch under verification: agents update it
// after recording a verdict, and it never changes product behaviour.
const MEMORY_EXCLUDES = [":(exclude).claude/agent-memory", ":(exclude).claude/agent-memory-local"];

// ---------------------------------------------------------------- git helpers

function git(args, opts = {}) {
  return execFileSync("git", args, {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...(opts.env ?? {}) },
    input: opts.input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  }).trim();
}

function tryGit(args, opts) {
  try {
    return git(args, opts);
  } catch {
    return null;
  }
}

function repoInfo(cwd = process.cwd()) {
  const root = git(["rev-parse", "--show-toplevel"], { cwd });
  const common = path.resolve(root, git(["rev-parse", "--git-common-dir"], { cwd: root }));
  const named = tryGit(["symbolic-ref", "--short", "-q", "HEAD"], { cwd: root });
  const head = tryGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  const branch = named ?? `detached-${(head ?? "nohead").slice(0, 12)}`;
  return { root, common, branch, detached: !named };
}

function defaultBaseRef(root) {
  const head = tryGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  for (const ref of [head, "origin/main", "origin/master", "main", "master"].filter(Boolean)) {
    if (tryGit(["rev-parse", "--verify", "-q", `${ref}^{commit}`], { cwd: root })) return ref;
  }
  return null;
}

// Base: AGENT_GATE_BASE, else the base recorded with `set-base` (from the
// start-issue record), else the merge base with the default branch.
function resolveBase(info) {
  const recorded = info.detached ? null : tryGit(["config", "--get", `branch.${info.branch}.agentbase`], { cwd: info.root });
  const override = process.env.AGENT_GATE_BASE || recorded;
  if (override) return git(["rev-parse", "--verify", `${override}^{commit}`], { cwd: info.root });
  const ref = defaultBaseRef(info.root);
  if (!ref) throw new Error("No base: no origin/HEAD, origin/main, main or master. Run `gate.mjs set-base <commit>`.");
  return git(["merge-base", "HEAD", ref], { cwd: info.root });
}

// Tree of the working directory, including untracked files .gitignore does not
// exclude, built in a throwaway index so the real index is untouched.
function worktreeTree(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    if (tryGit(["rev-parse", "--verify", "-q", "HEAD"], { cwd: root })) git(["read-tree", "HEAD"], { cwd: root, env });
    git(["add", "-A", "."], { cwd: root, env });
    return git(["write-tree"], { cwd: root, env });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function patchText(info, { committed = false, binary = true, excludes = [] } = {}) {
  const base = resolveBase(info);
  const target = committed ? git(["rev-parse", "HEAD"], { cwd: info.root }) : worktreeTree(info.root);
  const args = ["diff", "--no-color", "--no-ext-diff", ...(binary ? ["--binary"] : []), base, target, "--", ".", ...MEMORY_EXCLUDES];
  for (const e of excludes) args.push(`:(exclude,glob)${e}`);
  return { base, text: execFileSync("git", args, { cwd: info.root, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }) };
}

function fingerprint(info, { committed = false } = {}) {
  const { base, text } = patchText(info, { committed });
  if (!text.trim()) return { base, fingerprint: "empty" };
  const id = git(["patch-id", "--verbatim"], { cwd: info.root, input: text }).split(/\s+/)[0];
  return { base, fingerprint: id || "empty" };
}

// ---------------------------------------------------------------- state

function runsRoot(info) {
  if (process.env.AGENT_RUNS_DIR) {
    const id = crypto.createHash("sha256").update(info.common).digest("hex").slice(0, 10);
    return path.join(process.env.AGENT_RUNS_DIR, `${path.basename(path.dirname(info.common))}-${id}`);
  }
  return path.join(info.common, "agent-runs");
}

function runDir(info) {
  const dir = path.join(runsRoot(info), info.branch.replace(/[^A-Za-z0-9._-]/g, "__"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function stateDir(info, name) {
  const dir = path.join(runsRoot(info), "_" + name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const safeId = (id) => String(id || "default").replace(/[^A-Za-z0-9._-]/g, "_");
const lockFile = (info, agentId) => path.join(stateDir(info, "locks"), `verifier-${safeId(agentId)}.lock`);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function latestVerdict(info) {
  return readJson(path.join(runDir(info), "latest.json"));
}

// ---------------------------------------------------------------- shell parsing
//
// Best-effort tokenizer: splits a Bash command into simple commands on ; & | &&
// || and newlines, respecting quotes, and also yields the contents of $(...)
// and backticks as commands of their own. Good enough for guardrails, not a
// sandbox.

function splitCommands(src) {
  const out = [];
  let cur = [];
  let tok = "";
  let inTok = false;
  const pushTok = () => {
    if (inTok) cur.push(tok);
    tok = "";
    inTok = false;
  };
  const pushCmd = () => {
    pushTok();
    if (cur.length) out.push(cur);
    cur = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length) {
      tok += src[++i];
      inTok = true;
    } else if (c === "'") {
      const end = src.indexOf("'", i + 1);
      tok += src.slice(i + 1, end === -1 ? src.length : end);
      inTok = true;
      i = end === -1 ? src.length : end;
    } else if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < src.length) s += src[++j];
        else s += src[j];
        j++;
      }
      for (const inner of extractSubstitutions(s)) out.push(...splitCommands(inner));
      tok += s;
      inTok = true;
      i = j;
    } else if (c === "$" && src[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < src.length && depth) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")") depth--;
        j++;
      }
      out.push(...splitCommands(src.slice(i + 2, j - 1)));
      tok += "$SUBST";
      inTok = true;
      i = j - 1;
    } else if (c === "`") {
      const end = src.indexOf("`", i + 1);
      out.push(...splitCommands(src.slice(i + 1, end === -1 ? src.length : end)));
      i = end === -1 ? src.length : end;
    } else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")" || c === "{" || c === "}") {
      pushCmd();
    } else if (/\s/.test(c)) {
      pushTok();
    } else {
      tok += c;
      inTok = true;
    }
  }
  pushCmd();
  // Drop leading VAR=value assignments and common wrappers, and split the
  // script a shell runs with -c, such as `bash -c "gh pr ready"`.
  const commands = out
    .map((words) => {
      let w = words.slice();
      while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w.shift();
      while (w.length && ["env", "command", "exec", "time", "nohup", "sudo", "xargs"].includes(w[0])) w.shift();
      return w;
    })
    .filter((w) => w.length);
  const nested = [];
  for (const w of commands) {
    if (!SHELLS.has(path.basename(w[0]))) continue;
    const flag = w.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag !== -1 && w[flag + 1] !== undefined) nested.push(...splitCommands(w[flag + 1]));
  }
  return [...commands, ...nested];
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

function extractSubstitutions(s) {
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "$" && s[i + 1] === "(") {
      let depth = 1;
      let j = i + 2;
      while (j < s.length && depth) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")") depth--;
        j++;
      }
      found.push(s.slice(i + 2, j - 1));
      i = j - 1;
    } else if (s[i] === "`") {
      const end = s.indexOf("`", i + 1);
      if (end === -1) break;
      found.push(s.slice(i + 1, end));
      i = end;
    }
  }
  return found;
}

const base = (w) => path.basename(w);

// git [global options] <sub> [args]  →  { sub, args, cwdOpt, targets }
// targets are the paths the options point git at: -C, --git-dir, --work-tree.
function parseGit(words) {
  if (base(words[0]) !== "git") return null;
  let i = 1;
  let cwdOpt = null;
  const targets = [];
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(w);
    if (eq) {
      targets.push(eq[2]);
      i += 1;
    } else if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--exec-path") {
      if (w === "-C") cwdOpt = words[i + 1];
      if (w === "-C" || w === "--git-dir" || w === "--work-tree") targets.push(words[i + 1]);
      i += 2;
    } else i += 1;
  }
  return { sub: words[i], args: words.slice(i + 1), cwdOpt, targets };
}

// gh [global flags] <group> <sub> [args]  →  { group, sub, args, repo }
function parseGh(words) {
  if (base(words[0]) !== "gh") return null;
  let i = 1;
  let repo = null;
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    if (w === "-R" || w === "--repo" || w === "--hostname") {
      if (w !== "--hostname") repo = words[i + 1];
      i += 2;
    } else if (w.startsWith("--repo=")) {
      repo = w.slice(7);
      i += 1;
    } else i += 1;
  }
  return { group: words[i], sub: words[i + 1], args: words.slice(i + 2), repo };
}

// A flag is on when it appears bare or with a value other than false, 0, no or off.
const hasFlag = (args, ...names) =>
  args.some((a) => names.some((n) => a === n
    || (n.startsWith("--") && a.startsWith(n + "=") && !/^(false|0|no|off)$/i.test(a.slice(n.length + 1)))));

function flagValue(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const n of names) {
      if (args[i] === n) return args[i + 1];
      if (n.startsWith("--") && args[i].startsWith(n + "=")) return args[i].slice(n.length + 1);
    }
  }
  return null;
}

// Does a `gh api` call write? (any method but GET, or fields/input without -X GET)
function ghApiWrites(args) {
  const method = (flagValue(args, "-X", "--method") || "").toUpperCase();
  if (method && method !== "GET") return true;
  const hasBody = hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
  if (hasBody && method !== "GET") return true;
  const joined = args.join(" ");
  return /\bgraphql\b/.test(joined) && /\bmutation\b/.test(joined);
}

// ---------------------------------------------------------------- gate logic

function evaluate(info, { committed }) {
  const v = latestVerdict(info);
  const current = fingerprint(info, { committed });
  if (!v) return { ok: false, reason: `No verdict recorded for branch ${info.branch}. Run a fresh verifier first.` };
  if (!PASSING.has(v.verdict)) return { ok: false, reason: `Latest verdict is ${v.verdict}. Fix the findings and re-verify.` };
  if (Number(v.blocking) !== 0) return { ok: false, reason: `Latest verdict has ${v.blocking} open P0-P2 finding(s).` };
  if (v.fingerprint !== current.fingerprint) {
    return {
      ok: false,
      reason:
        `The verified patch (${v.fingerprint.slice(0, 12)}) differs from the ${committed ? "committed" : "working-tree"} patch ` +
        `(${current.fingerprint.slice(0, 12)}): the code changed after verification, or not everything verified is committed. Re-verify.`,
    };
  }
  return { ok: true, reason: `Verified ${v.verdict} at ${v.recorded_at} matches the current ${committed ? "committed" : "working-tree"} patch.` };
}

function pushedMatchesHead(info) {
  const head = git(["rev-parse", "HEAD"], { cwd: info.root });
  const pushed = tryGit(["rev-parse", "--verify", "-q", "@{push}"], { cwd: info.root });
  if (!pushed) return { ok: false, reason: "The branch has no pushed counterpart. Push it before opening a ready PR." };
  if (pushed !== head) return { ok: false, reason: "The pushed branch differs from HEAD. Push the verified commit (or re-verify what was pushed)." };
  return { ok: true };
}

// The real path of a file that may not exist yet: the nearest existing
// ancestor resolved through symlinks, such as macOS's /var -> /private/var,
// with the rest appended.
function realish(target) {
  let existing = target;
  const rest = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return target;
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const real = fs.realpathSync.native(existing);
  const joined = path.join(real, ...rest);
  return process.platform === "win32" ? joined.toLowerCase() : joined;
}

// ---------------------------------------------------------------- hook I/O

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }),
  );
  process.exit(0);
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      flags._.push(a);
      continue;
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) flags[key] = true;
    else {
      if (key === "exclude") (flags.exclude ??= []).push(next);
      else flags[key] = next;
      i++;
    }
  }
  return flags;
}

// ---------------------------------------------------------------- hooks

/** The default branch's short name, from origin/HEAD, else main or master. */
function defaultBranch(root) {
  const head = tryGit(["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], { cwd: root });
  if (head) return head.replace(/^origin\//, "");
  return tryGit(["rev-parse", "--verify", "-q", "refs/heads/main"], { cwd: root }) ? "main" : "master";
}

/** Whether a path, once real, falls in the gate's own state: tokens, locks and verdict records. */
function isGateState(info, file) {
  const root = realish(runsRoot(info));
  const abs = realish(file);
  if (!(abs === root || abs.startsWith(root + path.sep))) return false;
  const [top] = path.relative(root, abs).split(path.sep);
  return top.startsWith("_") || ["latest.json", "verdicts.jsonl"].includes(path.basename(abs));
}

const hooks = {
  // Settings PreToolUse on every Bash call: protect the verdict state, never
  // push the default branch, and gate ready PRs wherever they hide in a command.
  "bash-guard"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    const commands = splitCommands(raw);
    let info = null;
    try {
      info = repoInfo(cwd);
    } catch {
      // Not in a repository: only the PR checks below apply.
    }
    if (info) {
      const stateWords = /(?:^|[\\/])(_tokens|_locks|latest\.json|verdicts\.jsonl)\b/;
      const mentionsRuns = raw.includes("agent-runs") || raw.includes(runsRoot(info));
      if (mentionsRuns && stateWords.test(raw)) {
        deny("The verdict state (tokens, locks, latest.json, verdicts.jsonl) is written only by gate.mjs. Use `node .agents/scripts/gate.mjs show` to read it.");
      }
      const main = defaultBranch(info.root);
      for (const w of commands) {
        const g = parseGit(w);
        if (!g || g.sub !== "push") continue;
        const positional = g.args.filter((arg) => !arg.startsWith("-"));
        const refspecs = positional.slice(1);
        const protectedName = (ref) => ["main", "master", main].includes(ref.replace(/^\+/, "").replace(/^refs\/heads\//, ""));
        const pushesMain =
          hasFlag(g.args, "--all", "--mirror") ||
          (refspecs.length === 0 && info.branch === main) ||
          refspecs.some((spec) => {
            const dst = spec.includes(":") ? spec.split(":").pop() : spec;
            return protectedName(dst) || (dst.replace(/^\+/, "") === "HEAD" && info.branch === main);
          });
        if (pushesMain) deny(`Never push to the default branch (${main}). Push the issue branch and open a pull request.`);
      }
    }
    const gated = [];
    for (const w of commands) {
      const gh = parseGh(w);
      if (!gh) continue;
      if (gh.group === "pr" && gh.sub === "create" && !hasFlag(gh.args, "--draft", "-d")) gated.push({ gh, kind: "create" });
      else if (gh.group === "pr" && gh.sub === "ready" && !hasFlag(gh.args, "--undo")) gated.push({ gh, kind: "ready" });
      else if (gh.group === "pr" && gh.sub === "edit" && hasFlag(gh.args, "--base", "-B")) gated.push({ gh, kind: "retarget" });
      else if (gh.group === "api") {
        const apiArgs = [gh.sub, ...gh.args];
        const target = apiArgs.join(" ");
        const graphqlInput = gh.sub === "graphql" && hasFlag(gh.args, "--input");
        const prWrite = ghApiWrites(apiArgs) && (/\/pulls\b/.test(target) || /createPullRequest|markPullRequestReadyForReview|updatePullRequestBranch/.test(target));
        if (prWrite || graphqlInput) {
          deny("Verification gate: open, ready or retarget PRs with `gh pr create` or `gh pr ready` so the gate can check them, "
            + "not `gh api`; a GraphQL query from a file can't be checked, so pass it with -f query=… instead.");
        }
      }
    }
    if (!gated.length) process.exit(0);
    if (!info) deny("Verification gate: not in a git repository, so the patch can't be checked.");
    for (const { gh } of gated) {
      const head = flagValue(gh.args, "--head", "-H");
      if (head && head.split(":").pop() !== info.branch) {
        deny(`Verification gate: run this from the branch being proposed (--head ${head}, but HEAD is ${info.branch}).`);
      }
      if (gh.repo) {
        const origin = tryGit(["remote", "get-url", "origin"], { cwd: info.root }) ?? "";
        if (!origin.replace(/\.git$/, "").endsWith(gh.repo.replace(/^.*github\.com[/:]/, ""))) {
          deny(`Verification gate: --repo ${gh.repo} is not this checkout's origin, so the patch can't be checked.`);
        }
      }
    }
    try {
      const r = evaluate(info, { committed: true });
      if (!r.ok) {
        deny(
          `Verification gate: ${r.reason} A ready-for-review PR needs a PASS or PASS+NOTES verdict from a fresh verifier for the ` +
            `exact committed patch (check: node .agents/scripts/gate.mjs check --committed). Open it with --draft if you only need CI.`,
        );
      }
      const p = pushedMatchesHead(info);
      if (!p.ok) deny(`Verification gate: ${p.reason}`);
      process.exit(0);
    } catch (e) {
      deny(`Verification gate could not evaluate the patch: ${e.message}`);
    }
  },

  // Settings SubagentStart, matcher ^verifier$: lock, and snapshot the patch.
  "verifier-start"(input, cwd) {
    try {
      const info = repoInfo(cwd);
      const fp = fingerprint(info).fingerprint;
      fs.writeFileSync(
        lockFile(info, input.agent_id),
        JSON.stringify({ agent_id: input.agent_id ?? null, branch: info.branch, fingerprint: fp, started: new Date().toISOString() }),
      );
    } catch {
      // Not a git repository: nothing to lock.
    }
    process.exit(0);
  },

  // Settings SubagentStop, matcher ^verifier$: no finishing without a verdict.
  "verifier-stop"(input, cwd) {
    let info;
    try {
      info = repoInfo(cwd);
    } catch {
      process.exit(0);
    }
    const file = lockFile(info, input.agent_id);
    const lock = readJson(file);
    const release = () => {
      fs.rmSync(file, { force: true });
      process.exit(0);
    };
    if (input.stop_hook_active === true) release(); // already reminded once; never loop
    const v = latestVerdict(info);
    const started = lock ? Date.parse(lock.started) : 0;
    if (v && (!started || Date.parse(v.recorded_at) >= started)) release();
    process.stderr.write(
      "Before you finish, write your record and run: node .agents/scripts/gate.mjs record --verdict <PASS|PASS+NOTES|FAIL|BLOCKED> " +
        "--blocking <n> --issue <url> --report <file>. Use BLOCKED with the exact blocker when you could not verify.\n",
    );
    process.exit(2);
  },

  // Verifier frontmatter PreToolUse on Bash: mint a one-use token for its own
  // `gate.mjs record` call. Frontmatter hooks run only while that subagent is
  // active, so no other agent can obtain a token.
  "authorize-record"(input, cwd) {
    const commands = splitCommands(String(input?.tool_input?.command ?? ""));
    const records = commands.filter((w) => w.some((t) => /gate\.mjs$/.test(t)) && w.includes("record"));
    if (!records.length) process.exit(0);
    if (commands.length > 1) deny("Run `gate.mjs record` as a command of its own, not combined with others.");
    try {
      const info = repoInfo(cwd);
      fs.writeFileSync(
        path.join(stateDir(info, "tokens"), `record-${safeId(input.agent_id)}.json`),
        JSON.stringify({ agent_id: input.agent_id ?? null, issued: new Date().toISOString() }),
      );
    } catch {
      // Not a repository: record will fail on its own.
    }
    process.exit(0);
  },

  // Verifier/reviewer frontmatter PreToolUse on Bash: observe, never change.
  "observe-only"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    let root = null;
    try {
      root = repoInfo(cwd).root;
    } catch {
      // Not in a repository.
    }
    for (const w of splitCommands(raw)) {
      const g = parseGit(w);
      if (g && g.sub) {
        // Commands pointed at a throwaway worktree outside the checkout are fine, but
        // only when every path git is pointed at (-C, --git-dir, --work-tree, GIT_DIR) is outside.
        const realRoot = root ? realish(root) : null;
        const isOutside = (p) => {
          const real = realish(path.resolve(cwd, p));
          return realRoot && real !== realRoot && !real.startsWith(realRoot + path.sep);
        };
        const outside = g.targets.length > 0 && g.targets.every(isOutside) && !/\bGIT_(DIR|WORK_TREE|INDEX_FILE)=/.test(raw);
        const worktreeRemovable = g.sub === "worktree" && g.args[0] === "remove"
          && g.args.slice(1).filter((arg) => !arg.startsWith("-")).every((p) => {
            const real = realish(path.resolve(cwd, p));
            const tmp = realish(os.tmpdir());
            return real.startsWith(tmp + path.sep) && isOutside(p);
          });
        const readOnlyForm =
          (g.sub === "stash" && ["list", "show"].includes(g.args[0])) ||
          (g.sub === "tag" && (g.args.length === 0 || hasFlag(g.args, "-l", "--list", "-n", "--contains", "--points-at"))) ||
          (g.sub === "branch" && !hasFlag(g.args, "-d", "-D", "-m", "-M", "-c", "-C", "-f", "--delete", "--move", "--copy", "--force", "--set-upstream-to", "-u", "--unset-upstream")) ||
          (g.sub === "worktree" && (g.args[0] === "list" || (g.args[0] === "add" && hasFlag(g.args, "--detach")) || worktreeRemovable)) ||
          (g.sub === "remote" && (g.args.length === 0 || ["-v", "show", "get-url"].includes(g.args[0])));
        const writes = [
          "commit", "push", "checkout", "switch", "reset", "stash", "clean", "rebase", "merge", "cherry-pick", "am", "apply",
          "restore", "rm", "mv", "tag", "revert", "update-ref", "filter-branch", "branch", "notes", "pull", "remote", "worktree",
          "submodule", "config", "gc", "prune", "replace", "symbolic-ref", "update-index", "add",
        ];
        if (writes.includes(g.sub) && !readOnlyForm && !(outside && !["push", "update-ref", "config"].includes(g.sub))) {
          deny(
            `Observe only: \`git ${g.sub}\` changes the checkout, history or config. To inspect the base, use ` +
              "`git worktree add --detach <temp-dir> <base>` and run commands there with `git -C <temp-dir>`.",
          );
        }
      }
      const gh = parseGh(w);
      if (gh) {
        const ghWrites = {
          pr: ["create", "edit", "comment", "close", "reopen", "merge", "ready", "review", "checkout", "lock", "unlock", "update-branch", "revert"],
          issue: ["create", "edit", "comment", "close", "reopen", "delete", "transfer", "pin", "unpin", "lock", "unlock", "develop"],
          release: ["create", "edit", "delete", "upload", "delete-asset"],
          project: ["create", "edit", "delete", "item-add", "item-edit", "item-delete", "item-archive", "field-create", "field-delete", "link", "unlink", "copy", "close", "mark-template"],
          label: ["create", "edit", "delete", "clone"],
          repo: ["create", "edit", "delete", "fork", "rename", "archive", "sync", "clone"],
          workflow: ["run", "enable", "disable"],
          run: ["rerun", "cancel", "delete"],
          secret: ["set", "delete"],
          variable: ["set", "delete"],
        };
        if ((ghWrites[gh.group] ?? []).includes(gh.sub) || (gh.group === "api" && ghApiWrites([gh.sub, ...gh.args]))) {
          deny(`Observe only: \`gh ${gh.group} ${gh.sub}\` writes to GitHub or changes the checkout. Report back instead.`);
        }
      }
    }
    process.exit(0);
  },

  // Frontmatter PreToolUse on Edit|Write|NotebookEdit: writes only to the run
  // directory, the system temp directory, and agent memory.
  "write-scope"(input, cwd) {
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!target) process.exit(0);
    const abs = realish(path.resolve(cwd, String(target)));
    const within = (dir) => {
      const real = realish(dir);
      return abs === real || abs.startsWith(real + path.sep);
    };
    try {
      const info = repoInfo(cwd);
      if (isGateState(info, abs)) deny("The verdict state is written only by gate.mjs.");
      const inRepo = [runsRoot(info), path.join(info.root, ".claude", "agent-memory-local"), path.join(info.root, ".claude", "agent-memory")];
      if (inRepo.some(within)) process.exit(0);
      if (within(info.root)) {
        deny(`This agent never edits the checkout. Write only under the run directory (node .agents/scripts/gate.mjs paths) or its memory; ${abs} is in the working tree.`);
      }
    } catch {
      // Not a repository: only temp is allowed.
    }
    if (within(os.tmpdir())) process.exit(0);
    deny(
      `This agent writes only under the run directory (node .agents/scripts/gate.mjs paths), the temp directory, or its memory. ` +
        `${abs} is outside them.`,
    );
  },

  // Settings PreToolUse on Edit|Write|NotebookEdit: no agent writes the verdict state.
  "state-guard"(input, cwd) {
    const target = input?.tool_input?.file_path ?? input?.tool_input?.notebook_path;
    if (!target) process.exit(0);
    try {
      if (isGateState(repoInfo(cwd), path.resolve(cwd, String(target)))) deny("The verdict state is written only by gate.mjs.");
    } catch {
      // Not a repository: nothing to protect.
    }
    process.exit(0);
  },

  // Frontmatter PreToolUse on Agent: spawn only the listed subagent types.
  "agent-scope"(input, _cwd, allowedTypes) {
    const type = input?.tool_input?.subagent_type ?? "general-purpose";
    if (allowedTypes.includes(type)) process.exit(0);
    deny(`This agent may only spawn: ${allowedTypes.join(", ")}. Requested: ${type}.`);
  },
};

// ---------------------------------------------------------------- commands

const commands = {
  fingerprint(argv) {
    const info = repoInfo();
    const { base: b, fingerprint: fp } = fingerprint(info, { committed: Boolean(parseFlags(argv).committed) });
    console.log(JSON.stringify({ branch: info.branch, base: b, fingerprint: fp }));
  },

  diff(argv) {
    const f = parseFlags(argv);
    process.stdout.write(patchText(repoInfo(), { committed: Boolean(f.committed), binary: false, excludes: f.exclude ?? [] }).text);
  },

  paths() {
    const info = repoInfo();
    console.log(JSON.stringify({ root: info.root, branch: info.branch, base: resolveBase(info), runDir: runDir(info) }, null, 2));
  },

  "set-base"(argv) {
    const info = repoInfo();
    if (info.detached) throw new Error("HEAD is detached; switch to the issue branch first.");
    const sha = git(["rev-parse", "--verify", `${argv[0]}^{commit}`], { cwd: info.root });
    git(["config", `branch.${info.branch}.agentbase`, sha], { cwd: info.root });
    console.log(JSON.stringify({ branch: info.branch, base: sha }));
  },

  record(argv) {
    const f = parseFlags(argv);
    const info = repoInfo();
    // The token proves the call came from the verifier (see authorize-record).
    const tokens = stateDir(info, "tokens");
    const now = Date.now();
    const token = fs
      .readdirSync(tokens)
      .map((name) => ({ file: path.join(tokens, name), data: readJson(path.join(tokens, name)) }))
      .find((t) => t.data && now - Date.parse(t.data.issued) < TOKEN_MAX_AGE_MS);
    if (!token) {
      console.error("Refused: only the verifier subagent may record a verdict.");
      process.exit(1);
    }
    fs.rmSync(token.file, { force: true });
    const lock = readJson(lockFile(info, token.data.agent_id));
    if (!lock || now - Date.parse(lock.started) > LOCK_MAX_AGE_MS) {
      console.error("Refused: no live verifier session for this agent.");
      process.exit(1);
    }
    const verdict = String(f.verdict ?? "").toUpperCase();
    if (!VERDICTS.includes(verdict)) throw new Error(`--verdict must be one of ${VERDICTS.join(", ")}`);
    const blocking = Number(f.blocking);
    if (!Number.isInteger(blocking) || blocking < 0) throw new Error("--blocking must be the count of Fail criteria plus open P0-P2 findings.");
    if (PASSING.has(verdict) && blocking > 0) throw new Error(`${verdict} with ${blocking} blocking finding(s) is contradictory. Record FAIL.`);
    if (!f.report || !fs.existsSync(String(f.report))) throw new Error("--report must point to the written verification record.");
    const fp = fingerprint(info);
    if (lock.branch !== info.branch) throw new Error(`Verification started on ${lock.branch}, but HEAD is now ${info.branch}.`);
    if (PASSING.has(verdict) && fp.fingerprint !== lock.fingerprint) {
      throw new Error(
        "The patch changed while you were verifying (an edit, or untracked files a build or the harness created; see `git status`). " +
          "Your evidence covers the earlier patch. Record FAIL or BLOCKED naming the files, or ask for them to be ignored and re-verify.",
      );
    }
    const entry = {
      branch: info.branch,
      issue: f.issue ?? null,
      base: fp.base,
      fingerprint: lock.fingerprint,
      head: tryGit(["rev-parse", "HEAD"], { cwd: info.root }),
      verdict,
      blocking,
      report: path.resolve(String(f.report)),
      verifier: token.data.agent_id,
      recorded_at: new Date().toISOString(),
    };
    const dir = runDir(info);
    fs.appendFileSync(path.join(dir, "verdicts.jsonl"), JSON.stringify(entry) + "\n");
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(entry, null, 2) + "\n");
    console.log(JSON.stringify(entry, null, 2));
  },

  show() {
    const info = repoInfo();
    const v = latestVerdict(info);
    if (!v) return console.log(JSON.stringify({ branch: info.branch, verdict: null }));
    const current = fingerprint(info).fingerprint;
    console.log(JSON.stringify({ ...v, matches_worktree: v.fingerprint === current, current_fingerprint: current }, null, 2));
  },

  check(argv) {
    const committed = Boolean(parseFlags(argv).committed);
    const r = evaluate(repoInfo(), { committed });
    console.log(r.reason);
    process.exit(r.ok ? 0 : 1);
  },

  hook(argv) {
    const [which, ...rest] = argv;
    if (!hooks[which]) throw new Error(`Unknown hook: ${which}`);
    const input = readStdinJson();
    const cwd = input.cwd && fs.existsSync(input.cwd) ? input.cwd : process.cwd();
    hooks[which](input, cwd, rest);
  },
};

const [cmd, ...rest] = process.argv.slice(2);
if (!commands[cmd]) {
  console.error("Usage: gate.mjs <fingerprint|diff|paths|set-base|record|show|check|hook> [...]");
  process.exit(1);
}
try {
  commands[cmd](rest);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
