import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import * as checks from "../lib/check-skills.mjs";
import { agentsBlock, ROOT, skillNames } from "../lib/install.mjs";
import { REPAIR } from "../skills/sprint-status/scripts/sprint-data.mjs";

const SKILLS = skillNames();
const PLATFORMS = ["web", "mobile", "desktop", "game", "service", "library-cli"];
const GUIDE_SECTIONS = ["## Test seams", "## Runtime evidence", "## Bug feedback loops",
  "## Compatibility at boundaries", "## Visible-first order"];
// Shipped files may link GitHub only through placeholder owners, the orgs/ and
// users/ segments of board URLs, and the credited author of a borrowed pattern.
const GITHUB_OWNER = /(?<![\w.-])github\.com[:/]([\w.-]+)/g;
const ALLOWED_OWNERS = new Set(["owner", "acme", "orgs", "users", "mattpocock"]);
// An IANA time zone name, by the areas the tz database uses, including its old country links such as US/Eastern.
const TIME_ZONE = /\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc|US|Canada|Brazil|Mexico|Chile)\/[A-Z][A-Za-z_+-]*(?:\/[A-Z][A-Za-z_+-]*)?/g;
// The tracker template's example zone, which the time zone check's error message repeats.
const ALLOWED_ZONES = new Set(["Europe/Berlin"]);

/** Files the package ships, with forward-slash paths relative to the fleet. */
function shippedFiles() {
  return ["bin", "lib", "skills", "references", "agents"].flatMap((base) =>
    checks.listFiles(path.join(ROOT, base))
      .filter((file) => /\.(md|mjs|yaml|yml|json)$/.test(file))
      .map((file) => `${base}/${file}`));
}

// The update rule, as "Updating the installation" in the profile reference states it. Every mention of the
// update repeats the user's run and the approval rule, and states or links the agent's steps.
const USER_RUN = "`npx agent-fleet@latest update --dry-run` and then `npx agent-fleet@latest update` in their own terminal";
const APPROVAL = "without the user's approval";
const AGENT_STEPS = ["`npx agent-fleet@latest update --dry-run --yes`", "approves that exact plan",
  "`npx agent-fleet@latest update --yes`", "same flags", "`--force`", "needs its own approval"];
const UPDATE_LINK = /\(\.\.\/\.\.\/references\/project-profile\.md#updating-the-installation\)|"Updating the installation" in `\.agents\/references\/project-profile\.md`/;

/** The paragraphs and list items of Markdown text, each on one line. */
function paragraphs(text) {
  return text.split(/\n\s*\n|\n(?=\s*(?:\d+\.|-) )/).map((block) => block.replace(/\s+/g, " ").trim());
}

/** What a paragraph that mentions the update lacks of the update rule. */
function updateRuleGaps(paragraph, { code = true } = {}) {
  const plain = (phrase) => (code ? phrase : phrase.replaceAll("`", ""));
  // The bare command, without --dry-run or --yes, comes only as the second half of the user's run.
  const bare = (code ? /`npx agent-fleet@latest update`/g : /npx agent-fleet@latest update(?! --)/g);
  const gaps = [];
  if (paragraph.split(plain(USER_RUN)).length - 1 !== (paragraph.match(bare) ?? []).length) {
    gaps.push("the user's run with its dry run first");
  }
  if (!paragraph.includes(APPROVAL)) gaps.push("the approval rule");
  const steps = AGENT_STEPS.every((step) => paragraph.includes(plain(step)));
  if (!steps && !UPDATE_LINK.test(paragraph)) gaps.push("the agent's steps or a link to them");
  return gaps;
}

function matchingLines(pattern) {
  const found = [];
  for (const file of shippedFiles()) {
    fs.readFileSync(path.join(ROOT, file), "utf8").split("\n").forEach((line, index) => {
      if (pattern(line)) found.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  return found;
}

describe("content", () => {
  test("every skill has valid frontmatter", () => {
    assert.ok(SKILLS.length >= 18);
    for (const name of SKILLS) assert.deepEqual(checks.checkSkill(path.join(ROOT, "skills", name)), [], name);
  });

  test("relative links resolve", () => {
    assert.deepEqual(checks.checkLinks(ROOT, [path.join(ROOT, "skills"), path.join(ROOT, "references")]), []);
  });

  test("no specific GitHub owner ships", () => {
    const named = matchingLines((line) =>
      [...line.matchAll(GITHUB_OWNER)].some(([, owner]) => !ALLOWED_OWNERS.has(owner)));
    assert.deepEqual(named, []);
  });

  test("no time zone ships except the template's example", () => {
    const named = matchingLines((line) => [...line.matchAll(TIME_ZONE)].some(([zone]) => !ALLOWED_ZONES.has(zone)));
    assert.deepEqual(named, []);
    assert.ok(matchingLines((line) => line.includes("`Europe/Berlin`"))
      .some((found) => found.startsWith("skills/setup-project/templates/issue-tracker.md:")));
  });

  test("nothing shipped still depends on Python", () => {
    assert.deepEqual(matchingLines((line) => /\bpython3?\b|\.py\b/.test(line)), []);
    const scripts = shippedFiles().filter((file) => file.endsWith(".py"));
    assert.deepEqual(scripts, []);
  });

  test("every platform has a complete guide", () => {
    const index = fs.readFileSync(path.join(ROOT, "references/platforms/README.md"), "utf8");
    const template = fs.readFileSync(path.join(ROOT, "skills/setup-project/templates/verification.md"), "utf8");
    for (const platform of PLATFORMS) {
      const guide = path.join(ROOT, "references/platforms", `${platform}.md`);
      assert.ok(fs.existsSync(guide), platform);
      const text = fs.readFileSync(guide, "utf8");
      for (const section of GUIDE_SECTIONS) assert.ok(text.includes(section), `${platform}: ${section}`);
      assert.ok(index.includes(`\`${platform}\``), platform);
      assert.ok(template.includes(`\`${platform}\``), platform);
    }
  });

  test("skills named in backticks exist", () => {
    const names = new Set(SKILLS);
    // A backticked word followed by "skill", "workflow", or a skill-routing verb.
    const pattern = /`([a-z]+(?:-[a-z]+)*)`(?= (?:skill|workflow|before|after|as the manual))/g;
    for (const skill of SKILLS) {
      const text = fs.readFileSync(path.join(ROOT, "skills", skill, "SKILL.md"), "utf8");
      for (const [, reference] of text.matchAll(pattern)) assert.ok(names.has(reference), `${skill}: ${reference}`);
    }
  });

  test("every profile file the skills read has a template", () => {
    const templates = new Set(fs.readdirSync(path.join(ROOT, "skills/setup-project/templates")));
    const referenced = new Set();
    for (const file of shippedFiles()) {
      const text = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const [, name] of text.matchAll(/docs\/agents\/([a-z-]+\.md)/g)) referenced.add(name);
    }
    assert.deepEqual([...referenced].filter((name) => !templates.has(name)), []);
  });

  test("the templates carry the profile fields the skills read", () => {
    const templates = path.join(ROOT, "skills", "setup-project", "templates");
    const domain = fs.readFileSync(path.join(templates, "domain.md"), "utf8");
    const boundaries = domain.slice(domain.indexOf("## Boundaries"));
    assert.match(boundaries, /^\| Boundary \|.*\| Local check \|$/m);
    const verification = fs.readFileSync(path.join(templates, "verification.md"), "utf8");
    assert.match(verification, /^\| Deploys \| /m);
    for (const [name, field] of [["cross-boundary-contract", "Local check"], ["cross-boundary-contract", "Deploys"],
      ["verify-work", "Local check"], ["prepare-pr", "Deploys"]]) {
      const text = fs.readFileSync(path.join(ROOT, "skills", name, "SKILL.md"), "utf8");
      assert.ok(text.includes(`\`${field}\``), `${name} reads ${field}`);
    }
  });

  test("every mention of the update states the user's run, the approval rule, and the agent's steps", () => {
    const profile = fs.readFileSync(path.join(ROOT, "references/project-profile.md"), "utf8");
    assert.match(profile, /^## Updating the installation$/m);
    const mentions = [];
    for (const file of shippedFiles().filter((name) => name.endsWith(".md"))) {
      for (const paragraph of paragraphs(fs.readFileSync(path.join(ROOT, file), "utf8"))) {
        if (paragraph.includes("agent-fleet@latest update")) mentions.push({ where: file, paragraph });
      }
    }
    for (const paragraph of paragraphs(agentsBlock(["claude"]))) {
      if (paragraph.includes("agent-fleet@latest update")) mentions.push({ where: "agentsBlock()", paragraph });
    }
    assert.ok(mentions.length >= 12, `found ${mentions.length} mentions`);
    for (const { where, paragraph } of mentions) {
      assert.deepEqual(updateRuleGaps(paragraph), [], `${where}: ${paragraph}`);
    }
    assert.deepEqual(updateRuleGaps(REPAIR, { code: false }), [], REPAIR);
    assert.ok(mentions.some(({ where, paragraph }) => where === "references/project-profile.md"
      && AGENT_STEPS.every((step) => paragraph.includes(step))), "the profile reference states the agent's steps");
  });

  test("the fleet and every borrowed skill carry an MIT licence", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    assert.equal(pkg.license, "MIT");
    assert.ok(pkg.files.includes("LICENSE"));
    const root = fs.readFileSync(path.join(ROOT, "LICENSE"), "utf8");
    assert.ok(root.startsWith("MIT License\n\nCopyright (c) "));
    const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
    const section = readme.slice(readme.indexOf("## License"), readme.indexOf("\n## ", readme.indexOf("## License") + 1));
    const listed = [...section.matchAll(/^\| `([a-z-]+)` \| /gm)].map(([, name]) => name);
    const licensed = SKILLS.filter((name) => fs.existsSync(path.join(ROOT, "skills", name, "LICENSE")));
    assert.deepEqual(listed.sort(), licensed.sort());
    for (const name of licensed) {
      const text = fs.readFileSync(path.join(ROOT, "skills", name, "LICENSE"), "utf8");
      assert.match(text, /^https:\/\/github\.com\/.+\/tree\/[0-9a-f]{40}\//m, `${name} pins its source commit`);
      assert.ok(text.includes("MIT License") && text.includes("Permission is hereby granted"), name);
    }
  });

  test("the package ships what the installer reads", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
    for (const entry of ["bin/", "lib/", "skills/", "references/", "agents/"]) assert.ok(pkg.files.includes(entry), entry);
    assert.equal(pkg.bin["agent-fleet"], "bin/agent-fleet.mjs");
    assert.equal(pkg.repository.url, "git+https://github.com/chustert/agent-fleet.git");
  });
});
