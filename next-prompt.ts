/**
 * next-prompt — next-prompt suggestion extension for pi.
 *
 * TUI-only (see F-03): when the input editor is empty after an agent turn has
 * fully settled, computes the single most logical next instruction the user
 * would type and shows it. Three render modes (config `renderMode`, default
 * "widget"):
 *   - "widget": a colored below-editor line `↳ next: <suggestion>  (Alt-/ to accept)`.
 *   - "ghost":  inline greyed ghost text in the input box after the caret.
 *   - "both":   inline ghost AND the below-editor line.
 *
 * The accept key (default `alt+/`, configurable) is handled via a GLOBAL
 * `ctx.ui.onTerminalInput` listener that swallows the key and fills the editor
 * via `ctx.ui.setEditorText` — editor-independent. Any other key dismisses the
 * suggestion immediately; deleting back to empty re-arms the last suggestion
 * after `rearmDelayMs` (default 2000, no new model call). No suggestion while
 * streaming.
 *
 * Config (all optional), merged global + project. Project config is only
 * honored when the project is trusted, and global privacy settings
 * (`allowCrossProvider`, `maxTranscriptChars`) act as policy floors that
 * project config can tighten but never loosen:
 *   ~/.pi/agent/next-prompt.json
 *   <cwd>/.pi/next-prompt.json
 *
 * Cross-destination disclosure (configured suggestion model on a different
 * provider/endpoint/model-route than the active model) is opt-in: it requires
 * `allowCrossProvider: true` (default false) AND explicit per-project consent,
 * persisted outside the repository in
 * `~/.pi/agent/next-prompt-consent.json`. Destination identity is provider +
 * endpoint origin + resolved model id, so a route/model change behind one
 * gateway never inherits consent (F-02/F-10).
 *
 * @module next-prompt
 */

import {
	existsSync,
	readFileSync,
	writeFileSync,
	mkdirSync,
	lstatSync,
	renameSync,
	chmodSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";

import {
	CONFIG_DIR_NAME,
	CustomEditor,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
	type EditorTheme,
	type KeyId,
	type TUI,
} from "@earendil-works/pi-tui";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	ThinkingLevel,
	UserMessage,
} from "@earendil-works/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NextPromptModelConfig {
	provider: string;
	model: string;
}

export type RenderMode = "widget" | "ghost" | "both";

export interface NextPromptConfig {
	model?: NextPromptModelConfig;
	/** Reasoning/thinking level for the suggestion model ("minimal".."max"). */
	thinking?: ThinkingLevel;
	/** Key id that accepts the suggestion (any pi-tui KeyId). Defaults to "alt+/". */
	acceptKey?: string;
	/** How the suggestion is shown. "widget" (default) = below-editor line; "ghost" = inline overlay in the input box. */
	renderMode?: RenderMode;
	systemPrompt?: string;
	maxTranscriptChars?: number;
	maxSuggestionChars?: number;
	/**
	 * Only the last N user/assistant message entries are sent in the
	 * transcript (tool results are never sent). Defaults to ALL entries.
	 * Smaller values minimize disclosure; invalid values fail closed.
	 */
	maxRecentTurns?: number;
	/**
	 * Whether a configured suggestion model on a *different destination*
	 * (provider + endpoint origin + model route) than the active model may
	 * receive the transcript. Defaults to FALSE. When false, fall back to the
	 * active model (or, when already on the active destination, use the
	 * configured model). Cross-destination use additionally requires
	 * per-project, per-destination consent (see consent flow in the
	 * controller).
	 */
	allowCrossProvider?: boolean;
	/** Delay (ms) before re-arming the last suggestion after the user deletes back to empty. Default 2000. */
	rearmDelayMs?: number;
}

/**
 * Effective configuration after validation, policy floors, and trust gating.
 * The controller never reads raw files; it always uses this shape.
 */
export interface EffectiveConfig extends NextPromptConfig {
	/** Resolved effective boolean (never undefined). */
	allowCrossProvider: boolean;
	/** Whether project config was trusted and therefore applied. */
	projectTrusted: boolean;
	/** True when invalid privacy-bearing fields caused compute to be disabled. */
	computeDisabled: boolean;
}

export interface DestinationIdentity {
	provider: string;
	origin: string;
	/** Routing identity of the resolved model (its registry id) on that endpoint. */
	model: string;
}

/** Consent record persisted outside the repository, keyed by project + destination. */
export interface ConsentRecord {
	/** Absolute project cwd. */
	project: string;
	destination: DestinationIdentity;
	/** ISO timestamp of the grant. */
	grantedAt: string;
	/** Model/provider label shown at grant time. */
	modelLabel: string;
}

export const DEFAULT_ALLOW_CROSS_PROVIDER = false;

export type TriggerDecision = "compute" | "skip";

/** Minimal shape of a session-branch entry we read. */
export interface BranchEntry {
	type: string;
	message?: { role?: string; content?: unknown; stopReason?: string };
}

/** Minimal shape of ctx used by resolveSuggestionModel / buildTranscript. */
export interface SuggestionCtx {
	model: Model<Api> | undefined;
	modelRegistry: {
		find(provider: string, modelId: string): Model<Api> | undefined;
	};
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	sessionManager: { getBranch(): BranchEntry[] };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRANSCRIPT = 12000;
const DEFAULT_MAX_SUGGESTION = 240;
export const DEFAULT_ACCEPT_KEY = "alt+/";
export const DEFAULT_REARM_MS = 2000;

const MIN_REARM_DELAY = 50;
const MIN_TRANSCRIPT_CHARS = 500;
const MIN_SUGGESTION_CHARS = 1;
const MAX_TRANSCRIPT_CHARS = 500_000;
const MAX_SUGGESTION_CHARS = 10_000;
const MIN_RECENT_TURNS = 1;
const MAX_RECENT_TURNS = 200;

/**
 * Keys that change where/whether transcript text is sent. Invalid values here
 * are fail-closed: they disable suggestion computation entirely.
 */
const RENDER_MODES: readonly string[] = ["widget", "ghost", "both"];
const THINKING_LEVELS: readonly string[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

// ANSI styling for the below-editor widget. Cyan accent for the ↳/next: prefix and
// the shortcut hint; the suggestion itself is plain (high-contrast default text).
const ACCENT = "\x1b[36m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Humanize a KeyId for display, e.g. "ctrl+tab" → "Ctrl-Tab". */
export function humanizeKey(key: string): string {
	return key
		.split("+")
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("-");
}

/**
 * Raw-byte fallback for accept-key detection, for terminals where pi-tui's
 * matchesKey() doesn't recognize a legacy alt+symbol sequence. Handles the
 * common forms an Alt+key or Ctrl+Alt+key can arrive in:
 *   alt+/   → "\x1b/"  (or sometimes "\x1bO/" / kitty CSI-u)
 *   ctrl+space → "\x00"
 * Only the last modifier+key segment is considered. Returns true if `data`
 * matches any of the candidate byte forms for the configured key.
 */
export function matchesAcceptKeyRaw(data: string, acceptKey: string): boolean {
	const parts = acceptKey.split("+");
	if (parts.length === 0) return false;
	const keyPart = parts[parts.length - 1]!;
	const modifiers = parts.slice(0, -1);
	const hasAlt = modifiers.includes("alt");
	const hasCtrl = modifiers.includes("ctrl");

	// ctrl+space special-case: legacy terminals send NUL.
	if (hasCtrl && !hasAlt && keyPart === "space" && data === "\x00") return true;

	// alt + single printable char: legacy form is ESC + char (both cases).
	if (hasAlt && !hasCtrl && keyPart.length === 1) {
		const cp = keyPart.codePointAt(0) ?? 0;
		const printable = cp >= 0x20 && cp <= 0x7e;
		if (printable) {
			if (data === `\x1b${keyPart}`) return true;
			if (data === `\x1b${keyPart.toUpperCase()}`) return true;
			// Some terminals prefix with SS3 ('O') for numpad/symbol variants.
			if (data === `\x1bO${keyPart}`) return true;
		}
	}
	return false;
}

export function loadConfig(
	cwd: string,
	opts: { projectTrusted?: boolean } = {},
): NextPromptConfig {
	return loadConfigDetailed(cwd, opts).cfg;
}

/**
 * Config load with status: returns the merged (floors-applied) config plus a
 * fail-closed flag raised when a privacy-bearing field was invalid.
 */
export function loadConfigDetailed(
	cwd: string,
	opts: { projectTrusted?: boolean } = {},
): { cfg: NextPromptConfig; computeDisabled: boolean } {
	const globalPath = join(getAgentDir(), "next-prompt.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "next-prompt.json");
	const projectTrusted = opts.projectTrusted ?? true;

	let globalCfg: NextPromptConfig = {};
	let projectCfg: NextPromptConfig = {};
	let globalInvalid = false;
	let projectInvalid = false;

	// F-07: an EXISTING but unreadable, syntactically invalid, or root-invalid
	// config file is privacy-invalid — the controller must not fall back to
	// defaults (which could silently change where/whether the transcript is
	// sent). Any parse/read failure sets the fail-closed flag.
	if (existsSync(globalPath)) {
		try {
			const parsed = parseConfig(readFileSync(globalPath, "utf-8"));
			globalCfg = parsed.cfg;
			if (parsed.privacyInvalid) globalInvalid = true;
		} catch (err) {
			console.warn(
				`next-prompt: failed to read global config ${globalPath}: ${err}; suggestions disabled`,
			);
			globalInvalid = true;
		}
	}
	if (projectTrusted && existsSync(projectPath)) {
		try {
			const parsed = parseConfig(readFileSync(projectPath, "utf-8"));
			projectCfg = parsed.cfg;
			if (parsed.privacyInvalid) projectInvalid = true;
		} catch (err) {
			console.warn(
				`next-prompt: failed to read project config ${projectPath}: ${err}; suggestions disabled`,
			);
			projectInvalid = true;
		}
	}

	// Merge, then apply policy floors so repository content can never loosen
	// a user-level privacy setting (F-02):
	//  - allowCrossProvider: project may tighten to false, never loosen a global false.
	//  - maxTranscriptChars: project may reduce, never increase a global cap.
	const merged: NextPromptConfig = { ...globalCfg, ...projectCfg };
	if (globalCfg.allowCrossProvider === false) {
		merged.allowCrossProvider = false;
	}
	if (typeof globalCfg.maxTranscriptChars === "number") {
		merged.maxTranscriptChars = Math.min(
			globalCfg.maxTranscriptChars,
			typeof projectCfg.maxTranscriptChars === "number"
				? projectCfg.maxTranscriptChars
				: globalCfg.maxTranscriptChars,
		);
	}
	return { cfg: merged, computeDisabled: globalInvalid || projectInvalid };
}

function parseConfig(text: string): {
	cfg: NextPromptConfig;
	privacyInvalid: boolean;
} {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		// Deliberate rethrow: callers surface a path-specific warning.
		throw new Error(`invalid JSON: ${(err as Error).message}`);
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error("config is not an object");
	const raw = parsed as Record<string, unknown>;
	const cfg: NextPromptConfig = {};
	let privacyInvalid = false;

	for (const key of Object.keys(raw)) {
		const value = raw[key];
		const failPrivacy = (why: string) => {
			privacyInvalid = true;
			console.warn(
				`next-prompt: invalid ${key} in config (${why}); disabling suggestions`,
			);
		};
		switch (key) {
			case "model": {
				const m = value;
				if (
					m === null ||
					typeof m !== "object" ||
					Array.isArray(m) ||
					typeof (m as NextPromptModelConfig).provider !== "string" ||
					((m as NextPromptModelConfig).provider as string).length === 0 ||
					typeof (m as NextPromptModelConfig).model !== "string" ||
					((m as NextPromptModelConfig).model as string).length === 0
				) {
					failPrivacy("must be { provider, model }");
				} else {
					cfg.model = {
						provider: (m as NextPromptModelConfig).provider,
						model: (m as NextPromptModelConfig).model,
					};
				}
				break;
			}
			case "systemPrompt":
				if (typeof value !== "string") failPrivacy("must be a string");
				else cfg.systemPrompt = value;
				break;
			case "allowCrossProvider":
				if (typeof value !== "boolean") failPrivacy("must be a boolean");
				else cfg.allowCrossProvider = value;
				break;
			case "maxTranscriptChars":
				if (
					typeof value !== "number" ||
					!Number.isInteger(value) ||
					value < MIN_TRANSCRIPT_CHARS ||
					value > MAX_TRANSCRIPT_CHARS
				)
					failPrivacy("must be an integer within bounds");
				else cfg.maxTranscriptChars = value;
				break;
			case "maxSuggestionChars":
				if (
					typeof value !== "number" ||
					!Number.isInteger(value) ||
					value < MIN_SUGGESTION_CHARS ||
					value > MAX_SUGGESTION_CHARS
				)
					console.warn(
						`next-prompt: invalid maxSuggestionChars in config; ignoring`,
					);
				else cfg.maxSuggestionChars = value;
				break;
			case "maxRecentTurns":
				if (
					typeof value !== "number" ||
					!Number.isInteger(value) ||
					value < MIN_RECENT_TURNS ||
					value > MAX_RECENT_TURNS
				)
					failPrivacy("must be an integer within bounds");
				else cfg.maxRecentTurns = value;
				break;
			case "rearmDelayMs":
				if (
					typeof value !== "number" ||
					!Number.isInteger(value) ||
					value < MIN_REARM_DELAY ||
					value > 60_000
				)
					console.warn(`next-prompt: invalid rearmDelayMs in config; ignoring`);
				else cfg.rearmDelayMs = value;
				break;
			case "thinking":
				if (typeof value !== "string" || !THINKING_LEVELS.includes(value))
					console.warn(`next-prompt: invalid thinking in config; ignoring`);
				else cfg.thinking = value as ThinkingLevel;
				break;
			case "renderMode":
				if (typeof value !== "string" || !RENDER_MODES.includes(value))
					console.warn(
						`next-prompt: invalid renderMode in config; using widget`,
					);
				else cfg.renderMode = value as RenderMode;
				break;
			case "acceptKey":
				if (typeof value !== "string" || value.trim().length === 0)
					console.warn(`next-prompt: invalid acceptKey in config; ignoring`);
				else if (value.trim().toLowerCase() === "tab")
					console.warn(
						`next-prompt: acceptKey "tab" conflicts with autocomplete; ignoring`,
					);
				else cfg.acceptKey = value;
				break;
			default:
				console.warn(`next-prompt: unknown config key "${key}" ignored`);
		}
	}
	return { cfg, privacyInvalid };
}

/**
 * Effective config for the controller: validated, floors applied, trust gated,
 * with the resolved boolean / privacy state materialized.
 */
export function loadEffectiveConfig(
	cwd: string,
	opts: { projectTrusted?: boolean } = {},
): EffectiveConfig {
	const projectTrusted = opts.projectTrusted ?? true;
	const { cfg, computeDisabled } = loadConfigDetailed(cwd, { projectTrusted });
	return {
		...cfg,
		allowCrossProvider: cfg.allowCrossProvider ?? DEFAULT_ALLOW_CROSS_PROVIDER,
		projectTrusted,
		computeDisabled,
	};
}

/**
 * Merge a partial config update into the existing global config file, preserving
 * unspecified keys. Returns the merged config plus a `saved` flag: false when
 * the destination was refused (symlink/non-regular) or the write failed.
 */
export function saveConfig(
	update: Partial<NextPromptConfig>,
): NextPromptConfig & { saved: boolean } {
	const path = join(getAgentDir(), "next-prompt.json");
	let existing: NextPromptConfig = {};
	if (existsSync(path)) {
		try {
			existing = parseConfig(readFileSync(path, "utf-8")).cfg;
		} catch {
			existing = {};
		}
	}
	const merged: NextPromptConfig = { ...existing, ...update };
	// Drop undefined values so the file stays clean.
	const clean: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(merged))
		if (v !== undefined) clean[k] = v;

	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });

	// F-14: refuse symlink / non-regular destinations so a hostile or accidental
	// link cannot redirect config writes.
	if (existsSync(path)) {
		const st = lstatSync(path);
		if (!st.isFile() || st.isSymbolicLink()) {
			console.warn(
				`next-prompt: refusing to overwrite non-regular config ${path}`,
			);
			return { ...merged, saved: false };
		}
	}

	// Atomic write: same-directory temp file with restrictive mode, then rename.
	const tmp = join(dir, `.next-prompt.json.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(clean, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, path);
		// Enforce the final mode even when the destination already existed.
		try {
			chmodSync(path, 0o600);
		} catch {
			/* best effort */
		}
	} catch (err) {
		console.warn(`next-prompt: failed to save config ${path}: ${err}`);
		try {
			rmSync(tmp, { force: true });
		} catch {
			/* best effort */
		}
		return { ...merged, saved: false };
	}
	return { ...merged, saved: true };
}

// ---------------------------------------------------------------------------
// Destination identity + cross-provider consent (F-02 / F-10)
// ---------------------------------------------------------------------------

/**
 * Normalized destination identity for a model: provider plus endpoint origin
 * when a baseUrl is available, plus the resolved model's routing id (F-02/F-10).
 * Two models on the same provider label and endpoint but different routing ids
 * (e.g. two downstream models behind one gateway) are distinct destinations.
 */
export function destinationOf(
	model: { provider: string; baseUrl?: string; id?: string } | undefined,
): DestinationIdentity | undefined {
	if (!model) return undefined;
	const provider = model.provider.toLowerCase();
	const identity: DestinationIdentity = {
		provider,
		origin: "",
		model: model.id ?? "",
	};
	if (model.baseUrl) {
		try {
			const origin = new URL(model.baseUrl).origin.toLowerCase();
			if (origin && origin !== "null") identity.origin = origin;
		} catch {
			/* fall through to provider-only identity */
		}
	}
	return identity;
}

export function sameDestination(
	a: DestinationIdentity | undefined,
	b: DestinationIdentity | undefined,
): boolean {
	if (!a || !b) return false;
	return (
		a.provider === b.provider && a.origin === b.origin && a.model === b.model
	);
}

/**
 * Consent key for a destination. Includes the model routing id so a route/
 * model change behind one gateway never inherits consent granted to another
 * downstream model (F-02/F-10). An empty model id (legacy record) can never
 * match a real destination key — old records force a fresh consent prompt.
 */
export function destinationKey(d: DestinationIdentity): string {
	const base = d.origin ? `${d.provider}@${d.origin}` : d.provider;
	return d.model ? `${base}#${d.model}` : base;
}

export function describeDestination(d: DestinationIdentity): string {
	const base = d.origin ? `${d.provider} (${d.origin})` : d.provider;
	return d.model ? `${base} — ${d.model}` : base;
}

function consentsPath(): string {
	return join(getAgentDir(), "next-prompt-consent.json");
}

/** Read persisted consent records (best effort). */
export function loadConsents(): ConsentRecord[] {
	const path = consentsPath();
	if (!existsSync(path)) return [];
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(r): r is ConsentRecord =>
				!!r &&
				typeof (r as ConsentRecord).project === "string" &&
				typeof (r as ConsentRecord).destination?.provider === "string",
		);
	} catch {
		return [];
	}
}

export function hasConsent(
	project: string,
	destination: DestinationIdentity,
): boolean {
	return loadConsents().some(
		(r) =>
			r.project === project &&
			destinationKey(r.destination) === destinationKey(destination),
	);
}

/** Persist a consent grant atomically (best effort; never throws). */
export function grantConsent(
	project: string,
	destination: DestinationIdentity,
	modelLabel: string,
): void {
	const path = consentsPath();
	const records = loadConsents().filter(
		(r) =>
			!(
				r.project === project &&
				destinationKey(r.destination) === destinationKey(destination)
			),
	);
	records.push({
		project,
		destination,
		grantedAt: new Date().toISOString(),
		modelLabel,
	});
	try {
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true });
		const tmp = join(
			dir,
			`.next-prompt-consent.json.${process.pid}.${Date.now()}.tmp`,
		);
		writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, path);
	} catch (err) {
		console.warn(`next-prompt: failed to persist consent: ${err}`);
	}
}

export function revokeConsent(
	project: string,
	destination: DestinationIdentity,
): void {
	const path = consentsPath();
	const records = loadConsents().filter(
		(r) =>
			!(
				r.project === project &&
				destinationKey(r.destination) === destinationKey(destination)
			),
	);
	try {
		const dir = dirname(path);
		mkdirSync(dir, { recursive: true });
		const tmp = join(
			dir,
			`.next-prompt-consent.json.${process.pid}.${Date.now()}.tmp`,
		);
		writeFileSync(tmp, `${JSON.stringify(records, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmp, path);
	} catch (err) {
		console.warn(`next-prompt: failed to revoke consent: ${err}`);
	}
}

/** Format a model for the config-command picker: "provider/model — name". */
export function formatModelOption(model: {
	provider: string;
	id: string;
	name?: string;
}): string {
	return `${model.provider}/${model.id} — ${model.name ?? model.id}`;
}

/** Parse a picked option (from formatModelOption) back into {provider, model}. */
export function parseModelOption(
	picked: string,
): NextPromptModelConfig | undefined {
	const m = picked.match(/^(.+?)\/(.+?) — /);
	if (!m || !m[1] || !m[2]) return undefined;
	return { provider: m[1], model: m[2] };
}

/** All selectable thinking levels plus an explicit "off/unset" entry. */
export const THINKING_OPTIONS = [
	"(unset — model default)",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const;

// ---------------------------------------------------------------------------
// Model resolution (destination-aware; F-02 / F-10)
// ---------------------------------------------------------------------------

/**
 * Result of model resolution. `crossDestination` is true only when the
 * configured model is on a different destination than the active model and
 * cross-destination use is permitted by config — the controller must then ask
 * for (or confirm persisted) consent before calling `complete()`.
 */
export interface ResolvedModel {
	model: Model<Api> | undefined;
	crossDestination: boolean;
}

/**
 * Resolve the suggestion model against the active model by *destination*
 * identity (provider + endpoint origin + model route), not label. Fail-closed
 * rules:
 *  - configured model on the same destination as active  → use it
 *  - configured model on a different destination and `allowCrossProvider`
 *    is false (the default)                             → active model, silent
 *  - configured model on a different destination and `allowCrossProvider`
 *    is true                                            → mark crossDestination;
 *    controller decides via consent
 *  - configured model missing from registry             → warn once, active
 *  - no active model and a different destination is requested
 *    (allowCrossProvider false)                         → no model (fail closed)
 */
export function resolveSuggestionModel(
	ctx: SuggestionCtx,
	config: NextPromptConfig,
	notifiedRef: { value: boolean },
): ResolvedModel {
	const active = ctx.model;
	if (!config.model?.provider || !config.model.model) {
		return { model: active, crossDestination: false };
	}

	const found = ctx.modelRegistry.find(
		config.model.provider,
		config.model.model,
	);
	if (!found) {
		if (!notifiedRef.value) {
			notifiedRef.value = true;
			ctx.ui.notify(
				`next-prompt: configured model ${config.model.provider}/${config.model.model} not found, using current model`,
				"warning",
			);
		}
		return { model: active, crossDestination: false };
	}

	const activeDest = destinationOf(active);
	const foundDest = destinationOf(found);
	if (sameDestination(activeDest, foundDest)) {
		return { model: found, crossDestination: false };
	}

	// Different destination than the active model.
	const crossAllowed = config.allowCrossProvider === true;
	if (!crossAllowed) {
		// Fail closed: no active model to fall back to and no permission → no call.
		if (!active) {
			if (!notifiedRef.value) {
				notifiedRef.value = true;
				ctx.ui.notify(
					`next-prompt: configured model ${config.model.provider}/${config.model.model} is on a different destination than the active model; suggestions disabled`,
					"warning",
				);
			}
			return { model: undefined, crossDestination: false };
		}
		return { model: active, crossDestination: false };
	}

	return { model: found, crossDestination: true };
}

// ---------------------------------------------------------------------------
// Secret redaction (defense-in-depth for cross-provider suggestion models)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
	/AKIA[0-9A-Z]{16}/g, // AWS access key id
	/sk-[a-zA-Z0-9]{20,}/g, // OpenAI-style secret
	/sk-proj-[A-Za-z0-9_-]{20,}/g, // OpenAI project-scoped key
	/sk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic key
	/ghp_[A-Za-z0-9]{36,}/g, // GitHub personal access token (classic PATs are 40 chars; 36+ avoids short false positives like ghp_test)
	/github_pat_[A-Za-z0-9_]{20,}/g, // GitHub fine-grained PAT
	/glpat-[A-Za-z0-9_-]{20,}/g, // GitLab PAT
	/AIza[0-9A-Za-z_-]{30,}/g, // Google API key
	/xoxb-[0-9a-zA-Z-]{10,}-[0-9a-zA-Z-]{10,}/g, // Slack bot token (xoxb-<10+>-<10+>)
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, // JWT
	/-----BEGIN [A-Z ]+PRIVATE KEY-----\s*[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g, // PEM
	/\b(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|access[_-]?key)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s"',;]+)/gi, // assignment forms
];

export function redactSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_PATTERNS) out = out.replace(re, "[redacted]");
	return out;
}

// ---------------------------------------------------------------------------
// Transcript building
// ---------------------------------------------------------------------------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			const b = block as { type: string; text?: string };
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
			else if (b.type === "image") parts.push("[image]");
		}
	}
	return parts.join(" ");
}

function joinUserText(content: unknown): string {
	return extractText(content);
}

function joinAssistantText(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block) {
			const b = block as { type: string; text?: string };
			// Skip thinking + toolCall blocks — low signal for "next prompt" prediction.
			if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
		}
	}
	return parts.join("");
}

export function buildTranscript(
	branch: BranchEntry[],
	config: NextPromptConfig = {},
): string {
	const max = config.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT;
	const lines: string[] = [];

	// F-11: user-configurable recent-turn selection. Only the last N user/
	// assistant entries are counted; tool results between them stay in the
	// kept slice but remain excluded from the output.
	let entries: BranchEntry[] = branch;
	if (typeof config.maxRecentTurns === "number") {
		const n = Math.max(1, Math.floor(config.maxRecentTurns));
		const messages = branch.filter(
			(entry) =>
				entry.type === "message" &&
				(entry.message?.role === "user" || entry.message?.role === "assistant"),
		);
		if (messages.length > n) {
			const startEntry = messages[messages.length - n];
			if (startEntry) {
				const startIdx = branch.indexOf(startEntry);
				entries = startIdx > 0 ? branch.slice(startIdx) : branch;
			}
		}
	}

	for (const entry of entries) {
		if (entry.type !== "message" || !entry.message) continue;
		const msg = entry.message;
		const role = msg.role;
		if (role === "user") {
			const t = joinUserText(msg.content);
			if (t) lines.push(`User: ${t}`);
		} else if (role === "assistant") {
			const t = joinAssistantText(msg.content);
			if (t) lines.push(`Assistant: ${t}`);
		}
		// toolResult skipped — verbose, low signal, may leak file contents.
	}

	let joined = redactSecrets(lines.join("\n"));
	if (joined.length > max) joined = joined.slice(joined.length - max);
	return joined;
}

export function buildMessages(transcript: string): Message[] {
	const userMessage: UserMessage = {
		role: "user",
		content: [{ type: "text", text: transcript }],
		timestamp: Date.now(),
	};
	return [userMessage];
}

// ---------------------------------------------------------------------------
// Suggestion sanitization
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Terminal-control sanitizer (F-01)
// ---------------------------------------------------------------------------

const BIDI_CONTROL = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/; // no /g: stateful lastIndex would skip every other control

/**
 * Remove terminal control sequences (OSC/CSI/DCS/APC/PM/SOS, both ESC-prefixed
 * and 8-bit C1 introducers), C0/C1 controls, DEL, carriage returns, bidi
 * override/isolate characters, and unpaired surrogates from model output so
 * untrusted text can never execute terminal commands, move the cursor,
 * overwrite the clipboard (OSC 52), or spoof the UI. Safe printable Unicode is
 * preserved.
 */
const CONTROL_STRING_CAP = 4096;

/**
 * Consume a control string (OSC/DCS/APC/PM/SOS) starting at `i` (the byte after
 * the introducer) until its terminator: BEL (0x07), ST (ESC \\), or C1 ST
 * (0x9C). Runaway sequences without a terminator within CONTROL_STRING_CAP
 * bytes consume the remainder of the string so no tail is re-emitted as text.
 * Returns the index just past the sequence end (or n when un-terminated).
 */
function consumeControlString(text: string, i: number, n: number): number {
	let j = i;
	const end = Math.min(n, i + CONTROL_STRING_CAP);
	while (j < end) {
		const c = text[j];
		if (c === "\x07") {
			j += 1;
			return j;
		}
		if (c === "\x1b" && text[j + 1] === "\\") {
			j += 2;
			return j;
		}
		if (c !== undefined && c.charCodeAt(0) === 0x9c) {
			j += 1;
			return j;
		}
		j += 1;
	}
	return n; // cap hit without a visible terminator: consume to end
}

/**
 * Consume a CSI sequence starting at `i` (the byte after the introducer) until
 * a final byte in 0x40..0x7E. Returns the index just past the final byte.
 */
function consumeCsi(text: string, i: number, n: number): number {
	let j = i;
	while (j < n) {
		const c = text.charCodeAt(j);
		if (c >= 0x40 && c <= 0x7e) break;
		j += 1;
	}
	return Math.min(j + 1, n);
}

export function sanitizeTerminalText(text: string): string {
	let out = "";
	let i = 0;
	const n = text.length;
	const isFinal = (cp: number) => cp >= 0x40 && cp <= 0x7e;
	const isC1 = (cp: number) => cp >= 0x80 && cp <= 0x9f;
	const isC0 = (cp: number) => cp < 0x20 || cp === 0x7f;
	const isLoneSurrogate = (cp: number) => cp >= 0xd800 && cp <= 0xdfff;

	while (i < n) {
		const ch = text[i]!;
		const cp = ch.charCodeAt(0);

		if (ch === "\x1b") {
			// ESC introduces a control sequence. Consume it fully.
			const next = text[i + 1];
			if (next === "[") {
				i = consumeCsi(text, i + 2, n);
			} else if (
				next === "]" ||
				next === "P" ||
				next === "_" ||
				next === "^" ||
				next === "X"
			) {
				// OSC / DCS / APC / PM / SOS: consume until ST, BEL, or C1 ST.
				i = consumeControlString(text, i + 2, n);
			} else if (next !== undefined && isFinal(next.charCodeAt(0))) {
				// ESC + single final byte (e.g. ESC 7, ESC c): consume both.
				i += 2;
			} else {
				i += 1; // dangling ESC: drop it
			}
			continue;
		}

		if (isC1(cp)) {
			// 8-bit control-string introducers: consume the whole sequence, not
			// just the one byte, so their payload never leaks as text (F-01).
			if (cp === 0x9b) {
				// CSI
				i = consumeCsi(text, i + 1, n);
			} else if (
				cp === 0x9d || // OSC
				cp === 0x90 || // DCS
				cp === 0x9e || // PM
				cp === 0x9f || // APC
				cp === 0x98 // SOS
			) {
				i = consumeControlString(text, i + 1, n);
			} else {
				i += 1; // other C1 (e.g. bare ST 0x9C): drop
			}
			continue;
		}

		if (isC0(cp)) {
			if (ch === "\n" || ch === "\t") out += " ";
			i += 1;
			continue;
		}
		if (BIDI_CONTROL.test(ch)) {
			i += 1;
			continue;
		}
		if (isLoneSurrogate(cp)) {
			// Unpaired surrogate (no low partner): drop it. A valid pair is
			// emitted as two units by the charCodeAt loop, so a high surrogate
			// followed by its low partner is preserved below.
			const nextCp = text.charCodeAt(i + 1);
			const isHigh = cp >= 0xd800 && cp <= 0xdbff;
			const isLow = cp >= 0xdc00 && cp <= 0xdfff;
			if (isHigh && nextCp >= 0xdc00 && nextCp <= 0xdfff) {
				out += ch + text[i + 1]!;
				i += 2;
			} else if (isLow) {
				i += 1; // lone low surrogate
			} else {
				i += 1; // lone high surrogate
			}
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/**
 * Upper bound on UTF-16 code units (≈ code points for well-formed text) for a
 * suggestion, computed from the visible-width cap. Zero-width characters have
 * zero display width and can therefore bypass a width-only cap; this bound
 * guarantees a hard storage/size limit after terminal filtering (F-01).
 * 4× the width cap is generous enough that CJK (2 columns) and emoji ZWJ
 * families never hit it before the width truncation does.
 */
export function suggestionCodePointCap(maxWidthChars: number): number {
	return Math.max(1, Math.floor(maxWidthChars * 4));
}

/**
 * Strip trailing zero-width / joining / variation / combining characters after
 * a code-point truncation so a dangling ZWJ or combining mark is not left
 * behind (F-01).
 */
function stripTrailingZeroWidth(s: string): string {
	return s.replace(/(?:[\u200B-\u200D\u2060\uFE0F\u034F\u180E]|\p{M})+$/u, "");
}

export function sanitizeSuggestion(
	raw: string,
	config: NextPromptConfig = {},
): string {
	const max = config.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION;
	// F-01: strip terminal control sequences before any other handling so the
	// suggestion can never carry escapes into the editor or the terminal.
	let s = sanitizeTerminalText(raw).trim();

	// First strip a leading+trailing fenced code block (``` ... ``` with optional language tag),
	// before quote handling, so the outer backticks aren't mistaken for paired backtick quotes.
	const fence = /^```[a-zA-Z0-9]*\n?([\s\S]*?)\n?```$/;
	const fenceMatch = s.match(fence);
	if (fenceMatch) s = fenceMatch[1]!.trim();

	// Strip one layer of surrounding quotes.
	if (s.length >= 2) {
		const first = s[0]!;
		const last = s[s.length - 1]!;
		if (
			(first === '"' && last === '"') ||
			(first === "'" && last === "'") ||
			(first === "`" && last === "`")
		) {
			s = s.slice(1, -1).trim();
		}
	}

	// Collapse internal newlines to single spaces (a prompt is one line).
	s = s.replace(/\s*\n\s*/g, " ").trim();

	// "NONE" sentinel => no suggestion.
	if (s === "NONE") return "";

	// Whitespace / punctuation only => no suggestion.
	if (/^[\s.,;:!?'"]+$/.test(s)) return "";

	// F-01: hard code-point bound after terminal filtering. Zero-width
	// sequences (ZWJ, bidi marks, variation selectors) have no visible width
	// and can never exceed the width cap — this bound is the real size limit
	// for storage/rendering. Apply it before the width-based truncation and
	// drop any trailing zero-width characters it might expose.
	const cps = Array.from(s);
	const maxCodepoints = suggestionCodePointCap(max);
	if (cps.length > maxCodepoints) {
		s = stripTrailingZeroWidth(cps.slice(0, maxCodepoints).join(""));
	}

	// Cap at a grapheme-safe boundary; truncateToWidth appends a trailing \x1b[0m reset,
	// strip it so the suggestion is clean text.
	if (visibleWidth(s) > max)
		s = truncateToWidth(s, max, "").replace(/\x1b\[[0-9;]*m$/g, "");
	return s;
}

// ---------------------------------------------------------------------------
// Trigger decision
// ---------------------------------------------------------------------------

export function shouldTrigger(
	branch: BranchEntry[],
	isIdle: boolean,
	editorText: string,
): TriggerDecision {
	if (!isIdle) return "skip";
	if (editorText.length > 0) return "skip";
	// Find the last message entry; it must be a completed assistant message.
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i]!;
		if (entry.type === "message" && entry.message) {
			const msg = entry.message;
			if (msg.role === "assistant" && msg.stopReason === "stop")
				return "compute";
			return "skip";
		}
	}
	return "skip";
}

// ---------------------------------------------------------------------------
// Ghost overlay rendering (pure; raw ANSI dim — no theme dependency)
// ---------------------------------------------------------------------------

const DIM_START = "\x1b[2m";
const DIM_END = "\x1b[22m";
const CURSOR_BLOCK_END = "\x1b[0m"; // ends the \x1b[7m... reverse-video cursor

export function overlayGhost(
	lines: string[],
	ghost: string,
	width: number,
): string[] {
	if (!ghost || lines.length === 0) return lines;

	// Find the cursor line by locating CURSOR_MARKER. Bail if unfocused (no marker).
	let cursorLineIdx = -1;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]!.includes(CURSOR_MARKER)) {
			cursorLineIdx = i;
			break;
		}
	}
	const contentWidth = Math.max(1, width);
	const result = lines.slice();

	if (cursorLineIdx === -1) {
		// Unfocused (e.g. user switched tabs/apps): CURSOR_MARKER is absent. The
		// editor renders one padded content line between top/bottom border rules.
		// Insert the ghost at the start of the content region, preserving left/right
		// padding exactly and never exceeding the line width (F-06). Only overlay an
		// empty editor; never replace real content.
		let contentIdx = -1;
		for (let i = 0; i < lines.length; i++) {
			const stripped = stripAnsi(lines[i]!).trim();
			if (!stripped.startsWith("─")) {
				contentIdx = i;
				break;
			}
		}
		if (contentIdx === -1) return lines;
		const line = result[contentIdx]!;
		const plain = stripAnsi(line);
		if (plain.trim().length > 0) return lines; // editor has content; leave it
		// Blank line: no real left padding to preserve (the whole line is padding).
		const lineVisible = visibleWidth(line);
		const cap = Math.max(1, lineVisible);
		const ghostSlice =
			visibleWidth(ghost) > cap ? truncateToWidth(ghost, cap, "") : ghost;
		if (!ghostSlice) return lines;
		const ghostStyled = `${DIM_START}${ghostSlice}${DIM_END}`;
		const pad = " ".repeat(Math.max(0, lineVisible - visibleWidth(ghostSlice)));
		result[contentIdx] = ghostStyled + pad;
		return result;
	}

	const line = result[cursorLineIdx]!;

	// The cursor block is: <before><CURSOR_MARKER>\x1b[7m<grapheme or space>\x1b[0m<rest>
	// Locate the first \x1b[0m after the CURSOR_MARKER to find the end of the cursor block.
	const markerIdx = line.indexOf(CURSOR_MARKER);
	if (markerIdx === -1) return lines; // defensive (already checked)
	const cursorBlockEnd = line.indexOf(
		CURSOR_BLOCK_END,
		markerIdx + CURSOR_MARKER.length,
	);
	if (cursorBlockEnd === -1) return lines; // unexpected structure; leave unchanged
	const insertAt = cursorBlockEnd + CURSOR_BLOCK_END.length;

	// Compute the visible width of the line content (excluding ANSI + the marker) so we
	// can size the ghost to fit within the editor content width without overflowing the
	// border.
	const leftPart = line.slice(0, insertAt);
	const trailingPart = line.slice(insertAt);
	// Strip trailing whitespace (the padding the base editor appends) to measure real width.
	const trailingTrimmed = trailingPart.replace(/\s+$/, "");
	const leftVisible = visibleWidth(
		stripAnsi(leftPart) + stripAnsi(trailingTrimmed),
	);
	const remaining = Math.max(0, contentWidth - leftVisible);

	const ghostSlice =
		visibleWidth(ghost) > remaining
			? truncateToWidth(ghost, remaining, "")
			: ghost;
	if (!ghostSlice) return lines; // nothing fits

	const ghostStyled = `${DIM_START}${ghostSlice}${DIM_END}`;
	const newLine =
		leftPart +
		ghostStyled +
		trailingTrimmed +
		" ".repeat(
			Math.max(0, contentWidth - leftVisible - visibleWidth(ghostSlice)),
		);
	result[cursorLineIdx] = newLine;
	return result;
}

/** Strip ANSI escape sequences for width measurement. */
function stripAnsi(s: string): string {
	// eslint-disable-next-line no-control-regex
	return s
		.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
		.replace(/\x1b[2-]m/g, "")
		.replace(CURSOR_MARKER, "");
}

// ---------------------------------------------------------------------------
// Suggestion state (editor-independent acceptance; rendering branches by mode)
// ---------------------------------------------------------------------------

export interface SuggestionState {
	suggestion: string;
	lastSuggestion: string;
	acceptKey: string;
	renderMode: RenderMode;
	rearmDelayMs: number;
	rearmTimer: ReturnType<typeof setTimeout> | undefined;
	rearmCheckTimer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Bumped on every user interaction and every reset. Any in-flight compute
	 * whose captured generation no longer matches is discarded (F-08).
	 */
	inputGeneration: number;
	isIdleGetter: () => boolean;
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	publishWidget: (content: string[] | undefined) => void;
	renderGhost: (() => void) | undefined;
	/** Abort + clear any in-flight suggestion request (F-08: user input cancels work). */
	abortInflight: () => void;
}

/** Publish the below-editor widget (or clear it when there's no suggestion). */
function renderWidget(state: SuggestionState): void {
	if (state.suggestion) {
		const hint = humanizeKey(state.acceptKey);
		state.publishWidget([
			`${ACCENT}↳ next:${RESET} ${state.suggestion}  ${ACCENT}${DIM}(${hint} to accept)${RESET}`,
		]);
	} else {
		state.publishWidget(undefined);
	}
}

function renderSuggestion(state: SuggestionState): void {
	const mode = state.renderMode;
	const showGhost = mode === "ghost" || mode === "both";
	const showWidget = mode === "widget" || mode === "both";
	if (showGhost) state.renderGhost?.();
	if (showWidget) renderWidget(state);
}

/**
 * Show a suggestion. Guarded twice: the captured input generation must still
 * match (no intervening user interaction) and the editor must still be empty
 * and the agent idle (no submit/turn since the request started).
 */
function showSuggestion(
	state: SuggestionState,
	text: string,
	generation: number,
): void {
	if (generation !== state.inputGeneration) return;
	if (state.getEditorText().length > 0 || !state.isIdleGetter()) return;
	state.suggestion = text;
	state.lastSuggestion = text;
	clearRearmTimer(state);
	clearRearmCheckTimer(state);
	renderSuggestion(state);
}

/**
 * Dismiss the active suggestion (widget + ghost) while keeping the cached
 * last suggestion for a later delete-to-empty re-arm. The caller bumps the
 * input generation to invalidate in-flight work.
 */
function dismissSuggestion(state: SuggestionState): void {
	clearRearmTimer(state);
	clearRearmCheckTimer(state);
	if (state.suggestion) {
		state.suggestion = "";
		renderSuggestion(state);
	}
}

/**
 * Full reset: dismiss, drop the cached suggestion, and bump the generation so
 * any in-flight compute cannot publish. Used on submit/turn/agent/session
 * lifecycle events.
 */
function clearSuggestion(state: SuggestionState | undefined): void {
	if (!state) return;
	clearRearmTimer(state);
	clearRearmCheckTimer(state);
	state.inputGeneration += 1;
	if (state.suggestion) {
		state.suggestion = "";
		renderSuggestion(state);
	}
	state.lastSuggestion = "";
}

function clearRearmTimer(state: SuggestionState): void {
	if (state.rearmTimer !== undefined) {
		clearTimeout(state.rearmTimer);
		state.rearmTimer = undefined;
	}
}

function clearRearmCheckTimer(state: SuggestionState): void {
	if (state.rearmCheckTimer !== undefined) {
		clearTimeout(state.rearmCheckTimer);
		state.rearmCheckTimer = undefined;
	}
}

/**
 * After a delete-to-empty transition, re-arm the last suggestion after
 * rearmDelayMs (no new model call). Only a genuine non-empty -> empty
 * transition arms the timers (F-09); dismissal via Escape/arrows/focus never
 * does. The 50ms outer timer defers until the editor has processed the key.
 */
function scheduleRearmCheck(
	state: SuggestionState,
	editorTextBefore: string,
): void {
	clearRearmCheckTimer(state);
	if (editorTextBefore.length === 0) return; // nothing to delete from
	state.rearmCheckTimer = setTimeout(() => {
		state.rearmCheckTimer = undefined;
		if (state.suggestion) return; // already showing
		if (!state.lastSuggestion) return; // nothing to re-arm with
		if (!state.isIdleGetter()) return; // agent running
		if (state.getEditorText().length > 0) return; // not empty
		clearRearmTimer(state);
		state.rearmTimer = setTimeout(() => {
			state.rearmTimer = undefined;
			if (state.suggestion) return;
			if (!state.isIdleGetter()) return;
			if (state.getEditorText().length > 0) return;
			showSuggestion(state, state.lastSuggestion, state.inputGeneration);
		}, state.rearmDelayMs);
	}, 50);
}

/**
 * Raw terminal-input handler. Accept key fills the editor; any other key
 * dismisses the active suggestion immediately (F-04), invalidates in-flight
 * work (F-08), and schedules a re-arm only for a genuine delete-to-empty
 * transition (F-09). Editor-independent via ctx.ui.onTerminalInput.
 */
function makeInputHandler(
	state: SuggestionState,
): (data: string) => { consume?: boolean } | undefined {
	return (data: string) => {
		const isAcceptKey =
			matchesKey(data, state.acceptKey as KeyId) ||
			matchesAcceptKeyRaw(data, state.acceptKey);
		const editorTextBefore = state.getEditorText();

		if (
			isAcceptKey &&
			state.suggestion &&
			state.isIdleGetter() &&
			editorTextBefore.length === 0
		) {
			// Accept: fill the editor, keep the suggestion cached for delete-to-empty
			// re-arm, clear the widget, bump the input generation (invalidates any
			// in-flight compute), and remember there is nothing to delete yet.
			state.lastSuggestion = state.suggestion;
			state.suggestion = "";
			state.inputGeneration += 1;
			clearRearmTimer(state);
			clearRearmCheckTimer(state);
			state.abortInflight();
			state.setEditorText(state.lastSuggestion);
			state.publishWidget(undefined);
			scheduleRearmCheck(state, editorTextBefore);
			return { consume: true };
		}

		// Non-accept key: dismiss any active suggestion, abort in-flight work,
		// and pass the key through to the editor.
		dismissSuggestion(state);
		state.inputGeneration += 1;
		state.abortInflight();
		scheduleRearmCheck(state, editorTextBefore);
		return undefined;
	};
}

// ---------------------------------------------------------------------------
// Default system prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You predict the single most logical next instruction the user would type into a coding agent, given the conversation so far. Reply with ONLY that instruction, one line, no quotes, no markdown, no explanation. If there is nothing useful to suggest, reply with the single word: NONE`;

// ---------------------------------------------------------------------------
// Ghost editor (inline overlay mode — renderMode: "ghost")
// ---------------------------------------------------------------------------
// A render-only CustomEditor that overlays the current suggestion
// (state.suggestion) as greyed inline text after the caret via overlayGhost().
// Acceptance/dismissal is handled by the global onTerminalInput handler, so
// this class never decides policy. Installed once per session; pi's
// resetExtensionUI on reload/switch is followed by a fresh session_start that
// re-installs it (no per-settle re-installation — F-05).

class GhostEditor extends CustomEditor {
	private suggestionState: SuggestionState;
	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		state: SuggestionState,
	) {
		super(tui, theme, keybindings);
		this.suggestionState = state;
	}

	/** Public so the controller can trigger a re-render when the ghost value changes. */
	requestGhostRender(): void {
		this.tui?.requestRender();
	}

	render(width: number): string[] {
		return overlayGhost(
			super.render(width),
			this.suggestionState.suggestion,
			width,
		);
	}

	handleInput(data: string): void {
		// The global handler already dismissed/accepted; delegate everything to the
		// base editor (autocomplete, history, paste, app keybindings) untouched.
		super.handleInput(data);
		this.tui?.requestRender();
	}
}

export { GhostEditor };

// ---------------------------------------------------------------------------
// Controller / event wiring
// ---------------------------------------------------------------------------

interface NextPromptRef {
	state: SuggestionState | undefined;
	inflight: AbortController | undefined;
	unsubInput: (() => void) | undefined;
}

export default function nextPromptExtension(pi: ExtensionAPI): void {
	const ref: NextPromptRef = {
		state: undefined,
		inflight: undefined,
		unsubInput: undefined,
	};
	let effective: EffectiveConfig | undefined;
	const notifiedFallback = { value: false };
	// Session-scoped denial set: a declined consent never re-prompts (nor
	// sends) for the remainder of the session.
	const deniedConsents = new Set<string>();
	let editorInstalled = false;

	function reset(): void {
		ref.inflight?.abort();
		ref.inflight = undefined;
		clearSuggestion(ref.state);
	}

	pi.on("session_start", (_e, ctx) => {
		reset();
		ref.unsubInput?.();
		ref.unsubInput = undefined;
		notifiedFallback.value = false;
		editorInstalled = false;
		deniedConsents.clear();

		// F-03: no TUI => no invisible suggestion work in headless modes.
		if (ctx.mode !== "tui") {
			ref.state = undefined;
			effective = undefined;
			return;
		}

		// F-02: trust-gated, validated config with policy floors applied.
		effective = loadEffectiveConfig(ctx.cwd, {
			projectTrusted: ctx.isProjectTrusted(),
		});
		if (effective.computeDisabled) {
			ctx.ui.notify(
				"next-prompt: invalid privacy-sensitive config; suggestions disabled",
				"warning",
			);
		}

		const publishWidget = (content: string[] | undefined) => {
			ctx.ui.setWidget("next-prompt", content, { placement: "belowEditor" });
		};
		// F-05: install the ghost editor exactly once per session, and only when
		// no other extension already owns the editor. Otherwise fall back to the
		// widget mode rather than clobbering the other editor (P1-1: the fallback
		// must actually switch renderMode, or no surface renders at all).
		let renderMode: RenderMode = effective.renderMode ?? "widget";

		const state: SuggestionState = {
			suggestion: "",
			lastSuggestion: "",
			acceptKey: effective.acceptKey ?? DEFAULT_ACCEPT_KEY,
			renderMode,
			rearmDelayMs: effective.rearmDelayMs ?? DEFAULT_REARM_MS,
			rearmTimer: undefined,
			rearmCheckTimer: undefined,
			inputGeneration: 0,
			isIdleGetter: () => ctx.isIdle(),
			getEditorText: () => ctx.ui.getEditorText(),
			setEditorText: (text) => ctx.ui.setEditorText(text),
			publishWidget,
			renderGhost: undefined,
			abortInflight: () => {
				ref.inflight?.abort();
				ref.inflight = undefined;
			},
		};
		ref.state = state;

		const wantGhost =
			(renderMode === "ghost" || renderMode === "both") &&
			!effective.computeDisabled;
		if (wantGhost && !editorInstalled) {
			const prior = ctx.ui.getEditorComponent();
			if (prior) {
				renderMode = "widget";
				state.renderMode = "widget";
				ctx.ui.notify(
					"next-prompt: another extension owns the editor; using widget mode",
					"warning",
				);
			} else {
				ctx.ui.setEditorComponent((tui, theme, kb) => {
					const ed = new GhostEditor(tui, theme, kb, state);
					state.renderGhost = () => ed.requestGhostRender();
					return ed;
				});
				editorInstalled = true;
			}
		}

		// Global terminal-input listener: accept/dismiss is editor-independent.
		ref.unsubInput = ctx.ui.onTerminalInput(makeInputHandler(state));
	});

	pi.on("agent_settled", async (_e, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
			if (!ref.state || !effective) return;
			// Re-read config so a mid-session edit takes effect on the next settle
			// without a reload.
			effective = loadEffectiveConfig(ctx.cwd, {
				projectTrusted: ctx.isProjectTrusted(),
			});
			if (effective.computeDisabled) return;
			if (!ctx.isIdle() || ctx.ui.getEditorText().length > 0) return;
			await maybeCompute(ctx);
		} catch (err) {
			console.warn("next-prompt: agent_settled handler failed", err);
		}
	});

	// Clear suggestion + abort in-flight the instant the user submits or the agent starts.
	pi.on("input", () => {
		reset();
	});
	pi.on("turn_start", () => {
		reset();
	});
	pi.on("agent_start", () => {
		reset();
	});

	pi.on("session_shutdown", () => {
		reset();
		ref.unsubInput?.();
		ref.unsubInput = undefined;
		ref.state = undefined;
		effective = undefined;
	});

	async function maybeCompute(ctx: ExtensionContext): Promise<void> {
		if (!ref.state || !effective) return;
		const state = ref.state;
		ref.inflight?.abort();
		const ac = new AbortController();
		ref.inflight = ac;
		const generation = state.inputGeneration;

		if (
			shouldTrigger(
				ctx.sessionManager.getBranch(),
				ctx.isIdle(),
				ctx.ui.getEditorText(),
			) !== "compute"
		) {
			return;
		}
		const resolved = resolveSuggestionModel(ctx, effective, notifiedFallback);
		if (!resolved.model) return;

		// F-02 / F-10: cross-destination disclosure requires explicit, persisted
		// per-project consent. Fail closed on decline; never re-prompt in-session.
		if (resolved.crossDestination) {
			const dest = destinationOf(resolved.model);
			const key = dest ? destinationKey(dest) : "";
			if (!dest || deniedConsents.has(key)) return;
			if (!hasConsent(ctx.cwd, dest)) {
				if (!ctx.ui.confirm) return; // no dialogs available -> fail closed
				const transcriptSize = buildTranscript(
					ctx.sessionManager.getBranch(),
					effective,
				).length;
				const granted = await ctx.ui.confirm(
					"next-prompt: send transcript to another provider?",
					`Suggestion model ${resolved.model.provider}/${resolved.model.id} is on a different destination (${describeDestination(dest)}) than the active model. This sends up to ${transcriptSize} chars of conversation text there. Allow for this project?`,
				);
				// F-08: the dialog may resolve AFTER an interaction, reset, or
				// shutdown invalidated this request. Require the original
				// controller/state identity, request signal, and input generation
				// to still be current before persisting consent or calling the
				// model — otherwise return without disclosing anything.
				if (
					ac.signal.aborted ||
					ref.state !== state ||
					generation !== state.inputGeneration
				) {
					if (ref.inflight === ac) ref.inflight = undefined;
					return;
				}
				if (!granted) {
					deniedConsents.add(key);
					ctx.ui.notify(
						"next-prompt: cross-provider suggestion declined",
						"warning",
					);
					return;
				}
				grantConsent(
					ctx.cwd,
					dest,
					`${resolved.model.provider}/${resolved.model.id}`,
				);
			}
		}

		const transcript = buildTranscript(
			ctx.sessionManager.getBranch(),
			effective,
		);
		const messages = buildMessages(transcript);
		const context: Context = {
			systemPrompt: effective.systemPrompt ?? SYSTEM_PROMPT,
			messages,
		};

		let resp: AssistantMessage;
		try {
			resp = await ctx.modelRegistry.complete(resolved.model, context, {
				signal: ac.signal,
				reasoning: effective.thinking,
			});
		} catch (err) {
			if (!ac.signal.aborted) {
				ctx.ui.notify("next-prompt: suggestion failed", "error");
			}
			return;
		}
		if (ac.signal.aborted || generation !== state.inputGeneration) return;

		if (resp.stopReason !== "stop") {
			if (resp.stopReason === "error") {
				ctx.ui.notify("next-prompt: suggestion model error", "warning");
			}
			return;
		}

		const raw = resp.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map((c) => c.text)
			.join("\n");
		const clean = sanitizeSuggestion(raw, effective);
		if (clean && ref.state === state) showSuggestion(state, clean, generation);
		if (ref.inflight === ac) ref.inflight = undefined;
	}

	// Interactive config command: `/next-prompt-config`. Walks the user through
	// every configurable option EXCEPT systemPrompt (config-file only, F-15) with
	// model-picker + dialogs, saves to ~/.pi/agent/next-prompt.json, and reloads
	// so changes take effect immediately.
	pi.registerCommand("next-prompt-config", {
		description: "Configure the next-prompt suggestion extension",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(
					"next-prompt: /next-prompt-config requires interactive mode",
					"error",
				);
				return;
			}
			const next = await configureInteractively(ctx, loadConfig(ctx.cwd));
			if (next) {
				const saved = saveConfig(next);
				if (!saved.saved) {
					ctx.ui.notify(
						"next-prompt: failed to save config; changes not applied",
						"error",
					);
					return;
				}
				ctx.ui.notify("next-prompt: config saved — reloading", "info");
				await ctx.reload();
			}
		},
	});
}

/**
 * Interactive config flow. Returns a partial NextPromptConfig to merge+save, or undefined
 * if the user cancelled at the first prompt. Pure-ish (reads models via ctx.modelRegistry;
 * only dialogs are interactive). Exported for unit testing with a stub ctx.
 */
export async function configureInteractively(
	ctx: {
		ui: {
			select: (title: string, options: string[]) => Promise<string | undefined>;
			input: (
				title: string,
				placeholder?: string,
			) => Promise<string | undefined>;
			confirm: (title: string, message: string) => Promise<boolean>;
		};
		modelRegistry: {
			getAvailable(): Array<{ provider: string; id: string; name?: string }>;
		};
	},
	current: NextPromptConfig,
): Promise<Partial<NextPromptConfig> | undefined> {
	const update: Partial<NextPromptConfig> = {};

	// 1. Suggestion model (picker over all available models, or "use current").
	const models = ctx.modelRegistry
		.getAvailable()
		.map((m) => formatModelOption(m));
	const currentLabel = current.model
		? formatModelOption({ ...current.model, id: current.model.model })
		: "(use current model)";
	const modelPick = await ctx.ui.select(
		`next-prompt: suggestion model [${currentLabel}]`,
		["(use current model)", ...models],
	);
	if (modelPick === undefined) return undefined;
	if (modelPick === "(use current model)") update.model = undefined;
	else update.model = parseModelOption(modelPick);

	// 2. renderMode — ghost first (nicer, inline in the box), then widget (reliable
	// below-editor line), then both.
	const renderOptions = [
		"ghost — inline greyed text in the input box",
		"widget — colored line below the input box",
		"both — inline ghost AND the below-editor line",
	];
	const currentRenderLabel = current.renderMode ?? "widget";
	const renderPick = await ctx.ui.select(
		`next-prompt: render mode [${currentRenderLabel}]`,
		renderOptions,
	);
	if (renderPick) update.renderMode = renderPick.split(" — ")[0] as RenderMode;

	// 3. thinking level
	const thinkPick = await ctx.ui.select(
		`next-prompt: thinking level [${current.thinking ?? "(unset)"}]`,
		[...THINKING_OPTIONS],
	);
	if (thinkPick)
		update.thinking =
			thinkPick === THINKING_OPTIONS[0]
				? undefined
				: (thinkPick as ThinkingLevel);

	// 4. acceptKey (free text)
	const acceptPick = await ctx.ui.input(
		`next-prompt: accept key [${current.acceptKey ?? "alt+/"}]`,
		current.acceptKey ?? "alt+/",
	);
	if (acceptPick) update.acceptKey = acceptPick.trim();

	// 5. rearmDelayMs (numeric text)
	const rearmPick = await ctx.ui.input(
		`next-prompt: re-arm delay ms [${current.rearmDelayMs ?? DEFAULT_REARM_MS}]`,
		String(current.rearmDelayMs ?? DEFAULT_REARM_MS),
	);
	if (rearmPick) {
		const n = Number(rearmPick.trim());
		if (Number.isInteger(n) && n >= MIN_REARM_DELAY && n <= 60_000)
			update.rearmDelayMs = n;
	}

	// 6. maxTranscriptChars (numeric text)
	const trPick = await ctx.ui.input(
		`next-prompt: max transcript chars [${current.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT}]`,
		String(current.maxTranscriptChars ?? DEFAULT_MAX_TRANSCRIPT),
	);
	if (trPick) {
		const n = Number(trPick.trim());
		if (
			Number.isInteger(n) &&
			n >= MIN_TRANSCRIPT_CHARS &&
			n <= MAX_TRANSCRIPT_CHARS
		)
			update.maxTranscriptChars = n;
	}

	// 7. maxRecentTurns (numeric text; disclosure minimization — empty keeps all)
	const rtPick = await ctx.ui.input(
		`next-prompt: max recent turns sent in transcript (empty = all) [${current.maxRecentTurns ?? "all"}]`,
		current.maxRecentTurns === undefined ? "" : String(current.maxRecentTurns),
	);
	if (rtPick && rtPick.trim().length > 0) {
		const n = Number(rtPick.trim());
		if (Number.isInteger(n) && n >= MIN_RECENT_TURNS && n <= MAX_RECENT_TURNS)
			update.maxRecentTurns = n;
	}

	// 8. maxSuggestionChars (numeric text)
	const sgPick = await ctx.ui.input(
		`next-prompt: max suggestion chars [${current.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION}]`,
		String(current.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION),
	);
	if (sgPick) {
		const n = Number(sgPick.trim());
		if (
			Number.isInteger(n) &&
			n >= MIN_SUGGESTION_CHARS &&
			n <= MAX_SUGGESTION_CHARS
		)
			update.maxSuggestionChars = n;
	}

	// 9. allowCrossProvider (confirm)
	const cross = await ctx.ui.confirm(
		`next-prompt: allow cross-provider suggestion (sends transcript to a different provider)? [${current.allowCrossProvider ?? DEFAULT_ALLOW_CROSS_PROVIDER}]`,
		"Yes = use the configured model even if it's on a different provider (requires per-project consent). No = fall back to the current model.",
	);
	update.allowCrossProvider = cross;

	return update;
}
