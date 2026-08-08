/**
 * next-prompt — inline "ghost" next-prompt suggestion extension for pi.
 *
 * When the input editor is empty after an agent turn has fully settled, computes the
 * single most logical next instruction the user would type and shows it as inline
 * greyed ghost text after the caret. Tab (with the autocomplete dropdown closed)
 * accepts; any other key dismisses; backspace-to-empty re-arms from the last
 * computed suggestion (no new model call). No ghost is shown while the agent is
 * streaming or the editor is non-empty.
 *
 * Config (all optional), merged global + project:
 *   ~/.pi/agent/next-prompt.json
 *   <cwd>/.pi/next-prompt.json
 *
 * {
 *   "model": { "provider": "anthropic", "model": "claude-haiku-4-5" },  // default: current model
 *   "systemPrompt": "...override...",
 *   "maxTranscriptChars": 12000,
 *   "maxSuggestionChars": 240,
 *   "debounceMs": 400,            // largely redundant with agent_settled; reserved
 *   "allowCrossProvider": true   // false => fall back to ctx.model if configured provider differs
 * }
 *
 * See PLAN.md for the full design (oracle-reviewed).
 *
 * @module next-prompt
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
	CONFIG_DIR_NAME,
	getAgentDir,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	CURSOR_MARKER,
	truncateToWidth,
	visibleWidth,
	type KeyId,
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

export interface NextPromptConfig {
	model?: NextPromptModelConfig;
	/** Reasoning/thinking level for the suggestion model ("minimal".."max"). */
	thinking?: ThinkingLevel;
	/** Key id that accepts the suggestion (e.g. "ctrl+tab", "tab", "alt+enter"). Defaults to "ctrl+tab". */
	acceptKey?: string;
	systemPrompt?: string;
	maxTranscriptChars?: number;
	maxSuggestionChars?: number;
	debounceMs?: number;
	allowCrossProvider?: boolean;
}

export type TriggerDecision = "compute" | "skip";

export interface InputDecision {
	action: "accept" | "dismiss" | "rearm" | "passthrough";
	ghost: string;
	acceptText?: string;
}

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

export function loadConfig(cwd: string): NextPromptConfig {
	const globalPath = join(getAgentDir(), "next-prompt.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "next-prompt.json");

	let globalCfg: NextPromptConfig = {};
	let projectCfg: NextPromptConfig = {};

	if (existsSync(globalPath)) {
		try {
			globalCfg = parseConfig(readFileSync(globalPath, "utf-8"));
		} catch (err) {
			console.warn(
				`next-prompt: failed to read global config ${globalPath}: ${err}`,
			);
		}
	}
	if (existsSync(projectPath)) {
		try {
			projectCfg = parseConfig(readFileSync(projectPath, "utf-8"));
		} catch (err) {
			console.warn(
				`next-prompt: failed to read project config ${projectPath}: ${err}`,
			);
		}
	}
	return { ...globalCfg, ...projectCfg };
}

function parseConfig(text: string): NextPromptConfig {
	// pi-lens-ignore: unchecked-throwing-call
	const parsed = JSON.parse(text) as NextPromptConfig;
	if (parsed && typeof parsed !== "object")
		throw new Error("config is not an object");
	if (
		parsed.model != null &&
		(typeof parsed.model !== "object" ||
			typeof parsed.model.provider !== "string" ||
			typeof parsed.model.model !== "string")
	) {
		console.warn(
			"next-prompt: config.model must be { provider, model }; ignoring",
		);
		return { ...parsed, model: undefined };
	}
	return parsed;
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

export function resolveSuggestionModel(
	ctx: SuggestionCtx,
	config: NextPromptConfig,
	notifiedRef: { value: boolean },
): Model<Api> | undefined {
	const active = ctx.model;

	if (config.model && config.model.provider && config.model.model) {
		// allowCrossProvider guard: if false and the configured provider differs from the
		// active one, fall back to the active model silently (do not notify).
		if (
			config.allowCrossProvider === false &&
			active &&
			config.model.provider !== active.provider
		) {
			return active;
		}
		const found = ctx.modelRegistry.find(
			config.model.provider,
			config.model.model,
		);
		if (found) return found;
		if (!notifiedRef.value) {
			notifiedRef.value = true;
			ctx.ui.notify(
				`next-prompt: configured model ${config.model.provider}/${config.model.model} not found, using current model`,
				"warning",
			);
		}
	}
	return active;
}

// ---------------------------------------------------------------------------
// Secret redaction (defense-in-depth for cross-provider suggestion models)
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
	/AKIA[0-9A-Z]{16}/g, // AWS access key id
	/sk-[a-zA-Z0-9]{20,}/g, // OpenAI-style secret
	/ghp_[A-Za-z0-9]+/g, // GitHub personal access token (variable length)
	/xoxb-[0-9a-zA-Z-]+/g, // Slack bot token
	/-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g, // PEM
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

	for (const entry of branch) {
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

export function sanitizeSuggestion(
	raw: string,
	config: NextPromptConfig = {},
): string {
	const max = config.maxSuggestionChars ?? DEFAULT_MAX_SUGGESTION;
	let s = raw.trim();

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
// Editor key-handling brain (pure)
// ---------------------------------------------------------------------------

export function decideInput(opts: {
	data: string;
	ghost: string;
	lastSuggestion: string;
	editorTextBefore: string;
	editorTextAfter: string;
	isShowingAutocomplete: boolean;
	isTab: boolean;
}): InputDecision {
	const {
		ghost,
		lastSuggestion,
		editorTextBefore,
		editorTextAfter,
		isShowingAutocomplete,
		isTab,
	} = opts;

	const backspaceToEmpty =
		editorTextBefore.length > 0 && editorTextAfter.length === 0;

	// 1. Accept on Tab, but only when autocomplete is NOT open (so we never clobber
	//    /template or path completion).
	if (ghost && isTab && !isShowingAutocomplete) {
		return { action: "accept", ghost: "", acceptText: ghost };
	}
	// 2. Dismiss on any non-Tab key while a ghost is showing (printable OR control
	//    keys like Escape — clear on any non-accept input, per oracle blocker #6).
	if (ghost && !isTab) {
		// The editor text may have changed (e.g. the printable char was inserted, or
		// escape did nothing). Re-arm check below only applies when text became empty.
		const newGhost = backspaceToEmpty && lastSuggestion ? lastSuggestion : "";
		return {
			action: backspaceToEmpty && lastSuggestion ? "rearm" : "dismiss",
			ghost: newGhost,
		};
	}
	// 3. No ghost: re-arm if the user just backspaced down to empty and we have a
	//    cached suggestion.
	if (!ghost && backspaceToEmpty && lastSuggestion) {
		return { action: "rearm", ghost: lastSuggestion };
	}
	// 4. Default passthrough.
	return { action: "passthrough", ghost: ghost };
}

// ---------------------------------------------------------------------------
// isPrintable (local helper; not exported by pi-tui)
// ---------------------------------------------------------------------------

export function isPrintable(data: string): boolean {
	if (data.length !== 1) return false;
	const c = data.charCodeAt(0);
	return c >= 0x20 && c !== 0x7f;
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
	if (cursorLineIdx === -1) return lines; // unfocused: no marker, do nothing.

	const result = lines.slice();
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
	const contentWidth = Math.max(1, width);
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
// Suggestion state (editor-independent; published via setWidget, accepted via onTerminalInput)
// ---------------------------------------------------------------------------

export interface SuggestionState {
	suggestion: string;
	acceptKey: string;
	isIdleGetter: () => boolean;
	getEditorText: () => string;
	setEditorText: (text: string) => void;
	publishWidget: (content: string[] | undefined) => void;
}

function renderSuggestionWidget(state: SuggestionState): void {
	if (state.suggestion) {
		const hint = humanizeKey(state.acceptKey);
		state.publishWidget([
			`${ACCENT}↳ next:${RESET} ${state.suggestion}  ${ACCENT}${DIM}(${hint} to accept)${RESET}`,
		]);
	} else {
		state.publishWidget(undefined);
	}
}

/** Show a suggestion. Race-guarded: only if the editor is empty and the agent is idle. */
function setSuggestion(state: SuggestionState, text: string): void {
	if (state.getEditorText().length === 0 && state.isIdleGetter()) {
		state.suggestion = text;
		renderSuggestionWidget(state);
	}
}

/** Clear the current suggestion (clears the widget too). */
function clearSuggestion(state: SuggestionState | undefined): void {
	if (!state) return;
	if (state.suggestion) {
		state.suggestion = "";
		state.publishWidget(undefined);
	}
}

/**
 * Raw terminal-input handler for the accept key. Returns { consume: true } to swallow the
 * key before the (default) editor sees it, and fills the editor with the suggestion.
 * Used via ctx.ui.onTerminalInput — editor-independent, survives resetExtensionUI.
 */
function makeAcceptHandler(state: SuggestionState): (data: string) => { consume?: boolean } | undefined {
	return (data: string) => {
		const isAcceptKey =
			matchesKey(data, state.acceptKey as KeyId) ||
			matchesAcceptKeyRaw(data, state.acceptKey);
		if (!isAcceptKey) return undefined;
		if (!state.suggestion) return undefined;
		if (!state.isIdleGetter()) return undefined;
		if (state.getEditorText().length > 0) return undefined;
		// Accept: fill the editor and clear the suggestion. Consume the key.
		state.setEditorText(state.suggestion);
		state.suggestion = "";
		state.publishWidget(undefined);
		return { consume: true };
	};
}

// ---------------------------------------------------------------------------
// Default system prompt
// ---------------------------------------------------------------------------

export const SYSTEM_PROMPT = `You predict the single most logical next instruction the user would type into a coding agent, given the conversation so far. Reply with ONLY that instruction, one line, no quotes, no markdown, no explanation. If there is nothing useful to suggest, reply with the single word: NONE`;

// ---------------------------------------------------------------------------
// Controller / event wiring
// ---------------------------------------------------------------------------

interface NextPromptRef {
	state: SuggestionState | undefined;
	inflight: AbortController | undefined;
	unsubInput: (() => void) | undefined;
}

export default function nextPromptExtension(pi: ExtensionAPI): void {
	const ref: NextPromptRef = { state: undefined, inflight: undefined, unsubInput: undefined };
	let config: NextPromptConfig = {};
	const notifiedFallback = { value: false };

	function reset(): void {
		ref.inflight?.abort();
		ref.inflight = undefined;
		clearSuggestion(ref.state);
	}

	pi.on("session_start", (_e, ctx) => {
		reset();
		// Unsubscribe any previous terminal-input listener (resetExtensionUI clears
		// listeners, but be safe across reloads).
		ref.unsubInput?.();
		ref.unsubInput = undefined;

		config = loadConfig(ctx.cwd);
		const publishWidget = (content: string[] | undefined) => {
			ctx.ui.setWidget("next-prompt", content, { placement: "belowEditor" });
		};
		const state: SuggestionState = {
			suggestion: "",
			acceptKey: config.acceptKey ?? DEFAULT_ACCEPT_KEY,
			isIdleGetter: () => ctx.isIdle(),
			getEditorText: () => ctx.ui.getEditorText(),
			setEditorText: (text) => ctx.ui.setEditorText(text),
			publishWidget,
		};
		ref.state = state;

		// Register a GLOBAL terminal-input listener that swallows the accept key
		// and fills the editor. This is editor-independent — it survives
		// pi's resetExtensionUI() which would otherwise orphan a custom editor.
		ref.unsubInput = ctx.ui.onTerminalInput(makeAcceptHandler(state));
	});

	pi.on("agent_settled", async (_e, ctx) => {
		try {
			if (!ref.state || !ctx.isIdle() || ctx.ui.getEditorText().length > 0)
				return;
			await maybeCompute(ctx);
		} catch (err) {
			console.warn("next-prompt: agent_settled handler failed", err);
		}
	});

	// Clear suggestion + abort in-flight the instant the user submits or the agent starts.
	pi.on("input", () => { reset(); });
	pi.on("turn_start", () => { reset(); });
	pi.on("agent_start", () => { reset(); });

	pi.on("session_shutdown", () => {
		reset();
		ref.unsubInput?.();
		ref.unsubInput = undefined;
		ref.state = undefined;
	});

	async function maybeCompute(ctx: ExtensionContext): Promise<void> {
		ref.inflight?.abort();
		const ac = new AbortController();
		ref.inflight = ac;

		if (
			shouldTrigger(
				ctx.sessionManager.getBranch(),
				ctx.isIdle(),
				ctx.ui.getEditorText(),
			) !== "compute"
		) {
			return;
		}
		const model = resolveSuggestionModel(ctx, config, notifiedFallback);
		if (!model) return;

		const transcript = buildTranscript(ctx.sessionManager.getBranch(), config);
		const messages = buildMessages(transcript);
		const context: Context = {
			systemPrompt: config.systemPrompt ?? SYSTEM_PROMPT,
			messages,
		};

		let resp: AssistantMessage;
		try {
			resp = await ctx.modelRegistry.complete(model, context, {
				signal: ac.signal,
				reasoning: config.thinking,
			});
		} catch (err) {
			if (!ac.signal.aborted) {
				ctx.ui.notify("next-prompt: suggestion failed", "error");
			}
			return;
		}
		if (ac.signal.aborted) return;

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
		const clean = sanitizeSuggestion(raw, config);
		if (clean && ref.state) setSuggestion(ref.state, clean);
	}
}
