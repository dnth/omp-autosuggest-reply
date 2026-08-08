# Adversarial Implementation Review and Remediation Plan

<!-- markdownlint-disable MD036 -->

## Executive summary

**Target:** `@gamaraan/next-prompt` v0.1.0 at commit `653fea7`
**Scope:** all 11 tracked files, the complete repository history, and the installed pi APIs at `0.84.1`
**Review strategy:** deep current-implementation review; the worktree had no implementation diff to compare
**Recommendation:** **REQUEST CHANGES before the next release**

| Severity | Count |
| --- | ---: |
| Critical | 0 |
| High | 5 |
| Medium | 8 |
| Low | 2 |

The test suite is substantial and currently green, but its fakes do not model several pi/TUI behaviors on which the implementation depends. The most important problems are:

1. untrusted model text is rendered as terminal control sequences;
2. repository config can silently change where transcripts are sent, even though pi exposes project-trust state;
3. headless modes can make invisible, unrequested suggestion-model calls;
4. the default widget does not dismiss on ordinary typing, while `both` can leave a stale widget; and
5. ghost mode repeatedly replaces the editor and can lose editor state or clobber another extension.

### Verification performed during this review

| Check | Result |
| --- | --- |
| `bun test` | **PASS:** 149 tests, 0 failures, 219 assertions |
| `tsc --noEmit` using `/usr/local/bin/tsc` | **PASS** |
| Primary LSP diagnostics on both TypeScript files | **PASS:** 0 findings |
| `npm pack --dry-run --json` | **PASS:** expected four package files |
| Direct unfocused-overlay probe | **FAIL:** width-40 rendered line became width 79 |
| Direct control-sequence sanitization probe | **FAIL:** OSC 52 survived unchanged |

A passing current suite therefore does not mean the shipped behavior is correct.

---

## Required invariants for the remediation

The implementation should make these invariants explicit before changes begin:

1. **No hidden work:** no suggestion-model call is made when a suggestion cannot be presented to the user.
2. **Disclosure is fail-closed:** repository content cannot loosen a user-level privacy policy or select a new transcript destination without explicit consent.
3. **Model output is untrusted:** only safe printable text reaches the terminal or editor.
4. **One state transition, one render:** suggestion state changes update every active presentation (`ghost`, `widget`, or both) through one path.
5. **Input invalidates stale work:** any user interaction that dismisses a suggestion prevents an older in-flight result from later reappearing.
6. **Re-arm is transition-based:** a cached suggestion is re-armed only after deletion from non-empty to empty, never merely because the editor is empty.
7. **TUI width is exact:** every custom-rendered line has `visibleWidth(line) <= width` and contains complete ANSI sequences.
8. **Editor composition is preserved:** this extension must not repeatedly replace editor state or silently disable another editor extension.

---

## Findings

### F-01 — HIGH — Model output can execute terminal control sequences

**Evidence**

- `sanitizeSuggestion()` removes quotes/fences/newlines and applies visible-width truncation, but preserves ESC, OSC, CSI, BEL, CR, C0/C1 controls, DEL, and bidi controls: `next-prompt.ts:L396-L436`.
- The value is interpolated directly into the widget: `next-prompt.ts:L647-L652`.
- It is also injected into the ghost overlay and, on acceptance, into the editor: `next-prompt.ts:L600-L614`, `next-prompt.ts:L732-L752`.
- The model response reaches this path directly: `next-prompt.ts:L984-L989`.
- Existing sanitization tests do not include terminal controls: `next-prompt.test.ts:L554-L590`.

**Reproduction observed during review**

`sanitizeSuggestion("\x1b]52;c;SGVsbG8=\x07")` returned the OSC 52 sequence unchanged.

**Impact**

A compromised provider or transcript-induced model response can overwrite the clipboard in supporting terminals, change the terminal title, move the cursor, spoof UI, conceal text, or exercise terminal-emulator vulnerabilities. Visible-width truncation is not a byte cap, so zero-width control payloads can bypass the configured suggestion limit.

**Required change**

- [ ] Add a dedicated `sanitizeTerminalText()` boundary before storing any model suggestion.
- [ ] Remove complete OSC/CSI/DCS/APC/PM/SOS sequences and remaining C0/C1 controls, DEL, CR, and bidi override/isolate characters.
- [ ] Normalize permitted whitespace to ordinary spaces.
- [ ] Apply both a display-width limit and a byte/code-point limit after filtering.
- [ ] Ensure only extension-generated ANSI reaches widget/ghost rendering.
- [ ] Reject an empty result after filtering.

**Acceptance criteria**

- Model output cannot introduce any terminal escape sequence.
- Safe Unicode, including emoji and non-Latin text, remains usable.
- Accepted editor text is identical to the safe text displayed.

---

### F-02 — HIGH — Repository config can silently override the transcript-disclosure policy

**Evidence**

- Project config is read directly from `<cwd>/.pi/next-prompt.json` and spread over global config: `next-prompt.ts:L168-L194`.
- This permits project overrides of `model`, `systemPrompt`, `maxTranscriptChars`, and `allowCrossProvider`: `next-prompt.ts:L70-L85`.
- The project file is read without consulting `ctx.isProjectTrusted()`, although the pi extension API explicitly provides that check for project-local configuration.
- The chosen model automatically receives transcript text after settlement: `next-prompt.ts:L939-L968`.
- The documented default is `allowCrossProvider: true`: `README.md:L88-L119`.

**Trigger scenario**

A cloned repository contains:

```json
{
  "model": { "provider": "external-provider", "model": "cheap-model" },
  "allowCrossProvider": true,
  "maxTranscriptChars": 1000000
}
```

This can override a user's global `allowCrossProvider: false` and cap, then send subsequent conversation text to the repository-selected destination.

**Impact**

Repository content can redirect conversation text, assistant-echoed source, credentials, customer data, or internal instructions to a different provider. Project trust and transcript-destination consent are currently conflated, and the user-level policy is not an enforceable upper bound.

**Required change**

- [ ] Do not read project config unless `ctx.isProjectTrusted()` is true.
- [ ] Make cross-destination disclosure opt-in; default `allowCrossProvider` to `false`.
- [ ] Treat global privacy settings as a policy floor: project config may tighten, never loosen, `allowCrossProvider` or increase the transcript cap.
- [ ] Do not allow repository config to select `model` or `systemPrompt` for outbound transcript processing without destination-specific consent.
- [ ] Persist consent outside the repository, keyed by project identity and normalized destination identity.
- [ ] Show provider, model, endpoint/origin, and transcript cap before first disclosure to a distinct destination.
- [ ] Fail closed on invalid or unapproved disclosure config.

**Acceptance criteria**

- An untrusted or merely cloned project cannot alter the outbound destination.
- Project config cannot override a global deny policy.
- No transcript is sent before explicit consent to a new destination.

---

### F-03 — HIGH — Headless/RPC modes can perform invisible suggestion-model calls

**Evidence**

- `session_start` registers TUI behavior without checking `ctx.mode` or `ctx.hasUI`: `next-prompt.ts:L860-L905`.
- `agent_settled` calls `maybeCompute()` in every mode: `next-prompt.ts:L907-L918`.
- The pi extension contract says TUI-specific components and terminal input must be guarded with `ctx.mode === "tui"`; UI methods are no-ops or unavailable in JSON/print modes.

**Trigger scenario**

Run pi in print, JSON, or RPC automation with the extension installed. A normal agent turn settles; the extension sends another transcript-bearing model request, but there is no interactive editor in which to present or accept the result.

**Impact**

Unexpected cost, latency, provider traffic, and transcript disclosure occur without visible product value. Automation may make twice the expected number of model calls.

**Required change**

- [ ] Disable state setup and suggestion computation unless `ctx.mode === "tui"`.
- [ ] If non-TUI support is desired later, design an explicit RPC/JSON result protocol and opt-in configuration rather than relying on no-op UI methods.
- [ ] Keep command behavior mode-aware and return a clear error outside TUI.

**Acceptance criteria**

- Print, JSON, and RPC sessions make zero suggestion-model calls by default.
- TUI behavior remains unchanged except for fixes in this plan.

---

### F-04 — HIGH — Ordinary typing does not dismiss the default widget; `both` leaves stale UI

**Evidence**

- The default render mode is `widget`: `next-prompt.ts:L866-L875`.
- For a non-accept key, the global handler only schedules a re-arm check and never clears the active suggestion: `next-prompt.ts:L735-L757`.
- The timer immediately exits because `state.suggestion` is still set: `next-prompt.ts:L707-L724`.
- In `both`, `GhostEditor.handleInput()` mutates `state.suggestion` and requests only an editor render; it does not clear the widget via `renderSuggestion()`: `next-prompt.ts:L801-L828`.
- T94 checks only that a key passes through; T111 tests the later submitted `input` event, not a terminal keystroke: `next-prompt.test.ts:L1359-L1364`, `next-prompt.test.ts:L1627-L1644`.

**Impact**

The primary/default mode contradicts the README's “any other key dismisses” contract. Stale text remains visible while the user types. In `both`, the ghost disappears but the widget advertises a suggestion the accept handler no longer accepts.

**Required change**

- [ ] Replace direct state mutation with central actions such as `show`, `dismiss`, `accept`, `invalidate`, and `rearm`.
- [ ] Every action must update both render surfaces through `renderSuggestion()`.
- [ ] On non-accept input while a suggestion is active, dismiss before passing input through.
- [ ] Preserve the key for the underlying editor; do not consume dismissal input.
- [ ] Do not schedule re-arm merely because dismissal happened.

**Acceptance criteria**

- One non-accept key immediately removes every visible suggestion in all three modes.
- A stale widget can never remain after the ghost state is cleared.

---

### F-05 — HIGH — Ghost mode repeatedly replaces editor state and clobbers editor composition

**Evidence**

- Ghost/both mode calls `setEditorComponent()` on session start: `next-prompt.ts:L887-L900`.
- It calls it again on every `agent_settled`, before checking whether the user has already typed: `next-prompt.ts:L907-L914`.
- pi 0.84.1 creates a new editor and copies only text when the factory is set: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:L2020-L2079`.
- A new editor resets cursor placement, autocomplete, undo/history internals, and extension-specific editor behavior.
- The pi extension documentation requires capturing `ctx.ui.getEditorComponent()` and composing with the prior factory; this implementation does not.
- T106/T109 only inspect an already-true boolean and do not count replacements or preserve state: `next-prompt.test.ts:L1551-L1561`, `next-prompt.test.ts:L1596-L1606`.

**Impact**

When a turn settles, a user's cursor can jump to the end, autocomplete/history/undo state can be lost, and another custom-editor extension can stop working. Reinstallation also causes extension-order races.

**Required change**

- [ ] Remove unconditional `agent_settled` editor reinstallation.
- [ ] Install once per `session_start` and retain ownership metadata/factory identity.
- [ ] Capture and compose with `ctx.ui.getEditorComponent()` as documented.
- [ ] Restore the prior component during shutdown if this extension still owns the installed wrapper.
- [ ] If safe composition is impossible for a prior component, warn and fall back to widget mode instead of overwriting it.
- [ ] Keep all editor state in the composed base component where feasible.

**Acceptance criteria**

- Settling a turn does not replace the editor.
- Cursor, text, undo, history, and autocomplete survive settlement.
- A pre-existing custom editor remains functional.

---

### F-06 — MEDIUM — Unfocused ghost rendering corrupts ANSI and violates width constraints

**Evidence**

- The unfocused branch uses `visibleWidth(ghostSlice)` as a raw JavaScript index into an ANSI-bearing line, then appends another width-sized padding region: `next-prompt.ts:L548-L572`.
- TUI documentation requires every rendered line to be no wider than the supplied `width`.
- A direct width-40 probe produced visible width 79 and sliced through the reverse-video cursor sequence.
- T63/T63c only look for the ghost escape; they never assert output width or valid escape boundaries: `next-prompt.test.ts:L760-L791`.
- T60's “no overflow” check only asserts that the line does not end with `\n`: `next-prompt.test.ts:L741-L749`.
- The faulty unfocused branch was introduced in commit `1dafa78`.

**Impact**

The exact unfocused/tab-switch scenario this code was added to support can render malformed escape fragments, garbage styling, clipping, or layout corruption.

**Required change**

- [ ] Stop slicing rendered ANSI text using display-column values.
- [ ] Replace the complete unfocused cursor cell or use an ANSI-aware column-slicing utility.
- [ ] Preserve existing left/right padding and pad exactly once.
- [ ] Assert `visibleWidth(line) <= width` for every returned line.
- [ ] Prefer rendering from editor state rather than reverse-engineering serialized ANSI if a composition-friendly approach is available.

**Acceptance criteria**

- Focused and unfocused output is valid ANSI and never exceeds the requested width.
- Wide glyphs, combining characters, padding, and narrow terminals are handled correctly.

---

### F-07 — MEDIUM — Runtime config validation is incomplete and can crash input handling

**Evidence**

- `parseConfig()` validates only the nested model shape after a TypeScript cast: `next-prompt.ts:L196-L213`.
- A numeric `acceptKey` reaches `matchesKey()` through a cast: `next-prompt.ts:L736-L738`; pi-tui calls `keyId.toLowerCase()`, so malformed JSON can throw on every keypress.
- Invalid `renderMode` values still permit model calls but render neither ghost nor widget: `next-prompt.ts:L658-L664`.
- Invalid caps and delays rely on JavaScript coercion: `next-prompt.ts:L357-L380`, `next-prompt.ts:L396-L436`, `next-prompt.ts:L707-L724`.
- Interactive numeric validation does not protect hand-edited global or project files: `next-prompt.ts:L1068-L1113`.

**Impact**

A typo or repository-supplied config can bypass transcript/output caps, create hidden calls, produce nonsensical timers, repeatedly fail model requests, or break terminal input.

**Required change**

- [ ] Add one strict runtime schema/parser for all config sources and interactive output.
- [ ] Reject arrays and `null` as root config.
- [ ] Validate `renderMode`, `thinking`, `acceptKey`, booleans, strings, and the model shape.
- [ ] Require bounded finite integers for transcript limit, suggestion limit, and re-arm delay.
- [ ] Decide and document unknown-key behavior; warnings are preferable to silent acceptance.
- [ ] Treat invalid privacy-bearing fields as fail-closed, not permissive fallback.
- [ ] Remove or implement the unused public `debounceMs` option.

**Acceptance criteria**

- No JSON value can cause a keypress-time exception.
- Invalid privacy config produces zero outbound model calls and a visible warning in TUI mode.

---

### F-08 — MEDIUM — User interaction does not invalidate an in-flight completion

**Evidence**

- A request records only an `AbortController`; it captures no input/session generation: `next-prompt.ts:L939-L968`.
- After completion, publication checks only `signal.aborted`, editor emptiness, and idle state: `next-prompt.ts:L975-L989`, `next-prompt.ts:L667-L673`.
- Terminal typing does not abort the request; only submitted `input`, `turn_start`, and `agent_start` events call `reset()`: `next-prompt.ts:L920-L929`.
- T77 covers only the case where text remains non-empty.

**Trigger scenario**

A completion starts, the user types and deletes back to empty before it resolves, and the old result is then published because the editor happens to be empty again.

**Impact**

Dismissed/stale output reappears, and provider work continues after the user has indicated intent to do something else.

**Required change**

- [ ] Increment an input/session generation on every non-accept interaction and lifecycle invalidation.
- [ ] Abort the active request immediately when user input dismisses the pending suggestion.
- [ ] Capture generation and state identity when the request starts; require both to match before publication.
- [ ] Clear `ref.inflight` in `finally` only if it still points to the same controller.

**Acceptance criteria**

- No completion begun before user interaction can publish afterward, even if the editor becomes empty again.

---

### F-09 — MEDIUM — Re-arm is based on current emptiness, not delete-to-empty, and stale cache crosses turns

**Evidence**

- `scheduleRearmCheck()` re-arms whenever the editor is empty; it does not require a non-empty-to-empty transition: `next-prompt.ts:L707-L724`.
- It is invoked for every non-accept key and ghost dismissal: `next-prompt.ts:L754-L756`, `next-prompt.ts:L815-L827`.
- `reset()` clears the active suggestion but does not clear `lastSuggestion`: `next-prompt.ts:L854-L858`, `next-prompt.ts:L677-L685`.

**Trigger scenarios**

1. Press Escape or an arrow while a suggestion is visible and the editor is empty; the dismissed suggestion returns after the delay.
2. Accept and submit suggestion A; the next suggestion call returns `NONE` or errors; later deleting text to empty can re-arm stale suggestion A from the previous turn.

**Impact**

Users cannot permanently dismiss a suggestion, and a suggestion for an old conversation state can return after a later turn.

**Required change**

- [ ] Pass an explicit input transition (`before`, `after`, and key/action) to re-arm logic.
- [ ] Re-arm only when `before.length > 0 && after.length === 0`.
- [ ] Do not re-arm after Escape, arrows, focus changes, or simple dismissal.
- [ ] Associate cached suggestions with a conversation/input generation.
- [ ] Clear the cache when a user message is submitted or the conversation generation changes.
- [ ] Preserve the cache only between acceptance and local editing before submission.
- [ ] Replace wall-clock sleeps in tests with fake timers.

**Acceptance criteria**

- Only deletion to empty re-arms.
- A cached suggestion never crosses a submitted turn.

---

### F-10 — MEDIUM — `allowCrossProvider=false` does not reliably identify or deny a different destination

**Evidence**

- The guard compares only provider labels: `next-prompt.ts:L278-L292`.
- The candidate model is resolved after the label check, so endpoint identity is not compared.
- pi model definitions can carry per-model `baseUrl` values.
- When `ctx.model` is undefined, the guard is skipped and a found configured model is returned despite `allowCrossProvider: false`.
- Tests cover same/different labels but not endpoint changes or the no-active-model case: `next-prompt.test.ts:L307-L333`.

**Impact**

Two models with the same provider label can route to different origins or downstream vendors, and the setting fails open when no active model is available.

**Required change**

- [ ] Resolve the candidate first.
- [ ] Define normalized destination identity using effective endpoint/origin plus provider/model routing policy.
- [ ] Treat gateways and downstream-model changes as distinct destinations unless consent explicitly covers them.
- [ ] Return no model when the active destination is unavailable and cross-destination use is denied.
- [ ] Reuse the destination identity for consent storage from F-02.

**Acceptance criteria**

- `allowCrossProvider=false` is fail-closed and cannot be bypassed by labels or missing active state.

---

### F-11 — MEDIUM — Secret redaction is too narrow to be treated as a disclosure mitigation

**Evidence**

- Only five narrow patterns are recognized: `next-prompt.ts:L308-L320`.
- Common structured families such as fine-grained GitHub tokens, project-scoped provider keys, GitLab tokens, Google API keys, bearer/JWT values, and assignment forms are not covered.
- User and assistant text are both included, so secrets echoed by the assistant are in scope: `next-prompt.ts:L357-L381`.
- The README calls redaction defense-in-depth, but the permissive cross-destination default gives it more practical responsibility than it can meet: `README.md:L130-L146`.

**Impact**

Credentials copied into a prompt or echoed by an assistant can be sent to another provider unchanged.

**Required change**

- [ ] Treat destination consent and least disclosure—not regex—as the primary control.
- [ ] Add maintained tests/patterns for currently supported structured token families.
- [ ] Support user-configurable transcript exclusions or a smaller recent-turn selection.
- [ ] Document that assistant final text can contain echoed file/tool secrets even though raw tool results are skipped.
- [ ] Avoid claims that imply comprehensive secret detection.

**Acceptance criteria**

- Documentation accurately states limits.
- Supported formats have positive and near-miss tests.
- Cross-destination transfer remains safe even when redaction misses a secret.

---

### F-12 — MEDIUM — CI and publication do not enforce release quality or integrity

**Evidence**

- PR CI runs only `bun test`: `.github/workflows/test.yml:L3-L27`.
- The package ships TypeScript source directly, but TypeScript is not a dev dependency and there is no `typecheck` script: `package.json:L1-L31`.
- Bun is configured as `latest`, making CI nondeterministic: `.github/workflows/test.yml:L17-L21`.
- Any `v*` tag publishes without dependency installation, tests, typecheck, package inspection, version/tag matching, or main-branch ancestry validation: `.github/workflows/publish.yml:L3-L25`.
- Publication uses a long-lived npm token and does not request provenance.

**Impact**

A type-invalid or untested tag can be published from an arbitrary commit under a mismatched version. A passing PR does not protect a separately created release tag.

**Required change**

- [ ] Add `test`, `typecheck`, and package-verification scripts.
- [ ] Add a pinned TypeScript dev dependency and a pinned Bun version.
- [ ] Run frozen install, typecheck, unit/integration tests, and package dry-run in PR and publish jobs.
- [ ] Verify `GITHUB_REF_NAME === "v" + package.json.version`.
- [ ] Verify the tagged commit is reachable from the protected default branch.
- [ ] Prefer npm trusted publishing with provenance; otherwise minimize and rotate token scope.
- [ ] Add minimum/latest supported pi compatibility coverage.

**Acceptance criteria**

- A mismatched version, failed typecheck, failed test, unexpected package file, or non-main tag cannot publish.

---

### F-13 — MEDIUM — The test harness does not model the lifecycle and TUI contracts being relied upon

**Evidence**

- `makeFake()` stores a single raw input callback and a boolean editor-installed flag: `next-prompt.test.ts:L846-L992`.
- It does not model terminal listener order/consumption, real editor input, focus, autocomplete, cursor, undo/history, component composition, exact width, or UI reset.
- Source and README claim terminal listeners survive `resetExtensionUI`: `next-prompt.ts:L727-L730`, `next-prompt.ts:L902-L904`, `README.md:L150-L154`.
- pi 0.84.1 actually clears extension input listeners during reset: `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js:L1686-L1704`.
- T88 directly invokes `session_start`; it does not exercise a real reset/reload lifecycle: `next-prompt.test.ts:L1260-L1268`.

**Impact**

Tests can remain green while the real editor, listener, focus, and rendering contracts are broken. Several current tests assert only that code ran, not that product behavior is correct.

**Required change**

- [ ] Add a thin pi-backed integration harness around real `Editor`/`CustomEditor` behavior.
- [ ] Model listener invocation before focused component input and respect `{ consume: true }`.
- [ ] Exercise real focus/unfocus rendering and `visibleWidth`.
- [ ] Track component factory identity and invocation counts.
- [ ] Add reload/new/resume/fork lifecycle tests or documented manual smoke tests where automation is impractical.
- [ ] Correct “survives reset” comments unless verified restoration is guaranteed.

**Acceptance criteria**

- Tests fail for each confirmed defect in this report before its fix is applied.
- Lifecycle claims are backed by either automated evidence or a release smoke-test checklist.

---

### F-14 — LOW — Config writes are non-atomic and inherit ambient permissions

**Evidence**

- `saveConfig()` directly truncates the destination with `writeFileSync()` and no explicit mode: `next-prompt.ts:L216-L236`.
- It does not reject symlinks/non-regular files or preserve the prior file if writing fails.
- Tests verify JSON content only: `next-prompt.test.ts:L1686-L1713`.

**Impact**

A custom/shared agent directory can create a group-readable or modifiable policy file. A crash, disk-full condition, or concurrent save can destroy the last valid config and cause permissive fallback behavior.

**Required change**

- [ ] Write a same-directory temporary file with mode `0600`.
- [ ] Flush/close, atomically rename, and enforce final mode `0600`.
- [ ] Reject symlink/non-regular destinations.
- [ ] Preserve the old file on failure and notify the user.

**Acceptance criteria**

- Interrupted or concurrent saves never leave malformed JSON.
- Ambient umask cannot make the file more permissive than `0600`.

---

### F-15 — LOW — Documentation and package metadata are stale or malformed

**Evidence**

- The GitHub pin code fence opened at `README.md:L46` is not properly closed before the Manual section, breaking Markdown rendering around `README.md:L49-L55`.
- The config command claims to walk through “every option,” but it cannot edit `systemPrompt`: `README.md:L82-L86`, `next-prompt.ts:L1015-L1123`.
- The source header says “Two render modes” although there are three and references removed `PLAN.md`: `next-prompt.ts:L5-L24`.
- `debounceMs` is exported but unused: `next-prompt.ts:L81`.
- The test header says 92 tests while the suite contains 149: `next-prompt.test.ts:L1-L5`.
- `package.json` lacks repository/homepage/bugs/engines/scripts metadata.

**Impact**

The npm/GitHub README renders incorrectly, public configuration expectations drift from implementation, and package consumers lack compatibility/support links.

**Required change**

- [ ] Fix Markdown fences and render the README locally before release.
- [ ] Align configuration documentation with the actual interactive flow.
- [ ] Remove stale comments, dead fields, and count claims.
- [ ] Add repository, homepage, bugs, engines, and scripts metadata.
- [ ] Document the supported pi/Bun/Node version range.

**Acceptance criteria**

- README renders correctly on GitHub and npm.
- Every documented option is either supported or explicitly file-only.

---

## Followable implementation plan

### Phase 1 — Establish safety boundaries

- [ ] Write failing tests for F-01, F-02, F-03, F-07, and F-10 before changing implementation.
- [ ] Introduce strict config parsing with explicit defaults and policy-floor merging.
- [ ] Guard all runtime setup/computation with `ctx.mode === "tui"`.
- [ ] Introduce normalized destination identity and consent checks.
- [ ] Add terminal-safe output sanitization and byte/display limits.
- [ ] Change cross-destination behavior to fail closed.

**Phase gate:** malformed/repository config cannot redirect transcripts, non-TUI modes make no calls, and terminal controls cannot reach rendering.

### Phase 2 — Replace ad hoc state mutation with a state machine

- [ ] Define explicit state fields: active suggestion, cache, cache generation, input generation, conversation generation, request generation, and render mode.
- [ ] Implement central actions for show, dismiss, accept, invalidate, submit, and delete-to-empty re-arm.
- [ ] Route widget and ghost updates through one render function.
- [ ] Abort/invalidate in-flight work on non-accept user input.
- [ ] Clear cached suggestions when a user message changes conversation generation.
- [ ] Re-arm only on a verified non-empty-to-empty edit transition.

**Phase gate:** F-04, F-08, and F-09 regression tests pass in all render modes.

### Phase 3 — Correct ghost rendering and editor composition

- [ ] Replace ANSI-unsafe unfocused overlay logic.
- [ ] Add exact-width tests using a real pi-tui editor render.
- [ ] Install the ghost wrapper once per session.
- [ ] Compose with `ctx.ui.getEditorComponent()` and restore prior ownership safely.
- [ ] Remove settle-time editor replacement.
- [ ] Add a widget fallback when editor composition cannot be guaranteed.

**Phase gate:** real focused/unfocused rendering is width-safe, and editor state/other extension behavior survives settlement.

### Phase 4 — Upgrade integration and lifecycle coverage

- [ ] Extend the harness to model terminal listeners, focused-component input, and consumption order.
- [ ] Add reload/new/resume/fork lifecycle coverage.
- [ ] Add autocomplete and conflicting-key coverage, especially a configured `tab` accept key.
- [ ] Replace timing sleeps with fake timers.
- [ ] Add an optional manual TUI smoke-test script/checklist for behavior that cannot be made deterministic in unit tests.

**Phase gate:** tests reproduce real pi 0.84.1 lifecycle and editor behavior rather than only fake callback wiring.

### Phase 5 — Harden persistence, CI, release, and documentation

- [ ] Make config writes atomic and private.
- [ ] Add package scripts and pinned development tooling.
- [ ] Run tests, typecheck, package verification, version checks, ancestry checks, and provenance in release CI.
- [ ] Fix README rendering and stale source/test comments.
- [ ] Add package metadata and compatibility policy.
- [ ] Run the complete verification matrix below.

**Phase gate:** a clean checkout can verify and package the release with one documented command, and an invalid tag cannot publish.

---

## Final verification test plan

These checks must be completed after all proposed changes. A release is not ready if any required item fails.

### A. Automated unit and integration tests

#### Output safety

- [ ] OSC 52 terminated by BEL is removed/rejected.
- [ ] OSC terminated by ST, CSI cursor/color commands, DCS/APC/PM/SOS, CR, NUL, DEL, and C1 controls are removed/rejected.
- [ ] Bidi overrides/isolates are removed or safely escaped.
- [ ] Safe emoji, combining characters, CJK, RTL letters without controls, and ordinary punctuation remain intact.
- [ ] Thousands of zero-width escapes cannot bypass the byte/code-point cap.
- [ ] Widget and ghost output contains only extension-generated ANSI.

#### Config and privacy

- [ ] Table-test every field with correct, wrong-type, `null`, array, fractional, negative, zero, and excessive values.
- [ ] Invalid `acceptKey` can never throw during terminal input.
- [ ] Invalid privacy config causes zero `complete()` calls.
- [ ] Untrusted project config is ignored.
- [ ] Project config cannot loosen a global deny policy or increase a global cap.
- [ ] New destination requires consent; changed endpoint invalidates prior consent.
- [ ] Same label/different endpoint is treated as different.
- [ ] Missing active model plus cross-destination deny returns no model.
- [ ] Supported secret formats have positive and near-miss tests in both user and assistant text.

#### Mode behavior

- [ ] TUI mode computes and renders normally.
- [ ] RPC, JSON, and print modes make zero suggestion-model calls by default.
- [ ] `/next-prompt-config` returns a clear mode error outside TUI.

#### Input state machine

Run each relevant sequence in `widget`, `ghost`, and `both`:

- [ ] settle → show → non-accept printable key → all UI clears immediately;
- [ ] settle → show → Escape/arrow → clear with no later re-arm;
- [ ] settle → show → accept → editor fills exactly once;
- [ ] accept → edit but do not submit → delete-to-empty → re-arm after configured delay;
- [ ] accept → submit → next call returns `NONE`/error → old suggestion never re-arms;
- [ ] pending completion → type → delete-to-empty → resolve old completion → nothing renders;
- [ ] pending completion → session switch/shutdown → resolve → nothing renders;
- [ ] autocomplete open → configured conflicting accept key → autocomplete wins or config is rejected according to the documented policy.

#### Rendering and editor integration

- [ ] Use actual pi-tui `Editor`/`CustomEditor.render()` output, not only synthetic strings.
- [ ] Focused and unfocused lines satisfy `visibleWidth(line) <= width` at widths 1, 2, 10, 40, and 120.
- [ ] Cover ASCII, emoji, combining marks, CJK, existing ANSI, cursor-at-end, cursor-on-character, and editor padding.
- [ ] Assert no partial ANSI escape fragments.
- [ ] Assert `setEditorComponent()` is not called again on settlement.
- [ ] Preserve text, mid-line cursor, undo, history browsing, autocomplete, and a pre-existing editor factory.

#### Config persistence

- [ ] Umask `0002` still produces mode `0600`.
- [ ] Existing permissive mode is corrected.
- [ ] Symlink/non-regular destination is refused.
- [ ] Simulated write/rename failure preserves the prior valid JSON.
- [ ] Concurrent saves never leave malformed JSON.

### B. Manual TUI smoke tests

Perform these in a real pi 0.84.1-compatible session on at least two terminal emulators if possible:

- [ ] Verify `widget`, `ghost`, and `both` visually at narrow and wide terminal sizes.
- [ ] Switch terminal/app focus while a ghost is visible; confirm no overflow or corrupted styling.
- [ ] Type, dismiss, accept, edit, delete-to-empty, and submit using the default key.
- [ ] Exercise slash/path autocomplete and a deliberately conflicting configured key.
- [ ] Verify IME input and wide Unicode cursor placement.
- [ ] Run `/reload`, `/new`, `/resume`, `/fork`, and `/clone`; acceptance and rendering must continue without duplicate listeners.
- [ ] Run alongside another custom-editor extension; both behaviors must remain available or next-prompt must fall back with a clear warning.
- [ ] Test model error, abort, `NONE`, length stop, slow completion, and provider switch.
- [ ] Verify the first cross-destination request requires clear consent and that denial results in no request.
- [ ] Run print/JSON/RPC modes and confirm no hidden suggestion request occurs.

### C. Repository and release checks

After adding the planned package scripts/tooling, run from a clean checkout:

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run verify:package
npm pack --dry-run --json
git diff --check
```

Then verify:

- [ ] all commands exit 0;
- [ ] the package archive contains only intended runtime/documentation files;
- [ ] the README renders correctly on GitHub and npm;
- [ ] package version equals the release tag;
- [ ] the tagged commit is on the protected default branch;
- [ ] publish provenance/trusted-publishing configuration is valid;
- [ ] the minimum and latest supported pi versions pass the suite;
- [ ] no blocking LSP or pi-lens diagnostics remain.

---

## Methodology and limitations

### Techniques used

- Read all tracked implementation, test, documentation, package, and workflow files.
- Examined full commit history and blame for load/config, input handling, ghost rendering, editor installation, and release changes.
- Compared behavior with installed pi/pi-tui 0.84.1 source and official extension/TUI documentation.
- Ran unit tests, TypeScript checking, LSP diagnostics, package dry-run, and focused runtime probes.
- Used three independent adversarial review lanes: runtime correctness/lifecycle, security/privacy/config, and tests/packaging/docs.

### Limitations

- No live interactive pi TUI session was run during this review.
- Terminal-specific key encoding, IME behavior, and actual multi-extension composition still require the manual smoke tests above.
- Compatibility was inspected primarily against pi packages 0.84.1.
- Secret redaction can never guarantee detection of arbitrary secrets; the plan intentionally makes destination consent and least disclosure the primary controls.

**Confidence:** high for the confirmed source-level and direct-probe findings; medium for terminal- and lifecycle-specific behavior pending live smoke tests.
