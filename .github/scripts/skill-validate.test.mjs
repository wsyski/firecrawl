import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO = path.resolve(import.meta.dirname, "..", "..");

// Every SKILL.md this repository ships, wherever it lives. Found rather than listed, because
// a skill added anywhere else would then be silently unvalidated.
const SKILL_GLOBS = ["skills/*/SKILL.md", ".claude/skills/*/SKILL.md"];

// `uvx agnix` rather than an installed agnix: the wheel bundles a prebuilt binary, so nothing
// is compiled and nothing has to be on PATH. A host with no network (and no uvx cache) SKIPS —
// an unreachable linter is not a red suite. test-ci-scripts.yml turns a skip back into a
// failure, because a validator that silently skips is the one outcome this file exists to
// prevent.
//
// EXACT `==`, not a range: uvx resolves a bare name or `name==version`, and a range is read as
// a PATH and refused, which made the case SKIP rather than run. The version is the one the
// rules were read from (AS-016 as documented at 0.57.0); a newer major may add rules, and the
// exact pin makes that a visible diff here rather than a surprise in CI.
const AGNIX = "agnix==0.57.0";

// One directory segment may be `*`; enough for SKILL_GLOBS, and no experimental fs.globSync.
function expand(pattern) {
  const segs = pattern.split("/");
  let dirs = [REPO];
  for (const seg of segs.slice(0, -1)) {
    dirs = dirs.flatMap((d) => {
      if (seg !== "*") {
        const next = path.join(d, seg);
        return fs.existsSync(next) ? [next] : [];
      }
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return [];
      }
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => path.join(d, e.name));
    });
  }
  const last = segs.at(-1);
  return dirs.map((d) => path.join(d, last)).filter((p) => fs.existsSync(p));
}

function skills() {
  return SKILL_GLOBS.flatMap(expand);
}

const diag = (d) => `${d.rule} ${d.file}:${d.line}  ${d.message}`;
const errorsIn = (report) =>
  (report.diagnostics ?? []).filter((d) => d.level === "error");

// agnix's JSON report, or null when it cannot be run here. Exit 1 is "found something to
// report" — a normal run, not a broken invocation; only an unparseable body means the tool
// never ran.
function agnix(args, cwd = REPO, timeout = 420_000) {
  const r = spawnSync("uvx", [AGNIX, ...args, "--format", "json"], {
    cwd,
    encoding: "utf8",
    timeout,
  });
  if (r.error) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

test("every skill in the project validates", (t) => {
  const found = skills();
  assert.ok(
    found.length > 0,
    `no SKILL.md found — the globs are wrong: ${SKILL_GLOBS.join(", ")}`,
  );

  const report = agnix(["."]);
  if (report === null) {
    return t.skip(
      "agnix is not runnable here (no uvx, no network, or no cache)",
    );
  }

  // 1. Nothing the linter reports as an ERROR.
  const errors = errorsIn(report);
  assert.equal(errors.length, 0, errors.map(diag).join("\n"));

  // 2. Every skill was actually LOOKED AT. agnix walks the tree, so a skill it never read
  //    would leave no finding and this would pass over it — a case that cannot fail is worse
  //    than no case. The JSON carries `files_checked`, a COUNT and no file list, so every
  //    skill we found must be inside the number agnix examined.
  const count = report.files_checked;
  assert.ok(
    count,
    `agnix reported no file count at all: ${Object.keys(report).join(", ")}`,
  );
  assert.ok(
    count >= found.length,
    `agnix examined ${count} file(s) but this project holds ${found.length} SKILL.md ` +
      `(${found.map((s) => path.relative(REPO, s)).join(", ")}) — it is reading a ` +
      "different tree, so every assertion above is about files it never opened",
  );

  // 3. A deliberate break IS caught, so (1) is known to be able to fail. A validator whose
  //    pass is never observed as a fail proves nothing.
  //
  //    This also pins the .agnix.toml to a RUNTIME rather than a suppression: the probe runs
  //    with the committed config, and an unquoted-colon description is caught under every
  //    target, so a config that disabled AS-016 (or turned skills off) would leave this with
  //    no error and fail here. Together with (1) that covers both wrong fixes — `target` alone
  //    would make the real skill an AS-016 error, a disabled rule would make the probe silent.
  //
  //    OUTSIDE the globbed trees on purpose: the probe is deliberately malformed, so a run
  //    interrupted between writing and cleaning leaves it behind — inside skills/ it would be
  //    a real SKILL.md that this same case reports as an error on the next run.
  //
  //    Passed EXPLICITLY, not via `.`: agnix's whole-repo walk skips dot-directories, so a
  //    probe under .agnix-probe/ is invisible to it (measured) and this assertion would pass
  //    vacuously. The explicit path puts the probe in scope while the config still resolves
  //    from cwd, so the committed .agnix.toml — the thing under test — governs the run
  //    (verified: with AS-016 disabled the identical probe reports no error).
  const probeDir = path.join(REPO, ".agnix-probe");
  const probe = path.join(probeDir, "skills", "zz-agnix-probe", "SKILL.md");
  fs.mkdirSync(path.dirname(probe), { recursive: true });
  try {
    fs.writeFileSync(
      probe,
      "---\nname: zz-agnix-probe\n" +
        "description: deliberately broken: an unquoted colon\n---\nbody\n",
    );
    const broke = agnix([".agnix-probe"]);
    assert.ok(broke !== null, "agnix stopped answering during the probe");
    assert.ok(
      errorsIn(broke).length > 0,
      "agnix reports no error for a SKILL.md whose frontmatter cannot parse — so the check " +
        `above cannot fail and proves nothing. Report: ${JSON.stringify(broke.summary)}`,
    );
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});

// The premise behind `.agnix.toml` naming a runtime. The skill carries nested
// `metadata.hermes`, which the universal Agent Skills spec rejects (a flat string map) and
// claude-code accepts. Both halves are asserted, because either alone is satisfiable by the
// wrong fix: a config that only silenced the rule would pass the second, one that only named a
// runtime would pass the first.
//
// In a TEMPORARY directory, not this repository. `.agnix.toml`'s runtime OVERRIDES `--target`,
// so comparing targets here would compare claude-code with claude-code and pass whatever the
// config says. The probe needs the same skill shape and no config — which is also the honest
// shape of the question, since it is about the SPEC and not this project's answer to it.
test("the metadata rule is answered by runtime, not by suppression", (t) => {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "agnix-target-"));
  const probe = path.join(probeDir, "SKILL.md");
  try {
    fs.writeFileSync(
      probe,
      "---\nname: zz-agnix-probe\n" +
        "description: A probe carrying Hermes' nested metadata.\n" +
        "metadata:\n  hermes:\n    requires_tools:\n      - __manual_command_only__\n" +
        "---\nbody\n",
    );
    const reportFor = (target) => agnix([".", "--target", target], probeDir);
    const generic = reportFor("generic");
    const claude = reportFor("claude-code");
    if (generic === null || claude === null) {
      return t.skip("agnix is not runnable here");
    }

    assert.ok(
      errorsIn(generic).length > 0,
      "the universal-spec target does not object to nested metadata.hermes — the premise " +
        "of the .agnix.toml target has changed and the config should be revisited",
    );
    assert.equal(
      errorsIn(claude).length,
      0,
      "claude-code rejects nested metadata.hermes too, so choosing the target cannot be " +
        `what makes this project's skill valid: ${JSON.stringify(errorsIn(claude))}`,
    );
  } finally {
    fs.rmSync(probeDir, { recursive: true, force: true });
  }
});
