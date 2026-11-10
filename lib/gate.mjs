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
// In a workspace, a repository that holds independent child repositories in
// its subfolders, `gate.mjs workspace set <path>...` names the repositories an
// issue changes. A verdict then covers every one of them, and a pull request in
// any of them needs that verdict. A repository without a workspace file works
// exactly as before.
//
// Commands:
//   gate.mjs fingerprint [--committed] [--repo <path>]   fingerprint of base..worktree (or base..HEAD);
//                                        in a workspace, of every member, or of one with --repo
//   gate.mjs diff [--committed] [--repo <path>] [--exclude <pathspec>]...   the exact patch of one repository
//   gate.mjs paths                       JSON: repo root, branch, base, run directory, and workspace members
//   gate.mjs set-base <commit> [--repo <path>]   record the branch's base (from start-issue)
//   gate.mjs workspace set <path>... | show | clear   name the repositories an issue changes, from the workspace root
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

function runDirPath(info) {
  return path.join(runsRoot(info), info.branch.replace(/[^A-Za-z0-9._-]/g, "__"));
}

function runDir(info) {
  const dir = runDirPath(info);
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

// ---------------------------------------------------------------- workspaces
//
// The workspace file lives in the workspace root's run directory and lists its
// members as paths from the workspace root, "." being the workspace's own
// repository. Gate state for a workspace issue lives in that run directory too,
// whichever member a command or hook starts in.

const WORKSPACE_FILE = "workspace.json";
const toPosix = (p) => p.split(path.sep).join("/");

function tryRepoInfo(dir) {
  try {
    return repoInfo(dir);
  } catch {
    return null;
  }
}

/** The members recorded for the workspace whose root is info.root, or null. */
function workspaceMembers(info) {
  const data = readJson(path.join(runDirPath(info), WORKSPACE_FILE));
  return Array.isArray(data?.members) && data.members.length ? data.members : null;
}

/** The repository of one member, by its path from the workspace root. */
function memberRepo(ws, rel) {
  if (rel === ".") return ws;
  const dir = path.resolve(ws.root, ...rel.split("/"));
  const info = fs.existsSync(dir) ? tryRepoInfo(dir) : null;
  if (!info || realish(info.root) !== realish(dir)) {
    throw new Error(`${rel} is not the root of a Git repository of its own. Name the issue's repositories again with \`gate.mjs workspace set\`.`);
  }
  return info;
}

/** The workspace that lists a repository as a member: { ws, members, rel }, or null. */
function enclosingWorkspace(info) {
  const parent = path.dirname(info.root);
  if (parent === info.root) return null;
  const ws = tryRepoInfo(parent);
  if (!ws) return null;
  const members = workspaceMembers(ws);
  const rel = toPosix(path.relative(ws.root, info.root));
  return members?.includes(rel) ? { ws, members, rel } : null;
}

/** The workspace root for workspace commands: the enclosing workspace when cwd is in a member, else cwd's repository. */
function workspaceRoot(cwd = process.cwd()) {
  const info = repoInfo(cwd);
  return enclosingWorkspace(info)?.ws ?? info;
}

/**
 * Where the gate's state lives for a directory. In a workspace, info is the
 * workspace root, members lists the member paths, and rel is this directory's
 * member. Otherwise members is null and info is the repository itself.
 */
function gateContext(cwd) {
  const info = repoInfo(cwd);
  // Membership comes first: a member answers to the workspace's verdict even if it has a workspace file of its own.
  const outer = enclosingWorkspace(info);
  if (outer) return { info: outer.ws, members: outer.members, rel: outer.rel };
  const members = workspaceMembers(info);
  if (members) return { info, members, rel: "." };
  return { info, members: null, rel: null };
}

function memberStates(ws, members, { committed = false } = {}) {
  return members.map((rel) => {
    const info = memberRepo(ws, rel);
    const { base, fingerprint: fp } = fingerprint(info, { committed });
    return { path: rel, branch: info.branch, base, fingerprint: fp };
  });
}

/** One fingerprint for a workspace change: every member's path and patch. */
function combinedFingerprint(states) {
  const id = crypto.createHash("sha256").update(JSON.stringify(states.map((s) => [s.path, s.fingerprint]))).digest("hex");
  return `workspace-${id.slice(0, 40)}`;
}

/** The fingerprint of what a context covers: one repository, or every workspace member. */
function contextFingerprint(ctx, { committed = false } = {}) {
  if (!ctx.members) return { ...fingerprint(ctx.info, { committed }), repos: null };
  const repos = memberStates(ctx.info, ctx.members, { committed });
  return { base: null, fingerprint: combinedFingerprint(repos), repos };
}

/** Whether a Git origin URL names the same repository as a slug such as `<owner>/<name>` or `github.com/<owner>/<name>`. */
function sameRepository(origin, slug) {
  const lastTwo = (s) => s.replace(/\.git$/, "").replace(/\/+$/, "").split(/[/:]/).filter(Boolean).slice(-2).join("/").toLowerCase();
  return Boolean(origin) && lastTwo(slug).includes("/") && lastTwo(origin) === lastTwo(slug);
}

/** The local repository a `gh --repo` slug names: the start repository, a workspace member, or a child of the workspace root. */
function repositoryForSlug(start, slug) {
  const ctx = (() => {
    try {
      return gateContext(start.root);
    } catch {
      return null;
    }
  })();
  const ws = ctx?.members ? ctx.info : start;
  const roots = [start.root, ws.root, ...(ctx?.members ?? []).map((rel) => path.resolve(ws.root, ...rel.split("/")))];
  for (const entry of fs.readdirSync(ws.root, { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(ws.root, entry.name, ".git"))) roots.push(path.join(ws.root, entry.name));
  }
  for (const root of roots) {
    const info = fs.existsSync(root) ? tryRepoInfo(root) : null;
    if (info && realish(info.root) === realish(root) && sameRepository(tryGit(["remote", "get-url", "origin"], { cwd: root }), slug)) return info;
  }
  return null;
}

// ---------------------------------------------------------------- shell parsing
//
// A best-effort reading of a Bash command line: good enough for guardrails, not
// a sandbox. It fails closed: it skips no text. Quoted strings, substitutions,
// comments and heredoc bodies are all read, the bodies and comments as plain
// words in which only substitutions are active, so a mistake in telling data
// from commands can only make the gate refuse more. An unterminated quote or
// substitution marks the reading uncertain.

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
// Commands that run another command: their options come before it.
const WRAPPERS = new Set(["env", "command", "exec", "time", "nohup", "sudo", "xargs", "nice", "timeout", "stdbuf", "builtin"]);
const COMMAND_WORDS = new Set(["gh", "git", ...SHELLS]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const markUncertain = (state) => {
  if (state) state.uncertain = true;
};

function endSingle(src, i, state) {
  const end = src.indexOf("'", i + 1);
  if (end === -1) markUncertain(state);
  return end === -1 ? src.length : end + 1;
}

function endDouble(src, i, state) {
  let j = i + 1;
  while (j < src.length && src[j] !== '"') {
    if (src[j] === "\\") j += 2;
    else if (src[j] === "$" && (src[j + 1] === "(" || src[j + 1] === "{")) j = endNested(src, j + 2, src[j + 1] === "(" ? ")" : "}", state);
    else if (src[j] === "`") j = endNested(src, j + 1, "`", state);
    else j++;
  }
  if (j >= src.length) markUncertain(state);
  return Math.min(j + 1, src.length);
}

/**
 * The heredoc that starts at i, or null. Its delimiter is the shell word after
 * `<<` or `<<-`, with quotes and backslashes removed, as bash reads it.
 */
function heredocAt(src, i) {
  // `<<<` is a here-string, not a heredoc, wherever the scan meets it.
  if (src[i] !== "<" || src[i + 1] !== "<" || src[i + 2] === "<" || src[i - 1] === "<") return null;
  let j = i + 2;
  const dash = src[j] === "-";
  if (dash) j++;
  while (src[j] === " " || src[j] === "\t") j++;
  let delim = "";
  while (j < src.length && !/[\s;&|()<>]/.test(src[j])) {
    const c = src[j];
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, j + 1);
      if (end === -1) return null;
      delim += src.slice(j + 1, end);
      j = end + 1;
    } else if (c === "\\") {
      delim += src[j + 1] ?? "";
      j += 2;
    } else {
      delim += c;
      j++;
    }
  }
  return delim ? { end: j, delim, dash } : null;
}

/**
 * Find the bodies of the pending heredocs, which start after the newline at i.
 * Returns the index of the newline that ends the last body, or the end of src,
 * and passes each body to onBody.
 */
function skipBodies(src, i, pending, onBody = () => {}) {
  let j = i;
  for (const h of pending.splice(0)) {
    const start = j + 1;
    let k = start;
    for (;;) {
      const newline = src.indexOf("\n", k);
      const lineEnd = newline === -1 ? src.length : newline;
      const line = src.slice(k, lineEnd);
      if ((h.dash ? line.replace(/^\t+/, "") : line) === h.delim) {
        onBody(h, src.slice(start, k));
        j = lineEnd;
        break;
      }
      if (newline === -1) {
        onBody(h, src.slice(start));
        return src.length;
      }
      k = newline + 1;
    }
  }
  return j;
}

/** The index just past the `close` that ends a construct whose body starts at i: `)`, `}` or a backtick. */
function endNested(src, i, close, state) {
  const pending = [];
  while (i < src.length) {
    const c = src[i];
    const h = close === ")" ? heredocAt(src, i) : null;
    if (c === "\\") i += 2;
    else if (c === close) return i + 1;
    else if (c === "'") i = endSingle(src, i, state);
    else if (c === '"') i = endDouble(src, i, state);
    else if (c === "$" && (src[i + 1] === "(" || src[i + 1] === "{")) i = endNested(src, i + 2, src[i + 1] === "(" ? ")" : "}", state);
    else if (c === "`" && close !== "`") i = endNested(src, i + 1, "`", state);
    else if (c === "(" && close === ")") i = endNested(src, i + 1, ")", state);
    else if (h) {
      pending.push(h);
      i = h.end;
    } else if (c === "\n" && pending.length) i = skipBodies(src, i, pending) + 1;
    else i++;
  }
  markUncertain(state);
  return src.length;
}

/** The command substitutions in text: inside double quotes, `${...}`, a comment or a heredoc body. */
function substitutionsIn(s, state) {
  const found = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") i++;
    else if (s[i] === "$" && s[i + 1] === "(") {
      const end = endNested(s, i + 2, ")", state);
      found.push(s.slice(i + 2, Math.max(i + 2, end - 1)));
      i = end - 1;
    } else if (s[i] === "`") {
      const end = endNested(s, i + 1, "`", state);
      found.push(s.slice(i + 1, Math.max(i + 1, end - 1)));
      i = end - 1;
    }
  }
  return found;
}

const isShell = (words) => words.length > 0 && SHELLS.has(path.basename(words[0]));

/** A command's words without leading assignments and wrappers such as `env -C <dir>`, `sudo -u <user>` or `timeout 10`. */
function normalize(words) {
  let w = words.slice();
  for (;;) {
    while (w.length && ASSIGNMENT.test(w[0])) w.shift();
    if (!w.length || !WRAPPERS.has(path.basename(w[0]))) return w;
    w.shift();
    const next = w.findIndex((t) => ASSIGNMENT.test(t) || WRAPPERS.has(path.basename(t)) || COMMAND_WORDS.has(path.basename(t)));
    if (next > 0) w = w.slice(next);
  }
}

/**
 * The commands of a command line as raw word lists. Substitutions, -c scripts,
 * here-strings fed to a shell, heredoc bodies and comments come out as commands
 * of their own. In literal mode, used for heredoc bodies and comments, quotes
 * are plain characters and only substitutions are active.
 */
function commandLists(src, state = { uncertain: false }, literal = false) {
  const out = [];
  let cur = [];
  let tok = "";
  let inTok = false;
  const pending = [];
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
      if (src[i + 1] !== "\n") {
        tok += src[i + 1];
        inTok = true;
      }
      i++;
    } else if (!literal && c === "'") {
      const end = endSingle(src, i, state);
      tok += src.slice(i + 1, src[end - 1] === "'" && end - 1 > i ? end - 1 : end);
      inTok = true;
      i = end - 1;
    } else if (!literal && c === '"') {
      const end = endDouble(src, i, state);
      const body = src.slice(i + 1, src[end - 1] === '"' && end - 1 > i ? end - 1 : end);
      for (const inner of substitutionsIn(body, state)) out.push(...commandLists(inner, state));
      tok += body.replace(/\\(.)/g, "$1");
      inTok = true;
      i = end - 1;
    } else if (c === "$" && src[i + 1] === "{") {
      const end = endNested(src, i + 2, "}", state);
      for (const inner of substitutionsIn(src.slice(i + 2, Math.max(i + 2, end - 1)), state)) out.push(...commandLists(inner, state));
      tok += "$VAR";
      inTok = true;
      i = end - 1;
    } else if ((c === "$" && src[i + 1] === "(") || c === "`") {
      const start = c === "`" ? i + 1 : i + 2;
      const end = endNested(src, start, c === "`" ? "`" : ")", state);
      out.push(...commandLists(src.slice(start, Math.max(start, end - 1)), state));
      tok += "$SUBST";
      inTok = true;
      i = end - 1;
    } else if (!literal && c === "#" && !inTok) {
      // A comment ends the line for bash. Its words are still read, as plain words, so an apostrophe in it hides nothing.
      const newline = src.indexOf("\n", i);
      const end = newline === -1 ? src.length : newline;
      pushCmd();
      out.push(...commandLists(src.slice(i + 1, end), state, true));
      i = end - 1;
    } else if (!literal && heredocAt(src, i)) {
      const h = heredocAt(src, i);
      pushTok();
      pending.push(h);
      i = h.end - 1;
    } else if (c === "\n") {
      pushCmd();
      if (pending.length) {
        const bodies = [];
        i = skipBodies(src, i, pending, (doc, body) => bodies.push(body));
        for (const body of bodies) out.push(...commandLists(body, state, true));
      }
    } else if (";&|(){}".includes(c)) {
      pushCmd();
    } else if (/\s/.test(c)) {
      pushTok();
    } else {
      tok += c;
      inTok = true;
    }
  }
  pushCmd();
  // A heredoc that never meets its delimiter runs to the end, and bash reads it so too.
  if (pending.length) skipBodies(src, src.length, pending);
  const nested = [];
  for (const words of out) {
    const w = normalize(words);
    if (!isShell(w)) continue;
    const flag = w.findIndex((arg, index) => index > 0 && /^-[a-z]*c[a-z]*$/.test(arg));
    if (flag !== -1 && w[flag + 1] !== undefined) nested.push(...commandLists(w[flag + 1], state));
    const here = w.findIndex((arg) => arg.startsWith("<<<"));
    if (here !== -1) nested.push(...commandLists(w[here].length > 3 ? w[here].slice(3) : (w[here + 1] ?? ""), state));
  }
  return [...out, ...nested];
}

/** A command line read once: its raw word lists, its commands without assignments and wrappers, and whether the reading is uncertain. */
function readCommandLine(src) {
  const state = { uncertain: false };
  const lists = commandLists(src, state);
  return { lists, commands: lists.map(normalize).filter((w) => w.length), uncertain: state.uncertain };
}

/** The commands of a command line, each without its leading assignments and wrappers. */
function splitCommands(src) {
  return readCommandLine(src).commands;
}

/**
 * The operators that separate commands at the top level of a command line:
 * `;`, `&`, `&&`, `|`, `||`, a newline that another command follows, `(`, `)`,
 * `{`, `}` and a comment, skipping quoted text, substitutions, redirections such
 * as `2>&1`, and heredoc bodies.
 */
function topLevelOperators(src) {
  const ops = [];
  const pending = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const h = heredocAt(src, i);
    if (c === "\\") i += 2;
    else if (c === "'") i = endSingle(src, i);
    else if (c === '"') i = endDouble(src, i);
    else if (c === "$" && (src[i + 1] === "(" || src[i + 1] === "{")) i = endNested(src, i + 2, src[i + 1] === "(" ? ")" : "}");
    else if (c === "`") i = endNested(src, i + 1, "`");
    else if (h) {
      pending.push(h);
      i = h.end;
    } else if (c === "\n") {
      const j = pending.length ? skipBodies(src, i, pending) : i;
      if (src.slice(j + 1).trim()) ops.push(";");
      i = j + 1;
    } else if ((c === "&" || c === "|") && src[i + 1] === c) {
      ops.push(c + c);
      i += 2;
    } else if (c === "&" && (src[i - 1] === ">" || src[i - 1] === "<" || src[i + 1] === ">")) {
      i++;
    } else if (c === "|") {
      ops.push("|");
      i += src[i + 1] === "&" ? 2 : 1;
    } else if (";&(){}".includes(c) || (c === "#" && (i === 0 || /\s/.test(src[i - 1])))) {
      ops.push(c);
      i++;
    } else i++;
  }
  return ops;
}

// Words that change the shell's directory, or the repository git and gh act on, for the commands after them.
const DIRECTORY_WORDS = new Set(["cd", "pushd", "popd", "eval", "source", "."]);
const SHELL_KEYWORDS = new Set(["if", "then", "else", "elif", "do", "while", "until", "!", "time", "command", "builtin"]);

function changesDirectory(words) {
  if (words.some((t) => /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GH_REPO)=/.test(t) || /^--(git-dir|work-tree)(=|$)/.test(t))) return true;
  const env = words.findIndex((t) => path.basename(t) === "env");
  if (env !== -1 && words.slice(env + 1).some((t) => /^(-[A-Za-z]*C|--chdir)(=|$)/.test(t))) return true;
  let i = 0;
  while (i < words.length && (ASSIGNMENT.test(words[i]) || SHELL_KEYWORDS.has(words[i]))) i++;
  return DIRECTORY_WORDS.has(words[i]);
}

/** A `cd` path, the way Git Bash on Windows also writes it, such as `/c/Users/me`. */
function resolveCdPath(from, target) {
  let t = target;
  if (t === "~" || t.startsWith("~/")) t = path.join(os.homedir(), t.slice(1));
  if (process.platform === "win32" && /^\/[A-Za-z](\/|$)/.test(t)) t = `${t[1]}:\\${t.slice(3)}`;
  return path.resolve(from, t);
}

const LEADING_CD = /^\s*cd[ \t]+('[^'\n]*'|"[^"$`\\\n]*"|[^\s;&|()<>`$'"\\#]+)[ \t]*&&/;

/**
 * The directory every command of a command line runs in, as { dir }, or null
 * when the gate can't follow it. A line without a directory change runs in
 * cwd. The one change the gate follows is a single leading `cd <path> &&`,
 * with nothing after it that runs whether or not that `cd` succeeded, and
 * no other `cd`, `pushd`, `popd`, `eval`, `source`, `env -C`, `GIT_DIR`,
 * `GIT_WORK_TREE`, `--git-dir`, `--work-tree` or `GH_REPO` anywhere, including
 * inside substitutions, nested shells, comments and heredoc bodies.
 */
function directoryPlan(raw, cwd, lists = commandLists(raw)) {
  const changes = lists.filter(changesDirectory);
  if (!changes.length) return { dir: cwd };
  const m = LEADING_CD.exec(raw);
  if (!m || changes.length !== 1) return null;
  if (topLevelOperators(raw.slice(m[0].length)).some((op) => op !== "&&" && op !== "|")) return null;
  return { dir: resolveCdPath(cwd, m[1].replace(/^(['"])([\s\S]*)\1$/, "$2")) };
}

const base = (w) => path.basename(w);

// git [global options] <sub> [args]  →  { at, sub, args, cwdOpts, targets }, from the first `git` word of a command.
// at is that word's position: 0 when git is the command itself. cwdOpts are the -C options in order; targets are
// every path the options point git at: -C, --git-dir, --work-tree.
function parseGit(words) {
  const at = words.findIndex((w) => base(w) === "git");
  if (at === -1) return null;
  let i = at + 1;
  const cwdOpts = [];
  const targets = [];
  while (i < words.length && words[i].startsWith("-")) {
    const w = words[i];
    const eq = /^--(git-dir|work-tree)=(.*)$/.exec(w);
    if (eq) {
      targets.push(eq[2]);
      i += 1;
    } else if (w === "-C" || w === "-c" || w === "--git-dir" || w === "--work-tree" || w === "--namespace" || w === "--exec-path") {
      if (w === "-C") cwdOpts.push(words[i + 1]);
      if (w === "-C" || w === "--git-dir" || w === "--work-tree") targets.push(words[i + 1]);
      i += 2;
    } else i += 1;
  }
  return { at, sub: words[i], args: words.slice(i + 1), cwdOpts, targets };
}

// gh [global flags] <group> <sub> [args]  →  { at, group, sub, args, repo }, from the first `gh` word of a command.
function parseGh(words) {
  const at = words.findIndex((w) => base(w) === "gh");
  if (at === -1) return null;
  let i = at + 1;
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
  const args = words.slice(i + 2);
  // gh also takes --repo after the subcommand, as in `gh pr create --repo <owner>/<name>`.
  return { at, group: words[i], sub: words[i + 1], args, repo: repo ?? flagValue(args, "-R", "--repo") };
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

/**
 * Judge a workspace verdict. It must cover exactly the members the workspace
 * names now. Without a target, every member's working-tree patch, or committed
 * patch with `committed`, must match. With a target, the member a pull request
 * comes from, that member's committed patch must match, and every other
 * member's committed or working-tree patch, so a verdict for a change across
 * repositories stops covering it once any part of it changes.
 */
function evaluateWorkspace(ctx, { committed, target = null }) {
  const v = latestVerdict(ctx.info);
  if (!v) return { ok: false, reason: `No verdict recorded for the workspace on branch ${ctx.info.branch}. Run a fresh verifier first.` };
  if (!PASSING.has(v.verdict)) return { ok: false, reason: `Latest verdict is ${v.verdict}. Fix the findings and re-verify.` };
  if (Number(v.blocking) !== 0) return { ok: false, reason: `Latest verdict has ${v.blocking} open P0-P2 finding(s).` };
  if (!Array.isArray(v.repos)) {
    return { ok: false, reason: "The latest verdict covers the workspace's own repository, not its members. Re-verify after `gate.mjs workspace set`." };
  }
  const covered = v.repos.map((r) => r.path);
  const missing = ctx.members.filter((rel) => !covered.includes(rel));
  const extra = covered.filter((rel) => !ctx.members.includes(rel));
  if (missing.length || extra.length) {
    return {
      ok: false,
      reason: `The workspace now names ${ctx.members.join(", ")}, but the latest verdict covers ${covered.join(", ")}. Re-verify the change as it is now.`,
    };
  }
  if (target !== null && !covered.includes(target)) {
    return { ok: false, reason: `${target} is not part of the latest verdict, which covers ${covered.join(", ")}. Re-verify with it included.` };
  }
  for (const r of v.repos) {
    const info = memberRepo(ctx.info, r.path);
    if (info.branch !== r.branch) return { ok: false, reason: `${r.path} is on ${info.branch}, but the verdict covers ${r.branch}.` };
    // The committed patch first: after the documented commit, it is the one that matches, and it is cheaper.
    const modes = target === null ? [committed] : r.path === target ? [true] : [true, false];
    if (!modes.some((c) => fingerprint(info, { committed: c }).fingerprint === r.fingerprint)) {
      const which = target === null ? (committed ? "committed" : "working-tree") : r.path === target ? "committed" : "current";
      return {
        ok: false,
        reason: `The verified patch of ${r.path} (${r.fingerprint.slice(0, 12)}) differs from its ${which} patch: the code changed after ` +
          "verification, or not everything verified is committed. Re-verify.",
      };
    }
  }
  return { ok: true, reason: `Verified ${v.verdict} at ${v.recorded_at} covers ${covered.join(", ")}, and every patch still matches.` };
}

/** The gate's judgement for a repository: its workspace verdict when it is a member, else its own. */
function judge(info, { committed }) {
  const ctx = gateContext(info.root);
  return ctx.members ? evaluateWorkspace(ctx, { committed, target: ctx.rel }) : evaluate(ctx.info, { committed });
}

const UNCLEAR_DIRECTORY = "Verification gate: this command line changes directory or repository in a way the gate can't follow, so it "
  + "can't tell which repository the command acts on. The one form it follows is a single leading `cd <path> && <command>`, "
  + "optionally piped. Leave out other `cd`, `pushd`, `popd`, `eval`, `source`, `env -C`, `GIT_DIR`, `GIT_WORK_TREE`, "
  + "`--git-dir`, `--work-tree` and `GH_REPO`, or run the command from the repository's own directory.";

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

/** The run directories' roots that apply to a directory: its repository's, and its workspace's when it is a member. */
function stateRoots(cwd) {
  const roots = [];
  const info = tryRepoInfo(cwd);
  if (info) roots.push(runsRoot(info));
  try {
    const ctx = gateContext(cwd);
    if (ctx.members) roots.push(runsRoot(ctx.info));
  } catch {
    // Not a repository, or a workspace member that no longer exists.
  }
  return [...new Set(roots)];
}

/** Whether a path, once real, falls in the gate's own state under any of the roots: tokens, locks and verdict records. */
function isGateState(roots, file) {
  const abs = realish(file);
  return roots.some((runs) => {
    const root = realish(runs);
    if (!(abs === root || abs.startsWith(root + path.sep))) return false;
    const [top] = path.relative(root, abs).split(path.sep);
    return top.startsWith("_") || ["latest.json", "verdicts.jsonl"].includes(path.basename(abs));
  });
}

const hooks = {
  // Settings PreToolUse on every Bash call: protect the verdict state, never
  // push the default branch, and gate ready PRs wherever they hide in a command.
  "bash-guard"(input, cwd) {
    const raw = String(input?.tool_input?.command ?? "");
    const stateWords = /(?:^|[\\/])(_tokens|_locks|latest\.json|verdicts\.jsonl)\b/;
    if (stateWords.test(raw) && (raw.includes("agent-runs") || stateRoots(cwd).some((root) => raw.includes(root)))) {
      deny("The verdict state (tokens, locks, latest.json, verdicts.jsonl) is written only by gate.mjs. Use `node .agents/scripts/gate.mjs show` to read it.");
    }
    // Judge every command in the repository it runs in. The gate follows one
    // directory change, a leading `cd <path> &&`, plus `git -C` and
    // `gh --repo`; a push or pull request command next to any other change of
    // directory or repository is refused, because the gate can't tell what it acts on.
    const { lists, commands, uncertain } = readCommandLine(raw);
    // The reader skips no text, so a command it misses can only hide inside an unterminated quote or substitution.
    if (uncertain && /(^|[^\w.-])(git|gh)([^\w.-]|$)/.test(raw)) {
      deny("Verification gate: this command line has an unterminated quote or substitution, so the gate can't read which "
        + "git or gh commands it runs. Fix the quoting, or split it into simpler commands.");
    }
    const pushes = commands.map(parseGit).filter((g) => g && g.sub === "push");
    const plan = pushes.length || commands.some((w) => parseGh(w)?.group === "pr") ? directoryPlan(raw, cwd, lists) : { dir: cwd };
    for (const g of pushes) {
      if (g.at > 0) {
        deny("Verification gate: run `git push` as a command of its own, not as an argument of another command such as "
          + "`find -execdir` or `xargs`, so the gate can tell which repository it pushes.");
      }
      if (!plan) deny(UNCLEAR_DIRECTORY);
      let dir = plan.dir;
      for (const opt of g.cwdOpts) dir = dir === null || opt === undefined || /[$`]/.test(opt) ? null : resolveCdPath(dir, opt);
      const target = dir && fs.existsSync(dir) ? tryRepoInfo(dir) : null;
      const main = target ? defaultBranch(target.root) : "main";
      const positional = g.args.filter((arg) => !arg.startsWith("-"));
      const refspecs = positional.slice(1);
      const onMain = !target || target.branch === main;
      const protectedName = (ref) => ["main", "master", main].includes(ref.replace(/^\+/, "").replace(/^refs\/heads\//, ""));
      const pushesMain =
        hasFlag(g.args, "--all", "--mirror") ||
        (refspecs.length === 0 && onMain) ||
        refspecs.some((spec) => {
          const dst = spec.includes(":") ? spec.split(":").pop() : spec;
          return protectedName(dst) || (dst.replace(/^\+/, "") === "HEAD" && onMain);
        });
      if (pushesMain && !target) {
        deny("Never push without a clear repository: this `git push` may run on a default branch the gate can't see. "
          + "Run it from the repository's directory.");
      }
      if (pushesMain) deny(`Never push to the default branch (${main}). Push the issue branch and open a pull request.`);
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
    if (!plan) deny(UNCLEAR_DIRECTORY);
    for (const { gh, kind } of gated) {
      if (gh.at > 0) {
        deny(`Verification gate: run \`gh pr ${gh.sub}\` as a command of its own, not as an argument of another command, so the gate can check it.`);
      }
      let target = fs.existsSync(plan.dir) ? tryRepoInfo(plan.dir) : null;
      if (!target) deny("Verification gate: not in a git repository, so the patch can't be checked.");
      // A pull request named by its URL may live in another repository than the one the gate judges.
      for (const arg of gh.args) {
        const url = /github\.com[/:]([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(arg);
        if (url && !sameRepository(tryGit(["remote", "get-url", "origin"], { cwd: target.root }), url[1])) {
          deny(`Verification gate: ${arg} belongs to another repository than this directory's. Run it from that repository's own directory.`);
        }
      }
      const head = flagValue(gh.args, "--head", "-H");
      if (gh.repo && !sameRepository(tryGit(["remote", "get-url", "origin"], { cwd: target.root }), gh.repo)) {
        // gh takes the pull request's head from this directory's branch, so for another repository the gate needs
        // the branch named, to tie the branch it checks to the one the pull request proposes.
        if (kind !== "create") {
          deny(`Verification gate: run \`gh pr ${gh.sub}\` for ${gh.repo} from that repository's own directory, so the gate can `
            + "check the patch it covers.");
        }
        if (!head) deny(`Verification gate: --repo ${gh.repo} names another repository than this directory's. Pass --head <branch> too.`);
        target = repositoryForSlug(target, gh.repo);
        if (!target) deny(`Verification gate: --repo ${gh.repo} is not this checkout's origin, so the patch can't be checked.`);
      }
      if (head && head.split(":").pop() !== target.branch) {
        deny(`Verification gate: run this from the branch being proposed (--head ${head}, but HEAD is ${target.branch}).`);
      }
      try {
        const r = judge(target, { committed: true });
        if (!r.ok) {
          deny(
            `Verification gate: ${r.reason} A ready-for-review PR needs a PASS or PASS+NOTES verdict from a fresh verifier for the ` +
              `exact committed patch (check: node .agents/scripts/gate.mjs check --committed). Open it with --draft if you only need CI.`,
          );
        }
        const p = pushedMatchesHead(target);
        if (!p.ok) deny(`Verification gate: ${p.reason}`);
      } catch (e) {
        deny(`Verification gate could not evaluate the patch: ${e.message}`);
      }
    }
    process.exit(0);
  },

  // Settings SubagentStart, matcher ^verifier$: lock, and snapshot the patch.
  "verifier-start"(input, cwd) {
    let ctx = null;
    try {
      ctx = gateContext(cwd);
      const fp = contextFingerprint(ctx);
      fs.writeFileSync(
        lockFile(ctx.info, input.agent_id),
        JSON.stringify({
          agent_id: input.agent_id ?? null, branch: ctx.info.branch, fingerprint: fp.fingerprint,
          repos: fp.repos ? fp.repos.map(({ path: rel, branch }) => ({ path: rel, branch })) : null, started: new Date().toISOString(),
        }),
      );
    } catch (e) {
      // In a repository, record why the patch couldn't be taken, such as a workspace member that is gone, so `record`
      // reports the cause instead of a missing session. Outside one there is nothing to lock.
      // The lock goes where `record` and verifier-stop look: the workspace's state when cwd is in a member.
      const info = ctx?.info ?? tryRepoInfo(cwd);
      if (info) {
        fs.writeFileSync(lockFile(info, input.agent_id),
          JSON.stringify({ agent_id: input.agent_id ?? null, error: e.message, started: new Date().toISOString() }));
        process.stdout.write(`Verification gate: the patch could not be taken at the start of verification: ${e.message}\n`);
      }
    }
    process.exit(0);
  },

  // Settings SubagentStop, matcher ^verifier$: no finishing without a verdict.
  "verifier-stop"(input, cwd) {
    let info;
    try {
      info = gateContext(cwd).info;
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
    if (lock?.error) release(); // no verdict can be recorded; the verifier reports the cause as BLOCKED
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
      const { info } = gateContext(cwd);
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
      // The run directories: this repository's, and its workspace's when it is a member.
      const roots = stateRoots(cwd);
      if (isGateState(roots, abs)) deny("The verdict state is written only by gate.mjs.");
      const inRepo = [...roots, path.join(info.root, ".claude", "agent-memory-local"), path.join(info.root, ".claude", "agent-memory")];
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
      if (isGateState(stateRoots(cwd), path.resolve(cwd, String(target)))) deny("The verdict state is written only by gate.mjs.");
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
    const f = parseFlags(argv);
    const committed = Boolean(f.committed);
    if (typeof f.repo === "string") {
      const info = memberRepo(gateContext().info, toPosix(f.repo));
      const { base: b, fingerprint: fp } = fingerprint(info, { committed });
      return console.log(JSON.stringify({ path: toPosix(f.repo), branch: info.branch, base: b, fingerprint: fp }));
    }
    const ctx = gateContext();
    const { base: b, fingerprint: fp, repos } = contextFingerprint(ctx, { committed });
    console.log(JSON.stringify(repos ? { branch: ctx.info.branch, fingerprint: fp, repos } : { branch: ctx.info.branch, base: b, fingerprint: fp }));
  },

  // The patch of one repository: the one you are in, or a workspace member with --repo.
  diff(argv) {
    const f = parseFlags(argv);
    const info = typeof f.repo === "string" ? memberRepo(gateContext().info, toPosix(f.repo)) : repoInfo();
    process.stdout.write(patchText(info, { committed: Boolean(f.committed), binary: false, excludes: f.exclude ?? [] }).text);
  },

  paths() {
    const ctx = gateContext();
    const { info } = ctx;
    const base = (repo) => {
      try {
        return resolveBase(repo);
      } catch {
        return null;
      }
    };
    const out = { root: info.root, branch: info.branch, base: ctx.members ? base(info) : resolveBase(info), runDir: runDir(info) };
    if (ctx.members) {
      out.members = ctx.members.map((rel) => {
        const m = memberRepo(info, rel);
        return { path: rel, root: m.root, branch: m.branch, base: base(m) };
      });
    }
    console.log(JSON.stringify(out, null, 2));
  },

  "set-base"(argv) {
    const f = parseFlags(argv);
    const info = typeof f.repo === "string" ? memberRepo(workspaceRoot(), toPosix(f.repo)) : repoInfo();
    if (info.detached) throw new Error("HEAD is detached; switch to the issue branch first.");
    const sha = git(["rev-parse", "--verify", `${f._[0]}^{commit}`], { cwd: info.root });
    git(["config", `branch.${info.branch}.agentbase`, sha], { cwd: info.root });
    console.log(JSON.stringify({ ...(typeof f.repo === "string" ? { path: toPosix(f.repo) } : {}), branch: info.branch, base: sha }));
  },

  // Run from the workspace root: name the repositories the issue changes.
  workspace(argv) {
    const [action, ...paths] = argv;
    const info = workspaceRoot();
    const file = path.join(runDir(info), WORKSPACE_FILE);
    if (action === "set") {
      if (!paths.length) throw new Error("Name each repository the issue changes, as a path from the workspace root.");
      const members = [...new Set(paths.map((p) => toPosix(path.normalize(p)).replace(/\/+$/, "") || "."))];
      for (const rel of members) {
        if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`${rel} is outside the workspace root.`);
        memberRepo(info, rel);
      }
      fs.writeFileSync(file, JSON.stringify({ members, set_at: new Date().toISOString() }, null, 2) + "\n");
    } else if (action === "clear") {
      fs.rmSync(file, { force: true });
    } else if (action !== "show") {
      throw new Error("Usage: gate.mjs workspace <set <path>...|show|clear>, run from the workspace root.");
    }
    const members = workspaceMembers(info) ?? [];
    console.log(JSON.stringify({
      root: info.root, branch: info.branch,
      members: members.map((rel) => ({ path: rel, root: memberRepo(info, rel).root, branch: memberRepo(info, rel).branch })),
    }, null, 2));
  },

  record(argv) {
    const f = parseFlags(argv);
    const ctx = gateContext();
    const { info } = ctx;
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
    if (lock?.error) {
      console.error(`Refused: the gate could not take the patch when verification started: ${lock.error} Report BLOCKED with this cause.`);
      process.exit(1);
    }
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
    const fp = contextFingerprint(ctx);
    if (lock.branch !== info.branch) throw new Error(`Verification started on ${lock.branch}, but HEAD is now ${info.branch}.`);
    for (const started of lock.repos ?? []) {
      const current = fp.repos?.find((r) => r.path === started.path);
      if (current && current.branch !== started.branch) {
        throw new Error(`Verification started with ${started.path} on ${started.branch}, but it is now on ${current.branch}.`);
      }
    }
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
    if (fp.repos) {
      entry.repos = fp.repos.map((r) => ({ ...r, head: tryGit(["rev-parse", "HEAD"], { cwd: memberRepo(info, r.path).root }) }));
    }
    const dir = runDir(info);
    fs.appendFileSync(path.join(dir, "verdicts.jsonl"), JSON.stringify(entry) + "\n");
    fs.writeFileSync(path.join(dir, "latest.json"), JSON.stringify(entry, null, 2) + "\n");
    console.log(JSON.stringify(entry, null, 2));
  },

  show() {
    const ctx = gateContext();
    const { info } = ctx;
    const v = latestVerdict(info);
    if (!v) return console.log(JSON.stringify({ branch: info.branch, verdict: null }));
    const current = contextFingerprint(ctx).fingerprint;
    console.log(JSON.stringify({ ...v, matches_worktree: v.fingerprint === current, current_fingerprint: current }, null, 2));
  },

  check(argv) {
    const committed = Boolean(parseFlags(argv).committed);
    const ctx = gateContext();
    const r = ctx.members ? evaluateWorkspace(ctx, { committed }) : evaluate(ctx.info, { committed });
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
  console.error("Usage: gate.mjs <fingerprint|diff|paths|set-base|workspace|record|show|check|hook> [...]");
  process.exit(1);
}
try {
  commands[cmd](rest);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
