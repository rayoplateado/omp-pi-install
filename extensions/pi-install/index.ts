/**
 * pi-install — OMP Extension
 *
 * Installs Pi plugins (extensions + skills) from GitHub into OMP.
 * Rewrites runtime imports to use OMP's injected objects (pi.pi, pi.typebox)
 * since OMP is a compiled binary and @oh-my-pi/* packages aren't on disk.
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
// Import rewriting — the core value of this extension
//
// OMP is a compiled binary. The @oh-my-pi/* and @sinclair/* packages are NOT
// available on disk for resolution. Extensions must use the injected runtime
// objects: pi.pi (coding-agent + ai + tui exports), pi.typebox (@sinclair/typebox).
//
// Pi extensions import from these packages:
//   @mariozechner/pi-coding-agent  →  available via pi.pi at runtime
//   @mariozechner/pi-agent-core    →  available via pi.pi at runtime
//   @mariozechner/pi-ai            →  mostly pi.pi, but Type → pi.typebox
//   @mariozechner/pi-tui           →  partially via pi.pi, rest polyfilled
//   @mariozechner/pi-utils         →  available via pi.pi at runtime
//   @sinclair/typebox              →  available via pi.typebox at runtime
//
// Strategy: rewrite the extension to extract these from the pi object at
// factory entry, then use local references throughout.
// ---------------------------------------------------------------------------

/**
 * Polyfills for pi-tui functions not exposed on pi.pi.
 * Injected into extension files that need them.
 */
const TUI_POLYFILLS = `
// --- pi-install: polyfills for pi-tui functions not in pi.pi ---
function truncateToWidth(text: string, maxWidth: number): string {
	// Strip ANSI for width calc, truncate if needed
	const strip = (s: string) => s.replace(/\\x1b\\[[0-9;]*m/g, "");
	if (strip(text).length <= maxWidth) return text;
	let visible = 0;
	let i = 0;
	while (i < text.length && visible < maxWidth - 1) {
		if (text[i] === "\\x1b" && text[i+1] === "[") {
			const end = text.indexOf("m", i);
			if (end !== -1) { i = end + 1; continue; }
		}
		visible++; i++;
	}
	return text.slice(0, i) + "\u2026";
}
function matchesKey(data: string, key: string): boolean {
	const MAP: Record<string, string> = {
		"escape": "\\x1b", "up": "\\x1b[A", "down": "\\x1b[B",
		"right": "\\x1b[C", "left": "\\x1b[D",
		"pageUp": "\\x1b[5~", "pageDown": "\\x1b[6~",
	};
	return data === (MAP[key] ?? key);
}
function visibleWidth(text: string): number {
	return text.replace(/\\x1b\\[[0-9;]*m/g, "").length;
}
// --- end polyfills ---
`.trim();

/**
 * Rewrite a Pi extension file so it works in OMP's compiled runtime.
 *
 * Transforms:
 *   1. Remap @mariozechner/pi-* → @oh-my-pi/pi-* (type imports survive erasure)
 *   2. Convert runtime imports from @oh-my-pi/* and @sinclair/typebox to use
 *      destructured locals from the injected pi object
 *   3. Inject polyfills for pi-tui functions not on pi.pi
 */
/** Symbols that live on pi.typebox, not pi.pi — even when re-exported by pi-ai. */
const TYPEBOX_SYMBOLS = new Set([
	"Type", "Kind", "TypeGuard", "TypeRegistry", "TypeBoxError",
	"TypeClone", "TypeCompiler", "Value", "ValueGuard",
]);

/** pi-tui functions not exposed on pi.pi — need polyfills. */
const POLYFILL_SYMBOLS = new Set(["truncateToWidth", "matchesKey", "visibleWidth"]);

/** Package scopes rewritten by this tool (after step 1 remap). */
const PI_SCOPES_RE = /^@oh-my-pi\//;
const TYPEBOX_SCOPE = "@sinclair/typebox";

function rewriteExtensionFile(filePath: string): boolean {
	let code = fs.readFileSync(filePath, "utf-8");
	const original = code;

	// Step 1: Remap scopes (@mariozechner → @oh-my-pi)
	code = code.replace(/@mariozechner\/pi-coding-agent/g, "@oh-my-pi/pi-coding-agent");
	code = code.replace(/@mariozechner\/pi-agent-core/g, "@oh-my-pi/pi-agent-core");
	code = code.replace(/@mariozechner\/pi-ai/g, "@oh-my-pi/pi-ai");
	code = code.replace(/@mariozechner\/pi-tui/g, "@oh-my-pi/pi-tui");
	code = code.replace(/@mariozechner\/pi-utils/g, "@oh-my-pi/pi-utils");

	// Step 2: Collect runtime (non-type) imports from pi scopes and typebox,
	// then remove them and inject destructured locals from the factory arg.
	//
	// Handles two patterns:
	//   import { A, B } from "..."   (named)
	//   import * as X from "..."     (namespace)
	const namedImportRe = /^import\s+\{([^}]+)\}\s+from\s+["'](@oh-my-pi\/[^"']+|@sinclair\/typebox)["'];?\s*$/gm;
	const namespaceImportRe = /^import\s+\*\s+as\s+(\w+)\s+from\s+["'](@oh-my-pi\/[^"']+|@sinclair\/typebox)["'];?\s*$/gm;

	const piPiSymbols: string[] = [];
	const typeboxSymbols: string[] = [];
	const namespaceBindings: { name: string; target: "pi" | "typebox" }[] = [];
	let needsPolyfills = false;

	// Process named imports: import { A, B } from "..."
	code = code.replace(namedImportRe, (_match, imports: string, pkg: string) => {
		const names = imports.split(",").map((s: string) => s.trim()).filter(Boolean);
		for (const n of names) {
			if (pkg === TYPEBOX_SCOPE || TYPEBOX_SYMBOLS.has(n)) {
				// Direct typebox import, or re-export from pi-ai (e.g. Type)
				typeboxSymbols.push(n);
			} else if (POLYFILL_SYMBOLS.has(n)) {
				needsPolyfills = true;
			} else {
				piPiSymbols.push(n);
			}
		}
		return "// [pi-install] removed: " + _match.trim();
	});

	// Process namespace imports: import * as X from "..."
	code = code.replace(namespaceImportRe, (_match, name: string, pkg: string) => {
		const target = pkg === TYPEBOX_SCOPE ? "typebox" : "pi";
		namespaceBindings.push({ name, target });
		return "// [pi-install] removed: " + _match.trim();
	});

	if (code === original) return false;

	// Step 3: Move module-level code that depends on removed imports into the factory.
	// Specifically, find `const X = Type.Something(...)` or similar top-level uses
	// of symbols we just removed, and relocate them inside the factory.
	const removedSymbols = new Set([
		...piPiSymbols, ...typeboxSymbols,
		...POLYFILL_SYMBOLS,
		...namespaceBindings.map(b => b.name),
	]);

	// Find the factory function
	const factoryRe = /(export\s+default\s+function\s+\w*\s*\([^)]*\)\s*\{)/;
	const factoryMatch = code.match(factoryRe);

	if (factoryMatch) {
		// Collect top-level declarations that reference removed symbols.
		// Match multi-line const blocks: `const Name = Symbol.Something({` ... `});`
		const movedBlocks: string[] = [];
		const symbolPattern = [...removedSymbols].map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
		if (symbolPattern) {
			// Match top-level const/let/var that use any removed symbol as a call (e.g. Type.Object(...))
			// This handles multi-line declarations by tracking brace/paren depth.
			const lines = code.split("\n");
			const usageRe = new RegExp(`\\b(${symbolPattern})\\s*[\\.\\(]`);
			let i = 0;
			while (i < lines.length) {
				const line = lines[i];
				// Only target top-level (not indented) const/let declarations
				const isTopLevel = /^(const|let|var)\s/.test(line);
				if (isTopLevel && usageRe.test(line)) {
					// Find the end of this declaration by tracking parens/braces
					let depth = 0;
					let j = i;
					do {
						for (const ch of lines[j]) {
							if (ch === "(" || ch === "{") depth++;
							if (ch === ")" || ch === "}") depth--;
						}
						j++;
					} while (depth > 0 && j < lines.length);
					
					// Move these lines into the factory
					const block = lines.splice(i, j - i);
					movedBlocks.push(...block.map(l => "\t" + l));
					// Don't increment i since splice shifted lines
					continue;
				}
				i++;
			}
			code = lines.join("\n");
		}

		// Re-match factory position (may have shifted due to removed blocks)
		const factoryMatch2 = code.match(factoryRe);
		if (factoryMatch2) {
			const injections: string[] = [];
			if (piPiSymbols.length > 0) {
				injections.push(`\tconst { ${piPiSymbols.join(", ")} } = pi.pi as any;`);
			}
			if (typeboxSymbols.length > 0) {
				injections.push(`\tconst { ${typeboxSymbols.join(", ")} } = pi.typebox as any;`);
			}
			for (const ns of namespaceBindings) {
				const source = ns.target === "typebox" ? "pi.typebox" : "pi.pi";
				injections.push(`\tconst ${ns.name} = ${source} as any;`);
			}
			if (needsPolyfills) {
				injections.push("");
				injections.push(TUI_POLYFILLS.split("\n").map(l => "\t" + l).join("\n"));
			}
			if (movedBlocks.length > 0) {
				injections.push("");
				injections.push("\t// [pi-install] relocated from module scope:");
				injections.push(...movedBlocks);
			}

			if (injections.length > 0) {
				code = code.replace(factoryRe, factoryMatch2[1] + "\n" + injections.join("\n"));
			}
		}
	}

	fs.writeFileSync(filePath, code);
	return true;
}

function rewriteExtensionDir(dir: string): number {
	let count = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
			count += rewriteExtensionDir(full);
		} else if (entry.isFile() && /\.(ts|js|tsx|jsx|mts|mjs)$/.test(entry.name)) {
			if (rewriteExtensionFile(full)) count++;
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

/**
 * If the extension dir has a package.json with dependencies, run bun install.
 * Third-party deps (jsdom, diff, etc.) aren't in the OMP binary, so they must
 * be installed from npm.
 */
async function installDepsIfNeeded(
	extDir: string,
	notify: (msg: string, level: "info" | "error" | "warning") => void,
	execFn: (cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>,
): Promise<void> {
	const pkgPath = path.join(extDir, "package.json");
	if (!fs.existsSync(pkgPath)) return;
	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		const deps = Object.keys(pkg.dependencies ?? {});
		if (deps.length === 0) return;

		// Filter out @mariozechner/* and @oh-my-pi/* — those are handled by the rewriter,
		// not by npm install.
		const thirdParty = deps.filter(d => !d.startsWith("@mariozechner/") && !d.startsWith("@oh-my-pi/") && !d.startsWith("@sinclair/"));
		if (thirdParty.length === 0) return;

		notify(`Installing dependencies: ${thirdParty.join(", ")}...`, "info");
		const result = await execFn("bun", ["install", "--production"], { cwd: extDir, timeout: 60_000 });
		if (result.code !== 0) {
			notify(`Warning: dependency install failed (exit ${result.code}). Extension may not work.`, "warning");
		}
	} catch {
		notify("Warning: could not parse package.json for dependency install.", "warning");
	}
}


async function installFromDir(
	tmpDir: string,
	repoName: string,
	notify: (msg: string, level: "info" | "error" | "warning") => void,
	execFn: (cmd: string, args: string[], opts?: { timeout?: number; cwd?: string }) => Promise<{ code: number; stdout: string; stderr: string }>,
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
					await installDepsIfNeeded(dest, notify, execFn);
					rewriteExtensionDir(dest);
					installedExts.push(name);
				} else {
					// Dir contains multiple extensions as subdirs/files
					for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
						const src = path.join(resolved, entry.name);
						if (entry.isDirectory()) {
							const dest = path.join(EXTENSIONS_DIR, entry.name);
							if (fs.existsSync(dest)) rmDir(dest);
							copyDir(src, dest);
							await installDepsIfNeeded(dest, notify, execFn);
							rewriteExtensionDir(dest);
							installedExts.push(entry.name);
						} else if (/\.(ts|js)$/.test(entry.name)) {
							const dest = path.join(EXTENSIONS_DIR, entry.name);
							fs.copyFileSync(src, dest);
							rewriteExtensionFile(dest);
							installedExts.push(entry.name);
						}
					}
				}
			} else if (/\.(ts|js)$/.test(resolved)) {
				// Single file extension
				const name = path.basename(resolved);
				const dest = path.join(EXTENSIONS_DIR, name);
				fs.copyFileSync(resolved, dest);
				rewriteExtensionFile(dest);
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
				const result = await installFromDir(tmpDir, repoName, (msg, level) => ctx.ui.notify(msg, level), pi.exec.bind(pi));
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
					const result = await installFromDir(tmpDir, repoName, (msg, level) => ctx.ui.notify(msg, level), pi.exec.bind(pi));
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
