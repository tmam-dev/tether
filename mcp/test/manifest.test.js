import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discoverSkills, discoverUserSkills, discoverSubAgents, discoverMcpServers, buildHarnessManifest } from "../dist/manifest.js";

function makeTempDir(prefix) {
	return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(rootDir, skillName, frontmatter) {
	const dir = join(rootDir, ".claude", "skills", skillName);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "SKILL.md"), frontmatter);
}

function writeAgent(rootDir, agentName, frontmatter) {
	const dir = join(rootDir, ".claude", "agents");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `${agentName}.md`), frontmatter);
}

describe("discoverSkills", () => {
	test("returns an empty array when .claude/skills does not exist", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("parses name and description from a skill's frontmatter, tagged with source project", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeSkill(
				rootDir,
				"run-platform-locally",
				"---\nname: run-platform-locally\ndescription: Use when asked to run the platform locally.\n---\n\n# Body\n",
			);
			assert.deepEqual(discoverSkills(rootDir), [
				{ name: "run-platform-locally", description: "Use when asked to run the platform locally.", source: "project" },
			]);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("discovers multiple skills, sorted by directory read order", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeSkill(rootDir, "skill-a", "---\nname: skill-a\ndescription: First skill.\n---\n");
			writeSkill(rootDir, "skill-b", "---\nname: skill-b\ndescription: Second skill.\n---\n");
			const skills = discoverSkills(rootDir);
			assert.equal(skills.length, 2);
			assert.deepEqual(
				skills.map((s) => s.name).sort(),
				["skill-a", "skill-b"],
			);
			assert.ok(skills.every((s) => s.source === "project"));
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips a skill directory with no SKILL.md", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			mkdirSync(join(rootDir, ".claude", "skills", "empty-dir"), { recursive: true });
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips a SKILL.md with no frontmatter delimiters", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeSkill(rootDir, "broken", "# Just a heading, no frontmatter\n");
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips frontmatter missing name or description", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeSkill(rootDir, "no-description", "---\nname: no-description\n---\n");
			assert.deepEqual(discoverSkills(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("truncates a description longer than 300 characters to exactly 300", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			const longDescription = "x".repeat(400);
			writeSkill(
				rootDir,
				"long-description",
				`---\nname: long-description\ndescription: ${longDescription}\n---\n`,
			);
			const skills = discoverSkills(rootDir);
			assert.equal(skills.length, 1);
			assert.equal(skills[0].description.length, 300);
			assert.equal(skills[0].description, "x".repeat(300));
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("leaves a description of exactly 300 characters or shorter unchanged", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			const exactDescription = "y".repeat(300);
			writeSkill(
				rootDir,
				"exact-description",
				`---\nname: exact-description\ndescription: ${exactDescription}\n---\n`,
			);
			const shortDescription = "Short description.";
			writeSkill(
				rootDir,
				"short-description",
				`---\nname: short-description\ndescription: ${shortDescription}\n---\n`,
			);
			const skills = discoverSkills(rootDir);
			const byName = Object.fromEntries(skills.map((s) => [s.name, s.description]));
			assert.equal(byName["exact-description"], exactDescription);
			assert.equal(byName["short-description"], shortDescription);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("caps discovered skills at 50 when more than 50 valid skill directories exist", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			for (let i = 0; i < 70; i++) {
				const name = `skill-${String(i).padStart(3, "0")}`;
				writeSkill(rootDir, name, `---\nname: ${name}\ndescription: Skill number ${i}.\n---\n`);
			}
			const skills = discoverSkills(rootDir);
			assert.equal(skills.length, 50);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("returns all skills when 50 or fewer valid skill directories exist", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			for (let i = 0; i < 30; i++) {
				const name = `skill-${String(i).padStart(3, "0")}`;
				writeSkill(rootDir, name, `---\nname: ${name}\ndescription: Skill number ${i}.\n---\n`);
			}
			const skills = discoverSkills(rootDir);
			assert.equal(skills.length, 30);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

describe("discoverUserSkills", () => {
	test("returns an empty array when the home directory has no .claude/skills", () => {
		const homeDir = makeTempDir("trail-manifest-home-test-");
		try {
			assert.deepEqual(discoverUserSkills(homeDir), []);
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test("parses a user-level skill, tagged with source user", () => {
		const homeDir = makeTempDir("trail-manifest-home-test-");
		try {
			writeSkill(homeDir, "my-user-skill", "---\nname: my-user-skill\ndescription: A user-level skill.\n---\n");
			assert.deepEqual(discoverUserSkills(homeDir), [
				{ name: "my-user-skill", description: "A user-level skill.", source: "user" },
			]);
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test("skips a flat .md file directly under .claude/skills (not the <name>/SKILL.md convention)", () => {
		const homeDir = makeTempDir("trail-manifest-home-test-");
		try {
			mkdirSync(join(homeDir, ".claude", "skills"), { recursive: true });
			writeFileSync(join(homeDir, ".claude", "skills", "commit.md"), "# Commit Skill\n\nSome instructions.\n");
			assert.deepEqual(discoverUserSkills(homeDir), []);
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});

	test("caps discovered user skills at 50", () => {
		const homeDir = makeTempDir("trail-manifest-home-test-");
		try {
			for (let i = 0; i < 70; i++) {
				const name = `user-skill-${String(i).padStart(3, "0")}`;
				writeSkill(homeDir, name, `---\nname: ${name}\ndescription: User skill number ${i}.\n---\n`);
			}
			assert.equal(discoverUserSkills(homeDir).length, 50);
		} finally {
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});

describe("discoverSubAgents", () => {
	test("returns an empty array when .claude/agents does not exist", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			assert.deepEqual(discoverSubAgents(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("parses name, description, and comma-separated tools from an agent's frontmatter", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeAgent(
				rootDir,
				"code-reviewer",
				"---\nname: code-reviewer\ndescription: Reviews code for bugs.\ntools: Read, Grep, Bash\n---\n\nSystem prompt body.\n",
			);
			assert.deepEqual(discoverSubAgents(rootDir), [
				{ name: "code-reviewer", description: "Reviews code for bugs.", tools: ["Read", "Grep", "Bash"] },
			]);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("defaults tools to an empty array when the frontmatter has no tools field", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeAgent(rootDir, "no-tools-agent", "---\nname: no-tools-agent\ndescription: An agent with no declared tools.\n---\n");
			assert.deepEqual(discoverSubAgents(rootDir), [
				{ name: "no-tools-agent", description: "An agent with no declared tools.", tools: [] },
			]);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips an agent file missing name or description", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			writeAgent(rootDir, "incomplete", "---\nname: incomplete\n---\n");
			assert.deepEqual(discoverSubAgents(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("skips a non-.md file under .claude/agents", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			mkdirSync(join(rootDir, ".claude", "agents"), { recursive: true });
			writeFileSync(join(rootDir, ".claude", "agents", "README.txt"), "not an agent");
			assert.deepEqual(discoverSubAgents(rootDir), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("truncates a description longer than 300 characters to exactly 300", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			const longDescription = "z".repeat(400);
			writeAgent(rootDir, "verbose-agent", `---\nname: verbose-agent\ndescription: ${longDescription}\n---\n`);
			const agents = discoverSubAgents(rootDir);
			assert.equal(agents.length, 1);
			assert.equal(agents[0].description.length, 300);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("caps discovered sub-agents at 50", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		try {
			for (let i = 0; i < 70; i++) {
				const name = `agent-${String(i).padStart(3, "0")}`;
				writeAgent(rootDir, name, `---\nname: ${name}\ndescription: Agent number ${i}.\n---\n`);
			}
			assert.equal(discoverSubAgents(rootDir).length, 50);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

describe("discoverMcpServers", () => {
	test("returns an empty array when neither source exists", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonPath = join(rootDir, "nonexistent-claude.json");
		try {
			assert.deepEqual(discoverMcpServers(rootDir, claudeJsonPath), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("reads server names from a project .mcp.json, never command/args/env", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonPath = join(rootDir, "nonexistent-claude.json");
		try {
			writeFileSync(
				join(rootDir, ".mcp.json"),
				JSON.stringify({
					mcpServers: {
						trail: { command: "npx", args: ["-y", "trailai-mcp"], env: { TRAIL_SECRET_KEY: "sk-super-secret" } },
					},
				}),
			);
			const servers = discoverMcpServers(rootDir, claudeJsonPath);
			assert.deepEqual(servers, [{ name: "trail" }]);
			assert.equal(JSON.stringify(servers).includes("sk-super-secret"), false);
			assert.equal(JSON.stringify(servers).includes("npx"), false);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("reads server names from ~/.claude.json's projects[rootDir].mcpServers, never command/args/env", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonDir = makeTempDir("trail-manifest-claudejson-");
		const claudeJsonPath = join(claudeJsonDir, ".claude.json");
		try {
			writeFileSync(
				claudeJsonPath,
				JSON.stringify({
					projects: {
						[rootDir]: {
							mcpServers: {
								github: { command: "npx", args: ["-y", "github-mcp"], env: { GITHUB_TOKEN: "gh-super-secret" } },
							},
						},
					},
				}),
			);
			const servers = discoverMcpServers(rootDir, claudeJsonPath);
			assert.deepEqual(servers, [{ name: "github" }]);
			assert.equal(JSON.stringify(servers).includes("gh-super-secret"), false);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
			rmSync(claudeJsonDir, { recursive: true, force: true });
		}
	});

	test("merges and deduplicates server names from both sources", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonDir = makeTempDir("trail-manifest-claudejson-");
		const claudeJsonPath = join(claudeJsonDir, ".claude.json");
		try {
			writeFileSync(join(rootDir, ".mcp.json"), JSON.stringify({ mcpServers: { trail: {}, shared: {} } }));
			writeFileSync(
				claudeJsonPath,
				JSON.stringify({ projects: { [rootDir]: { mcpServers: { github: {}, shared: {} } } } }),
			);
			const servers = discoverMcpServers(rootDir, claudeJsonPath);
			assert.deepEqual(
				servers.map((s) => s.name).sort(),
				["github", "shared", "trail"],
			);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
			rmSync(claudeJsonDir, { recursive: true, force: true });
		}
	});

	test("degrades to an empty array for a malformed .mcp.json", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonPath = join(rootDir, "nonexistent-claude.json");
		try {
			writeFileSync(join(rootDir, ".mcp.json"), "not valid json{{{");
			assert.deepEqual(discoverMcpServers(rootDir, claudeJsonPath), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	test("degrades to an empty array when the project has no entry in ~/.claude.json", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonDir = makeTempDir("trail-manifest-claudejson-");
		const claudeJsonPath = join(claudeJsonDir, ".claude.json");
		try {
			writeFileSync(claudeJsonPath, JSON.stringify({ projects: { "/some/other/project": { mcpServers: { foo: {} } } } }));
			assert.deepEqual(discoverMcpServers(rootDir, claudeJsonPath), []);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
			rmSync(claudeJsonDir, { recursive: true, force: true });
		}
	});

	test("caps discovered MCP servers at 50", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const claudeJsonPath = join(rootDir, "nonexistent-claude.json");
		try {
			const servers = {};
			for (let i = 0; i < 70; i++) servers[`server-${String(i).padStart(3, "0")}`] = {};
			writeFileSync(join(rootDir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
			assert.equal(discoverMcpServers(rootDir, claudeJsonPath).length, 50);
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});

describe("buildHarnessManifest", () => {
	test("combines project and user skills into one skills array", () => {
		const rootDir = makeTempDir("trail-manifest-test-");
		const homeDir = makeTempDir("trail-manifest-home-test-");
		try {
			writeSkill(rootDir, "project-skill", "---\nname: project-skill\ndescription: Project skill.\n---\n");
			writeSkill(homeDir, "user-skill", "---\nname: user-skill\ndescription: User skill.\n---\n");
			const manifest = buildHarnessManifest(rootDir, homeDir);
			assert.equal(manifest.schemaVersion, 1);
			const byName = Object.fromEntries(manifest.skills.map((s) => [s.name, s]));
			assert.deepEqual(byName["project-skill"], { name: "project-skill", description: "Project skill.", source: "project" });
			assert.deepEqual(byName["user-skill"], { name: "user-skill", description: "User skill.", source: "user" });
		} finally {
			rmSync(rootDir, { recursive: true, force: true });
			rmSync(homeDir, { recursive: true, force: true });
		}
	});
});
