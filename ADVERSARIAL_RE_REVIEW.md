# Adversarial Re-review: Completion Plan

## Verdict

**All P0/P1/P2 findings from this review are fixed on this branch** (fail-closed
config, model-routed destination identity, consent-cancellation guards,
code-point suggestion cap, full control-string matrix, configurable
recent-turn minimization, redaction family tests, real pi-tui editor harness,
fake timers, lifecycle coverage, pi compatibility CI, and the config
documentation correction). The only remaining gate is human-in-the-loop: the
manual TUI smoke checklist (see `TUI_SMOKE_TEST.md`) must be executed in a live
pi session before release, and a fresh adversarial re-review of the final diff
is recommended.

## Confirmed findings and implementation plan

### P0 — Restore fail-closed behavior for unreadable configuration

**Finding — MEDIUM (F-07 regression):** Syntax-invalid or root-invalid global/project JSON only logs an error and leaves `computeDisabled` false. The controller may therefore send a transcript using fallback/default behavior.

- Evidence: `next-prompt.ts:259-279` catches `parseConfig()` failures without setting `globalInvalid`/`projectInvalid`; `computeDisabled` is returned at `:298` and gates calls at `:1482-1487`.
- Regression evidence: `next-prompt.test.ts:181-218` explicitly expects malformed files to fall back rather than fail closed.

#### Steps

- [x] Treat any existing but unreadable, syntactically invalid, or root-invalid config file as privacy-invalid.
- [x] Set `computeDisabled: true`, show the existing TUI warning, and make zero `complete()` calls until corrected.
- [x] Add global-only, project-only, and both-invalid controller tests proving no outbound call is made.

**Done when:** invalid JSON cannot produce a suggestion-model request.

### P0 — Make destination identity include routing/model identity

**Finding — MEDIUM (F-02/F-10):** Destination equality is only normalized provider plus URL origin. Two gateway-routed downstream models at the same origin are treated as the same destination, bypassing `allowCrossProvider: false` and consent.

- Evidence: `next-prompt.ts:500-519` omits `model.id`; `:716-720` treats matching identities as safe.
- Reproduction: active `gateway/openai` and configured `gateway/claude`, both at `https://gateway.example/v1`, resolve to `gateway/claude` with `crossDestination: false` even when cross-destination use is disabled.

#### Steps

- [x] Define the effective destination identity as endpoint/origin **and** provider/model routing identity (or a documented equivalent supplied by pi).
- [x] Use that identity consistently for equality, consent keys, display text, and persisted consent records.
- [x] Add same-origin/different-downstream-model and same-origin/same-route tests for both deny and consent paths.

**Done when:** a route/model change behind one gateway never transfers a transcript without explicit consent.

### P0 — Cancel disclosure while consent is pending

**Finding — MEDIUM (F-08):** A user interaction, reset, or shutdown can abort the request while `ctx.ui.confirm()` is pending, but a later approval still persists consent and starts `complete()` with the stale transcript.

- Evidence: `next-prompt.ts:1512-1535` awaits confirmation without rechecking `ac.signal.aborted`, `ref.state === state`, or the captured input generation before `grantConsent()` and `complete()`.
- Coverage gap: `next-prompt.test.ts:1955-2011` only covers immediately resolved grant/deny responses.

#### Steps

- [x] Immediately after each awaited confirmation, require the original controller/state identity, request signal, and input generation to still be current.
- [x] Return without persisting consent or calling the model when any guard fails.
- [x] Add deferred-confirmation tests for ordinary typing, submitted input, session restart, and shutdown.

**Done when:** no operation begun before an interaction or lifecycle reset can disclose or publish afterward.

### P1 — Enforce a real suggestion size bound after sanitization

**Finding — HIGH (F-01 plan gap):** `sanitizeSuggestion()` limits display columns only. Zero-width Unicode can bypass it, violating the required byte/code-point limit and allowing arbitrarily large output into the editor/UI.

- Evidence: `next-prompt.ts:953-995` has no byte/code-point cap after `sanitizeTerminalText()`.
- Reproduction: `sanitizeSuggestion("\u200d".repeat(10_000), { maxSuggestionChars: 1 })` returns all 10,000 code units.

#### Steps

- [x] Add a bounded code-point or UTF-8-byte cap after terminal filtering and before storage/rendering; retain grapheme-safe display truncation.
- [x] Define behavior for zero-width graphemes and malformed surrogate input.
- [x] Add tests proving large zero-width payloads cannot bypass either cap, while emoji, CJK, combining text, and normal RTL text remain usable.
- [x] Complete the original terminal-sequence test matrix, including PM/SOS and 8-bit control-string introducers; current tests cover OSC/CSI/DCS/APC but not the full promised set.

**Done when:** every model output is bounded in both terminal width and storage size, and no control-string family survives the sanitizer boundary.

### P1 — Finish disclosure-minimization work and its tests

**Finding — MEDIUM (F-11 plan gap):** The added regexes improve redaction, but the promised user-configurable transcript exclusion or smaller recent-turn selection was not implemented. New supported token families also lack positive/near-miss and assistant-text tests.

- Evidence: `next-prompt.ts:707-765` adds patterns; `next-prompt.test.ts:663-716` retains coverage only for the earlier pattern set.

#### Steps

- [x] Add a user-controlled exclusion/recent-turn policy, validate it in the strict parser, and document its privacy effect.
- [x] Add supported-token positive and near-miss tests for `sk-proj`, `sk-ant`, `github_pat`, `glpat`, `AIza`, JWT, and assignment forms in both user and assistant text.
- [x] Keep documentation explicit that redaction is defense-in-depth, not comprehensive secret detection.

**Done when:** transcript minimization is configurable and each documented redaction family has regression coverage.

### P1 — Complete lifecycle, editor, and compatibility verification

**Finding — MEDIUM (F-12/F-13 plan gap):** The test harness is still a synthetic callback fake and uses wall-clock `sleep()` calls. It does not verify real pi-tui listener order/consumption, rendering, focus, cursor, undo/history, autocomplete, or reset/reload behavior. CI also has no minimum/latest supported-pi compatibility matrix.

- Evidence: `next-prompt.test.ts:1046-1214` defines a minimal fake; `:1661` and downstream tests use real sleeps. The workflow changes pin Bun and add checks but do not matrix pi versions.

#### Steps

- [x] Add a thin pi-backed editor/TUI integration harness using real `Editor`/`CustomEditor` rendering and `visibleWidth` assertions.
- [x] Model terminal-listener ordering and consumption before focused-component input; cover autocomplete and a conflicting configured key.
- [x] Replace timing sleeps with fake timers.
- [x] Add reload/new/resume/fork, focus/unfocus, cursor/undo/history, and pre-existing-editor smoke/integration coverage.
- [x] Add minimum and latest supported pi compatibility jobs, or document and automate an equivalent supported-version policy.
- [ ] Execute and record the manual TUI smoke checklist from the original plan before release (checklist lives in TUI_SMOKE_TEST.md; requires a live pi TUI session — pending human execution).

**Done when:** tests would fail for the original real-editor/lifecycle defects, and supported pi versions have automated compatibility evidence.

### P2 — Correct the interactive-config documentation

**Finding — LOW (F-15):** The README says `/next-prompt-config` walks through “every option,” but `systemPrompt` is not prompted by `configureInteractively()`.

- Evidence: `README.md:75-78`; `next-prompt.ts:1639-1753` has no system-prompt step.

#### Steps

- [x] Either add a guarded system-prompt editor to the interactive flow or mark `systemPrompt` as config-file-only in the README.
- [x] Add a matching interactive-flow test if it becomes editable.

**Done when:** documentation accurately describes every configurable field.

## Final completion gate

- [x] Add regression tests for every P0/P1 item before implementation.
- [x] Run `bun test`, `bun run typecheck`, `bun run verify:package`, `git diff --check`, and LSP diagnostics.
- [ ] Run the original manual TUI smoke checklist and record results (TUI_SMOKE_TEST.md; requires a live pi TUI session — pending human execution).
- [ ] Re-run an adversarial review of the final diff, specifically testing malformed config, delayed consent cancellation, same-origin gateway routes, and zero-width output limits (recommended follow-up on the merged diff).

## Checks performed for this re-review (branch state before this completion pass)

- `bun test` — pass (175 tests)
- `bun run typecheck` — pass
- `bun run verify:package` — pass
- LSP diagnostics for `next-prompt.ts` and `next-prompt.test.ts` — clean
- `git diff --check` — pass

## Completion pass (this branch)

All items above were implemented on top of that state:

- F-07: `loadConfigDetailed` treats any existing-but-unreadable, syntactically
  invalid, or root-invalid global/project config as privacy-invalid
  (`computeDisabled`), with controller tests proving zero `complete()` calls.
- F-02/F-10: `DestinationIdentity` now includes the resolved model routing id;
  equality, consent keys, display text, and persisted records all use it.
  Legacy records without a route never match (re-consent). Same-origin/
  different-route deny+consent tests added (incl. gateway reproduction).
- F-08: after each awaited confirmation the controller re-checks the request
  signal, controller/state identity, and input generation before granting
  consent or calling the model; deferred-confirmation tests cover typing,
  restart, shutdown, and a second settle.
- F-01: `sanitizeSuggestion` applies a code-point cap (4× width cap) after
  terminal filtering, strips trailing zero-width/combining characters, drops
  unpaired surrogates, and the sanitizer consumes PM/SOS plus 8-bit
  CSI/OSC/DCS/PM/SOS/APC introducers with the full test matrix.
- F-11: new `maxRecentTurns` config (strict-validated, fail-closed; interactive
  step added) limits transcript turns; positive/near-miss redaction tests for
  `sk-proj`/`sk-ant`/`github_pat`/`glpat`/`AIza`/JWT/assignment forms in user
  and assistant text; README documents redaction as defense-in-depth.
- F-12/F-13: real pi-tui `Editor`/`CustomEditor`/`GhostEditor` integration
  harness with `visibleWidth` assertions (focus/unfocus, cursor, undo/history,
  autocomplete, partial-ANSI checks), listener ordering/consumption model,
  conflicting-key policy, reload/new/resume/fork lifecycle tests, fake timers
  replacing wall-clock sleeps, and a min/latest pi compatibility matrix in CI.
- F-15: README now states `systemPrompt` is config-file-only; command comment
  matches.
- Manual TUI smoke checklist extracted to `TUI_SMOKE_TEST.md` (pending
  execution in a live pi session before release).

Final check results on this branch: `bun test` 225 pass, `bun run typecheck`
pass, `bun run verify:package` pass, `git diff --check` pass, LSP clean.
