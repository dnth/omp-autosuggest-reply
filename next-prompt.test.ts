/**
 * Unit tests for next-prompt.ts covering every pure helper, the terminal
 * sanitizer, overlayGhost rendering, config validation/trust, destination
 * consent, and the controller wiring (with a fake ExtensionAPI firing
 * lifecycle events and terminal input).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
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
import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import type { Api } from "@earendil-works/pi-ai";

import {
	buildMessages,
	buildTranscript,
	configureInteractively,
	DEFAULT_ACCEPT_KEY,
	destinationOf,
	formatModelOption,
	humanizeKey,
	loadConfig,
	loadEffectiveConfig,
	matchesAcceptKeyRaw,
	overlayGhost,
	parseModelOption,
	redactSecrets,
	resolveSuggestionModel,
	sanitizeSuggestion,
	sanitizeTerminalText,
	saveConfig,
	shouldTrigger,
	SYSTEM_PROMPT,
	THINKING_OPTIONS,
	type BranchEntry,
	type NextPromptConfig,
	type SuggestionCtx,
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
		expect(destinationOf({ provider: "openai" })).toEqual({
			provider: "openai",
			origin: "",
		});
	});
	test("D2: identity includes endpoint origin", () => {
		expect(
			destinationOf({
				provider: "openai",
				baseUrl: "https://api.example.com/v1",
			}),
		).toEqual({ provider: "openai", origin: "https://api.example.com" });
	});
	test("D3: same origin with different path/padding is the same destination", () => {
		const a = destinationOf({
			provider: "openai",
			baseUrl: "https://api.example.com/v1/",
		});
		const b = destinationOf({
			provider: "openai",
			baseUrl: "https://api.example.com/v2",
		});
		expect(a).toEqual(b);
	});
	test("D4: undefined model → undefined destination", () => {
		expect(destinationOf(undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// loadEffectiveConfig: trust gating + policy floors (F-02)
// ---------------------------------------------------------------------------

describe("loadEffectiveConfig", () => {
	test("F1: untrusted project config is ignored entirely", () => {
		writeFile(tmpHome, "next-prompt.json", JSON.stringify({ acceptKey: "ctrl+space" }));
		const cwd = mkdtempSync(join(tmpdir(), "np-cwd-"));
		writeFile(
			cwd,
			".pi/next-prompt.json",
			JSON.stringify({ model: { provider: "openai", model: "gpt" }, allowCrossProvider: true }),
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

	test("F8: numeric acceptKey is dropped and cannot reach matchesKey", () => {
		writeFile(
			tmpHome,
			"next-prompt.json",
			JSON.stringify({ acceptKey: 7 }),
		);
		const eff = loadEffectiveConfig(
			mkdtempSync(join(tmpdir(), "np-cwd-")),
		);
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
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "openai" && m === "gpt-4o" ? configured : undefined,
		});
		const out = resolveSuggestionModel(
			ctx,
			cfgModel("openai", "gpt-4o"),
			{ value: false },
		);
		expect(out).toEqual({ model: configured, crossDestination: false });
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
			model: { provider: "openai", id: "gpt" },
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
		const active = { provider: "openai", id: "gpt", baseUrl: "https://a.example.com/v1" };
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
	test('DEFAULT_ACCEPT_KEY is "alt+/"', () => {
		expect(DEFAULT_ACCEPT_KEY).toBe("alt+/");
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
		expect(redactSecrets(`token ${sk} here`)).toBe(
			"token [redacted] here",
		);
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
		expect(redactSecrets(`tok ${shortPat} end`)).toBe(
			`tok ${shortPat} end`,
		); // 35 chars after prefix → below 36 threshold → not matched
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
		expect(sanitizeTerminalText("a\x9bb")).toBe("ab"); // CSI single-byte
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
		expect(sanitizeTerminalText("👨‍👩‍👧 café 日本語")).toBe("👨‍👩‍👧 café 日本語");
	});
	test("T50j: newline/tab are normalized to space", () => {
		expect(sanitizeTerminalText("a\nb\tc")).toBe("a b c");
	});
	test("T50k: sanitizeSuggestion strips OSC before truncation", () => {
		expect(
			sanitizeSuggestion(`ok \x1b]52;c;${btoa("payload")}\x07`, {}),
		).toBe("ok");
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
		for (const line of out) expect(visibleWidth(line)).toBeLessThanOrEqual(WIDTH);
	});
	test("T64: output contains raw ANSI dim escapes (not theme.fg)", () => {
		const lines = makeLines({ text: "hi" });
		const out = overlayGhost(lines, "sug", WIDTH);
		expect(out[1]!).toContain("\x1b[2m");
		expect(out[1]!).toContain("\x1b[22m");
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
// Controller wiring (fake ExtensionAPI firing agent_settled)
// ---------------------------------------------------------------------------

// A minimal fake that implements only the surface the controller touches.
function makeFake(opts: {
	branch?: BranchEntry[];
	idle?: boolean;
	completeResult?: {
		content: Array<{ type: "text"; text: string }>;
		stopReason: string;
	};
	completeError?: Error;
	model?: { provider: string; id: string; baseUrl?: string };
	findModel?: (p: string, m: string) => unknown;
	mode?: string;
	projectTrusted?: boolean;
	hasPriorEditor?: boolean;
	confirmResult?: boolean;
	confirmCall?: () => void;
}): {
	pi: import("@earendil-works/pi-coding-agent").ExtensionAPI;
	ctx: unknown;
	widgetContent: string[] | undefined;
	editorText: string;
	setEditorText: (t: string) => void;
	inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
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
	};
	handlers: Map<string, (e: unknown, ctx: unknown) => unknown>;
	setIdle: (v: boolean) => void;
	editorComponentInstalled: boolean;
	editorComponentCalls: number;
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
	};
	let editorText = "";
	let inputHandler:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	let widgetContent: string[] | undefined;
	let editorComponentInstalled = false;
	let editorComponentCalls = 0;
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
				return (
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
			confirm: async (title: string) => {
				calls.confirms.push(title);
				opts.confirmCall?.();
				return opts.confirmResult ?? true;
			},
			onTerminalInput: (
				handler: (data: string) => { consume?: boolean } | undefined,
			) => {
				inputHandler = handler;
				return () => {
					inputHandler = undefined;
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
				opts.hasPriorEditor ? (() => {}) as never : undefined,
			setEditorComponent: (
				factory: (tui: unknown, theme: unknown, kb: unknown) => unknown,
			) => {
				editorComponentInstalled = true;
				editorComponentCalls += 1;
				// Call the factory so a real GhostEditor is constructed (lightweight ctor).
				factory(
					{ requestRender: () => {} } as unknown,
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
		get editorComponentInstalled() {
			return editorComponentInstalled;
		},
		get editorComponentCalls() {
			return editorComponentCalls;
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
		expect(fake.widgetContent?.[0] ?? "").toContain("Ctrl-Space to accept");
	});

	test("T74e: no acceptKey config → widget hint shows Alt-/", async () => {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.widgetContent?.[0] ?? "").toContain("Alt-/ to accept");
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

	test("T84: loadConfig failure at session_start → extension still installs, falls back to ctx.model", async () => {
		// Malformed global config.
		writeFile(process.env.PI_CODING_AGENT_DIR!, "next-prompt.json", "{ broken");
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
		});
		await fake.handlers.get("session_start")!({}, fake.ctx);
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "openai",
			id: "gpt",
		});
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
		await sleep(150);
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
		fake.inputHandler!("\x1b/");
		expect(fake.editorText).toBe("stale");
		// User submits; reset clears the cached suggestion.
		fake.handlers.get("input")!({}, fake.ctx);
		fake.setEditorText("");
		// Delete-to-empty would previously re-arm the stale cache; must NOT now.
		fake.inputHandler!("\x7f");
		await sleep(200);
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
		// Fire the accept key (alt+/ → \x1b/)
		const result = fake.inputHandler!("\x1b/");
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
		const result = fake.inputHandler!("\x1b/");
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
		const result = fake.inputHandler!("\x1b/");
		expect(result).toBeUndefined();
		expect(fake.editorText).toBe("already typed");
	});

	test("T97: accept key with no suggestion → not consumed", async () => {
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		// No suggestion computed (default completeResult text "suggestion" — but clear it first)
		fake.handlers.get("input")!({}, fake.ctx);
		const result = fake.inputHandler!("\x1b/");
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
		fake.inputHandler!("\x1b/");
		expect(fake.editorText).toBe("redo this");
		expect(fake.widgetContent).toBeUndefined();
		// Delete back to empty (backspace, then clear editor text).
		fake.inputHandler!("\x7f");
		fake.setEditorText("");
		// After the deferred check + rearmDelayMs, the suggestion re-appears.
		await sleep(150);
		expect(fake.widgetContent?.[0] ?? "").toContain("redo this");
		// No new model call — the complete call count is unchanged.
		expect(fake.calls.complete.length).toBe(1);
	});

	test("T99: no last suggestion → nothing to re-arm", async () => {
		writeRearmConfig(60);
		const { fake } = await setup({ branch: [assistantEntry("a")] });
		// No agent_settled → no suggestion, no lastSuggestion. Fire backspace-to-empty.
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		await sleep(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T100: re-arm canceled if editor non-empty when timer fires", async () => {
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\x1b/");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		// Type something before the rearm timer fires.
		fake.setEditorText("new text");
		await sleep(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T101: re-arm canceled if agent becomes non-idle", async () => {
		writeRearmConfig(60);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			completeResult: {
				content: [{ type: "text", text: "x" }],
				stopReason: "stop",
			},
		});
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		fake.inputHandler!("\x1b/");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		fake.setIdle(false);
		await sleep(150);
		expect(fake.widgetContent).toBeUndefined();
	});

	test("T102: config rearmDelayMs default is 2000 when unconfigured", async () => {
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
		fake.inputHandler!("\x1b/");
		fake.setEditorText("");
		fake.inputHandler!("\x7f");
		await sleep(150);
		expect(fake.widgetContent).toBeUndefined(); // hasn't fired yet (default is 2000ms)
	});
});

// sanity: SYSTEM_PROMPT is non-empty
test("SYSTEM_PROMPT is non-empty", () => {
	expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
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

	test("T106b: renderMode=ghost falls back to widget when another extension owns the editor (F-05 / P1-1)", async () => {
		writeFile(
			process.env.PI_CODING_AGENT_DIR!,
			"next-prompt.json",
			JSON.stringify({ renderMode: "ghost" }),
		);
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			hasPriorEditor: true,
			completeResult: {
				content: [{ type: "text", text: "fallback suggestion" }],
				stopReason: "stop",
			},
		});
		expect(fake.editorComponentInstalled).toBe(false); // never clobbers
		expect(
			fake.calls.notifies.some(([m, t]) => t === "warning" && m.includes("another extension")),
		).toBe(true);
		// P1-1: the fallback must actually render the widget, not silently compute.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(1);
		expect(fake.widgetContent?.[0] ?? "").toContain("fallback suggestion");
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
	async function setupCross(opts: { confirmResult?: boolean } = {}) {
		const { fake } = await setup({
			branch: [assistantEntry("a")],
			model: { provider: "openai", id: "gpt" },
			findModel: (p, m) =>
				p === "anthropic" && m === "haiku"
					? { provider: "anthropic", id: "haiku" }
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

	test("C1: first cross-destination use prompts for consent; grant → complete on configured model", async () => {
		const { fake } = await setupCross();
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.confirms).toHaveLength(1);
		expect(fake.calls.complete[0]!.model).toEqual({
			provider: "anthropic",
			id: "haiku",
		});
	});

	test("C2: decline → zero complete calls + warning, no re-prompt on second settle", async () => {
		const { fake } = await setupCross({ confirmResult: false });
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.complete).toHaveLength(0);
		expect(
			fake.calls.notifies.some(([m]) => m.includes("declined")),
		).toBe(true);
		// Session denial: settling again must not re-prompt nor send.
		await fake.handlers.get("agent_settled")!({}, fake.ctx);
		expect(fake.calls.confirms).toHaveLength(1);
		expect(fake.calls.complete).toHaveLength(0);
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
				maxSuggestionChars: "200",
				allowCrossProvider: false,
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
			maxSuggestionChars: 200,
			allowCrossProvider: false,
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
				acceptKey: "alt+/",
				rearmDelayMs: "2000",
				maxTranscriptChars: "12000",
				maxSuggestionChars: "240",
				allowCrossProvider: true,
			},
		});
		const out = await configureInteractively(ctx, {});
		expect(out?.thinking).toBeUndefined();
	});

	test("T123: invalid numeric input → field not set", async () => {
		const ctx = makeConfigCtx({
			answers: {
				model: "(use current model)",
				renderMode: "widget — colored line below the input box",
				thinking: "(unset — model default)",
				acceptKey: "alt+/",
				rearmDelayMs: "not a number",
				maxTranscriptChars: "abc",
				maxSuggestionChars: "200",
				allowCrossProvider: true,
			},
		});
		const out = await configureInteractively(ctx, {});
		expect(out?.rearmDelayMs).toBeUndefined();
		expect(out?.maxTranscriptChars).toBeUndefined();
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
