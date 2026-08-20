import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, buildHarnessManifest } from "../dist/manifest.js";

function makeProjectRoot() {
	return mkdtempSync(join(tmpdir(), "trail-manifest-test-"));
}

function writeSkill(rootDir, skillName, frontmatter) {
	const dir = join(rootDir, ".claude", "skills", skillName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

describe("discoverSkills", () => {
	test("returns an empty array when .claude/skills does not exist", () => {
		const rootDir = makeProjectRoot();
		try {
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("parses name and description from a skill's frontmatter", () => {
		const rootDir = makeProjectRoot();
		try {
			writeSkill(
				rootDir,
				"run-platform-locally",
				"---\nname: run-platform-locally\ndescription: Use when asked to run the platform locally.\n---\n\n# Body\n",
			);
			assert.deepEqual(discoverSkills(rootDir), [
				{ name: "run-platform-locally", description: "Use when asked to run the platform locally." },
			]);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("discovers multiple skills, sorted by directory read order", () => {
		const rootDir = makeProjectRoot();
		try {
			writeSkill(rootDir, "skill-a", "---\nname: skill-a\ndescription: First skill.\n---\n");
			writeSkill(rootDir, "skill-b", "---\nname: skill-b\ndescription: Second skill.\n---\n");
			const skills = discoverSkills(rootDir);
			assert.equal(skills.length, 2);
			assert.deepEqual(
				skills.map((s) => s.name).sort(),
				["skill-a", "skill-b"],
			);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips a skill directory with no SKILL.md", () => {
		const rootDir = makeProjectRoot();
		try {
			mkdirSync(join(rootDir, ".claude", "skills", "empty-dir"), { recursive: true });
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips a SKILL.md with no frontmatter delimiters", () => {
		const rootDir = makeProjectRoot();
		try {
			writeSkill(rootDir, "broken", "# Just a heading, no frontmatter\n");
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips frontmatter missing name or description", () => {
		const rootDir = makeProjectRoot();
		try {
			writeSkill(rootDir, "no-description", "---\nname: no-description\n---\n");
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

describe("buildHarnessManifest", () => {
	test("wraps discovered skills with a schema version", () => {
		const rootDir = makeProjectRoot();
		try {
			writeSkill(rootDir, "skill-a", "---\nname: skill-a\ndescription: First skill.\n---\n");
			assert.deepEqual(buildHarnessManifest(rootDir), {
				schemaVersion: 1,
				skills: [{ name: "skill-a", description: "First skill." }],
			});
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
