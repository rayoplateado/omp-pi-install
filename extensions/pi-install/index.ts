/**
 * pi-install — OMP Extension
 *
 * Installs Pi plugins (extensions + skills) from GitHub into OMP,
 * automatically remapping @mariozechner/pi-* imports to @oh-my-pi/pi-*.
 *
 * Commands:
 *   /pi-install <user/repo | github-url>  — install a Pi plugin
 *   /pi-uninstall [name]                  — remove an installed plugin
 *   /pi-list                              — list installed Pi plugins
 *   /pi-update [name]                     — re-install from source
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const OMP_AGENT_DIR = path.join(os.homedir(), ".omp", "agent");
const EXTENSIONS_DIR = path.join(OMP_AGENT_DIR, "extensions");
const SKILLS_DIR = path.join(OMP_AGENT_DIR, "skills");
const REGISTRY_PATH = path.join(OMP_AGENT_DIR, "pi-plugins.json");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface InstalledPlugin {
	name: string;
	source: string;
	extensions: string[];
	skills: string[];
	installedAt: string;
}

interface PluginRegistry {
	plugins: Record<string, InstalledPlugin>;
}

interface PiManifest {
	extensions?: string[];
	skills?: string[];
}

// ---------------------------------------------------------------------------
// Import remapping — the core value of this extension
// ---------------------------------------------------------------------------

const SCOPE_REMAP: [RegExp, string][] = [
	[/@mariozechner\/pi-coding-agent/g, "@oh-my-pi/pi-coding-agent"],
	[/@mariozechner\/pi-agent-core/g, "@oh-my-pi/pi-agent-core"],
	[/@mariozechner\/pi-ai/g, "@oh-my-pi/pi-ai"],
	[/@mariozechner\/pi-tui/g, "@oh-my-pi/pi-tui"],
	[/@mariozechner\/pi-utils/g, "@oh-my-pi/pi-utils"],
];

function remapFileImports(filePath: string): boolean {
	const content = fs.readFileSync(filePath, "utf-8");
	let result = content;
	for (const [pattern, replacement] of SCOPE_REMAP) {
		result = result.replace(pattern, replacement);
	}
	if (result !== content) {
		fs.writeFileSync(filePath, result);
		return true;
	}
	return false;
}

function remapDirImports(dir: string): number {
	let count = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
			count += remapDirImports(full);
		} else if (entry.isFile() && /\.(ts|js|tsx|jsx|mts|mjs)$/.test(entry.name)) {
			if (remapFileImports(full)) count++;
		}
	}
	return count;
}

// ---------------------------------------------------------------------------
// Registry persistence
// ---------------------------------------------------------------------------

function loadRegistry(): PluginRegistry {
	try {
		if (fs.existsSync(REGISTRY_PATH)) {
			return JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
		}
	} catch {
		// Corrupted file — start fresh
	}
	return { plugins: {} };
}

function saveRegistry(reg: PluginRegistry): void {
	fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
	fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// GitHub URL normalization
// ---------------------------------------------------------------------------

function normalizeGitHubUrl(input: string): string | null {
	const s = input.trim().replace(/\.git$/, "").replace(/\/$/, "");

	// user/repo
	if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
		return `https://github.com/${s}`;
	}
	// github.com/user/repo (no scheme)
	if (s.startsWith("github.com/")) {
		return `https://${s}`;
	}
	// Full https URL
	if (/^https?:\/\/github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/.test(s)) {
		return s;
	}
	return null;
}

function repoNameFromUrl(url: string): string {
	return url.split("/").pop()!;
}

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

function copyDir(src: string, dest: string): void {
	fs.mkdirSync(dest, { recursive: true });
	for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
		const from = path.join(src, entry.name);
		const to = path.join(dest, entry.name);
		if (entry.isDirectory()) {
			copyDir(from, to);
		} else {
			fs.copyFileSync(from, to);
		}
	}
}

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Core install logic
// ---------------------------------------------------------------------------

async function installFromDir(
	tmpDir: string,
	repoName: string,
	notify: (msg: string, level: "info" | "error" | "warning") => void,
): Promise<{ name: string; extensions: string[]; skills: string[] } | null> {
	// Read manifest: omp > pi > fallback to convention
	const pkgPath = path.join(tmpDir, "package.json");
	let manifest: PiManifest = {};
	let pkgName = repoName;

	if (fs.existsSync(pkgPath)) {
		try {
			const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
			pkgName = pkg.name ?? repoName;
			manifest = pkg.omp ?? pkg.pi ?? {};
		} catch {
			notify("Warning: malformed package.json, scanning by convention...", "warning");
		}
	}

	// Fallback: look for extensions/ and skills/ dirs by convention
	if (!manifest.extensions?.length && fs.existsSync(path.join(tmpDir, "extensions"))) {
		manifest.extensions = ["./extensions"];
	}
	if (!manifest.skills?.length && fs.existsSync(path.join(tmpDir, "skills"))) {
		manifest.skills = ["./skills"];
	}

	if (!manifest.extensions?.length && !manifest.skills?.length) {
		notify("No extensions or skills found in this package.", "error");
		return null;
	}

	const installedExts: string[] = [];
	const installedSkills: string[] = [];

	// Install extensions
	if (manifest.extensions) {
		fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

		for (const extRef of manifest.extensions) {
			const resolved = path.resolve(tmpDir, extRef);
			if (!fs.existsSync(resolved)) {
				notify(`Extension path not found: ${extRef}`, "warning");
				continue;
			}

			if (fs.statSync(resolved).isDirectory()) {
				// Check if this dir IS an extension (has index.ts) or CONTAINS extensions
				const hasIndex = fs.existsSync(path.join(resolved, "index.ts"))
					|| fs.existsSync(path.join(resolved, "index.js"));

				if (hasIndex) {
					// This dir is itself one extension
					const name = path.basename(resolved);
					const dest = path.join(EXTENSIONS_DIR, name);
					if (fs.existsSync(dest)) rmDir(dest);
					copyDir(resolved, dest);
					remapDirImports(dest);
					installedExts.push(name);
				} else {
					// Dir contains multiple extensions as subdirs/files
					for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
						const src = path.join(resolved, entry.name);
						if (entry.isDirectory()) {
							const dest = path.join(EXTENSIONS_DIR, entry.name);
							if (fs.existsSync(dest)) rmDir(dest);
							copyDir(src, dest);
							remapDirImports(dest);
							installedExts.push(entry.name);
						} else if (/\.(ts|js)$/.test(entry.name)) {
							const dest = path.join(EXTENSIONS_DIR, entry.name);
							fs.copyFileSync(src, dest);
							remapFileImports(dest);
							installedExts.push(entry.name);
						}
					}
				}
			} else if (/\.(ts|js)$/.test(resolved)) {
				// Single file extension
				const name = path.basename(resolved);
				const dest = path.join(EXTENSIONS_DIR, name);
				fs.copyFileSync(resolved, dest);
				remapFileImports(dest);
				installedExts.push(name);
			}
		}
	}

	// Install skills
	if (manifest.skills) {
		fs.mkdirSync(SKILLS_DIR, { recursive: true });

		for (const skillRef of manifest.skills) {
			const resolved = path.resolve(tmpDir, skillRef);
			if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
				notify(`Skill path not found or not a directory: ${skillRef}`, "warning");
				continue;
			}

			// Check if this dir IS a skill (has SKILL.md) or CONTAINS skills
			if (fs.existsSync(path.join(resolved, "SKILL.md"))) {
				// This dir is itself a skill
				const name = path.basename(resolved);
				const dest = path.join(SKILLS_DIR, name);
				if (fs.existsSync(dest)) rmDir(dest);
				copyDir(resolved, dest);
				installedSkills.push(name);
			} else {
				// Dir contains multiple skills as subdirs
				for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
					if (!entry.isDirectory()) continue;
					const src = path.join(resolved, entry.name);
					if (!fs.existsSync(path.join(src, "SKILL.md"))) continue;

					const dest = path.join(SKILLS_DIR, entry.name);
					if (fs.existsSync(dest)) rmDir(dest);
					copyDir(src, dest);
					installedSkills.push(entry.name);
				}
			}
		}
	}

	if (installedExts.length === 0 && installedSkills.length === 0) {
		notify("Found manifest entries but no actual extensions or skills to install.", "error");
		return null;
	}

	return { name: pkgName, extensions: installedExts, skills: installedSkills };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function piInstallExtension(pi: ExtensionAPI) {
	pi.setLabel("Pi Plugin Installer");

	// -------------------------------------------------------------------
	// /pi-install <user/repo | url>
	// -------------------------------------------------------------------
	pi.registerCommand("pi-install", {
		description: "Install a Pi plugin from GitHub → /pi-install user/repo",
		handler: async (args, ctx) => {
			const input = (args ?? "").trim();
			if (!input) {
				ctx.ui.notify(
					[
						"Usage: /pi-install <user/repo | github-url>",
						"",
						"Examples:",
						"  /pi-install davebcn87/pi-autoresearch",
						"  /pi-install https://github.com/user/repo",
					].join("\n"),
					"info",
				);
				return;
			}

			const gitUrl = normalizeGitHubUrl(input);
			if (!gitUrl) {
				ctx.ui.notify(`Invalid GitHub reference: ${input}\nExpected: user/repo or https://github.com/user/repo`, "error");
				return;
			}

			const repoName = repoNameFromUrl(gitUrl);
			ctx.ui.notify(`Cloning ${repoName}...`, "info");

			const tmpDir = path.join(os.tmpdir(), `pi-install-${repoName}-${Date.now()}`);

			try {
				// Clone
				const clone = await pi.exec("git", ["clone", "--depth", "1", "--single-branch", gitUrl, tmpDir], {
					timeout: 60_000,
				});

				if (clone.code !== 0) {
					const err = (clone.stderr || clone.stdout || "unknown error").trim();
					ctx.ui.notify(`Clone failed:\n${err.slice(0, 300)}`, "error");
					return;
				}

				// Install
				const result = await installFromDir(tmpDir, repoName, (msg, level) => ctx.ui.notify(msg, level));
				if (!result) return;

				// Save to registry
				const reg = loadRegistry();
				reg.plugins[result.name] = {
					name: result.name,
					source: gitUrl,
					extensions: result.extensions,
					skills: result.skills,
					installedAt: new Date().toISOString(),
				};
				saveRegistry(reg);

				// Report
				const lines = [`Installed ${result.name}`];
				if (result.extensions.length) lines.push(`  Extensions: ${result.extensions.join(", ")}`);
				if (result.skills.length) lines.push(`  Skills: ${result.skills.join(", ")}`);
				lines.push("", "Run /reload to activate.");
				ctx.ui.notify(lines.join("\n"), "info");
			} finally {
				// Always clean up
				if (fs.existsSync(tmpDir)) rmDir(tmpDir);
			}
		},
	});

	// -------------------------------------------------------------------
	// /pi-uninstall [name]
	// -------------------------------------------------------------------
	pi.registerCommand("pi-uninstall", {
		description: "Uninstall a Pi plugin → /pi-uninstall <name>",
		handler: async (args, ctx) => {
			const reg = loadRegistry();
			const plugins = Object.keys(reg.plugins);

			if (plugins.length === 0) {
				ctx.ui.notify("No Pi plugins installed.", "info");
				return;
			}

			let name = (args ?? "").trim();

			if (!name) {
				ctx.ui.notify(
					`Installed plugins:\n${plugins.map((p) => `  - ${p}`).join("\n")}\n\nUsage: /pi-uninstall <name>`,
					"info",
				);
				return;
			}

			const plugin = reg.plugins[name];
			if (!plugin) {
				// Try fuzzy match
				const match = plugins.find((p) => p.toLowerCase().includes(name.toLowerCase()));
				if (!match) {
					ctx.ui.notify(`Plugin "${name}" not found.\nInstalled: ${plugins.join(", ")}`, "error");
					return;
				}
				name = match;
			}

			const target = reg.plugins[name]!;

			// Remove extensions
			for (const ext of target.extensions) {
				const p = path.join(EXTENSIONS_DIR, ext);
				if (fs.existsSync(p)) {
					fs.statSync(p).isDirectory() ? rmDir(p) : fs.unlinkSync(p);
				}
			}

			// Remove skills
			for (const skill of target.skills) {
				const p = path.join(SKILLS_DIR, skill);
				if (fs.existsSync(p)) rmDir(p);
			}

			delete reg.plugins[name];
			saveRegistry(reg);

			ctx.ui.notify(`Uninstalled ${name}. Run /reload to apply.`, "info");
		},
	});

	// -------------------------------------------------------------------
	// /pi-list
	// -------------------------------------------------------------------
	pi.registerCommand("pi-list", {
		description: "List installed Pi plugins",
		handler: async (_args, ctx) => {
			const reg = loadRegistry();
			const plugins = Object.values(reg.plugins);

			if (plugins.length === 0) {
				ctx.ui.notify("No Pi plugins installed.\nUse /pi-install <user/repo> to install one.", "info");
				return;
			}

			const lines = plugins.map((p) => {
				const parts = [p.name];
				parts.push(`  Source: ${p.source}`);
				if (p.extensions.length) parts.push(`  Extensions: ${p.extensions.join(", ")}`);
				if (p.skills.length) parts.push(`  Skills: ${p.skills.join(", ")}`);
				parts.push(`  Installed: ${p.installedAt}`);
				return parts.join("\n");
			});

			ctx.ui.notify(lines.join("\n\n"), "info");
		},
	});

	// -------------------------------------------------------------------
	// /pi-update [name]
	// -------------------------------------------------------------------
	pi.registerCommand("pi-update", {
		description: "Update a Pi plugin from its source → /pi-update [name]",
		handler: async (args, ctx) => {
			const reg = loadRegistry();
			const plugins = Object.keys(reg.plugins);

			if (plugins.length === 0) {
				ctx.ui.notify("No Pi plugins installed.", "info");
				return;
			}

			let name = (args ?? "").trim();

			// If no name, update all
			const targets = name
				? [reg.plugins[name] ?? reg.plugins[plugins.find((p) => p.toLowerCase().includes(name.toLowerCase())) ?? ""]].filter(Boolean)
				: Object.values(reg.plugins);

			if (targets.length === 0) {
				ctx.ui.notify(`Plugin "${name}" not found.\nInstalled: ${plugins.join(", ")}`, "error");
				return;
			}

			for (const plugin of targets) {
				ctx.ui.notify(`Updating ${plugin.name} from ${plugin.source}...`, "info");

				const repoName = repoNameFromUrl(plugin.source);
				const tmpDir = path.join(os.tmpdir(), `pi-install-${repoName}-${Date.now()}`);

				try {
					const clone = await pi.exec("git", ["clone", "--depth", "1", "--single-branch", plugin.source, tmpDir], {
						timeout: 60_000,
					});

					if (clone.code !== 0) {
						ctx.ui.notify(`Failed to update ${plugin.name}: clone failed`, "error");
						continue;
					}

					// Remove old files first
					for (const ext of plugin.extensions) {
						const p = path.join(EXTENSIONS_DIR, ext);
						if (fs.existsSync(p)) {
							fs.statSync(p).isDirectory() ? rmDir(p) : fs.unlinkSync(p);
						}
					}
					for (const skill of plugin.skills) {
						const p = path.join(SKILLS_DIR, skill);
						if (fs.existsSync(p)) rmDir(p);
					}

					// Re-install
					const result = await installFromDir(tmpDir, repoName, (msg, level) => ctx.ui.notify(msg, level));
					if (result) {
						reg.plugins[result.name] = {
							name: result.name,
							source: plugin.source,
							extensions: result.extensions,
							skills: result.skills,
							installedAt: new Date().toISOString(),
						};
						ctx.ui.notify(`Updated ${result.name}`, "info");
					}
				} finally {
					if (fs.existsSync(tmpDir)) rmDir(tmpDir);
				}
			}

			saveRegistry(reg);
			ctx.ui.notify("Updates complete. Run /reload to apply.", "info");
		},
	});
}
