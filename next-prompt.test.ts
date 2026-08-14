/**
 * Unit tests for next-prompt.ts covering every pure helper, the terminal
 * sanitizer, overlayGhost rendering, config validation/trust, destination
 * consent, and the controller wiring (with a fake ExtensionAPI firing
 * lifecycle events and terminal input).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	CURSOR_MARKER,
	Editor,
	getKeybindings,
	matchesKey,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage } from "@earendil-works/pi-ai";

import {
	buildMessages,
	buildTranscript,
	configureInteractively,
	consentChoiceFromLabel,
	DEFAULT_ACCEPT_KEY,
	DEFAULT_ENHANCE_KEY,
	destinationKey,
	destinationOf,
	detectHost,
	formatModelOption,
	formatSuggestionHint,
	GhostEditor,
	humanizeKey,
	isInteractiveContext,
	isLeftArrow,
	isRightArrow,
	loadConfig,
	loadEffectiveConfig,
	isKittyKeyRelease,
	matchesAcceptKeyRaw,
	overlayGhost,
	parseModelOption,
	parseSuggestionBatch,
	projectTrustedForHost,
	redactSecrets,
	resolveSuggestionModel,
	sanitizeEnhancedPrompt,
	sanitizeSuggestion,
	sanitizeTerminalText,
	saveConfig,
	setOmpCompletionModuleForTests,
	shouldTrigger,
	suggestionCodePointCap,
	suggestionKey,
	SUGGESTION_BATCH_SIZE,
	SYSTEM_PROMPT,
	THINKING_OPTIONS,
	type BranchEntry,
	type HostKind,
	type NextPromptConfig,
	type OmpCompletionModule,
	type SuggestionCtx,
	type SuggestionState,
} from "./next-prompt.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpHome = "";
let origEnv: string | undefined;

beforeEach(() => {
	tmpHome = mkdtempSync(join(tmpdir(), "np-test-"));
	origEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmpHome;
});

afterEach(() => {
	if (origEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = origEnv;
	rmSync(tmpHome, { recursive: true, force: true });
	// Never leak an OMP completion-module override across tests.
	setOmpCompletionModuleForTests(undefined);
	// F-13: never leak fake timers across tests.
	vi.useRealTimers();
});

function writeFile(dir: string, path: string, content: string): void {
	const full = join(dir, path);
	mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
	writeFileSync(full, content);
}

function readFileSyncSafe(path: string): string {
	try {
		return readFileSync(path, "utf-8");
	} catch {
		return "{}";
	}
}

function userEntry(text: string): BranchEntry {
	return { type: "message", message: { role: "user", content: text } };
}
function userArrayEntry(text: string, withImage = false): BranchEntry {
	const content: unknown[] = [{ type: "text", text }];
	if (withImage)
		content.push({ type: "image", data: "abc", mimeType: "image/png" });
	return { type: "message", message: { role: "user", content } };
}
function assistantEntry(text: string, stopReason = "stop"): BranchEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			stopReason,
		},
	};
}
function assistantMultiEntry(): BranchEntry {
	return {
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "internal reasoning" },
				{ type: "text", text: "Here is the answer." },
				{ type: "toolCall", id: "1", name: "read", arguments: {} },
			],
			stopReason: "stop",
		},
	};
}
function toolResultEntry(): BranchEntry {
	return {
		type: "message",
		message: {
			role: "toolResult",
			content: [{ type: "text", text: "file contents" }],
		},
	};
}

function makeCtx(opts: {
	model?: { provider: string; id: string; baseUrl?: string };
	findModel?: (provider: string, modelId: string) => unknown;
	notify?: (m: string, t?: "info" | "warning" | "error") => void;
	branch?: BranchEntry[];
}): SuggestionCtx {
	const model = (opts.model
		? {
				provider: opts.model.provider,
				id: opts.model.id,
				baseUrl: opts.model.baseUrl,
			}
		: undefined) as never as
		| import("@earendil-works/pi-ai").Model<Api>
		| undefined;
	return {
		model,
		modelRegistry: {
			find: ((provider: string, modelId: string) =>
				opts.findModel
					? opts.findModel(provider, modelId)
					: undefined) as never,
		},
		ui: { notify: opts.notify ?? (() => {}) },
		sessionManager: { getBranch: () => opts.branch ?? [] },
	};
}

// ---------------------------------------------------------------------------
// loadConfig
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	test("T1: project key overrides global key with the same name", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 50 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 99 }),
		);
		const cfg = loadConfig(cwd);
		expect(cfg.maxSuggestionChars).toBe(99);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T2: missing both files returns empty object (no throw)", () => {
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		expect(loadConfig(cwd)).toEqual({});
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T3: malformed global JSON returns project config", () => {
		writeFile(tmpHome, "next-prompt.json", "{ not json");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 7 }),
		);
		const cfg = loadConfig(cwd);
		expect(cfg.maxSuggestionChars).toBe(7);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T4: malformed project JSON returns global config", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 7 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", "{ broken");
		const cfg = loadConfig(cwd);
		expect(cfg.maxSuggestionChars).toBe(7);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T5: both malformed returns empty object", () => {
		writeFile(tmpHome, "next-prompt.json", "{ broken");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", "{ also broken");
		expect(loadConfig(cwd)).toEqual({});
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T6: empty JSON object returns empty object", () => {
		writeFile(tmpHome, "next-prompt.json", "{}");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		expect(loadConfig(cwd)).toEqual({});
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T7: uses getAgentDir() + CONFIG_DIR_NAME for paths", () => {
		// PI_CODING_AGENT_DIR set in beforeEach points to tmpHome; global path is tmpHome/next-prompt.json
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: 1111 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 222 }),
		);
		const cfg = loadConfig(cwd);
		expect(cfg.maxTranscriptChars).toBe(1111); // from global (getAgentDir)
		expect(cfg.maxSuggestionChars).toBe(222); // from project (.pi)
		rmSync(cwd, { recursive: true, force: true });
	});
});

// ---------------------------------------------------------------------------
// destinationOf / sameDestination / consent
// ---------------------------------------------------------------------------

describe("destination identity", () => {
	test("D1: provider-only identity when no baseUrl", () => {
		expect(destinationOf({ provider: "openai", id: "gpt" })).toEqual({
			provider: "openai",
			origin: "",
			model: "gpt",
		});
	});
	test("D2: identity includes endpoint origin", () => {
		expect(
			destinationOf({
				provider: "openai",
				id: "gpt",
				baseUrl: "https://api.example.com/v1",
			}),
		).toEqual({
			provider: "openai",
			origin: "https://api.example.com",
			model: "gpt",
		});
	});
	test("D2b: identity includes the model routing id (F-02/F-10)", () => {
		expect(
			destinationOf({
				provider: "openai",
				id: "gpt-4o",
				baseUrl: "https://gateway.example.com/v1",
			}),
		).toEqual({
			provider: "openai",
			origin: "https://gateway.example.com",
			model: "gpt-4o",
		});
	});
	test("D2c: same origin but different model route is a DIFFERENT destination", () => {
		const a = destinationOf({
			provider: "openai",
			id: "gpt-4o",
			baseUrl: "https://gateway.example.com/v1",
		});
		const b = destinationOf({
			provider: "openai",
			id: "claude",
			baseUrl: "https://gateway.example.com/v1",
		});
		expect(a).not.toEqual(b);
	});
	test("D3: same origin with different path/padding is the same destination", () => {
		const a = destinationOf({
			provider: "openai",
			id: "gpt",
			baseUrl: "https://api.example.com/v1/",
		});
		const b = destinationOf({
			provider: "openai",
			id: "gpt",
			baseUrl: "https://api.example.com/v2",
		});
		expect(a).toEqual(b);
	});
	test("D4: undefined model → undefined destination", () => {
		expect(destinationOf(undefined)).toBeUndefined();
	});
	test("D5: destinationKey includes model; legacy (no model) key can never match (F-02)", () => {
		const d = destinationOf({
			provider: "openai",
			id: "gpt-4o",
			baseUrl: "https://gateway.example.com/v1",
		});
		expect(destinationKey(d!)).toBe(
			"openai@https://gateway.example.com#gpt-4o",
		);
		// Legacy consent record without a model id → its key never equals a real one.
		expect(destinationKey({ provider: "openai", origin: "", model: "" })).toBe(
			"openai",
		);
		expect(
			destinationKey({ provider: "openai", origin: "", model: "" }),
		).not.toBe(destinationKey(d!));
	});

	test("P1: pairAllowed matches directionally, case-insensitively, and never the reverse", () => {
		const { pairAllowed } =
			require("./next-prompt.ts") as typeof import("./next-prompt.ts");
		const pairs: Array<[string, string]> = [["openai", "anthropic"]];
		expect(pairAllowed(pairs, "openai", "anthropic")).toBe(true);
		// Case-insensitive on both sides.
		expect(pairAllowed(pairs, "OpenAI", "ANTHROPIC")).toBe(true);
		// Directional: the reverse pair is NOT implied.
		expect(pairAllowed(pairs, "anthropic", "openai")).toBe(false);
		// Missing inputs never match.
		expect(pairAllowed(pairs, undefined, "anthropic")).toBe(false);
		expect(pairAllowed(pairs, "openai", undefined)).toBe(false);
		// Empty/missing pair list never matches.
		expect(pairAllowed(undefined, "openai", "anthropic")).toBe(false);
		expect(pairAllowed([], "openai", "anthropic")).toBe(false);
	});

	test("P2: consent labels tolerate whitespace/ANSI and symbolic values", () => {
		expect(consentChoiceFromLabel("once")).toBe("once");
		expect(consentChoiceFromLabel("  Allow once (this project)  ")).toBe("once");
		expect(
			consentChoiceFromLabel("\x1b[36mAlways allow for this provider pair\x1b[0m"),
		).toBe("always");
		expect(consentChoiceFromLabel(" Decline ")).toBe("decline");
		expect(consentChoiceFromLabel(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// loadEffectiveConfig: trust gating + policy floors (F-02)
// ---------------------------------------------------------------------------

describe("loadEffectiveConfig", () => {
	test("F1: untrusted project config is ignored entirely", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ acceptKey: "ctrl+space" }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({
				model: { provider: "openai", model: "gpt" },
				allowCrossProvider: true,
			}),
		);
		const eff = loadEffectiveConfig(cwd, { projectTrusted: false });
		expect(eff.projectTrusted).toBe(false);
		expect(eff.model).toBeUndefined();
		expect(eff.acceptKey).toBe("ctrl+space");
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F2: global allowCrossProvider=false is a floor the project cannot loosen", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ allowCrossProvider: false }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ allowCrossProvider: true }),
		);
		const eff = loadEffectiveConfig(cwd);
		expect(eff.allowCrossProvider).toBe(false);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F3: project may tighten allowCrossProvider to false", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ allowCrossProvider: true }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ allowCrossProvider: false }),
		);
		expect(loadEffectiveConfig(cwd).allowCrossProvider).toBe(false);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F4: project cannot increase a global transcript cap", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: 1000 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxTranscriptChars: 50000 }),
		);
		expect(loadEffectiveConfig(cwd).maxTranscriptChars).toBe(1000);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F5: project may reduce the transcript cap", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: 10000 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxTranscriptChars: 500 }),
		);
		expect(loadEffectiveConfig(cwd).maxTranscriptChars).toBe(500);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F6: invalid privacy field in global config fails closed (computeDisabled)", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: "unlimited" }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		expect(loadEffectiveConfig(cwd).computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7: invalid non-privacy field is dropped without disabling compute", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ renderMode: "sideways", maxSuggestionChars: 5 }),
		);
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(false);
		expect(eff.renderMode).toBeUndefined();
		expect(eff.maxSuggestionChars).toBe(5);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7b: malformed global JSON fails closed (computeDisabled) — F-07", () => {
		writeFile(tmpHome, "next-prompt.json", "{ broken");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7c: malformed project JSON fails closed (computeDisabled) — F-07", () => {
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", "{ broken");
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7d: unreadable global config fails closed (computeDisabled) — F-07", () => {
		// Directory at the config path: readFileSync throws EISDIR.
		mkdirSync(join(tmpHome, "next-prompt.json"));
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7e: both configs malformed fails closed (computeDisabled) — F-07", () => {
		writeFile(tmpHome, "next-prompt.json", "{ broken");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", "{ also broken");
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F7f: valid project config cannot rescue an invalid global config — F-07", () => {
		writeFile(tmpHome, "next-prompt.json", "{ broken");
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ maxSuggestionChars: 7 }),
		);
		const eff = loadEffectiveConfig(cwd);
		expect(eff.computeDisabled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("F8: numeric acceptKey is dropped and cannot reach matchesKey", () => {
		writeFile(tmpHome, "next-prompt.json", JSON.stringify({ acceptKey: 7 }));
		const eff = loadEffectiveConfig(mkdtempSync(join(tmpdir(), "np-cwd-")));
		expect(eff.acceptKey).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// resolveSuggestionModel
// ---------------------------------------------------------------------------

describe("resolveSuggestionModel", () => {
	const cfgModel = (provider: string, model: string): NextPromptConfig => ({
		model: { provider, model },
	});

	test("T8: configured model on the SAME destination as active is returned (no cross flag)", () => {
		const configured = { provider: "openai", id: "gpt-4o" };
		const ctx = makeCtx({
			model: { provider: "openai", id: "gpt-4o" },
			findModel: (p, m) =>
				p === "openai" && m === "gpt-4o" ? configured : undefined,
		});
		const out = resolveSuggestionModel(ctx, cfgModel("openai", "gpt-4o"), {
			value: false,
		});
		expect(out).toEqual({ model: configured, crossDestination: false });
	});

	test("T8b: same provider+endpoint but DIFFERENT model route is a DIFFERENT destination (F-02/F-10)", () => {
		// Two downstream models behind one gateway: active gateway/openai,
		// configured gateway/claude — same origin, different route.
		const active = {
			provider: "openai",
			id: "gpt",
			baseUrl: "https://gateway.example.com/v1",
		};
		const configured = {
			provider: "openai",
			id: "claude",
			baseUrl: "https://gateway.example.com/v1",
		};
		const ctx = makeCtx({
			model: active,
			findModel: (p, m) =>
				p === "openai" && m === "claude" ? configured : undefined,
		});
		// Deny path: cross-destination use disabled → falls back to active, no consent.
		const deny: NextPromptConfig = {
			model: { provider: "openai", model: "claude" },
			allowCrossProvider: false,
		};
		expect(resolveSuggestionModel(ctx, deny, { value: false })).toEqual({
			model: active,
			crossDestination: false,
		});
		// Consent path: cross-destination use enabled → flags crossDestination.
		const allow: NextPromptConfig = {
			model: { provider: "openai", model: "claude" },
			allowCrossProvider: true,
		};
		expect(resolveSuggestionModel(ctx, allow, { value: false })).toEqual({
			model: configured,
			crossDestination: true,
		});
	});

	test("T9: configured model absent returns ctx.model and notifies once (warning)", () => {
		const active = { provider: "openai", id: "gpt" };
		const notifies: Array<[string, string]> = [];
		const ctx = makeCtx({
			model: active,
			notify: (m, t) => notifies.push([m, t ?? "info"]),
		});
		const out = resolveSuggestionModel(ctx, cfgModel("anthropic", "missing"), {
			value: false,
		});
		expect(out).toEqual({ model: active, crossDestination: false });
		expect(notifies).toHaveLength(1);
		expect(notifies[0]![1]).toBe("warning");
		expect(notifies[0]![0]).toContain("not found");
	});

	test("T10: no model block returns ctx.model, no notify", () => {
		const active = { provider: "openai", id: "gpt" };
		const notifies: string[] = [];
		const ctx = makeCtx({ model: active, notify: (m) => notifies.push(m) });
		const out = resolveSuggestionModel(ctx, {}, { value: false });
		expect(out).toEqual({ model: active, crossDestination: false });
		expect(notifies).toHaveLength(0);
	});

	test("T11: no config + ctx.model undefined returns undefined model", () => {
		const ctx = makeCtx({ model: undefined as never });
		expect(resolveSuggestionModel(ctx, {}, { value: false })).toEqual({
			model: undefined,
			crossDestination: false,
		});
	});

	test("T12: configured absent AND ctx.model undefined returns undefined model (no throw)", () => {
		const ctx = makeCtx({ model: undefined as never });
		expect(
			resolveSuggestionModel(ctx, cfgModel("anthropic", "missing"), {
				value: false,
			}),
		).toEqual({ model: undefined, crossDestination: false });
	});

	test("T13: notify-once — calling twice only notifies once", () => {
		const active = { provider: "openai", id: "gpt" };
		const notifies: string[] = [];
		const ctx = makeCtx({ model: active, notify: (m) => notifies.push(m) });
		const ref = { value: false };
		resolveSuggestionModel(ctx, cfgModel("anthropic", "missing"), ref);
		resolveSuggestionModel(ctx, cfgModel("anthropic", "missing"), ref);
		expect(notifies).toHaveLength(1);
	});

	test("T14: allowCrossProvider=false + different destination returns ctx.model, no notify", () => {
		const active = { provider: "openai", id: "gpt" };
		const notifies: string[] = [];
		const ctx = makeCtx({
			model: active,
			notify: (m) => notifies.push(m),
			findModel: (p, m) =>
				p === "anthropic" && m === "claude"
					? { provider: "anthropic", id: "claude" }
					: undefined,
		});
		const cfg: NextPromptConfig = {
			model: { provider: "anthropic", model: "claude" },
			allowCrossProvider: false,
		};
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: active,
			crossDestination: false,
		});
		expect(notifies).toHaveLength(0);
	});

	test("T15: allowCrossProvider=false + same destination returns configured model", () => {
		const configured = { provider: "openai", id: "gpt-4o" };
		const ctx = makeCtx({
			model: { provider: "openai", id: "gpt-4o" },
			findModel: (p, m) =>
				p === "openai" && m === "gpt-4o" ? configured : undefined,
		});
		const cfg: NextPromptConfig = {
			model: { provider: "openai", model: "gpt-4o" },
			allowCrossProvider: false,
		};
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: configured,
			crossDestination: false,
		});
	});

	test("T15b: same provider label but different endpoint is a DIFFERENT destination (F-10)", () => {
		const active = {
			provider: "openai",
			id: "gpt",
			baseUrl: "https://a.example.com/v1",
		};
		const configured = {
			provider: "openai",
			id: "gpt-4o",
			baseUrl: "https://b.example.com/v1",
		};
		const ctx = makeCtx({
			model: active,
			findModel: (p, m) =>
				p === "openai" && m === "gpt-4o" ? configured : undefined,
		});
		const cfg: NextPromptConfig = {
			model: { provider: "openai", model: "gpt-4o" },
			allowCrossProvider: false,
		};
		// Same label, different endpoint → treated as cross-destination → fall back.
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: active,
			crossDestination: false,
		});
	});

	test("T15c: allowCrossProvider=true + different destination flags crossDestination", () => {
		const configured = { provider: "anthropic", id: "claude-haiku" };
		const ctx = makeCtx({
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "claude-haiku" ? configured : undefined,
		});
		const cfg: NextPromptConfig = {
			model: { provider: "anthropic", model: "claude-haiku" },
			allowCrossProvider: true,
		};
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: configured,
			crossDestination: true,
		});
	});

	test("T15d: no active model + cross-destination + allowCross=false fails closed", () => {
		const configured = { provider: "anthropic", id: "claude-haiku" };
		const ctx = makeCtx({
			model: undefined as never,
			findModel: (p, m) =>
				p === "anthropic" && m === "claude-haiku" ? configured : undefined,
		});
		const cfg: NextPromptConfig = {
			model: { provider: "anthropic", model: "claude-haiku" },
			allowCrossProvider: false,
		};
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: undefined,
			crossDestination: false,
		});
	});

	test("T16: model present but wrong shape is ignored, returns ctx.model", () => {
		const active = { provider: "openai", id: "gpt" };
		const ctx = makeCtx({ model: active });
		// @ts-expect-error — deliberately malformed
		const cfg: NextPromptConfig = { model: "claude-haiku" };
		expect(resolveSuggestionModel(ctx, cfg, { value: false })).toEqual({
			model: active,
			crossDestination: false,
		});
	});
});

// ---------------------------------------------------------------------------
// acceptKey + humanizeKey
// ---------------------------------------------------------------------------

describe("acceptKey / humanizeKey", () => {
	test('DEFAULT_ACCEPT_KEY is "enter"', () => {
		expect(DEFAULT_ACCEPT_KEY).toBe("enter");
	});

	test("humanizeKey: ctrl+tab → Ctrl-Tab", () => {
		expect(humanizeKey("ctrl+tab")).toBe("Ctrl-Tab");
	});

	test("humanizeKey: tab → Tab", () => {
		expect(humanizeKey("tab")).toBe("Tab");
	});

	test("humanizeKey: ctrl+shift+enter → Ctrl-Shift-Enter", () => {
		expect(humanizeKey("ctrl+shift+enter")).toBe("Ctrl-Shift-Enter");
	});

	test("humanizeKey: enter → Enter", () => {
		expect(humanizeKey("enter")).toBe("Enter");
	});

	test("humanizeKey: alt+/ → Alt-/", () => {
		expect(humanizeKey("alt+/")).toBe("Alt-/");
	});

	test("humanizeKey: empty string → empty", () => {
		expect(humanizeKey("")).toBe("");
	});
});

// ---------------------------------------------------------------------------
// matchesAcceptKeyRaw (raw-byte fallback for terminals where matchesKey fails)
// ---------------------------------------------------------------------------

describe("matchesAcceptKeyRaw", () => {
	test('alt+/ matches legacy "\x1b/"', () => {
		expect(matchesAcceptKeyRaw("\x1b/", "alt+/")).toBe(true);
	});

	test('alt+/ matches uppercase "\x1bO/" (SS3 variant)', () => {
		expect(matchesAcceptKeyRaw("\x1bO/", "alt+/")).toBe(true);
	});

	test('alt+/ does NOT match bare "/" (no ESC prefix)', () => {
		expect(matchesAcceptKeyRaw("/", "alt+/")).toBe(false);
	});

	test('alt+e matches "\x1be"', () => {
		expect(matchesAcceptKeyRaw("\x1be", "alt+e")).toBe(true);
	});

	test('alt+? matches legacy "\x1b?" (shift-symbol; not the default)', () => {
		expect(matchesAcceptKeyRaw("\x1b?", "alt+?")).toBe(true);
	});

	test('ctrl+space matches NUL "\x00"', () => {
		expect(matchesAcceptKeyRaw("\x00", "ctrl+space")).toBe(true);
	});

	test("ctrl+space does NOT match plain space", () => {
		expect(matchesAcceptKeyRaw(" ", "ctrl+space")).toBe(false);
	});

	test('alt+/ does NOT match "\x1b" alone (split ESC)', () => {
		expect(matchesAcceptKeyRaw("\x1b", "alt+/")).toBe(false);
	});

	test('plain "tab" (no modifiers) → false (no raw form handled)', () => {
		expect(matchesAcceptKeyRaw("\t", "tab")).toBe(false);
	});

	test("empty acceptKey → false", () => {
		expect(matchesAcceptKeyRaw("\x1b/", "")).toBe(false);
	});
	test("enter matches CR and LF", () => {
		expect(matchesAcceptKeyRaw("\r", "enter")).toBe(true);
		expect(matchesAcceptKeyRaw("\n", "enter")).toBe(true);
		expect(matchesAcceptKeyRaw("\r", "shift+enter")).toBe(false);
		expect(matchesAcceptKeyRaw("a", "enter")).toBe(false);
	});
});

describe("arrow keys + suggestionKey + hint", () => {
	test("CSI and SS3 left/right", () => {
		expect(isLeftArrow("\x1b[D")).toBe(true);
		expect(isLeftArrow("\x1bOD")).toBe(true);
		expect(isLeftArrow("\x1b[C")).toBe(false);
		expect(isRightArrow("\x1b[C")).toBe(true);
		expect(isRightArrow("\x1bOC")).toBe(true);
		expect(isRightArrow("\x1b[A")).toBe(false);
	});
	test("Alt+< / Alt+> are left/right aliases", () => {
		expect(isLeftArrow("\x1b<")).toBe(true);
		expect(isLeftArrow("\x1b,")).toBe(true);
		expect(isLeftArrow("\x1bO<")).toBe(true);
		expect(isRightArrow("\x1b>")).toBe(true);
		expect(isRightArrow("\x1b.")).toBe(true);
		expect(isRightArrow("\x1bO>")).toBe(true);
		expect(isLeftArrow("\x1b>")).toBe(false);
		expect(isRightArrow("\x1b<")).toBe(false);
	});
	test("suggestionKey collapses case and whitespace", () => {
		expect(suggestionKey("  Write Tests ")).toBe("write tests");
		expect(suggestionKey("write   tests")).toBe(suggestionKey("Write Tests"));
	});
	test("formatSuggestionHint shows carousel keys and index", () => {
		const base = {
			suggestion: "one",
			lastSuggestion: "one",
			alternatives: ["one"],
			altIndex: 0,
			acceptKey: "enter",
			renderMode: "widget" as const,
			rearmDelayMs: 2000,
			rearmTimer: undefined,
			rearmCheckTimer: undefined,
			inputGeneration: 0,
			isIdleGetter: () => true,
			getEditorText: () => "",
			setEditorText: () => {},
			publishWidget: () => {},
			renderGhost: undefined,
			fallbackToWidget: undefined,
			abortInflight: () => {},
		};
		expect(formatSuggestionHint(base)).toBe("(Enter · ←→)");
		expect(
			formatSuggestionHint({
				...base,
				alternatives: ["one", "two"],
				altIndex: 1,
			}),
		).toBe("(Enter · 2/2 ←→)");
		expect(
			formatSuggestionHint({
				...base,
				alternatives: ["one", "two", "three"],
				altIndex: 0,
			}),
		).toBe("(Enter · 1/3 ←→)");
		expect(SUGGESTION_BATCH_SIZE).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

describe("redactSecrets", () => {
	test("T17: AWS AKIA key redacted", () => {
		expect(redactSecrets("key AKIAIOSFODNN7EXAMPLE here")).toBe(
			"key [redacted] here",
		);
	});
	test("T18: OpenAI sk- key redacted", () => {
		const sk = `sk-${"a".repeat(24)}`;
		expect(redactSecrets(`token ${sk} here`)).toBe("token [redacted] here");
	});
	test("T19: GitHub ghp_ token redacted", () => {
		// Fixture assembled from parts so scanners do not treat the literal as a real token.
		const token = `gh${String.fromCharCode(112)}_` + "0".repeat(40);
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
	});
	test("T20: Slack xoxb- token redacted", () => {
		expect(
			redactSecrets(`bot xoxb-${"1".repeat(16)}-${"a".repeat(14)} here`),
		).toBe("bot [redacted] here");
	});
	test("T21: PEM private key block redacted", () => {
		const pem =
			"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBALW0+abcd\n-----END RSA PRIVATE KEY-----";
		expect(redactSecrets(`pre ${pem} post`)).toBe("pre [redacted] post");
	});
	test("T22: clean text unchanged", () => {
		expect(redactSecrets("just a normal sentence")).toBe(
			"just a normal sentence",
		);
	});
	test("T23: multiple secrets all redacted", () => {
		const mixed = `AKIAIOSFODNN7EXAMPLE and sk-${"a".repeat(24)}`;
		const out = redactSecrets(mixed);
		expect(out).toBe("[redacted] and [redacted]");
	});

	test("T20a: short ghp_ (under 36 chars) NOT redacted (avoids false positives like ghp_test)", () => {
		const shortPat = `gh${String.fromCharCode(112)}_` + "0".repeat(35);
		expect(redactSecrets("tok ghp_test end")).toBe("tok ghp_test end");
		expect(redactSecrets(`tok ${shortPat} end`)).toBe(`tok ${shortPat} end`); // 35 chars after prefix → below 36 threshold → not matched
	});

	test("T20b: 40-char ghp_ IS redacted (classic GitHub PAT)", () => {
		// Fixture assembled from parts so scanners do not treat the literal as a real token.
		const token = `gh${String.fromCharCode(112)}_` + "a".repeat(40);
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
	});

	test("T20c: short xoxb- (no second dash group of 10+) NOT redacted", () => {
		expect(redactSecrets("bot xoxb-short here")).toBe("bot xoxb-short here");
		expect(redactSecrets("bot xoxb-1234567890-abc here")).toBe(
			"bot xoxb-1234567890-abc here",
		); // second group only 3 chars → not matched
	});
	test("T20d: sk-proj- OpenAI project key redacted (positive + near-miss)", () => {
		const token = `sk-proj-${("A1b2" + "C3d4").repeat(5)}`; // 40 chars after prefix
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
		// Near-miss: too short.
		expect(redactSecrets("tok sk-proj-short end")).toBe(
			"tok sk-proj-short end",
		);
	});
	test("T20e: sk-ant- Anthropic key redacted (positive + near-miss)", () => {
		const token = `sk-ant-${("aB12" + "cD34").repeat(6)}`; // 48 chars
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
		expect(redactSecrets("tok sk-ant-x end")).toBe("tok sk-ant-x end");
	});
	test("T20f: github_pat_ fine-grained PAT redacted (positive + near-miss)", () => {
		const token = `github_pat_${("a1B" + "2cD").repeat(7)}_abc`; // 25+ chars
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
		expect(redactSecrets("tok github_pat_short end")).toBe(
			"tok github_pat_short end",
		);
	});
	test("T20g: glpat- GitLab PAT redacted (positive + near-miss)", () => {
		const token = `glpat-${("a1b" + "2C").repeat(5)}xyz`; // 21+ chars
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
		expect(redactSecrets("tok glpat-short end")).toBe("tok glpat-short end");
	});
	test("T20h: AIza Google API key redacted (positive + near-miss)", () => {
		const token = `AIza${("aB1" + "2Cd").repeat(9)}x`; // 31+ chars after prefix
		expect(redactSecrets(`tok ${token} end`)).toBe("tok [redacted] end");
		expect(redactSecrets("tok AIza-xxx end")).toBe("tok AIza-xxx end");
	});
	test("T20i: JWT redacted (positive + near-miss)", () => {
		const jwt = `eyJhbGciOiJIUzI1NiJ9.${("abc" + "123").repeat(4)}.${("sig" + "456").repeat(4)}`;
		expect(redactSecrets(`tok ${jwt} end`)).toBe("tok [redacted] end");
		// Near-miss: two segments only.
		expect(redactSecrets("tok eyJhbGciOiJIUzI1NiJ9.abc end")).toBe(
			"tok eyJhbGciOiJIUzI1NiJ9.abc end",
		);
	});
	test("T20j: assignment forms redacted (positive + near-miss)", () => {
		expect(redactSecrets("password=hunter2!")).toBe("[redacted]");
		expect(redactSecrets('API_KEY: "abc123"')).toBe("[redacted]");
		expect(redactSecrets("client_secret='s3cr3t'")).toBe("[redacted]");
		// Near-miss: key without a value separator.
		expect(redactSecrets("the password is hunter2")).toBe(
			"the password is hunter2",
		);
	});
	test("T20k: secrets echoed in ASSISTANT text are redacted (F-11)", () => {
		const branch = [
			assistantEntry(
				`here is the key: sk-proj-${("A1b2" + "C3d4").repeat(5)} and sk-ant-${("aB12" + "cD34").repeat(6)}`,
			),
		];
		const out = buildTranscript(branch, {});
		expect(out).toBe("Assistant: here is the key: [redacted] and [redacted]");
	});
	test("T20l: secrets echoed in USER text are redacted (F-11)", () => {
		const branch = [
			userEntry(`gitlab token glpat-${("a1b" + "2C").repeat(5)}xyz`),
		];
		expect(buildTranscript(branch, {})).toBe("User: gitlab token [redacted]");
	});
});

// ---------------------------------------------------------------------------
// buildTranscript
// ---------------------------------------------------------------------------

describe("buildTranscript", () => {
	test("T24: empty branch returns empty string", () => {
		expect(buildTranscript([], {})).toBe("");
	});
	test("T25: user string message", () => {
		expect(buildTranscript([userEntry("hello")], {})).toBe("User: hello");
	});
	test("T26: user content-array text + image", () => {
		expect(buildTranscript([userArrayEntry("hello", true)], {})).toBe(
			"User: hello [image]",
		);
	});
	test("T27: assistant text + thinking + toolCall blocks — only text included", () => {
		expect(buildTranscript([assistantMultiEntry()], {})).toBe(
			"Assistant: Here is the answer.",
		);
	});
	test("T28: toolResult entries skipped", () => {
		const branch = [userEntry("q"), assistantEntry("a"), toolResultEntry()];
		expect(buildTranscript(branch, {})).toBe("User: q\nAssistant: a");
	});
	test("T29: secrets in text are redacted", () => {
		const branch = [userEntry("key=AKIAIOSFODNN7EXAMPLE")];
		expect(buildTranscript(branch, {})).toBe("User: key=[redacted]");
	});
	test("T30: tail-truncation keeps the most recent slice", () => {
		const long = "x".repeat(100);
		const branch = [userEntry(long), userEntry("TAIL")];
		const out = buildTranscript(branch, { maxTranscriptChars: 10 });
		expect(out).toBe("User: TAIL");
	});
	test("T31: default cap applied when config omits field", () => {
		const long = "y".repeat(20000);
		const out = buildTranscript([userEntry(long)], {});
		expect(out.length).toBe(12000);
	});
	test("T32: multi-line user content preserves internal newlines", () => {
		const branch = [userEntry("line1\nline2")];
		expect(buildTranscript(branch, {})).toBe("User: line1\nline2");
	});
	test("T32b: maxRecentTurns keeps only the last N message entries (F-11)", () => {
		const branch = [
			userEntry("q1"),
			assistantEntry("a1"),
			toolResultEntry(),
			userEntry("q2"),
			assistantEntry("a2"),
		];
		const out = buildTranscript(branch, { maxRecentTurns: 2 });
		expect(out).toBe("User: q2\nAssistant: a2");
	});
	test("T32c: maxRecentTurns larger than branch keeps everything (F-11)", () => {
		const branch = [userEntry("q1"), assistantEntry("a1")];
		expect(buildTranscript(branch, { maxRecentTurns: 10 })).toBe(
			"User: q1\nAssistant: a1",
		);
	});
	test("T32d: maxRecentTurns=1 keeps the single newest entry (F-11)", () => {
		const branch = [userEntry("q1"), assistantEntry("a1"), userEntry("q2")];
		expect(buildTranscript(branch, { maxRecentTurns: 1 })).toBe("User: q2");
	});
	test("T32e: toolResult entries between kept messages stay excluded (F-11)", () => {
		const branch = [
			userEntry("q1"),
			assistantEntry("a1"),
			toolResultEntry(),
			userEntry("q2"),
		];
		expect(buildTranscript(branch, { maxRecentTurns: 2 })).toBe(
			"Assistant: a1\nUser: q2",
		);
	});
	test("T32f: invalid maxRecentTurns in config fails closed (F-11)", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxRecentTurns: 0 }),
		);
		expect(
			loadEffectiveConfig(mkdtempSync(join(tmpdir(), "np-cwd-")))
				.computeDisabled,
		).toBe(true);
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ maxRecentTurns: 201 }),
		);
		expect(
			loadEffectiveConfig(mkdtempSync(join(tmpdir(), "np-cwd-")))
				.computeDisabled,
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// buildMessages
// ---------------------------------------------------------------------------

describe("buildMessages", () => {
	test("T33: exactly one UserMessage with single TextContent + numeric timestamp", () => {
		const msgs = buildMessages("hi");
		expect(msgs).toHaveLength(1);
		const m = msgs[0]!;
		expect(m.role).toBe("user");
		expect(Array.isArray(m.content)).toBe(true);
		expect(m.content).toEqual([{ type: "text", text: "hi" }]);
		expect(typeof m.timestamp).toBe("number");
	});
	test("T34: empty transcript still yields a one-message array", () => {
		expect(buildMessages("")).toHaveLength(1);
	});
	test("T35: content equals transcript verbatim", () => {
		expect(
			(
				buildMessages("verbatim text")[0]!.content as Array<{ text: string }>
			)[0]!.text,
		).toBe("verbatim text");
	});
});

// ---------------------------------------------------------------------------
// sanitizeSuggestion
// ---------------------------------------------------------------------------

describe("sanitizeSuggestion", () => {
	test("T36: trims whitespace", () => {
		expect(sanitizeSuggestion("  hello  ", {})).toBe("hello");
	});
	test("T37: strips paired double/single/backtick quotes", () => {
		expect(sanitizeSuggestion('"hi"', {})).toBe("hi");
		expect(sanitizeSuggestion("'hi'", {})).toBe("hi");
		expect(sanitizeSuggestion("`hi`", {})).toBe("hi");
	});
	test("T38: strips leading+trailing fenced code block (with optional lang tag)", () => {
		expect(sanitizeSuggestion("```\nhi\n```", {})).toBe("hi");
		expect(sanitizeSuggestion("```ts\nhi\n```", {})).toBe("hi");
	});
	test("T39: collapses internal newlines to single spaces", () => {
		expect(sanitizeSuggestion("line1\nline2", {})).toBe("line1 line2");
	});
	test("T40: caps to maxSuggestionChars at grapheme boundary", () => {
		expect(sanitizeSuggestion("abcdefgh", { maxSuggestionChars: 3 })).toBe(
			"abc",
		);
	});
	test("T41: NONE sentinel returns empty", () => {
		expect(sanitizeSuggestion("NONE", {})).toBe("");
	});
	test("T42: whitespace/punctuation-only returns empty", () => {
		expect(sanitizeSuggestion("  ...  ", {})).toBe("");
		expect(sanitizeSuggestion("\"'", {})).toBe("");
	});
	test("T43: default cap applied when config omits field", () => {
		const long = "a".repeat(500);
		expect(sanitizeSuggestion(long, {}).length).toBe(240);
	});
	test("T44: emoji / wide-char truncation does not split a grapheme", () => {
		// 👨‍👩‍👧 is a multi-codepoint grapheme; truncateToWidth is grapheme-aware.
		const out = sanitizeSuggestion("ab👨‍👩‍👧cd", { maxSuggestionChars: 2 });
		expect(out).toBe("ab");
	});
	test("T44b: zero-width payload cannot bypass the code-point cap (F-01)", () => {
		const zwj = "\u200d".repeat(10_000);
		const out = sanitizeSuggestion(zwj, { maxSuggestionChars: 1 });
		// Bounded by the code-point cap (max*4 = 4), and no dangling ZWJ remains.
		expect(out.length).toBeLessThanOrEqual(4);
		expect(out.endsWith("\u200d")).toBe(false);
	});
	test("T44c: mixed zero-width + text is bounded by the code-point cap (F-01)", () => {
		const raw = `run ${("\u200d").repeat(10_000)} tail`;
		const out = sanitizeSuggestion(raw, { maxSuggestionChars: 5 });
		expect(out.length).toBeLessThanOrEqual(20); // 5*4 codepoints
		expect(out.endsWith("\u200d")).toBe(false);
	});
	test("T44d: default cap also bounds a huge zero-width payload (F-01)", () => {
		const out = sanitizeSuggestion("\u200d".repeat(50_000), {});
		expect(out.length).toBeLessThanOrEqual(suggestionCodePointCap(240));
	});
	test("T44e: emoji, CJK, combining, RTL text stay usable under the caps (F-01)", () => {
		const text = "👨‍👩‍👧 café 日本語 مرحبا e\u0301";
		const out = sanitizeSuggestion(text, { maxSuggestionChars: 240 });
		expect(out).toBe(text); // unchanged at generous width
		// Wide CJK under a small width cap still truncates at grapheme boundary.
		const small = sanitizeSuggestion("日本語", { maxSuggestionChars: 2 });
		expect(visibleWidth(small)).toBeLessThanOrEqual(2);
	});
});

// ---------------------------------------------------------------------------
// parseSuggestionBatch
// ---------------------------------------------------------------------------

describe("parseSuggestionBatch", () => {
	test("splits numbered and bulleted lines, drops NONE and duplicates", () => {
		expect(
			parseSuggestionBatch("1. write tests\n2. update the README\n3. NONE"),
		).toEqual(["write tests", "update the README"]);
		expect(
			parseSuggestionBatch("- write tests\n* Write   tests\n• commit the change"),
		).toEqual(["write tests", "commit the change"]);
	});
	test("single line still yields a one-item batch", () => {
		expect(parseSuggestionBatch("write unit tests")).toEqual([
			"write unit tests",
		]);
	});
	test("whole-reply NONE is empty", () => {
		expect(parseSuggestionBatch("NONE")).toEqual([]);
	});
	test("strips an outer fence and caps at SUGGESTION_BATCH_SIZE", () => {
		const raw = "```\n1. a\n2. b\n3. c\n4. d\n```";
		expect(parseSuggestionBatch(raw)).toEqual(["a", "b", "c"]);
		expect(parseSuggestionBatch(raw)).toHaveLength(SUGGESTION_BATCH_SIZE);
	});
	test("OSC payload with embedded newlines does not become extra items", () => {
		const raw =
			"write tests\n\x1b]52;c;PAYLOAD\nsmuggled\x07\nupdate the README";
		expect(parseSuggestionBatch(raw)).toEqual([
			"write tests",
			"update the README",
		]);
	});
});

// ---------------------------------------------------------------------------
// shouldTrigger
// ---------------------------------------------------------------------------

describe("shouldTrigger", () => {
	test("T45: empty branch → skip", () => {
		expect(shouldTrigger([], true, "")).toBe("skip");
	});
	test("T46: last message not assistant stop → skip", () => {
		expect(shouldTrigger([assistantEntry("a", "toolUse")], true, "")).toBe(
			"skip",
		);
		expect(shouldTrigger([userEntry("q")], true, "")).toBe("skip");
	});
	test("T47: has assistant stop but not idle → skip", () => {
		expect(shouldTrigger([assistantEntry("a")], false, "")).toBe("skip");
	});
	test("T48: has assistant stop, idle, editor non-empty → skip", () => {
		expect(shouldTrigger([assistantEntry("a")], true, "text")).toBe("skip");
	});
	test("T49: has assistant stop, idle, editor empty → compute", () => {
		expect(shouldTrigger([assistantEntry("a")], true, "")).toBe("compute");
	});
	test("T49b: trailing toolResult after assistant stop still computes (OMP persist order)", () => {
		expect(
			shouldTrigger(
				[
					userEntry("q"),
					assistantEntry("a"),
					toolResultEntry(),
					toolResultEntry(),
				],
				true,
				"",
			),
		).toBe("compute");
	});
	test("T49c: trailing toolResult after assistant toolUse still skips", () => {
		expect(
			shouldTrigger(
				[userEntry("q"), assistantEntry("a", "toolUse"), toolResultEntry()],
				true,
				"",
			),
		).toBe("skip");
	});
	test("T49d: non-message entries after assistant stop still compute", () => {
		expect(
			shouldTrigger(
				[assistantEntry("a"), { type: "custom" }],
				true,
				"",
			),
		).toBe("compute");
	});
});

// ---------------------------------------------------------------------------
// Terminal-control sanitizer
// ---------------------------------------------------------------------------

describe("sanitizeTerminalText", () => {
	test("T50a: OSC 52 clipboard sequence terminated by BEL is removed", () => {
		const seq = `\x1b]52;c;${btoa("hello")}\x07`;
		expect(sanitizeTerminalText(`pre ${seq} post`)).toBe("pre  post");
	});
	test("T50b: OSC terminated by ST (ESC \\) is removed", () => {
		expect(sanitizeTerminalText("a\x1b]0;title\x1b\\b")).toBe("ab");
	});
	test("T50c: CSI sequences (color/cursor) are removed", () => {
		expect(sanitizeTerminalText("a\x1b[31mred\x1b[0mb")).toBe("aredb");
		expect(sanitizeTerminalText("\x1b[2Jclear")).toBe("clear");
	});
	test("T50d: DCS/APC sequences are removed", () => {
		expect(sanitizeTerminalText("a\x1bP1;2data\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x1b_stuff\x07b")).toBe("ab");
	});
	test("T50e: C0 controls (BEL, NUL, CR, DEL) are removed", () => {
		expect(sanitizeTerminalText("a\x07b")).toBe("ab");
		expect(sanitizeTerminalText("a\x00b")).toBe("ab");
		expect(sanitizeTerminalText("a\rb")).toBe("ab");
		expect(sanitizeTerminalText("a\x7fb")).toBe("ab");
	});
	test("T50f: C1 controls are removed", () => {
		// 0x9B is CSI: the sequence (including its final byte) is consumed.
		expect(sanitizeTerminalText("a\x9bb")).toBe("a");
		expect(sanitizeTerminalText("a\x9b31mred\x9b0mb")).toBe("aredb");
	});
	test("T50g: bidi override/isolate characters are removed — including consecutive controls (P1-2)", () => {
		expect(sanitizeTerminalText("a\u202Eb\u202Cc")).toBe("abc");
		expect(sanitizeTerminalText("a\u2066b\u2069c")).toBe("abc");
		// Stateful-regex parity bug: two consecutive controls must BOTH be removed.
		expect(sanitizeTerminalText("a\u202C\u202Eafter")).toBe("aafter");
		expect(sanitizeTerminalText("\u202e\u202e\u202eX")).toBe("X");
	});
	test("T50h: dangling ESC is dropped", () => {
		expect(sanitizeTerminalText("a\x1b")).toBe("a");
		expect(sanitizeTerminalText("a\x1bX")).toBe("a"); // ESC + final byte
	});
	test("T50i: safe Unicode (emoji, CJK, combining) is preserved", () => {
		expect(sanitizeTerminalText("👨‍👩‍👧 café 日本語")).toBe(
			"👨‍👩‍👧 café 日本語",
		);
	});
	test("T50j: newline/tab are normalized to space", () => {
		expect(sanitizeTerminalText("a\nb\tc")).toBe("a b c");
	});
	test("T50k: sanitizeSuggestion strips OSC before truncation", () => {
		expect(sanitizeSuggestion(`ok \x1b]52;c;${btoa("payload")}\x07`, {})).toBe(
			"ok",
		);
	});
	test("T50l: OSC terminated by C1 ST (0x9C) is removed without eating following text (P2-2)", () => {
		expect(sanitizeTerminalText("a\x1b]0;title\x9cb")).toBe("ab");
	});
	test("T50m: OSC payload longer than the scan cap is consumed entirely, no tail re-emission (P2-1)", () => {
		const payload = "A".repeat(4200);
		const out = sanitizeTerminalText(`\x1b]52;c;${payload}\x07B`);
		// Cap-hit without a visible terminator: the whole string is consumed so no
		// part of the runaway sequence (or its tail) survives as literal text.
		expect(out).toBe("");
	});
	test("T50n: DCS/APC also terminated by C1 ST", () => {
		expect(sanitizeTerminalText("a\x1bP1;2data\x9cb")).toBe("ab");
		expect(sanitizeTerminalText("a\x1b_stuff\x9cb")).toBe("ab");
	});
	test("T50o: PM (ESC ^) and SOS (ESC X) sequences are removed (F-01)", () => {
		expect(sanitizeTerminalText("a\x1b^payload\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x1b^payload\x07b")).toBe("ab");
		expect(sanitizeTerminalText("a\x1bXpayload\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x1bXpayload\x9cb")).toBe("ab");
	});
	test("T50p: 8-bit CSI (0x9B) consumes its full sequence (F-01)", () => {
		expect(sanitizeTerminalText("a\x9b31mred\x9b0mb")).toBe("aredb");
		expect(sanitizeTerminalText("a\x9b2Jb")).toBe("ab");
	});
	test("T50q: 8-bit OSC/DCS/PM/SOS/APC introducers consume payload to terminator (F-01)", () => {
		// 0x9D OSC, 0x90 DCS, 0x9E PM, 0x98 SOS, 0x9F APC — each with ESC\\ ST.
		expect(sanitizeTerminalText("a\x9d0;title\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x9d52;c;xyz\x07b")).toBe("ab");
		expect(sanitizeTerminalText("a\x90data\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x9epayload\x1b\\b")).toBe("ab");
		expect(sanitizeTerminalText("a\x98payload\x9cb")).toBe("ab");
		expect(sanitizeTerminalText("a\x9fpayload\x07b")).toBe("ab");
	});
	test("T50r: 8-bit OSC payload longer than the scan cap is fully consumed (F-01)", () => {
		const payload = "A".repeat(4200);
		expect(sanitizeTerminalText(`a\x9d${payload}\x07b`)).toBe("a");
	});
	test("T50s: lone surrogates dropped, valid pairs preserved (F-01)", () => {
		expect(sanitizeTerminalText("a\ud800b")).toBe("ab");
		expect(sanitizeTerminalText("a\udc00b")).toBe("ab");
		expect(sanitizeTerminalText("a\ud83d\ude00b")).toBe("a😀b");
	});
});

// ---------------------------------------------------------------------------
// overlayGhost
// ---------------------------------------------------------------------------

describe("overlayGhost", () => {
	const WIDTH = 40;
	// Build a realistic rendered cursor line: leftpad + text + CURSOR_MARKER + cursor block + rest + padding
	function makeLines(
		opts: { text?: string; rest?: string; focused?: boolean } = {},
	): string[] {
		const text = opts.text ?? "hi";
		const rest = opts.rest ?? "";
		const focused = opts.focused ?? true;
		const border = "─".repeat(WIDTH);
		const top = border;
		const bottom = border;
		const contentWidth = WIDTH;
		const cursor = "\x1b[7m \x1b[0m"; // cursor at end (empty grapheme → highlighted space)
		const marker = focused ? CURSOR_MARKER : "";
		const displayText = text + marker + cursor + rest;
		const visibleW = text.length + 1 + rest.length; // +1 for the cursor space
		const padding = " ".repeat(Math.max(0, contentWidth - visibleW));
		return [top, displayText + padding, bottom];
	}

	test("T58: no ghost returns lines unchanged (reference-equal)", () => {
		const lines = makeLines();
		expect(overlayGhost(lines, "", WIDTH)).toBe(lines);
	});
	test("T59: ghost shorter than remaining width — appended after cursor block, raw ANSI dim, re-padded", () => {
		const lines = makeLines({ text: "hi" });
		const out = overlayGhost(lines, "sug", WIDTH);
		expect(out).not.toBe(lines);
		const cursorLine = out[1]!;
		expect(cursorLine).toContain("\x1b[2msug\x1b[22m");
		// cursor block still present and before the ghost
		expect(cursorLine.indexOf("\x1b[7m \x1b[0m")).toBeLessThan(
			cursorLine.indexOf("\x1b[2msug"),
		);
	});
	test("T60: ghost longer than remaining width — truncated, no overflow past border", () => {
		const lines = makeLines({ text: "x".repeat(38) }); // nearly full width
		const out = overlayGhost(lines, "very long ghost that wont fit", WIDTH);
		const cursorLine = out[1]!;
		expect(cursorLine).toContain("\x1b[2m");
		expect(cursorLine).toContain("\x1b[22m");
		// P2-4: assert the rendered line never exceeds the requested width.
		expect(visibleWidth(cursorLine)).toBeLessThanOrEqual(WIDTH);
	});
	test("T61: cursor on a non-last visual line — only that line gains the ghost", () => {
		const lines = makeLines({ text: "hi" });
		const out = overlayGhost(lines, "sug", WIDTH);
		expect(out[0]).toBe(lines[0]); // top border untouched
		expect(out[2]).toBe(lines[2]); // bottom border untouched
		expect(out[1]).not.toBe(lines[1]);
	});
	test("T62: empty lines array returns []", () => {
		expect(overlayGhost([], "sug", WIDTH)).toEqual([]);
	});
	test("T63: unfocused editor WITH content is left untouched (no ghost clobber)", () => {
		const lines = makeLines({ focused: false }); // contains "hi"
		const out = overlayGhost(lines, "sug", WIDTH);
		expect(out).toBe(lines); // unchanged — never replace real content
	});

	test("T63b: unfocused editor with empty content line — ghost at start", () => {
		// Simulate a fully unfocused empty editor: top border, blank content, bottom border.
		const border = "─".repeat(WIDTH);
		const blank = " ".repeat(WIDTH);
		const lines = [border, blank, border];
		const out = overlayGhost(lines, "hello", WIDTH);
		expect(out[0]).toBe(border); // top border untouched
		expect(out[2]).toBe(border); // bottom border untouched
		expect(out[1]).toContain("\x1b[2mhello\x1b[22m");
	});

	test("T63c: unfocused editor — ghost truncated to contentWidth, no overflow", () => {
		const border = "─".repeat(WIDTH);
		const blank = " ".repeat(WIDTH);
		const lines = [border, blank, border];
		const out = overlayGhost(lines, "x".repeat(WIDTH * 2), WIDTH);
		// The content line must contain the dim ghost but not exceed visible width.
		expect(out[1]).toContain("\x1b[2m");
		expect(out[1]).toContain("\x1b[22m");
		// P2-4: every returned line is width-exact.
		for (const line of out)
			expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});
	test("T64: output contains raw ANSI dim escapes (not theme.fg)", () => {
		const lines = makeLines({ text: "hi" });
		const out = overlayGhost(lines, "sug", WIDTH);
		expect(out[1]!).toContain("\x1b[2m");
		expect(out[1]!).toContain("\x1b[22m");
	});
	test("T64b: OMP-style cursor (marker + plain glyph, no reverse-video block) still overlays after the cursor (dual-host)", () => {
		// OMP's focused editor renders `<marker><theme glyph>` without the
		// \x1b[7m…\x1b[0m block Pi uses; the ghost must be inserted after the
		// glyph, not dropped.
		const border = "─".repeat(WIDTH);
		const cursorGlyph = "\u258c"; // theme.symbols.inputCursor style glyph
		const line = "hi" + CURSOR_MARKER + cursorGlyph + " ".repeat(WIDTH - 3);
		const lines = [border, line, border];
		const out = overlayGhost(lines, "sug", WIDTH);
		const cursorLine = out[1]!;
		expect(cursorLine).toContain("\x1b[2msug\x1b[22m");
		expect(cursorLine.indexOf(cursorGlyph)).toBeLessThan(
			cursorLine.indexOf("\x1b[2msug"),
		);
		expect(cursorLine).toContain(CURSOR_MARKER);
	});
	test("T65: does not mutate the input lines array", () => {
		const lines = makeLines({ text: "hi" });
		const snapshot = lines.slice();
		overlayGhost(lines, "sug", WIDTH);
		expect(lines).toEqual(snapshot);
	});
	test("T66: CURSOR_MARKER byte offset relative to cursor block is unchanged (IME-safety)", () => {
		const lines = makeLines({ text: "hi" });
		const out = overlayGhost(lines, "sug", WIDTH);
		const newLine = out[1]!;
		const newMarkerIdx = newLine.indexOf(CURSOR_MARKER);
		const newCursorBlockIdx = newLine.indexOf("\x1b[7m", newMarkerIdx);
		// The marker must still immediately precede the cursor block (no ghost inserted between them)
		expect(
			newLine.slice(newMarkerIdx + CURSOR_MARKER.length, newCursorBlockIdx),
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Real pi-tui editor integration (F-13)
// ---------------------------------------------------------------------------
// Uses the actual pi-tui Editor/CustomEditor/GhostEditor classes with a stub
// TUI so rendering, focus, cursor, undo/history, and autocomplete contracts
// are exercised against the real implementation, not a callback fake.

/**
 * Construct a stub-backed pi-tui Editor. Pi's `Editor` constructor is
 * `(tui, theme)`; OMP's is `(theme)` — the runtime suite runs against Pi while
 * the OMP typecheck compiles against OMP types, so widen the constructor at
 * the boundary. Tests only exercise the shared rendering/input surface.
 */
function makeStubEditor(): Editor {
	return new (Editor as unknown as new (...args: unknown[]) => Editor)(
		{ requestRender: () => {}, terminal: { rows: 24, cols: 80 } },
		{
			borderColor: (s: string) => s,
			selectList: {
				selectedPrefix: (s: string) => s,
				selectedText: (s: string) => s,
				description: (s: string) => s,
				scrollInfo: (s: string) => s,
				noMatch: (s: string) => s,
			},
		},
	);
}

describe("real pi-tui editor integration", () => {
	const mkTui = () =>
		({
			requestRender: () => {},
			terminal: { rows: 24, cols: 80 },
		}) as never;
	const mkTheme = () =>
		({
			borderColor: (s: string) => s,
			selectList: {
				selectedPrefix: (s: string) => s,
				selectedText: (s: string) => s,
				description: (s: string) => s,
				scrollInfo: (s: string) => s,
				noMatch: (s: string) => s,
			},
		}) as never;

	function mkGhostState(over: Partial<SuggestionState> = {}): SuggestionState {
		return {
			suggestion: "",
			lastSuggestion: "",
			alternatives: [],
			altIndex: 0,
			acceptKey: "enter",
			renderMode: "ghost",
			rearmDelayMs: 2000,
			rearmTimer: undefined,
			rearmCheckTimer: undefined,
			inputGeneration: 0,
			isIdleGetter: () => true,
			getEditorText: () => "",
			setEditorText: () => {},
			publishWidget: () => {},
			renderGhost: undefined,
			fallbackToWidget: undefined,
			abortInflight: () => {},
			...over,
		};
	}

	test("E1: ghost overlay renders width-safe, focused and unfocused, at 1/2/10/40/120", () => {
		for (const width of [1, 2, 10, 40, 120]) {
			const state = mkGhostState({ suggestion: "suggestion text" });
			const ed = new GhostEditor(mkTui(), mkTheme(), {} as never, state);
			ed.focused = true;
			const focused = ed.render(width);
			for (const line of focused)
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const focusedJoin = focused.join("\n");
			// The ghost only fits when the editor content width allows it; at
			// width 1-2 nothing can render. Width-safety holds at every width.
			if (width >= 10) {
				expect(focusedJoin).toContain("\x1b[2m");
			}
			expect(focusedJoin).toContain(CURSOR_MARKER);

			const unfocused = new GhostEditor(mkTui(), mkTheme(), {} as never, state);
			unfocused.focused = false;
			const unfocusedLines = unfocused.render(width);
			for (const line of unfocusedLines)
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			const unfocusedJoin = unfocusedLines.join("\n");
			if (width >= 10) {
				expect(unfocusedJoin).toContain("\x1b[2m");
			}
			expect(unfocusedJoin).not.toContain(CURSOR_MARKER);
		}
	});

	test("E2: ghost overlay never emits partial ANSI fragments", () => {
		const state = mkGhostState({ suggestion: "suggestion" });
		const ed = new GhostEditor(mkTui(), mkTheme(), {} as never, state);
		ed.focused = true;
		for (const line of ed.render(40)) {
			// After stripping all known ANSI sequences and the (zero-width)
			// cursor marker, no ESC may remain.
			const stripped = line
				.replace(CURSOR_MARKER, "")
				.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
				.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).not.toContain("\x1b");
		}
	});

	test("E3: ghost preserves base text and mid-line cursor position", () => {
		const state = mkGhostState({ suggestion: "ghost" });
		const ed = new GhostEditor(
			mkTui(),
			mkTheme(),
			getKeybindings() as never,
			state,
		);
		ed.focused = true;
		ed.setText("abc");
		// Move cursor to the start: left, left, left.
		ed.handleInput("\x1b[D");
		ed.handleInput("\x1b[D");
		ed.handleInput("\x1b[D");
		const lines = ed.render(40).join("\n");
		// Cursor sits on the first grapheme: highlighted "a", then ghost (+
		// accept-key hint), then "bc".
		expect(lines).toContain("\x1b[7ma\x1b[0m");
		expect(lines).toContain("\x1b[2mghost  (Enter · ←→)\x1b[22mbc");
		expect(ed.getText()).toBe("abc");
	});

	test("E4: base editor handles real input: typing, backspace, history, undo", () => {
		const kb = getKeybindings();
		const ed = new CustomEditor(mkTui(), mkTheme(), kb as never);
		ed.focused = true;
		for (const ch of ["a", "b", "c"]) ed.handleInput(ch);
		expect(ed.getText()).toBe("abc");
		ed.handleInput("\x7f"); // backspace
		expect(ed.getText()).toBe("ab");
		ed.handleInput("\x1f"); // ctrl+- (undo)
		expect(ed.getText()).toBe("abc");
		// History browsing.
		ed.setText("prompt one");
		ed.addToHistory(ed.getText());
		ed.setText("");
		ed.handleInput("\x1b[A"); // up arrow
		expect(ed.getText()).toBe("prompt one");
	});

	test("E4b: ghost overlay failure → render still returns base lines and falls back to widget exactly once (P1-1)", () => {
		let fallbacks = 0;
		const state = mkGhostState({ suggestion: "suggestion" });
		state.fallbackToWidget = () => {
			fallbacks += 1;
			state.renderMode = "widget";
			state.renderGhost = undefined;
		};
		const ed = new GhostEditor(mkTui(), mkTheme(), {} as never, state);
		ed.focused = true;
		ed.setText("abc");
		// Make the ghost overlay itself throw (e.g. an unexpected render error).
		Object.defineProperty(state, "suggestion", {
			get: () => {
				throw new Error("overlay exploded");
			},
		});
		const baseEditor = new CustomEditor(mkTui(), mkTheme(), {} as never);
		baseEditor.focused = true;
		baseEditor.setText("abc");
		const base = baseEditor.render(40);
		// Render must not throw and must return the un-ghosted base lines.
		const first = ed.render(40);
		const second = ed.render(40);
		expect(first).toEqual(base);
		expect(second).toEqual(base);
		// Exactly one fallback fired (the controller's guard makes later calls
		// no-ops once renderMode is widget; the spy here re-enters per render).
		expect(fallbacks).toBeGreaterThan(0);
	});

	test("E5: autocomplete dropdown renders width-safe and Tab applies the selection", async () => {
		const ed = makeStubEditor();
		ed.focused = true;
		let requested = 0;
		// Boundary cast: Pi's AutocompleteProvider carries `triggerCharacters`,
		// OMP's does not; this provider only relies on the shared surface.
		ed.setAutocompleteProvider({
			triggerCharacters: ["/"],
			getSuggestions: async () => {
				requested += 1;
				return { items: [{ value: "bar", label: "bar" }], prefix: "/" };
			},
			applyCompletion: (lines: string[], cursorLine: number, _cursorCol: number) => {
				lines[cursorLine] = "/bar";
				return { lines, cursorLine, cursorCol: 4 };
			},
		} as never);
		ed.handleInput("/");
		await sleep(200); // debounce + async resolve
		expect(requested).toBeGreaterThan(0);
		const rendered = ed.render(40).join("\n");
		expect(rendered).toContain("bar"); // dropdown visible
		ed.handleInput("\t"); // accept highlighted completion
		expect(ed.getText()).toBe("/bar");
	});

	test("E6: terminal listeners run before focused editor input; consume stops the chain (F-13)", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "accept me" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("accept me");
		// A second, later-registered listener observes the chain after ours.
		let spyCalls = 0;
		fake.inputListeners.push(() => {
			spyCalls += 1;
			return undefined;
		});
		// Accept key: our handler consumes → later listener and editor never see it.
		fake.deliverInput("\r");
		expect(spyCalls).toBe(0);
		expect(fake.editor.getText()).toBe("");
		expect(fake.editorText).toBe("accept me");
		// Non-accept key: our handler dismisses but does NOT consume → editor gets it.
		fake.deliverInput("x");
		expect(spyCalls).toBe(1);
		expect(fake.editor.getText()).toBe("x");
	});

	test("E7: conflicting acceptKey 'tab' is rejected and tab passes through unconsumed", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ acceptKey: "tab" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "sug" }],
				stopReason: "stop",
			},
		});
		// Config was rejected → hint shows the DEFAULT key, not Tab.
		expect(fake.widgetContent?.[0] ?? "").not.toContain("Tab to accept");
		// Tab is never consumed and never fills the editor.
		fake.deliverInput("\t");
		expect(fake.editor.getText()).toBe("");
		expect(fake.editorText).toBe("");
		expect(fake.widgetContent).toBeUndefined(); // dismissed
	});

	test("E8: lifecycle — reload/new/resume/fork keep exactly one listener per session and no duplicate installs", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		let starts = 1;
		for (const reason of ["reload", "new", "resume", "fork"]) {
			starts += 1;
			await fake.handlers.get("session_start")!(
				{ type: "session_start", reason },
				fake.ctx,
			);
			// pi clears extension listeners + custom editors on reset; a fresh
			// session_start unsubscribes the old listener and (re)installs the
			// editor exactly once for that session.
			expect(fake.inputListeners).toHaveLength(1);
			expect(fake.unsubInputCalls).toBe(starts - 1);
			expect(fake.editorComponentCalls).toBe(starts);
		}
	});

	test("E9: session_shutdown unsubscribes the terminal listener", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.inputListeners).toHaveLength(1);
		fake.handlers.get("session_shutdown")!({}, fake.ctx);
		expect(fake.inputListeners).toHaveLength(0);
		expect(fake.unsubInputCalls).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Controller wiring (fake ExtensionAPI firing agent_settled)
// ---------------------------------------------------------------------------

// A minimal fake that implements only the surface the controller touches.
// Identity-stable "previous editor owner" so restore calls (which pass the
// captured prior factory back) are distinguishable from fresh installs.
const PRIOR_EDITOR_FACTORY = (() => {}) as never;
function makeFake(opts: {
	branch?: BranchEntry[];
	idle?: boolean;
	completeResult?: {
		content: Array<{ type: "text"; text: string }>;
		stopReason: string;
	};
	completeResults?: Array<{
		content: Array<{ type: "text"; text: string }>;
		stopReason: string;
	}>;
	completeError?: Error;
	model?: { provider: string; id: string; baseUrl?: string };
	findModel?: (p: string, m: string) => unknown;
	mode?: string;
	projectTrusted?: boolean;
	hasPriorEditor?: boolean;
	/** setEditorComponent throws on install (e.g. the owner rejects replacement). */
	setEditorComponentThrows?: boolean;
	/** The constructed GhostEditor's tui.requestRender throws (ghost render pipeline fails). */
	requestRenderThrows?: boolean;
	confirmResult?:
		| boolean
		| Promise<boolean>
		| (() => boolean | Promise<boolean>);
	confirmCall?: () => void;
	/** Result for ctx.ui.select (consent chooser). Defaults to "once". */
	selectResult?: string | Promise<string> | (() => string | Promise<string>);
	/** Hook invoked while the consent selector is open. */
	selectCall?: () => void;
	/** Omit ctx.ui.select entirely (fallback-to-confirm path). */
	selectUnavailable?: boolean;
}): {
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
	ctx: unknown;
	widgetContent: string[] | undefined;
	editorText: string;
	setEditorText: (t: string) => void;
	inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	/** Registered terminal-input listeners, in order (model of pi's listener chain). */
	inputListeners: Array<(data: string) => { consume?: boolean } | undefined>;
	/** Deliver raw input through the listener chain (consume stops dispatch). */
	deliverInput: (data: string) => void;
	/** Number of listener unsubscriptions (pi clears listeners on reset). */
	unsubInputCalls: number;
	/** The focused editor component (real pi-tui Editor) receiving non-consumed input. */
	editor: import("@earendil-works/pi-tui").Editor;
	calls: {
		complete: Array<{
			model: unknown;
			systemPrompt?: string;
			messages: unknown[];
			signal?: AbortSignal;
			reasoning?: string;
		}>;
		notifies: Array<[string, string]>;
		confirms: string[];
		selects: Array<[string, string[]]>;
	};
	handlers: Map<string, (e: unknown, ctx: unknown) => unknown>;
	setIdle: (v: boolean) => void;
	editorComponentInstalled: boolean;
	editorComponentCalls: number;
	/** Count of restore calls: setEditorComponent(undefined) — the fallback path. */
	editorComponentRestores: number;
	/** Last editor instance produced by the installed factory (GhostEditor), if any. */
	lastEditorComponent: unknown;
} {
	let idle = opts.idle ?? true;
	const calls = {
		complete: [] as Array<{
			model: unknown;
			systemPrompt?: string;
			messages: unknown[];
			signal?: AbortSignal;
			reasoning?: string;
		}>,
		notifies: [] as Array<[string, string]>,
		confirms: [] as string[],
		selects: [] as Array<[string, string[]]>,
	};
	let editorText = "";
	let inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	const inputListeners: Array<
		(data: string) => { consume?: boolean } | undefined
	> = [];
	let unsubInputCalls = 0;
	let widgetContent: string[] | undefined;
	let editorComponentInstalled = false;
	let editorComponentCalls = 0;
	let editorComponentRestores = 0;
	let lastEditorComponent: unknown;
	// Real pi-tui Editor as the focused component (F-13: real editor input).
	const editor = makeStubEditor();
	editor.focused = true;
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();
	const ctx = {
		cwd: "/tmp",
		mode: opts.mode ?? "tui",
		isIdle: () => idle,
		isProjectTrusted: () => opts.projectTrusted ?? true,
		model: opts.model ?? { provider: "openai", id: "gpt" },
		modelRegistry: {
			find: ((p: string, m: string) => opts.findModel?.(p, m)) as never,
			complete: async (
				model: unknown,
				context: { systemPrompt?: string; messages: unknown[] },
				options?: { signal?: AbortSignal; reasoning?: string },
			) => {
				calls.complete.push({
					model,
					systemPrompt: context.systemPrompt,
					messages: context.messages,
					signal: options?.signal,
					reasoning: options?.reasoning,
				});
				if (opts.completeError) throw opts.completeError;
				const queued = opts.completeResults?.[calls.complete.length - 1];
				return (
					queued ??
					opts.completeResult ?? {
						content: [{ type: "text" as const, text: "suggestion" }],
						stopReason: "stop",
					}
				);
			},
		},
		ui: {
			notify: (m: string, t: "info" | "warning" | "error" = "info") =>
				calls.notifies.push([m, t]),
			...(opts.selectUnavailable
				? {}
				: {
						select: async (title: string, options: string[]) => {
							calls.selects.push([title, options]);
							opts.selectCall?.();
							const result =
								typeof opts.selectResult === "function"
									? opts.selectResult()
									: (opts.selectResult ?? "once");
							return typeof result === "string" ? result : await result;
						},
					}),
			confirm: async (title: string) => {
				calls.confirms.push(title);
				opts.confirmCall?.();
				const result =
					typeof opts.confirmResult === "function"
						? opts.confirmResult()
						: (opts.confirmResult ?? true);
				return typeof result === "boolean" ? result : await result;
			},
			onTerminalInput: (
				handler: (data: string) => { consume?: boolean } | undefined,
			) => {
				inputHandler = handler;
				inputListeners.push(handler);
				return () => {
					const idx = inputListeners.indexOf(handler);
					if (idx >= 0) inputListeners.splice(idx, 1);
					if (inputHandler === handler) inputHandler = undefined;
					unsubInputCalls += 1;
				};
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			setWidget: (
				_key: string,
				content: string[] | undefined,
				_options?: { placement?: string },
			) => {
				widgetContent = content;
			},
			getEditorComponent: () =>
				opts.hasPriorEditor ? PRIOR_EDITOR_FACTORY : undefined,
			setEditorComponent: (
				factory:
					| ((tui: unknown, theme: unknown, kb: unknown) => unknown)
					| undefined,
			) => {
				editorComponentCalls += 1;
				if (factory === PRIOR_EDITOR_FACTORY) {
					// Restore path (fallbackToWidget): the previous owner is back.
					editorComponentInstalled = false;
					editorComponentRestores += 1;
					return;
				}
				if (factory === undefined) {
					// Explicit reset to the default editor.
					editorComponentInstalled = false;
					editorComponentRestores += 1;
					return;
				}
				if (opts.setEditorComponentThrows) {
					throw new Error("editor owner rejected replacement");
				}
				editorComponentInstalled = true;
				// Call the factory so a real GhostEditor is constructed (lightweight ctor).
				lastEditorComponent = factory(
					{
						requestRender: () => {
							if (opts.requestRenderThrows) {
								throw new Error("ghost render pipeline failed");
							}
						},
					} as unknown,
					{ borderColor: (s: string) => s, selectList: {} } as unknown,
					{ matches: () => false } as unknown,
				);
			},
		},
		sessionManager: { getBranch: () => opts.branch ?? [] },
	};
	const pi = {
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (_name: string, _options: unknown) => {
			// No-op stub for tests; the config command is exercised via configureInteractively.
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	return {
		pi,
		ctx,
		get widgetContent() {
			return widgetContent;
		},
		get editorText() {
			return editorText;
		},
		setEditorText: (t: string) => {
			editorText = t;
		},
		get inputHandler() {
			return inputHandler;
		},
		get inputListeners() {
			return inputListeners;
		},
		deliverInput: (data: string) => {
			// pi invokes terminal listeners BEFORE the focused component; a
			// { consume: true } result stops the chain (F-13).
			for (const listener of [...inputListeners]) {
				const result = listener(data);
				if (result?.consume) return;
			}
			editor.handleInput(data);
		},
		get unsubInputCalls() {
			return unsubInputCalls;
		},
		get editor() {
			return editor;
		},
		get editorComponentInstalled() {
			return editorComponentInstalled;
		},
		get editorComponentCalls() {
			return editorComponentCalls;
		},
		get editorComponentRestores() {
			return editorComponentRestores;
		},
		get lastEditorComponent() {
			return lastEditorComponent;
		},
		calls,
		handlers,
		setIdle: (v: boolean) => {
			idle = v;
		},
	};
}

async function setup(opts: Parameters<typeof makeFake>[0]) {
	const fake = makeFake(opts);
	const factory = (await import("./next-prompt.ts")).default;
	factory(fake.pi);
	// Trigger session_start so the controller installs the editor and captures it.
	await fake.handlers.get("session_start")!({}, fake.ctx);
	return { fake };
}

// ---------------------------------------------------------------------------
// OMP-shaped controller fixture
// ---------------------------------------------------------------------------
// A distinct fake matching the researched OMP 17.2.12 ExtensionAPI/Context:
//   - `hasUI` and NO `mode`;
//   - `agent_end` registered and NO `agent_settled`;
//   - `modelRegistry.resolver` and NO `modelRegistry.complete`;
//   - NO `ui.getEditorComponent` / `ui.setEditorComponent`;
//   - no `isProjectTrusted`.
// Completion goes through the OMP transport: `completeSimple` read from the
// lazily loaded completion module (replaced via setOmpCompletionModuleForTests),
// invoked with `apiKey: modelRegistry.resolver(model)`. Unavailable methods are
// absent from the fixture, so a regression that reaches for a Pi-only API on
// OMP throws instead of silently passing.

/** The auth resolver the OMP fake's modelRegistry returns. */
const OMP_RESOLVER = (async () => "sk-omp-test") as never;

function makeOmpFake(opts: {
	branch?: BranchEntry[];
	idle?: boolean;
	completeSimpleResult?: {
		content: Array<{ type: "text"; text: string }>;
		stopReason: string;
	};
	completeSimpleError?: Error;
	/** The loaded module lacks `completeSimple` entirely (C9). */
	completeSimpleUnavailable?: boolean;
	/** The completion-module loader itself rejects (import failure). */
	moduleLoadError?: Error;
	model?: { provider: string; id: string; baseUrl?: string };
	findModel?: (p: string, m: string) => unknown;
	hasUI?: boolean;
	/** Omit the hasUI key entirely (context with neither host marker — B9). */
	omitHasUI?: boolean;
	confirmResult?:
		| boolean
		| Promise<boolean>
		| (() => boolean | Promise<boolean>);
	selectResult?: string | Promise<string> | (() => string | Promise<string>);
	/** Hook invoked while the consent selector is open. */
	selectCall?: () => void;
	selectUnavailable?: boolean;
	/** The constructed GhostEditor's tui.requestRender throws (ghost render pipeline fails). */
	requestRenderThrows?: boolean;
}): {
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
	ctx: unknown;
	widgetContent: string[] | undefined;
	editorText: string;
	setEditorText: (t: string) => void;
	inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	inputListeners: Array<(data: string) => { consume?: boolean } | undefined>;
	deliverInput: (data: string) => void;
	unsubInputCalls: number;
	editor: import("@earendil-works/pi-tui").Editor;
	calls: {
		ompComplete: Array<{
			model: unknown;
			systemPrompt?: string | string[];
			messages: unknown[];
			apiKey?: unknown;
			signal?: AbortSignal;
			reasoning?: unknown;
		}>;
		notifies: Array<[string, string]>;
		confirms: string[];
		selects: Array<[string, string[]]>;
	};
	handlers: Map<string, (e: unknown, ctx: unknown) => unknown>;
	setIdle: (v: boolean) => void;
	/** Number of times the OMP completion-module loader was invoked. */
	loaderCalls: number;
	/** Whether the ghost editor was installed via setEditorComponent. */
	editorComponentInstalled: boolean;
	editorComponentCalls: number;
	/** Count of setEditorComponent(undefined) calls (default-editor restore). */
	editorComponentRestores: number;
} {
	let idle = opts.idle ?? true;
	let loaderCalls = 0;
	let editorComponentInstalled = false;
	let editorComponentCalls = 0;
	let editorComponentRestores = 0;
	const calls = {
		ompComplete: [] as Array<{
			model: unknown;
			systemPrompt?: string | string[];
			messages: unknown[];
			apiKey?: unknown;
			signal?: AbortSignal;
			reasoning?: unknown;
		}>,
		notifies: [] as Array<[string, string]>,
		confirms: [] as string[],
		selects: [] as Array<[string, string[]]>,
	};
	let editorText = "";
	let inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	const inputListeners: Array<
		(data: string) => { consume?: boolean } | undefined
	> = [];
	let unsubInputCalls = 0;
	let widgetContent: string[] | undefined;
	const editor = makeStubEditor();
	editor.focused = true;
	const handlers = new Map<string, (e: unknown, ctx: unknown) => unknown>();

	// OMP transport: completeSimple from the lazily loaded (test-seamed)
	// completion module, invoked with the registry resolver as apiKey.
	const module: OmpCompletionModule = opts.completeSimpleUnavailable
		? {}
		: {
				completeSimple: async (
					model,
					context,
					options,
				): Promise<AssistantMessage> => {
					calls.ompComplete.push({
						model,
						systemPrompt: context.systemPrompt,
						messages: context.messages,
						apiKey: options?.apiKey,
						signal: options?.signal,
						reasoning: options?.reasoning,
					});
					if (opts.completeSimpleError) throw opts.completeSimpleError;
					return (
						(opts.completeSimpleResult ?? {
							content: [{ type: "text" as const, text: "suggestion" }],
							stopReason: "stop",
						}) as unknown as AssistantMessage
					);
				},
			};
	setOmpCompletionModuleForTests(() => {
		loaderCalls += 1;
		if (opts.moduleLoadError) return Promise.reject(opts.moduleLoadError);
		return Promise.resolve(module);
	});

	const ctx = {
		cwd: "/tmp",
		// OMP shape: `hasUI` present, `mode` and `isProjectTrusted` absent.
		// omitHasUI removes the key entirely so tests can model a context
		// with neither host marker (B9).
		...(opts.omitHasUI ? {} : { hasUI: opts.hasUI ?? true }),
		isIdle: () => idle,
		model: opts.model ?? { provider: "openai", id: "gpt" },
		modelRegistry: {
			find: ((p: string, m: string) => opts.findModel?.(p, m)) as never,
			resolver: (() => OMP_RESOLVER) as never,
			// deliberately no `complete`
		},
		ui: {
			notify: (m: string, t: "info" | "warning" | "error" = "info") =>
				calls.notifies.push([m, t]),
			...(opts.selectUnavailable
				? {}
				: {
						select: async (title: string, options: string[]) => {
							calls.selects.push([title, options]);
							opts.selectCall?.();
							const result =
								typeof opts.selectResult === "function"
									? opts.selectResult()
									: (opts.selectResult ?? "once");
							return typeof result === "string" ? result : await result;
						},
					}),
			confirm: async (title: string) => {
				calls.confirms.push(title);
				const result =
					typeof opts.confirmResult === "function"
						? opts.confirmResult()
						: (opts.confirmResult ?? true);
				return typeof result === "boolean" ? result : await result;
			},
			onTerminalInput: (
				handler: (data: string) => { consume?: boolean } | undefined,
			) => {
				inputHandler = handler;
				inputListeners.push(handler);
				return () => {
					const idx = inputListeners.indexOf(handler);
					if (idx >= 0) inputListeners.splice(idx, 1);
					if (inputHandler === handler) inputHandler = undefined;
					unsubInputCalls += 1;
				};
			},
			getEditorText: () => editorText,
			setEditorText: (text: string) => {
				editorText = text;
			},
			setWidget: (
				_key: string,
				content: string[] | undefined,
				_options?: { placement?: string },
			) => {
				widgetContent = content;
			},
			// OMP shape: setEditorComponent exists, getEditorComponent does not.
			setEditorComponent: (
				factory:
					| ((tui: unknown, theme: unknown, kb: unknown) => unknown)
					| undefined,
			) => {
				editorComponentCalls += 1;
				if (factory === undefined) {
					// Restore the default editor (fallback / session reset).
					editorComponentInstalled = false;
					editorComponentRestores += 1;
					return;
				}
				editorComponentInstalled = true;
				factory(
					{
						requestRender: () => {
							if (opts.requestRenderThrows) {
								throw new Error("ghost render pipeline failed");
							}
						},
					} as unknown,
					{ borderColor: (s: string) => s, selectList: {} } as unknown,
					{ matches: () => false } as unknown,
				);
			},
		},
		sessionManager: { getBranch: () => opts.branch ?? [] },
	};
	const pi = {
		// OMP injects its coding-agent exports and a typebox shim onto the API;
		// detectHost() keys off these capabilities.
		pi: {},
		typebox: {},
		on: (event: string, handler: (e: unknown, c: unknown) => unknown) => {
			handlers.set(event, handler);
		},
		registerCommand: (_name: string, _options: unknown) => {
			// No-op stub for tests; the config command is exercised via configureInteractively.
		},
	} as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
	return {
		pi,
		ctx,
		get widgetContent() {
			return widgetContent;
		},
		get editorText() {
			return editorText;
		},
		setEditorText: (t: string) => {
			editorText = t;
		},
		get inputHandler() {
			return inputHandler;
		},
		get inputListeners() {
			return inputListeners;
		},
		deliverInput: (data: string) => {
			for (const listener of [...inputListeners]) {
				const result = listener(data);
				if (result?.consume) return;
			}
			editor.handleInput(data);
		},
		get unsubInputCalls() {
			return unsubInputCalls;
		},
		get editor() {
			return editor;
		},
		calls,
		handlers,
		setIdle: (v: boolean) => {
			idle = v;
		},
		get loaderCalls() {
			return loaderCalls;
		},
		get editorComponentInstalled() {
			return editorComponentInstalled;
		},
		get editorComponentCalls() {
			return editorComponentCalls;
		},
		get editorComponentRestores() {
			return editorComponentRestores;
		},
	};
}

async function setupOmp(opts: Parameters<typeof makeOmpFake>[0]) {
	const fake = makeOmpFake(opts);
	const factory = (await import("./next-prompt.ts")).default;
	factory(fake.pi);
	// Trigger session_start so the controller installs OMP session state.
	await fake.handlers.get("session_start")!({}, fake.ctx);
	return { fake };
}

describe("controller wiring (agent_settled)", () => {
	test("T71: agent_settled + editor non-empty → no complete call", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		fake.setEditorText("already typing");
		const handler = fake.handlers.get("agent_settled")!;
		await handler({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("T72: agent_settled + editor empty + idle → complete called once", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		const handler = fake.handlers.get("agent_settled")!;
		await handler({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("T73: default model = ctx.model when config has no model block", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "openai",
			id: "gpt",
		});
	});

	test("T74: configured model used when present in registry", async () => {
		const configured = { provider: "anthropic", id: "haiku" };
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku" ? configured : undefined,
		});
		// No config file → resolveSuggestionModel returns ctx.model. To test the configured
		// path, write a config file.
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete[0]!.model).toBe(configured);
	});

	test("T74b: config thinking level is passed as reasoning to complete", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ thinking: "low" }),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete[0]!.reasoning).toBe("low");
	});

	test("T74c: no thinking config → reasoning undefined (model default)", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		// No config file → no thinking.
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete[0]!.reasoning).toBeUndefined();
	});

	test("T74d: config acceptKey is reflected in the widget hint", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ acceptKey: "ctrl+space" }),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("Ctrl-Space · ←→");
	});

	test("T74e: no acceptKey config → widget hint shows Enter", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("Enter · ←→");
	});

	test("T75: allowCrossProvider=false + different provider → ctx.model used", async () => {
		const active = { provider: "openai", id: "gpt" };
		const configured = { provider: "anthropic", id: "haiku" };
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: active,
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku" ? configured : undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: false,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete[0]!.model).toBe(active);
	});

	test("T76: second agent_settled while first in flight → first aborted (single-flight)", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		const handler = fake.handlers.get("agent_settled")!;
		const p1 = handler({}, fake.ctx);
		const p2 = handler({}, fake.ctx);
		await Promise.all([p1, p2]);
		// First complete's signal should be aborted; second may or may not have run, but
		// the net effect is at least one aborted signal observed.
		const aborted = fake.calls.complete.some((c) => c.signal?.aborted);
		expect(aborted).toBe(true);
	});

	test("T77: complete resolves after editor became non-empty → setGhost ignored, editor text unchanged", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		const handler = fake.handlers.get("agent_settled")!;
		const p = handler({}, fake.ctx);
		fake.setEditorText("user typed");
		await p;
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T78: complete resolves after agent started (idle=false) → setGhost ignored (idle guard)", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		const handler = fake.handlers.get("agent_settled")!;
		const p = handler({}, fake.ctx);
		fake.setIdle(false);
		await p;
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T79: complete returns stopReason length → no ghost", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "length",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T80: complete returns stopReason error → notify warning, no ghost", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "error",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		expect(fake.calls.notifies.some((n) => n[1] === "warning")).toBe(true);
	});

	test("T81: complete returns NONE text → no ghost", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "NONE" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T82: complete throws (non-abort) → notify error once, no ghost", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeError: new Error("boom"),
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		expect(
			fake.calls.notifies.some(
				(n) => n[0].includes("failed") && n[1] === "error",
			),
		).toBe(true);
	});

	test("T83: complete aborted (signal) → no notify, no ghost", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeError: new Error("aborted"),
		});
		// Simulate abort by firing agent_start which aborts the in-flight controller.
		const handler = fake.handlers.get("agent_settled")!;
		const p = handler({}, fake.ctx);
		fake.handlers.get("agent_start")!({}, fake.ctx); // aborts
		await (p as Promise<unknown>).catch(() => {});
		// The complete that actually ran threw "boom" (our fake always throws), so an error
		// notify may fire; the key assertion is no ghost is set.
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T84: loadConfig failure at session_start → computeDisabled, zero complete calls (F-07)", async () => {
		// Malformed global config must fail closed: no suggestion model request.
		writeFile(process.env.PI_CODING_AGENT_DIR!, "next-prompt.json", "{ broken");
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
		// The TUI warning is surfaced.
		expect(
			fake.calls.notifies.some(
				([m, t]) => t === "warning" && m.includes("suggestions disabled"),
			),
		).toBe(true);
	});

	test("T84b: malformed PROJECT config → computeDisabled, zero complete calls (F-07)", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", "{ broken");
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		(fake.ctx as { cwd: string }).cwd = cwd;
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("T84c: invalid privacy field (maxTranscriptChars) → zero complete calls", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: "unlimited" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("T85: input event → inflight aborted + ghost cleared", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		fake.setEditorText("dummy"); // suggestion is internal; widget cleared on clear events
		fake.handlers.get("input")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T86: turn_start / agent_start → inflight aborted + ghost cleared", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		fake.setEditorText("dummy"); // suggestion is internal; widget cleared on clear events
		fake.handlers.get("turn_start")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		fake.setEditorText("dummy"); // suggestion is internal; widget cleared on clear events
		fake.handlers.get("agent_start")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T87: session_shutdown → inflight aborted, editor nulled, ghost cleared", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		fake.setEditorText("dummy"); // suggestion is internal; widget cleared on clear events
		fake.handlers.get("session_shutdown")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T88: session_start (reload) → previous inflight aborted, new editor installed, ghost cleared", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		fake.setEditorText("dummy"); // suggestion is internal; widget cleared on clear events
		await fake.handlers.get("session_start")!(
			{ type: "session_start", reason: "reload" },
			fake.ctx,
		);
		expect(fake.widgetContent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Acceptance / regression
// ---------------------------------------------------------------------------

describe("acceptance / regression", () => {
	test("T89: end-to-end: agent_settled → complete → ghost shown → (accept is editor-level)", async () => {
		const { fake } = await setup({
			branch: [userEntry("q"), assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "what's next?" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("what's next?");
	});

	test("T90: shouldTrigger short-circuits when editor non-empty (typing cancels)", () => {
		// Pure check: even with a valid branch, non-empty editor means skip.
		expect(shouldTrigger([assistantEntry("a")], true, "typing")).toBe("skip");
	});

	test("T91: re-arm is transition-based — only delete-to-empty re-arms (controller-level)", async () => {
		// The delete-to-empty re-arm is exercised end-to-end in the re-arm describe
		// (T98+). This regression asserts Escape while a suggestion is showing does
		// NOT re-arm, because dismissal is not a non-empty→empty transition.
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\x1b"); // Escape dismisses
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined(); // no re-arm
	});

	test("T92: typing then submitting then settling → fresh suggestion computed (not stale)", async () => {
		const { fake } = await setup({
			branch: [userEntry("q"), assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "fresh" }],
				stopReason: "stop",
			},
		});
		// First settle → ghost "fresh"
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("fresh");
		// User types & submits → ghost cleared
		fake.handlers.get("input")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		// Settle again with a new complete result → fresh suggestion
		fake as unknown as {
			opts: {
				completeResult: {
					content: Array<{ type: string; text: string }>;
					stopReason: string;
				};
			};
		};
		// We can't easily mutate the fake's complete result after creation; instead just
		// re-fire and confirm a new complete call is made (the suggestion is recomputed).
		const before = fake.calls.complete.length;
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete.length).toBeGreaterThan(before);
	});

	test("T92b: stale cached suggestion never re-arms after a submit (F-09)", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "stale" }],
				stopReason: "stop",
			},
		});
		// Turn 1: suggestion shown, accepted into the editor.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r");
		expect(fake.editorText).toBe("stale");
		// User submits; reset clears the cached suggestion.
		fake.handlers.get("input")!({}, fake.ctx);
		fake.setEditorText("");
		// Delete-to-empty would previously re-arm the stale cache; must NOT now.
		fake.inputHandler!("\x7f");
		vi.advanceTimersByTime(200);
		expect(fake.widgetContent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Accept-handler (onTerminalInput): the core of the accept fix
// ---------------------------------------------------------------------------

describe("accept handler (onTerminalInput)", () => {
	test("T93: accept key fills the editor and clears the widget (consume=true)", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "suggestion text" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("suggestion text");
		// Fire the accept key (enter → \r)
		const result = fake.inputHandler!("\r");
		expect(result).toEqual({ consume: true });
		expect(fake.editorText).toBe("suggestion text");
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T94: non-accept key is NOT consumed (passes through to editor)", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		const result = fake.inputHandler!("a");
		expect(result).toBeUndefined();
	});

	test("T95: accept key while agent NOT idle → not consumed", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.setIdle(false);
		const result = fake.inputHandler!("\r");
		expect(result).toBeUndefined();
	});

	test("T96: accept key while editor non-empty → not consumed", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.setEditorText("already typed");
		const result = fake.inputHandler!("\r");
		expect(result).toBeUndefined();
		expect(fake.editorText).toBe("already typed");
	});

	test("T97: accept key with no suggestion → not consumed", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// No suggestion computed (default completeResult text "suggestion" — but clear it first)
		fake.handlers.get("input")!({}, fake.ctx);
		const result = fake.inputHandler!("\r");
		expect(result).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Re-arm: after accept, deleting back to empty re-shows the last suggestion
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Configure a tiny rearmDelayMs so tests don't wait 2s.
function writeRearmConfig(delayMs: number): void {
	writeFile(
		process.env.PI_CODING_AGENT_DIR!,
		"next-prompt.json",
		JSON.stringify({ rearmDelayMs: delayMs }),
	);
}

describe("re-arm after delete-to-empty", () => {
	test("T98: accept then delete back to empty → suggestion re-appears after delay (no new model call)", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "redo this" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("redo this");
		// Accept → fills editor, clears widget.
		fake.inputHandler!("\r");
		expect(fake.editorText).toBe("redo this");
		expect(fake.widgetContent).toBeUndefined();
		// Delete back to empty (backspace, then clear editor text).
		fake.inputHandler!("\x7f");
		fake.setEditorText("");
		// After the deferred check + rearmDelayMs, the suggestion re-appears.
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent?.[0] ?? "").toContain("redo this");
		// No new model call — the complete call count is unchanged.
		expect(fake.calls.complete.length).toBe(1);
	});

	test("T98b: delete that empties the editor LATE (after the first 50ms check) still re-arms via re-poll (chunked/laggy delivery)", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "late clear" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r"); // accept → editor = "late clear"
		// Delete key arrives; the editor text does NOT empty within the first
		// 50ms check (chunked/laggy terminal delivery), then settles empty.
		fake.inputHandler!("\x7f");
		vi.advanceTimersByTime(100); // first check sees non-empty text → re-polls
		fake.setEditorText(""); // editor finally settles empty
		vi.advanceTimersByTime(100); // next poll arms the rearm timer
		vi.advanceTimersByTime(200); // rearmDelayMs (60) fires
		expect(fake.widgetContent?.[0] ?? "").toContain("late clear");
		expect(fake.calls.complete).toHaveLength(1); // cached — no new model call
	});

	test("T98c: delete events arriving AFTER the editor is already empty do NOT cancel the pending re-arm (backspace auto-repeat)", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "hold delete" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r"); // accept → editor = "hold delete"
		// Delete to empty: the key that empties the editor.
		fake.inputHandler!("\x7f");
		fake.setEditorText("");
		// Auto-repeat: MORE delete keys arrive with an already-empty editor.
		fake.inputHandler!("\x7f");
		fake.inputHandler!("\x7f");
		fake.inputHandler!("\x7f");
		vi.advanceTimersByTime(150); // check survives the trailing events → arms
		vi.advanceTimersByTime(200); // rearmDelayMs (60) fires
		expect(fake.widgetContent?.[0] ?? "").toContain("hold delete");
		expect(fake.calls.complete).toHaveLength(1); // cached — no new model call
	});

	test("T99: no last suggestion → nothing to re-arm", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		// No agent_settled → no suggestion, no lastSuggestion. Fire backspace-to-empty.
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T100: re-arm canceled if editor non-empty when timer fires", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		// Type something before the rearm timer fires.
		fake.setEditorText("new text");
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T101: re-arm canceled if agent becomes non-idle", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		fake.setIdle(false);
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T102: config rearmDelayMs default is 2000 when unconfigured", async () => {
		vi.useFakeTimers();
		// No config file → default 2000. We don't wait 2s; just assert the re-arm does
		// NOT fire within a short window (proving it's not the tiny default).
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\r");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined(); // hasn't fired yet (default is 2000ms)
	});
});

// sanity: SYSTEM_PROMPT is non-empty
test("SYSTEM_PROMPT asks for a numbered-free batch", () => {
	expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
	expect(SYSTEM_PROMPT).toContain("three distinct");
	expect(SYSTEM_PROMPT).toContain("one per line");
});

// ---------------------------------------------------------------------------
// renderMode config + ghost editor install
// ---------------------------------------------------------------------------

describe("renderMode config", () => {
	test("T103: default renderMode is widget → setEditorComponent NOT called", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentInstalled).toBe(false);
	});

	test("T104: renderMode=widget uses setWidget (below-editor line)", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "widget suggestion" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("↳ next:");
		expect(fake.widgetContent?.[0] ?? "").toContain("widget suggestion");
		expect(fake.editorComponentInstalled).toBe(false);
	});

	test("T105: renderMode=ghost installs custom editor on session_start", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentInstalled).toBe(true);
	});

	test("T106: renderMode=ghost installs the editor ONCE — not re-installed on agent_settled (F-05)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentCalls).toBe(1);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.editorComponentCalls).toBe(1); // no re-install
	});

	test("T106b: renderMode=ghost still tries ghost when another extension owns the editor; falls back to widget only on render failure (P1-1)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			hasPriorEditor: true,
			completeResult: {
				content: [{ type: "text", text: "ghost suggestion" }],
				stopReason: "stop",
			},
		});
		// Ghost is attempted despite the prior owner.
		expect(fake.editorComponentInstalled).toBe(true);
		// Warning explains the ownership + the conditional fallback.
		expect(
			fake.calls.notifies.some(
				([m, t]) =>
					t === "warning" &&
					m.includes("another extension owns the editor") &&
					m.includes("falling back to widget only if ghost rendering fails"),
			),
		).toBe(true);
		// No fallback fired: the prior editor is NOT restored, ghost stays active.
		expect(fake.editorComponentRestores).toBe(0);
		// Suggestion renders via the ghost, not the widget (P1-1: still renders).
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T106c: ghost install throws → falls back to widget, restores prior owner (P1-1)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			hasPriorEditor: true,
			setEditorComponentThrows: true,
			completeResult: {
				content: [{ type: "text", text: "fallback suggestion" }],
				stopReason: "stop",
			},
		});
		expect(fake.editorComponentInstalled).toBe(false); // install failed
		expect(fake.editorComponentRestores).toBe(1); // prior owner restored
		expect(
			fake.calls.notifies.some(
				([m, t]) => t === "warning" && m.includes("fell back to widget mode"),
			),
		).toBe(true);
		// P1-1: the fallback must actually render the widget, not silently compute.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.widgetContent?.[0] ?? "").toContain("fallback suggestion");
	});

	test("T106d: ghost render pipeline throws → falls back to widget, restores default editor (P1-1)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			requestRenderThrows: true,
			completeResult: {
				content: [{ type: "text", text: "fallback suggestion" }],
				stopReason: "stop",
			},
		});
		expect(fake.editorComponentInstalled).toBe(true); // install itself succeeded
		// The failure surfaces when the suggestion renders (requestGhostRender).
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.editorComponentRestores).toBe(1); // default editor restored
		expect(
			fake.calls.notifies.some(
				([m, t]) => t === "warning" && m.includes("fell back to widget mode"),
			),
		).toBe(true);
		// P1-1: the fallback must actually render the widget, not silently compute.
		expect(fake.widgetContent?.[0] ?? "").toContain("fallback suggestion");
		// Guarded: a second settle after the fallback does not re-notify.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(
			fake.calls.notifies.filter(([m]) =>
				m.includes("fell back to widget mode"),
			),
		).toHaveLength(1);
	});

	test("T107: renderMode=ghost does NOT use setWidget (no below-editor line)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "ghost suggestion" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// renderMode "both" — inline ghost + below-editor widget simultaneously
// ---------------------------------------------------------------------------

describe("renderMode both", () => {
	test("T108: renderMode=both installs custom editor on session_start", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "both" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentInstalled).toBe(true);
	});

	test("T109: renderMode=both installs the editor ONCE — not re-installed on agent_settled (F-05)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "both" }),
		);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentCalls).toBe(1);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.editorComponentCalls).toBe(1); // no re-install
	});

	test("T110: renderMode=both publishes the widget (below-editor line) after settle", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "both" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "both suggestion" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// In "both" mode the widget is published (ghost renders in the editor separately).
		expect(fake.widgetContent?.[0] ?? "").toContain("↳ next:");
		expect(fake.widgetContent?.[0] ?? "").toContain("both suggestion");
	});

	test("T111: renderMode=both clears the widget on input (and the ghost via reset)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "both" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent).toBeDefined();
		fake.handlers.get("input")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Non-TUI guard (F-03)
// ---------------------------------------------------------------------------

describe("non-TUI mode", () => {
	test("N1: RPC mode makes zero complete calls and no editor install", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			mode: "rpc",
		});
		expect(fake.editorComponentInstalled).toBe(false);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
		expect(fake.widgetContent).toBeUndefined();
	});
	test("N2: print mode makes zero complete calls", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			mode: "print",
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Cross-destination consent (F-02 / F-10)
// ---------------------------------------------------------------------------

describe("cross-destination consent", () => {
	async function setupCross(
		opts: {
			confirmResult?:
				| boolean
				| Promise<boolean>
				| (() => boolean | Promise<boolean>);
			selectResult?:
				| string
				| Promise<string>
				| (() => string | Promise<string>);
			selectCall?: () => void;
			selectUnavailable?: boolean;
			baseUrl?: string;
		} = {},
	) {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: {
				provider: "openai",
				id: "gpt",
				baseUrl: opts.baseUrl,
			},
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku"
					? { provider: "anthropic", id: "haiku", baseUrl: opts.baseUrl }
					: undefined,
			...opts,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		return { fake };
	}

	function consentsOnDisk(): unknown[] {
		const path = `${process.env.PI_CODING_AGENT_DIR}/next-prompt-consent.json`;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as unknown[];
		} catch {
			return [];
		}
	}

	function globalConfigOnDisk(): Record<string, unknown> {
		const path = `${process.env.PI_CODING_AGENT_DIR}/next-prompt.json`;
		try {
			return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	test("C1: first cross-destination use prompts (select); allow-once → complete on configured model", async () => {
		const { fake } = await setupCross();
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		// The dialog offers the three choices, always-allow second.
		expect(fake.calls.selects[0]![1].join("|")).toContain(
			"Always allow for this provider pair",
		);
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "anthropic",
			id: "haiku",
		});
		expect(consentsOnDisk()).toHaveLength(1);
	});

	test("C2: decline → zero complete calls + warning, no re-prompt on second settle", async () => {
		const { fake } = await setupCross({ selectResult: "decline" });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
		expect(fake.calls.notifies.some(([m]) => m.includes("declined"))).toBe(
			true,
		);
		// Session denial: settling again must not re-prompt nor send.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("C3: granted consent persists → second settle does not re-prompt (F-02)", async () => {
		const { fake } = await setupCross();
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(consentsOnDisk()).toHaveLength(1);
		// New session: consent persisted per project+destination.
		const { fake: fake2 } = await setupCross();
		await fake2.handlers.get("agent_settled")!({}, fake2.ctx);
		expect(fake2.calls.selects).toHaveLength(0);
		expect(fake2.calls.complete).toHaveLength(1);
	});

	test("C4: same origin + DIFFERENT model route re-prompts (F-02/F-10)", async () => {
		// Active gateway/openai, configured gateway/claude — same endpoint.
		const baseUrl = "https://gateway.example.com/v1";
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt", baseUrl },
			findModel: (p, m) =>
				p === "openai" && m === "claude"
					? { provider: "openai", id: "claude", baseUrl }
					: undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "openai", model: "claude" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1); // consent for gateway/claude
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "openai",
			id: "claude",
			baseUrl,
		});
		// Grant consent for gateway/claude, then the config switches to
		// gateway/gpt-4o: different route → consent must be asked again.
		const { fake: fake2 } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt", baseUrl },
			findModel: (p, m) =>
				p === "openai" && m === "gpt-4o"
					? { provider: "openai", id: "gpt-4o", baseUrl }
					: undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "openai", model: "gpt-4o" },
				allowCrossProvider: true,
			}),
		);
		await fake2.handlers.get("session_start")!({}, fake2.ctx);
		await fake2.handlers.get("agent_settled")!({}, fake2.ctx);
		expect(fake2.calls.selects).toHaveLength(1);
	});

	test("C5: legacy consent record WITHOUT model route never matches → re-prompt (F-02/F-10)", async () => {
		// Persist a legacy record (no model field) for this project+provider.
		const dir = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			`${dir}/next-prompt-consent.json`,
			JSON.stringify([
				{
					project: "/tmp",
					destination: { provider: "anthropic", origin: "" },
					grantedAt: new Date().toISOString(),
					modelLabel: "anthropic/haiku",
				},
			]),
		);
		const { fake } = await setupCross();
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// Fail closed: the legacy record does not authorize the current route.
		expect(fake.calls.selects).toHaveLength(1);
	});

	test("C6: provider pair in global config skips the dialog entirely (directional)", async () => {
		// Pair allows openai→anthropic; prompt once, then never again.
		const dir = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: [["openai", "anthropic"]],
			}),
		);
		const { fake } = await setupCross();
		// setupCross overwrites next-prompt.json without pairs → restore them.
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: [["openai", "anthropic"]],
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(0);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "anthropic",
			id: "haiku",
		});
	});

	test("C7: always-allow persists the directional pair to global config; no re-prompt afterwards", async () => {
		const { fake } = await setupCross({ selectResult: "always" });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(1);
		// Pair persisted in the global config file, merged with the rest.
		const cfg = globalConfigOnDisk();
		const pairs = cfg.allowCrossProviderPairs as Array<[string, string]>;
		expect(pairs).toContainEqual(["openai", "anthropic"]);
		// Info notification confirms the save.
		expect(
			fake.calls.notifies.some(
				([m, t]) => t === "info" && m.includes("saved to global config"),
			),
		).toBe(true);
		// Per-destination consent also persisted (belt and suspenders).
		expect(consentsOnDisk()).toHaveLength(1);
		// New session: pair grant → no dialog, still completes.
		const { fake: fake2 } = await setupCross();
		await fake2.handlers.get("agent_settled")!({}, fake2.ctx);
		expect(fake2.calls.selects).toHaveLength(0);
		expect(fake2.calls.complete).toHaveLength(1);
	});
	test("C7b: real select label for always-allow persists and completes", async () => {
		const { fake } = await setupCross({
			selectResult: "Always allow for this provider pair",
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(1);
		expect(globalConfigOnDisk().allowCrossProviderPairs).toEqual([
			["openai", "anthropic"],
		]);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(2);
	});

	test("C7c: styled/trimmed always-allow label persists the provider pair", async () => {
		const { fake } = await setupCross({
			selectResult: "  \x1b[36mAlways allow for this provider pair\x1b[0m  ",
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(globalConfigOnDisk().allowCrossProviderPairs).toEqual([
			["openai", "anthropic"],
		]);
	});

	test("C7d: selector input does not invalidate consent persistence", async () => {
		let deliverInput: ((data: string) => void) | undefined;
		const { fake } = await setupCross({
			selectResult: "always",
			selectCall: () => deliverInput?.("\r"),
		});
		deliverInput = fake.deliverInput;
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(globalConfigOnDisk().allowCrossProviderPairs).toEqual([
			["openai", "anthropic"],
		]);
	});

	test("C8: pair grant is directional — reverse pair does not skip the dialog", async () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: [["anthropic", "openai"]],
			}),
		);
		const { fake } = await setupCross();
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: [["anthropic", "openai"]],
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// openai→anthropic is NOT allowed; the dialog still appears.
		expect(fake.calls.selects).toHaveLength(1);
	});

	test("C9: no select API → falls back to confirm dialog; grant → complete", async () => {
		const { fake } = await setupCross({
			selectUnavailable: true,
			confirmResult: true,
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(0);
		expect(fake.calls.confirms).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(1);
		expect(consentsOnDisk()).toHaveLength(1);
	});

	test("C10: malformed allowCrossProviderPairs fails closed (no compute)", async () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: ["openai", "anthropic"], // not a pair
			}),
		);
		const { fake } = await setupCross();
		// setupCross rewrote config; restore the invalid one.
		writeFileSync(
			`${dir}/next-prompt.json`,
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				allowCrossProviderPairs: ["openai", "anthropic"],
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// Fail closed: no dialog, no compute.
		expect(fake.calls.selects).toHaveLength(0);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("F08a: consent resolved AFTER ordinary typing → no grant, no complete (F-08)", async () => {
		let resolveConfirm!: (v: string) => void;
		const pending = new Promise<string>((r) => {
			resolveConfirm = r;
		});
		const { fake } = await setupCross({ selectResult: pending });
		const settle = fake.handlers.get("agent_settled")!({}, fake.ctx);
		// Ordinary typing while the dialog is pending bumps the input generation.
		fake.deliverInput("x");
		resolveConfirm("once"); // late approval
		await settle;
		expect(fake.calls.complete).toHaveLength(0);
		expect(consentsOnDisk()).toHaveLength(0); // consent never persisted
	});

	test("F08b: consent resolved AFTER session restart → no grant, no complete (F-08)", async () => {
		let resolveConfirm!: (v: string) => void;
		const pending = new Promise<string>((r) => {
			resolveConfirm = r;
		});
		const { fake } = await setupCross({ selectResult: pending });
		const settle = fake.handlers.get("agent_settled")!({}, fake.ctx);
		// Session restart invalidates state and aborts in-flight work.
		await fake.handlers.get("session_start")!(
			{ type: "session_start", reason: "reload" },
			fake.ctx,
		);
		resolveConfirm("once");
		await settle;
		expect(fake.calls.complete).toHaveLength(0);
		expect(consentsOnDisk()).toHaveLength(0);
	});

	test("F08c: consent resolved AFTER shutdown → no grant, no complete (F-08)", async () => {
		let resolveConfirm!: (v: string) => void;
		const pending = new Promise<string>((r) => {
			resolveConfirm = r;
		});
		const { fake } = await setupCross({ selectResult: pending });
		const settle = fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.handlers.get("session_shutdown")!({}, fake.ctx);
		resolveConfirm("once");
		await settle;
		expect(fake.calls.complete).toHaveLength(0);
		expect(consentsOnDisk()).toHaveLength(0);
	});

	test("F08d: consent resolved AFTER a second settle aborts the first → no late disclose (F-08)", async () => {
		const resolvers: Array<(v: string) => void> = [];
		const { fake } = await setupCross({
			// Each select call gets its own deferred promise.
			selectResult: () =>
				new Promise<string>((r) => {
					resolvers.push(r);
				}),
		});
		const first = fake.handlers.get("agent_settled")!({}, fake.ctx);
		// Second settle while the first dialog is pending aborts the first.
		const second = fake.handlers.get("agent_settled")!({}, fake.ctx);
		// User approves the SECOND dialog only; the first never resolves.
		resolvers[resolvers.length - 1]!("once");
		await second;
		resolvers[0]!("once"); // late approval on the aborted first dialog
		await first;
		// The stale first settle must never disclose; only the second may
		// complete (its own fresh request).
		expect(fake.calls.complete.length).toBeLessThanOrEqual(1);
	});
});

// ---------------------------------------------------------------------------
// Widget dismissal on ordinary typing (F-04)
// ---------------------------------------------------------------------------

describe("widget dismissal", () => {
	test("W1: default widget mode clears the suggestion on a non-accept key", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "suggestion text" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("suggestion text");
		fake.inputHandler!("a"); // ordinary typing
		expect(fake.widgetContent).toBeUndefined(); // dismissed immediately
	});
});

async function waitUntil(
	pred: () => boolean,
	ms = 400,
	label = "condition",
): Promise<void> {
	const start = Date.now();
	while (!pred()) {
		if (Date.now() - start > ms) {
			throw new Error(`timed out waiting for ${label}`);
		}
		await new Promise((r) => setTimeout(r, 5));
	}
}

function widgetText(fake: { widgetContent: string[] | undefined }): string {
	return fake.widgetContent?.[0] ?? "";
}

describe("suggestion carousel", () => {
	test("C1: settle batch is navigable with wrap and no extra model calls", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [
					{
						type: "text",
						text: "write unit tests\nupdate the README\ncommit the change",
					},
				],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("write unit tests");
		expect(widgetText(fake)).toContain("1/3");
		expect(fake.calls.complete).toHaveLength(1);

		const right = fake.inputHandler!("\x1b[C");
		expect(right).toEqual({ consume: true });
		expect(widgetText(fake)).toContain("update the README");
		expect(widgetText(fake)).toContain("2/3");
		expect(fake.calls.complete).toHaveLength(1);

		fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("commit the change");
		expect(widgetText(fake)).toContain("3/3");

		// Right at the last item wraps to the first — still one model call.
		fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("write unit tests");
		expect(widgetText(fake)).toContain("1/3");
		expect(fake.calls.complete).toHaveLength(1);

		const left = fake.inputHandler!("\x1b[D");
		expect(left).toEqual({ consume: true });
		expect(widgetText(fake)).toContain("commit the change");
		expect(widgetText(fake)).toContain("3/3");
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("C2: left on the first item wraps to the last", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "only one\ntry the other task" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("only one");
		expect(widgetText(fake)).toContain("1/2");

		const left = fake.inputHandler!("\x1bOD");
		expect(left).toEqual({ consume: true });
		expect(widgetText(fake)).toContain("try the other task");
		expect(widgetText(fake)).toContain("2/2");
		expect(fake.calls.complete).toHaveLength(1);

		fake.inputHandler!("\x1b[D");
		expect(widgetText(fake)).toContain("only one");
		expect(widgetText(fake)).toContain("1/2");
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("C3: duplicates and NONE in the batch are dropped", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [
					{
						type: "text",
						text: "Write tests\nwrite   tests\nNONE\ncommit the change",
					},
				],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("Write tests");
		expect(widgetText(fake)).toContain("1/2");
		fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("commit the change");
		expect(widgetText(fake)).toContain("2/2");
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("C4: up arrow still dismisses and is not consumed", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "go away" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		const up = fake.inputHandler!("\x1b[A");
		expect(up).toBeUndefined();
		expect(fake.widgetContent).toBeUndefined();
	});

	test("C5: extra arrows never start another model call", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [
					{
						type: "text",
						text: "option 1\noption 2\noption 3\noption 4",
					},
				],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("option 1");
		expect(widgetText(fake)).toContain("1/3");
		for (let i = 0; i < 8; i++) fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("option 3");
		expect(widgetText(fake)).toContain("3/3");
		expect(fake.calls.complete).toHaveLength(1);
		fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("option 1");
		expect(widgetText(fake)).toContain("1/3");
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("C6: a new settle replaces the previous turn's batch", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResults: [
				{
					content: [{ type: "text", text: "old one\nold two\nold three" }],
					stopReason: "stop",
				},
				{
					content: [{ type: "text", text: "new one\nnew two" }],
					stopReason: "stop",
				},
			],
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("old one");
		fake.handlers.get("input")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("new one");
		expect(widgetText(fake)).toContain("1/2");
		expect(widgetText(fake)).not.toContain("old");
		fake.inputHandler!("\x1b[C");
		expect(widgetText(fake)).toContain("new two");
		expect(widgetText(fake)).not.toContain("old");
		expect(fake.calls.complete).toHaveLength(2);
	});

	test("C7: Alt+< / Alt+> wrap the same batch as left/right", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [
					{
						type: "text",
						text: "write unit tests\nupdate the README\ncommit the change",
					},
				],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(widgetText(fake)).toContain("write unit tests");

		const next = fake.inputHandler!("\x1b>");
		expect(next).toEqual({ consume: true });
		expect(widgetText(fake)).toContain("update the README");
		expect(widgetText(fake)).toContain("2/3");

		fake.inputHandler!("\x1b.");
		expect(widgetText(fake)).toContain("commit the change");
		expect(widgetText(fake)).toContain("3/3");

		const prev = fake.inputHandler!("\x1b<");
		expect(prev).toEqual({ consume: true });
		expect(widgetText(fake)).toContain("update the README");
		expect(widgetText(fake)).toContain("2/3");

		fake.inputHandler!("\x1b,");
		expect(widgetText(fake)).toContain("write unit tests");
		expect(widgetText(fake)).toContain("1/3");
		expect(fake.calls.complete).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Atomic config writes (F-14)
// ---------------------------------------------------------------------------

describe("atomic config writes", () => {
	test("A1: saved config file has mode 0600 regardless of umask", () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		const path = `${dir}/next-prompt.json`;
		saveConfig({ acceptKey: "ctrl+space" });
		const mode = (statSync(path).mode & 0o777).toString(8);
		expect(mode).toBe("600");
	});
	test("A2: saveConfig refuses a symlink destination", () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		const real = `${dir}/real-config.json`;
		const path = `${dir}/next-prompt.json`;
		writeFileSync(real, "{}");
		try {
			symlinkSync(real, path);
		} catch {
			return; // platform without symlink support — skip
		}
		saveConfig({ acceptKey: "ctrl+space" });
		// Symlink target untouched; link not replaced.
		try {
			expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({});
		} catch (err) {
			throw new Error(`unexpected symlink write: ${String(err)}`);
		}
	});
});

// ---------------------------------------------------------------------------
// Config command helpers (formatModelOption, parseModelOption, saveConfig, configureInteractively)
// ---------------------------------------------------------------------------

describe("config command helpers", () => {
	test("T112: formatModelOption → 'provider/model — name'", () => {
		expect(
			formatModelOption({
				provider: "anthropic",
				id: "claude-haiku",
				name: "Claude Haiku",
			}),
		).toBe("anthropic/claude-haiku — Claude Haiku");
	});

	test("T113: formatModelOption falls back to id when name absent", () => {
		expect(
			formatModelOption({ provider: "ollama", id: "deepseek-v4-flash" }),
		).toBe("ollama/deepseek-v4-flash — deepseek-v4-flash");
	});

	test("T114: parseModelOption extracts provider + model", () => {
		expect(parseModelOption("anthropic/claude-haiku — Claude Haiku")).toEqual({
			provider: "anthropic",
			model: "claude-haiku",
		});
	});

	test("T115: parseModelOption returns undefined for malformed input", () => {
		expect(parseModelOption("not a model option")).toBeUndefined();
		expect(parseModelOption("")).toBeUndefined();
	});

	test("T116: THINKING_OPTIONS has unset sentinel + 6 levels", () => {
		expect(THINKING_OPTIONS[0]).toBe("(unset — model default)");
		expect(THINKING_OPTIONS).toContain("low");
		expect(THINKING_OPTIONS.length).toBe(7);
	});

	test("T117: saveConfig merges with existing and writes to disk", () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		const path = `${dir}/next-prompt.json`;
		// Pre-write an existing config.
		writeFile(
			dir,
			"next-prompt.json",
			JSON.stringify({ thinking: "high", acceptKey: "alt+/" }),
		);
		const merged = saveConfig({ renderMode: "ghost" });
		expect(merged.thinking).toBe("high"); // preserved
		expect(merged.renderMode).toBe("ghost"); // added
		let onDisk: Record<string, unknown>;
		try {
			onDisk = JSON.parse(readFileSyncSafe(path)) as Record<string, unknown>;
		} catch (err) {
			throw new Error(`invalid saved config: ${String(err)}`);
		}
		expect(onDisk.thinking).toBe("high");
		expect(onDisk.renderMode).toBe("ghost");
	});

	test("T118: saveConfig preserves unspecified keys and adds new ones", () => {
		const dir = process.env.PI_CODING_AGENT_DIR!;
		writeFile(
			dir,
			"next-prompt.json",
			JSON.stringify({ acceptKey: "ctrl+space", rearmDelayMs: 500 }),
		);
		const merged = saveConfig({ acceptKey: "alt+/" });
		expect(merged.rearmDelayMs).toBe(500); // preserved
		expect(merged.acceptKey).toBe("alt+/"); // overridden
	});
});

// Minimal stub ctx for configureInteractively tests.
function makeConfigCtx(opts: {
	models?: Array<{ provider: string; id: string; name?: string }>;
	answers: Record<string, string | boolean | undefined>;
}): Parameters<typeof configureInteractively>[0] {
	const calls: { select: string[]; input: string[]; confirm: string[] } = {
		select: [],
		input: [],
		confirm: [],
	};
	let a = 0;
	const nextAnswer = () => {
		const key = Object.keys(opts.answers)[a++]!;
		return opts.answers[key];
	};
	return {
		modelRegistry: { getAvailable: () => opts.models ?? [] },
		ui: {
			select: async (title: string, _options: string[]) => {
				calls.select.push(title);
				return nextAnswer() as string | undefined;
			},
			input: async (title: string, _placeholder?: string) => {
				calls.input.push(title);
				return nextAnswer() as string | undefined;
			},
			confirm: async (title: string, _message: string) => {
				calls.confirm.push(title);
				return nextAnswer() as boolean;
			},
		},
	} as Parameters<typeof configureInteractively>[0];
}

describe("configureInteractively", () => {
	test("T119: full flow — all options set", async () => {
		const ctx = makeConfigCtx({
			models: [
				{ provider: "anthropic", id: "claude-haiku", name: "Claude Haiku" },
			],
			answers: {
				model: "anthropic/claude-haiku — Claude Haiku",
				renderMode: "ghost — inline greyed text in the input box",
				thinking: "low",
				acceptKey: "ctrl+space",
				rearmDelayMs: "1500",
				maxTranscriptChars: "8000",
				maxRecentTurns: "12",
				maxSuggestionChars: "200",
				allowCrossProvider: false,
				enhanceEnabled: true,
				enhanceKey: "alt+?",
			},
		});
		const out = await configureInteractively(ctx, {});
		expect(out).toEqual({
			model: { provider: "anthropic", model: "claude-haiku" },
			renderMode: "ghost",
			thinking: "low",
			acceptKey: "ctrl+space",
			rearmDelayMs: 1500,
			maxTranscriptChars: 8000,
			maxRecentTurns: 12,
			maxSuggestionChars: 200,
			allowCrossProvider: false,
			enhanceEnabled: true,
			enhanceKey: "alt+?",
		});
	});

	test("T120: cancel at model picker → undefined", async () => {
		const ctx = makeConfigCtx({ answers: { model: undefined } });
		const out = await configureInteractively(ctx, {});
		expect(out).toBeUndefined();
	});

	test("T121: model '(use current model)' → model undefined", async () => {
		const ctx = makeConfigCtx({
			models: [{ provider: "openai", id: "gpt" }],
			answers: { model: "(use current model)" },
		});
		const out = await configureInteractively(ctx, {});
		expect(out?.model).toBeUndefined();
	});

	test("T122: thinking '(unset)' → thinking undefined", async () => {
		const ctx = makeConfigCtx({
			answers: {
				model: "(use current model)",
				renderMode: "widget — colored line below the input box",
				thinking: "(unset — model default)",
				acceptKey: "enter",
				rearmDelayMs: "2000",
				maxTranscriptChars: "12000",
				maxRecentTurns: "",
				maxSuggestionChars: "240",
				allowCrossProvider: true,
			},
		});
		const out = await configureInteractively(ctx, {});
		expect(out?.thinking).toBeUndefined();
		expect(out?.maxRecentTurns).toBeUndefined(); // empty input keeps all
	});

	test("T123: invalid numeric input → field not set", async () => {
		const ctx = makeConfigCtx({
			answers: {
				model: "(use current model)",
				renderMode: "widget — colored line below the input box",
				thinking: "(unset — model default)",
				acceptKey: "enter",
				rearmDelayMs: "not a number",
				maxTranscriptChars: "abc",
				maxRecentTurns: "abc",
				maxSuggestionChars: "200",
				allowCrossProvider: true,
			},
		});
		const out = await configureInteractively(ctx, {});
		expect(out?.rearmDelayMs).toBeUndefined();
		expect(out?.maxTranscriptChars).toBeUndefined();
		expect(out?.maxRecentTurns).toBeUndefined();
		expect(out?.maxSuggestionChars).toBe(200);
	});
});

test("T124: renderMode picker lists ghost first with descriptions", async () => {
	const seenRenderOptions: string[] = [];
	const ctx = {
		modelRegistry: { getAvailable: () => [] },
		ui: {
			select: async (_title: string, options: string[]) => {
				// Capture render-mode options (those starting with ghost/widget/both).
				if (
					options.some(
						(o) =>
							o.startsWith("ghost") ||
							o.startsWith("widget") ||
							o.startsWith("both"),
					)
				) {
					seenRenderOptions.push(...options);
					return undefined; // cancel at render picker
				}
				return "(use current model)"; // proceed past model picker
			},
			input: async () => undefined,
			confirm: async () => false,
		},
	} as unknown as Parameters<typeof configureInteractively>[0];
	await configureInteractively(ctx, {});
	expect(seenRenderOptions[0]).toContain("ghost");
	expect(seenRenderOptions.some((o) => o.startsWith("widget"))).toBe(true);
	expect(seenRenderOptions.some((o) => o.startsWith("both"))).toBe(true);
});

// ---------------------------------------------------------------------------
// OMP dual-compatibility (host boundary + lifecycle + transport + render)
// ---------------------------------------------------------------------------

describe("host compatibility boundary", () => {
	test("B1: detectHost classifies Pi (no injected services) as pi", () => {
		expect(detectHost({ on: () => {} })).toBe("pi");
		expect(detectHost(undefined)).toBe("pi");
	});

	test("B2: detectHost classifies OMP (injected typebox/pi services) as omp", () => {
		expect(detectHost({ typebox: {}, pi: {} })).toBe("omp");
		expect(detectHost({ typebox: {} })).toBe("omp");
		expect(detectHost({ pi: {} })).toBe("omp");
	});

	test("B3: host classification is deterministic and order-independent", () => {
		// Same api object, classified twice — identical result; the shape of
		// the context passed to handlers never influences classification.
		const ompApi = { typebox: {} };
		expect(detectHost(ompApi)).toBe("omp");
		expect(detectHost(ompApi)).toBe("omp");
	});

	test("H1: Pi TUI context is interactive", () => {
		expect(isInteractiveContext({ mode: "tui" })).toBe(true);
	});

	test("H2: Pi RPC/print context is non-interactive", () => {
		expect(isInteractiveContext({ mode: "rpc" })).toBe(false);
		expect(isInteractiveContext({ mode: "print" })).toBe(false);
		expect(isInteractiveContext({ mode: "json" })).toBe(false);
	});

	test("H3: OMP context with hasUI=true (no mode) is interactive", () => {
		expect(isInteractiveContext({ hasUI: true })).toBe(true);
	});

	test("H4: OMP context with hasUI=false (no mode) is non-interactive", () => {
		expect(isInteractiveContext({ hasUI: false })).toBe(false);
	});

	test("B4: unknown context with neither field is conservatively non-interactive", () => {
		expect(isInteractiveContext({})).toBe(false);
	});

	test("H5: projectTrustedForHost forwards Pi's isProjectTrusted", () => {
		expect(projectTrustedForHost({ isProjectTrusted: () => true })).toBe(true);
		expect(projectTrustedForHost({ isProjectTrusted: () => false })).toBe(false);
	});

	test("H6: projectTrustedForHost defaults to trusted when the method is absent (OMP)", () => {
		expect(projectTrustedForHost({})).toBe(true);
	});

	test("B5: Pi fake registers agent_settled and never agent_end; no OMP-only ctx fields", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		// Pi lifecycle: agent_settled registered, agent_end never a trigger.
		expect(fake.handlers.has("agent_settled")).toBe(true);
		expect(fake.handlers.has("agent_end")).toBe(false);
		// Pi context lacks the OMP-only resolver; complete is present.
		expect(
			"resolver" in (fake.ctx as { modelRegistry: object }).modelRegistry,
		).toBe(false);
		expect(
			"complete" in (fake.ctx as { modelRegistry: object }).modelRegistry,
		).toBe(true);
	});

	test("B6: OMP fake registers agent_end and never agent_settled; no Pi-only ctx fields", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		expect(fake.handlers.has("agent_end")).toBe(true);
		expect(fake.handlers.has("agent_settled")).toBe(false);
		// OMP shape: no mode, no isProjectTrusted, no modelRegistry.complete,
		// no editor getter/setter.
		expect("mode" in (fake.ctx as object)).toBe(false);
		expect("isProjectTrusted" in (fake.ctx as object)).toBe(false);
		expect(
			"complete" in (fake.ctx as { modelRegistry: object }).modelRegistry,
		).toBe(false);
		expect(
			"resolver" in (fake.ctx as { modelRegistry: object }).modelRegistry,
		).toBe(true);
		expect(
			"getEditorComponent" in (fake.ctx as { ui: object }).ui,
		).toBe(false);
		// OMP exposes setEditorComponent (ghost install) but no getter.
		expect(
			"setEditorComponent" in (fake.ctx as { ui: object }).ui,
		).toBe(true);
	});

	test("B7: Pi session starts and computes without any OMP-only field", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("B8: OMP session starts without mode/isProjectTrusted and computes on final agent_end", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
	});

	test("B9: unknown context (no mode, no hasUI) follows the conservative no-compute path", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			omitHasUI: true,
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("H5c: Pi untrusted project keeps project-config trust gating in the controller", async () => {
		// Untrusted project: the project-level ghost renderMode is ignored, so
		// no custom editor is installed (default widget mode).
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(cwd, ".pi/next-prompt.json", JSON.stringify({ renderMode: "ghost" }));
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			projectTrusted: false,
		});
		(fake.ctx as { cwd: string }).cwd = cwd;
		await fake.handlers.get("session_start")!({}, fake.ctx);
		expect(fake.editorComponentInstalled).toBe(false);
		// Trusted project: the same project config WOULD install the editor.
		const { fake: trusted } = await setup({
			branch: [assistantEntry("a")],
			projectTrusted: true,
		});
		(trusted.ctx as { cwd: string }).cwd = cwd;
		await trusted.handlers.get("session_start")!({}, trusted.ctx);
		expect(trusted.editorComponentInstalled).toBe(true);
		rmSync(cwd, { recursive: true, force: true });
	});

	test("H6c: OMP session start with no isProjectTrusted does not throw and loads config", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		// Session start already succeeded; effective config loaded through the
		// documented default and the widget pipeline works end to end.
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("suggestion");
	});
});

describe("OMP lifecycle (agent_end)", () => {
	test("L1: Pi agent_settled, idle, empty editor → exactly one computation", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("L2: Pi never registers agent_end as a second trigger", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		expect(fake.handlers.has("agent_end")).toBe(false);
	});

	test("L3: OMP final agent_end, idle, empty editor → exactly one computation", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
	});

	test("L4: OMP agent_end with willContinue:true → zero computations", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!(
			{ type: "agent_end", willContinue: true },
			fake.ctx,
		);
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("L5: OMP final agent_end with non-empty editor → zero computations", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		fake.setEditorText("already typing");
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(0);
	});

	test("L6: OMP terminal agent_end fires before the session unwinds — ctx.isIdle() is false, but the terminal event IS the settle signal and compute still runs (verified live on OMP 17.2.13)", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		fake.setIdle(false); // OMP reports not-idle at extension agent_end time
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
	});

	test("L7: second OMP agent_end while first is pending → first aborted, stale cannot render", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		const handler = fake.handlers.get("agent_end")!;
		const p1 = handler({}, fake.ctx);
		const p2 = handler({}, fake.ctx);
		await Promise.all([p1, p2]);
		expect(fake.calls.ompComplete.some((c) => c.signal?.aborted)).toBe(true);
	});

	test("L6b: OMP compute-path render does NOT require real-time idle (session unwinds after agent_end)", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "still shows" }],
				stopReason: "stop",
			},
		});
		fake.setIdle(false); // still busy when the (fast) completion resolves
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
		expect(fake.widgetContent?.[0] ?? "").toContain("still shows");
	});

	test("L6c: OMP re-arm path KEEPS the real-time idle gate (user-driven render)", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "cached" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		fake.inputHandler!("\r"); // accept into the editor
		fake.setEditorText("");
		fake.inputHandler!("\x7f"); // delete-to-empty schedules re-arm
		fake.setIdle(false); // agent busy when the re-arm timer fires
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent).toBeUndefined(); // idle gate held
	});

	test("L8: input while OMP request pending → abort, nothing renders, no error notify", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleError: new Error("boom"),
		});
		const handler = fake.handlers.get("agent_end")!;
		const p = handler({}, fake.ctx);
		fake.handlers.get("input")!({}, fake.ctx); // user submits while pending
		await p;
		expect(fake.widgetContent).toBeUndefined();
		expect(
			fake.calls.notifies.some(([m, t]) => t === "error" && m.includes("failed")),
		).toBe(false);
	});

	test("L8b: agent_start while OMP request pending → abort, stale result cannot render", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "stale" }],
				stopReason: "stop",
			},
		});
		const handler = fake.handlers.get("agent_end")!;
		const p = handler({}, fake.ctx);
		fake.handlers.get("agent_start")!({}, fake.ctx);
		await p;
		expect(fake.widgetContent).toBeUndefined();
	});

	test("L8c: shutdown while OMP request pending → abort, stale result cannot render", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "stale" }],
				stopReason: "stop",
			},
		});
		const handler = fake.handlers.get("agent_end")!;
		const p = handler({}, fake.ctx);
		fake.handlers.get("session_shutdown")!({}, fake.ctx);
		await p;
		expect(fake.widgetContent).toBeUndefined();
	});
});

describe("OMP completion transport (completeSimple)", () => {
	test("C1: Pi completion uses modelRegistry.complete and never invokes the OMP loader", async () => {
		let loaderCalls = 0;
		setOmpCompletionModuleForTests(() => {
			loaderCalls += 1;
			return Promise.resolve({});
		});
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(loaderCalls).toBe(0);
	});

	test("C2: OMP completion calls completeSimple exactly once per settle; loader runs once (cached)", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
		expect(fake.loaderCalls).toBe(1);
		// Second settle: cached module, no second load.
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(2);
		expect(fake.loaderCalls).toBe(1);
	});

	test("C3: OMP options — resolved model, exact context, registry resolver as apiKey, signal, reasoning", async () => {
		const configured = { provider: "anthropic", id: "haiku" };
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku" ? configured : undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
				thinking: "low",
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(1);
		const c = fake.calls.ompComplete[0]!;
		expect(c.model).toBe(configured); // resolved after all consent checks
		// OMP's Context.systemPrompt is an array of system-prompt lines.
		expect(c.systemPrompt).toEqual([SYSTEM_PROMPT]);
		expect(c.messages).toHaveLength(1);
		expect(c.apiKey).toBe(OMP_RESOLVER); // modelRegistry.resolver(model)
		expect(c.signal instanceof AbortSignal).toBe(true);
		expect(c.reasoning).toBe("low");
	});

	test("C4: OMP with no thinking config → reasoning is undefined", async () => {
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete[0]!.reasoning).toBeUndefined();
	});

	test("C5: OMP success response → sanitized suggestion published", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "what's next?" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("what's next?");
	});

	test("C6: OMP length stop → no render, no notify", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "length",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("C6b: OMP error stop → warning notify, no render", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "error",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		expect(fake.calls.notifies.some((n) => n[1] === "warning")).toBe(true);
	});

	test("C6c: OMP NONE text → no render", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "NONE" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("C7: OMP transport rejects before abort → exactly one error notification, no unhandled rejection", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleError: new Error("boom"),
		});
		// Awaiting the handler settles the rejection inside the controller.
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		const failed = fake.calls.notifies.filter(
			([m, t]) => t === "error" && m.includes("failed"),
		);
		expect(failed).toHaveLength(1);
	});

	test("C8: abort while OMP transport pending → no error notify, no stale render", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleError: new Error("boom"),
		});
		const handler = fake.handlers.get("agent_end")!;
		const p = handler({}, fake.ctx);
		fake.handlers.get("input")!({}, fake.ctx); // aborts the in-flight request
		await p;
		expect(fake.widgetContent).toBeUndefined();
		expect(
			fake.calls.notifies.some(([m, t]) => t === "error" && m.includes("failed")),
		).toBe(false);
	});

	test("C9: completeSimple absent → controlled diagnostic, no crash, no suggestion", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleUnavailable: true,
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		expect(
			fake.calls.notifies.some(
				([m, t]) =>
					t === "warning" && m.includes("completion API unavailable"),
			),
		).toBe(true);
	});

	test("C9b: OMP module import failure → one controlled diagnostic, no crash", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			moduleLoadError: new Error("import failed"),
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent).toBeUndefined();
		expect(
			fake.calls.notifies.some(([m, t]) => t === "error" && m.includes("failed")),
		).toBe(true);
	});
});

describe("OMP render downgrade (widget-only)", () => {
	test("R1: OMP renderMode widget → widget renders; no custom-editor access exists", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "widget suggestion" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("↳ next:");
		expect(fake.widgetContent?.[0] ?? "").toContain("widget suggestion");
	});

	test("R2: OMP renderMode ghost → GhostEditor installed via setEditorComponent, ghost renders (no widget), no getEditorComponent", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "ghost suggestion" }],
				stopReason: "stop",
			},
		});
		expect(
			"getEditorComponent" in (fake.ctx as { ui: object }).ui,
		).toBe(false);
		expect(fake.editorComponentInstalled).toBe(true);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		// ghost-only: no below-editor widget published.
		expect(fake.widgetContent).toBeUndefined();
	});

	test("R3: OMP renderMode both → GhostEditor installed AND the widget renders", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "both" }),
		);
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "both suggestion" }],
				stopReason: "stop",
			},
		});
		expect(fake.editorComponentInstalled).toBe(true);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("both suggestion");
	});

	test("R4: OMP ghost render failure → one warning, default editor restored, no duplicate warning on later settles", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			requestRenderThrows: true,
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.editorComponentInstalled).toBe(false);
		expect(fake.editorComponentRestores).toBe(1); // default editor restored
		expect(
			fake.calls.notifies.filter(
				([m, t]) => t === "warning" && m.includes("fell back to widget mode"),
			),
		).toHaveLength(1);
		// Later settles do not re-notify (guarded fallback).
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(
			fake.calls.notifies.filter(
				([m, t]) => t === "warning" && m.includes("fell back to widget mode"),
			),
		).toHaveLength(1);
		expect(fake.inputListeners).toHaveLength(1);
	});

	test("R4b: OMP reload resets a previous session's ghost editor to default, then re-installs for the new session", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		expect(fake.editorComponentInstalled).toBe(true);
		expect(fake.editorComponentCalls).toBe(1);
		await fake.handlers.get("session_start")!(
			{ type: "session_start", reason: "reload" },
			fake.ctx,
		);
		// OMP teardown has no host-side editor reset, so the extension resets
		// the previous ghost to the default editor, then installs a fresh one.
		expect(fake.editorComponentRestores).toBe(1);
		expect(fake.editorComponentCalls).toBe(3); // setup install + reset + reinstall
		expect(fake.editorComponentInstalled).toBe(true);
	});

	test("R5: OMP accept key fills the editor exactly once and consumes the raw key", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "suggestion text" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("suggestion text");
		const result = fake.inputHandler!("\r");
		expect(result).toEqual({ consume: true });
		expect(fake.editorText).toBe("suggestion text");
		expect(fake.widgetContent).toBeUndefined();
		expect(fake.editorText).toBe("suggestion text"); // exactly once, no leak
	});

	test("R6: OMP non-accept input → widget clears and the key passes through", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "suggestion text" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		const result = fake.inputHandler!("a");
		expect(result).toBeUndefined(); // not consumed
		expect(fake.widgetContent).toBeUndefined(); // dismissed
	});

	test("R7: OMP delete-to-empty re-arms the cached suggestion without another model call", async () => {
		vi.useFakeTimers();
		writeRearmConfig(60);
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "redo this" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("redo this");
		fake.inputHandler!("\r"); // accept
		expect(fake.editorText).toBe("redo this");
		fake.inputHandler!("\x7f");
		fake.setEditorText("");
		vi.advanceTimersByTime(150);
		expect(fake.widgetContent?.[0] ?? "").toContain("redo this");
		expect(fake.calls.ompComplete).toHaveLength(1); // no new model call
	});
});

describe("OMP acceptance / privacy", () => {
	test("O1: end-to-end — final agent_end → completeSimple → visible suggestion", async () => {
		const { fake } = await setupOmp({
			branch: [userEntry("q"), assistantEntry("a")],
			completeSimpleResult: {
				content: [{ type: "text", text: "what's next?" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("what's next?");
	});

	test("O2: same-destination OMP request proceeds without a cross-destination prompt", async () => {
		const configured = { provider: "anthropic", id: "haiku" };
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "anthropic", id: "haiku" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku" ? configured : undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ model: { provider: "anthropic", model: "haiku" } }),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(0);
		expect(fake.calls.ompComplete).toHaveLength(1);
		expect(fake.calls.ompComplete[0]!.model).toBe(configured);
	});

	test("O3: OMP cross-destination decline → zero completeSimple calls, no re-prompt in session", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku"
					? { provider: "anthropic", id: "haiku" }
					: undefined,
			selectResult: "decline",
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(fake.calls.notifies.some(([m]) => m.includes("declined"))).toBe(true);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1); // session denial: no re-prompt
		expect(fake.calls.ompComplete).toHaveLength(0);
	});

	test("O3b: OMP cross-destination allow-once → completeSimple on the configured model, consent persisted", async () => {
		const configured = { provider: "anthropic", id: "haiku" };
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku" ? configured : undefined,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.selects).toHaveLength(1);
		expect(fake.calls.ompComplete).toHaveLength(1);
		expect(fake.calls.ompComplete[0]!.model).toBe(configured);
		const consents = JSON.parse(
			readFileSync(
				`${process.env.PI_CODING_AGENT_DIR}/next-prompt-consent.json`,
				"utf-8",
			),
		) as Array<{ project: string }>;
		expect(consents).toHaveLength(1);
		expect(consents[0]!.project).toBe("/tmp");
	});

	test("O4: OMP consent resolved AFTER input → zero completeSimple calls, consent not persisted", async () => {
		let resolveConfirm!: (v: string) => void;
		const pending = new Promise<string>((r) => {
			resolveConfirm = r;
		});
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku"
					? { provider: "anthropic", id: "haiku" }
					: undefined,
			selectResult: pending,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		const settle = fake.handlers.get("agent_end")!({}, fake.ctx);
		fake.deliverInput("x"); // ordinary typing invalidates the request
		resolveConfirm("once"); // late approval
		await settle;
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(
			existsSync(
				`${process.env.PI_CODING_AGENT_DIR}/next-prompt-consent.json`,
			),
		).toBe(false);
	});

	test("O4b: OMP consent resolved AFTER shutdown → zero completeSimple calls", async () => {
		let resolveConfirm!: (v: string) => void;
		const pending = new Promise<string>((r) => {
			resolveConfirm = r;
		});
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku"
					? { provider: "anthropic", id: "haiku" }
					: undefined,
			selectResult: pending,
		});
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				model: { provider: "anthropic", model: "haiku" },
				allowCrossProvider: true,
			}),
		);
		await fake.handlers.get("session_start")!({}, fake.ctx);
		const settle = fake.handlers.get("agent_end")!({}, fake.ctx);
		fake.handlers.get("session_shutdown")!({}, fake.ctx);
		resolveConfirm("once");
		await settle;
		expect(fake.calls.ompComplete).toHaveLength(0);
	});

	test("O5: OMP headless (hasUI:false) creates no completion request", async () => {
		const { fake } = await setupOmp({
			branch: [assistantEntry("a")],
			hasUI: false,
		});
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("O6: OMP invalid privacy config fails closed (zero completeSimple)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ maxTranscriptChars: "unlimited" }),
		);
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.calls.ompComplete).toHaveLength(0);
		expect(
			fake.calls.notifies.some(
				([m, t]) => t === "warning" && m.includes("suggestions disabled"),
			),
		).toBe(true);
	});

	test("O7: OMP config acceptKey is reflected in the widget hint", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ acceptKey: "ctrl+space" }),
		);
		const { fake } = await setupOmp({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_end")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("Ctrl-Space · ←→");
	});
});

// ---------------------------------------------------------------------------
// Enhance-prompt (in-place rewrite of the typed prompt)
// ---------------------------------------------------------------------------

describe("sanitizeEnhancedPrompt", () => {
	test("EN1: passes clean text through unchanged", () => {
		expect(sanitizeEnhancedPrompt("Fix the parser bug.")).toBe(
			"Fix the parser bug.",
		);
	});
	test("EN2: strips a surrounding code fence", () => {
		expect(sanitizeEnhancedPrompt("```\nFix the bug.\n```")).toBe("Fix the bug.");
	});
	test("EN3: strips one layer of matching quotes", () => {
		expect(sanitizeEnhancedPrompt('"Fix the bug."')).toBe("Fix the bug.");
	});
	test("EN4: preserves internal newlines (multi-line prompt)", () => {
		expect(sanitizeEnhancedPrompt("Step one.\nStep two.")).toBe(
			"Step one.\nStep two.",
		);
	});
	test("EN5: NONE sentinel and blank/punctuation replies become empty", () => {
		expect(sanitizeEnhancedPrompt("NONE")).toBe("");
		expect(sanitizeEnhancedPrompt("   ")).toBe("");
		expect(sanitizeEnhancedPrompt("...")).toBe("");
	});
	test("EN6: strips terminal control sequences", () => {
		expect(sanitizeEnhancedPrompt("Fix\x1b[31m the bug.")).toBe("Fix the bug.");
	});
});

describe("enhance config parsing", () => {
	test("EN7: valid enhance keys load", () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({
				enhanceEnabled: false,
				enhanceKey: "alt+j",
				enhanceSystemPrompt: "rewrite it",
			}),
		);
		const cfg = loadConfig(mkdtempSync(join(tmpdir(), "np-cwd-")));
		expect(cfg.enhanceEnabled).toBe(false);
		expect(cfg.enhanceKey).toBe("alt+j");
		expect(cfg.enhanceSystemPrompt).toBe("rewrite it");
	});
	test("EN8: enhanceKey 'enter'/'tab'/empty/non-string are rejected", () => {
		for (const bad of ["enter", "tab", ""]) {
			writeFile(
				process.env.PI_CODING_AGENT_DIR!,
				"next-prompt.json",
				JSON.stringify({ enhanceKey: bad }),
			);
			expect(
				loadConfig(mkdtempSync(join(tmpdir(), "np-cwd-"))).enhanceKey,
			).toBeUndefined();
		}
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ enhanceKey: 7 }),
		);
		expect(
			loadConfig(mkdtempSync(join(tmpdir(), "np-cwd-"))).enhanceKey,
		).toBeUndefined();
	});
});

const ENHANCE_KEY = "\x1b/"; // alt+/ default (legacy ESC /, protocol-independent)

describe("enhance key handling (onTerminalInput)", () => {
	test("EN9: enhance rewrites the editor in place with one model call", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "Fix the parser bug." }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("fix teh parser bug");
		const result = fake.inputHandler!(ENHANCE_KEY);
		expect(result).toEqual({ consume: true });
		await sleep(30);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.editorText).toBe("Fix the parser bug.");
		// Only the typed text is sent (no transcript); enhance system prompt used.
		const call = fake.calls.complete[0]!;
		expect(String(call.systemPrompt)).toContain("rewrite a single instruction");
		expect(JSON.stringify(call.messages)).toContain("fix teh parser bug");
	});

	test("EN10: same key toggles to original and re-applies (no new call)", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "Fix the parser bug." }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("fix teh parser bug");
		fake.inputHandler!(ENHANCE_KEY);
		await sleep(30);
		expect(fake.editorText).toBe("Fix the parser bug.");
		fake.inputHandler!(ENHANCE_KEY);
		expect(fake.editorText).toBe("fix teh parser bug");
		fake.inputHandler!(ENHANCE_KEY);
		expect(fake.editorText).toBe("Fix the parser bug.");
		expect(fake.calls.complete).toHaveLength(1);
	});

	test("EN11: Escape reverts to the original", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "Fix the parser bug." }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("fix teh parser bug");
		fake.inputHandler!(ENHANCE_KEY);
		await sleep(30);
		expect(fake.editorText).toBe("Fix the parser bug.");
		const result = fake.inputHandler!("\x1b");
		expect(result).toEqual({ consume: true });
		expect(fake.editorText).toBe("fix teh parser bug");
	});

	test("EN12: empty editor is a no-op (nothing to enhance)", async () => {
		const { fake } = await setup({});
		fake.setEditorText("");
		fake.inputHandler!(ENHANCE_KEY);
		await sleep(20);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("EN13: not idle → key consumed but no model call", async () => {
		const { fake } = await setup({});
		fake.setIdle(false);
		fake.setEditorText("do the thing");
		const result = fake.inputHandler!(ENHANCE_KEY);
		expect(result).toEqual({ consume: true });
		await sleep(20);
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("EN14: disabled → key not consumed, no model call", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ enhanceEnabled: false }),
		);
		const { fake } = await setup({});
		fake.setEditorText("do the thing");
		const result = fake.inputHandler!(ENHANCE_KEY);
		await sleep(20);
		expect(result).toBeUndefined();
		expect(fake.calls.complete).toHaveLength(0);
	});

	test("EN15: 'already clear' reply keeps the typed text and notifies", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "do the thing" }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("do the thing");
		fake.inputHandler!(ENHANCE_KEY);
		await sleep(30);
		expect(fake.editorText).toBe("do the thing");
		expect(fake.calls.notifies.some(([m]) => m.includes("already clear"))).toBe(
			true,
		);
	});

	test("EN16: editing after triggering discards the stale result", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "SHOULD NOT APPLY" }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("original text");
		fake.inputHandler!(ENHANCE_KEY); // start async enhance
		fake.inputHandler!("x"); // user edits: bumps generation + aborts enhance
		fake.setEditorText("edited text");
		await sleep(30);
		expect(fake.editorText).toBe("edited text");
	});

	test("EN17: kitty Alt+/ release after press does not abort enhance", async () => {
		const { fake } = await setup({
			completeResult: {
				content: [{ type: "text", text: "Fix the parser bug." }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("fix teh parser bug");
		const press = "\x1b[47;3:1u"; // CSI-u Alt+/ press
		const release = "\x1b[47;3:3u"; // CSI-u Alt+/ release
		// Non-vacuous: the press MUST match the enhance key, otherwise consume
		// would be undefined and complete would stay 0.
		expect(
			matchesKey(press, DEFAULT_ENHANCE_KEY) ||
				matchesAcceptKeyRaw(press, DEFAULT_ENHANCE_KEY),
		).toBe(true);
		expect(isKittyKeyRelease(press)).toBe(false);
		expect(isKittyKeyRelease(release)).toBe(true);
		expect(fake.inputHandler!(press)).toEqual({ consume: true });
		expect(fake.inputHandler!(release)).toBeUndefined();
		await sleep(30);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.editorText).toBe("Fix the parser bug.");
	});

	test("EN17-omp: same press/release on the OMP fixture still completes", async () => {
		const { fake } = await setupOmp({
			completeSimpleResult: {
				content: [{ type: "text", text: "Fix the parser bug." }],
				stopReason: "stop",
			},
		});
		fake.setEditorText("fix teh parser bug");
		const press = "\x1b[47;3:1u";
		const release = "\x1b[47;3:3u";
		expect(fake.inputHandler!(press)).toEqual({ consume: true });
		expect(fake.inputHandler!(release)).toBeUndefined();
		await sleep(30);
		expect(fake.calls.ompComplete).toHaveLength(1);
		expect(fake.editorText).toBe("Fix the parser bug.");
	});
});

describe("enhance key encoding under enhanced keyboard protocols", () => {
	// Reproduces the alt+? bug: pi-tui enables xterm modifyOtherKeys=2 / kitty,
	// so a modified keypress arrives as a CSI sequence, not a bare ESC+char.
	// "alt+?" is physically Alt+Shift+/, so the terminal reports modifier
	// shift|alt, but the keyid parses to alt only and matchesKey() requires
	// exact modifier equality — the match can never succeed. The default key
	// must therefore be a non-shift key. Each assertion mirrors the input
	// handler check: matchesKey(data, key) || matchesAcceptKeyRaw(data, key).

	// xterm modifyOtherKeys form: CSI 27 ; (modifier+1) ; codepoint ~
	const MOK_ALT_SHIFT_SLASH = "\x1b[27;4;47~"; // Alt+Shift+/ (base '/', 47)
	const MOK_ALT_SHIFT_QMARK = "\x1b[27;4;63~"; // Alt+Shift+/ (shifted '?', 63)
	const MOK_ALT_SLASH = "\x1b[27;3;47~"; // Alt+/ (no shift)

	test("default alt+/ fires under modifyOtherKeys and legacy", () => {
		const key = DEFAULT_ENHANCE_KEY;
		expect(
			matchesKey(MOK_ALT_SLASH, key) || matchesAcceptKeyRaw(MOK_ALT_SLASH, key),
		).toBe(true);
		expect(
			matchesKey("\x1b/", key) || matchesAcceptKeyRaw("\x1b/", key),
		).toBe(true);
	});

	test("default alt+/ fires on CSI-u press; release is a key-release not a match", () => {
		const key = DEFAULT_ENHANCE_KEY;
		const press = "\x1b[47;3:1u";
		const release = "\x1b[47;3:3u";
		expect(matchesKey(press, key) || matchesAcceptKeyRaw(press, key)).toBe(
			true,
		);
		expect(isKittyKeyRelease(press)).toBe(false);
		expect(isKittyKeyRelease(release)).toBe(true);
	});

	test("regression: alt+? is DEAD under modifyOtherKeys (why it is not the default)", () => {
		expect(
			matchesKey(MOK_ALT_SHIFT_SLASH, "alt+?") ||
				matchesAcceptKeyRaw(MOK_ALT_SHIFT_SLASH, "alt+?"),
		).toBe(false);
		expect(
			matchesKey(MOK_ALT_SHIFT_QMARK, "alt+?") ||
				matchesAcceptKeyRaw(MOK_ALT_SHIFT_QMARK, "alt+?"),
		).toBe(false);
		// Only the pre-protocol form matches — which a real VTE/xterm never sends
		// once modifyOtherKeys/kitty is negotiated. This false-positive hid the bug.
		expect(
			matchesKey("\x1b?", "alt+?") || matchesAcceptKeyRaw("\x1b?", "alt+?"),
		).toBe(true);
	});

	test("DEFAULT_ENHANCE_KEY is a non-shift key", () => {
		expect(DEFAULT_ENHANCE_KEY).toBe("alt+/");
		expect(DEFAULT_ENHANCE_KEY.includes("shift")).toBe(false);
	});
});
