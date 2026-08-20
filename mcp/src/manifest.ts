/**
 * Harness manifest discovery - reads a coding-agent harness's registered
 * skills off disk, so a Trail run can be stamped with what the harness
 * could reach for at the moment the run started (not just what it did).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface SkillEntry {
	name: string;
	description: string;
	source: "project" | "user";
}

export interface HarnessManifest {
	schemaVersion: 1;
	skills: SkillEntry[];
}

const FRONTMATTER_DELIMITER = "---";
const MAX_DESCRIPTION_LENGTH = 300;
// 50, not 200: this manifest now has four categories (project skills, user
// skills, sub-agents, MCP servers) sharing one ~100KB request-body budget.
// Worst case: 3 categories x 50 entries x ~370 bytes (name + 300-char
// description + JSON overhead) + 50 MCP-server entries x ~50 bytes
// (name only) ~= 58KB -- safely under budget with headroom for the run's
// other span attributes.
const MAX_SKILLS = 50;

function parseFrontmatter(content: string): Record<string, string> | null {
	const lines = content.split("\n");
	if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) return null;
	const endIndex = lines.slice(1).findIndex((line) => line.trim() === FRONTMATTER_DELIMITER);
	if (endIndex === -1) return null;

	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, endIndex + 1)) {
		const colonIndex = line.indexOf(":");
		if (colonIndex === -1) continue;
		const key = line.slice(0, colonIndex).trim();
		const value = line.slice(colonIndex + 1).trim();
		if (key) fields[key] = value;
	}
	return fields;
}

function scanSkillsDir(skillsDir: string, source: "project" | "user"): SkillEntry[] {
	let entries: string[];
	try {
		entries = readdirSync(skillsDir);
	} catch {
		return [];
	}

	const skills: SkillEntry[] = [];
	for (const entry of entries) {
		if (skills.length >= MAX_SKILLS) break;

		const skillPath = join(skillsDir, entry, "SKILL.md");
		let content: string;
		try {
			if (!statSync(skillPath).isFile()) continue;
			content = readFileSync(skillPath, "utf-8");
		} catch {
			continue;
		}

		const frontmatter = parseFrontmatter(content);
		if (!frontmatter?.name || !frontmatter?.description) continue;
		skills.push({
			name: frontmatter.name,
			description: frontmatter.description.slice(0, MAX_DESCRIPTION_LENGTH),
			source,
		});
	}
	return skills;
}

/**
 * Reads rootDir/.claude/skills/[name]/SKILL.md frontmatter. A missing
 * .claude/skills directory, a skill directory with no SKILL.md, or a
 * SKILL.md missing frontmatter/name/description is skipped, never thrown -
 * manifest discovery must never break trail_start_run.
 *
 * Output is bounded so the resulting manifest can never grow large enough to
 * blow past the server's request body limit: each description is truncated
 * to MAX_DESCRIPTION_LENGTH characters, and at most MAX_SKILLS entries are
 * returned (the first ones encountered, no prioritization).
 */
export function discoverSkills(rootDir: string): SkillEntry[] {
	return scanSkillsDir(join(rootDir, ".claude", "skills"), "project");
}

/**
 * Same discovery and bounding as discoverSkills, but reads the developer's
 * user-level ~/.claude/skills/ instead of a project directory. Takes an
 * optional homeDir override (defaults to the real home directory) so this
 * is testable without touching the real developer's home directory.
 */
export function discoverUserSkills(homeDir: string = homedir()): SkillEntry[] {
	return scanSkillsDir(join(homeDir, ".claude", "skills"), "user");
}

export function buildHarnessManifest(rootDir: string, homeDir: string = homedir()): HarnessManifest {
	return {
		schemaVersion: 1,
		skills: [...discoverSkills(rootDir), ...discoverUserSkills(homeDir)],
	};
}
