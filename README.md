# next-prompt — next-prompt suggestions for pi and Oh My Pi

A [pi](https://github.com/earendil-works/pi-coding-agent) / [Oh My Pi](https://github.com/oh-my-pi) (OMP)
coding-agent extension that, after an agent turn fully settles and the input editor is empty, computes the single
most logical next instruction you'd type and shows it. Three render modes:

- **`widget`** (default) — a colored below-editor line:
  `↳ next: <suggestion>  (Alt-/ to accept)`
- **`ghost`** — inline greyed ghost text **in the input box** (renders even when the
  editor is unfocused, e.g. after switching tabs/apps)
- **`both`** — inline ghost AND the below-editor widget simultaneously

> **OMP editor-coexistence note:** `ghost`/`both` work on OMP too. OMP has no
> public editor-owner getter, so next-prompt cannot detect another custom-editor
> extension that installed first in the same session — the last installer wins
> there (Pi captures and can restore the prior owner). If ghost rendering ever
> fails, the default editor is restored and the mode falls back to widget.

Accept with **`Alt-/`** (default; configurable) to fill the input box. Any other key
dismisses; backspace down to empty re-arms the last suggestion after a short delay (no
new model call). No suggestion while streaming; the suggestion is cleared and any
in-flight model call aborted the instant you submit, start a turn, or the agent starts.

## Install

Pi and OMP auto-discover extensions from standard locations.

### From npm / the pi package gallery

The published package is `@gamaraan/next-prompt`, published under the npm account `gamaraan`:

```bash
pi install npm:@gamaraan/next-prompt
```

A specific release can be pinned with:

```bash
pi install npm:@gamaraan/next-prompt@0.1.0
```

### OMP

Install through the OMP plugin manager (observed from `omp plugin --help` /
`omp plugin install --dry-run`):

```bash
omp plugin install npm:@gamaraan/next-prompt
```

Pin a specific release the same way:

```bash
omp plugin install npm:@gamaraan/next-prompt@0.1.0
```

After installing, run `omp plugin doctor` and confirm zero plugin errors. The
package manifest uses the `pi.extensions` form, which OMP accepts directly and
loads with its legacy `@earendil-works/pi-*` import remapping — there is no
separate OMP package.

### From GitHub

The source repository is `gamaraan/next-prompt-extension`:

```bash
pi install git:github.com/gamaraan/next-prompt-extension
```

To pin a GitHub release or commit, append the tag or commit reference:

```bash
pi install git:github.com/gamaraan/next-prompt-extension@v0.1.0
```

### Manual — copy the file

Copy `next-prompt.ts` into your global pi extensions directory:

```bash
cp next-prompt.ts ~/.pi/agent/extensions/next-prompt.ts
```

Or, for a single project only, place it in the project-local extensions directory
(loads after the project is trusted):

```bash
cp next-prompt.ts .pi/extensions/next-prompt.ts
```

### Manual — reference from settings

Add the path to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/or/relative/path/to/next-prompt.ts"
  ]
}
```

Restart `pi` (or start a new session) after installing.

## Configure

### Interactive: `/next-prompt-config`

Run the `/next-prompt-config` slash command for a guided walkthrough of
**every configurable option except `systemPrompt`** (that one is config-file-only) —
a model picker (lists all available models), render mode, thinking level, accept
key, re-arm delay, transcript/recent-turn/suggestion caps, and cross-provider
disclosure. Changes are saved to the host agent dir
(`~/.pi/agent/next-prompt.json` on Pi, `~/.omp/agent/next-prompt.json` on OMP)
and the host reloads so they take effect immediately.

### Config file

All fields optional. Merged global + project (project overrides global **per top-level
key**; the nested `model` block is replaced wholesale, not merged). The config root
comes from the host's `CONFIG_DIR_NAME`:

| Host | Global | Project |
| --- | --- | --- |
| Pi | `~/.pi/agent/next-prompt.json` | `<cwd>/.pi/next-prompt.json` |
| OMP | `~/.omp/agent/next-prompt.json` | `<cwd>/.omp/next-prompt.json` |

```json
{
  "model": { "provider": "ollama", "model": "deepseek-v4-flash:0731-cloud" },
  "thinking": "low",
  "acceptKey": "alt+/",
  "renderMode": "both",
  "rearmDelayMs": 2000,
  "maxTranscriptChars": 12000,
  "maxRecentTurns": 10,
  "maxSuggestionChars": 240,
  "allowCrossProvider": false
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | current model (`ctx.model`) | `{ provider, model }`. If the configured model isn't found, pi notifies once (`warning`) and falls back to the current model. |
| `thinking` | unset | Reasoning level for the suggestion model: `"minimal"`/`"low"`/`"medium"`/`"high"`/`"xhigh"`/`"max"`. Set `"low"` for faster suggestions. Passed as `reasoning` to the model call. |
| `acceptKey` | `"alt+/"` | Any pi-tui `KeyId` (e.g. `"alt+/"`, `"ctrl+space"`, `"shift+enter"`). Intercepted **before** the base editor, so keys like `ctrl+space` (`\x00`) won't pollute the box. Accept only fires when a suggestion is showing and the autocomplete dropdown is closed. |
| `renderMode` | `"widget"` | `"widget"` (below-editor line), `"ghost"` (inline greyed text in the box), or `"both"` (inline ghost + below-editor widget). On OMP, `ghost`/`both` work too (see the editor-coexistence note above). |
| `rearmDelayMs` | `2000` | Delay (ms) before re-arming the last suggestion after the user deletes back to empty. No new model call. |
| `systemPrompt` | built-in extractor | Config-file only (not prompted by `/next-prompt-config`). See `SYSTEM_PROMPT` in `next-prompt.ts`. |
| `maxTranscriptChars` | `12000` | Tail-truncation of the conversation transcript sent to the model. |
| `maxRecentTurns` | all | Disclosure minimization: only the last N user/assistant turns are sent (tool results are never sent regardless). Invalid values fail closed — suggestions are disabled. |
| `maxSuggestionChars` | `240` | Cap on the returned suggestion length (visible width; a hard code-point bound of 4× this value also applies, so zero-width payloads cannot bypass the cap). |
| `allowCrossProvider` | `false` | When `true`, a configured suggestion model on a **different destination** (provider + endpoint + model route) than the active model may be used — but only after explicit per-project consent (see Security). When `false`, fall back to the active model silently. Project config can never loosen a global `false`. |
| `allowCrossProviderPairs` | `[]` | Directional provider pairs that skip the consent dialog: `[["activeProvider", "suggestionProvider"]]` (e.g. `[["opencode-go", "openai"]]`). Set via the dialog's "Always allow for this provider pair" option (saved to the global config) or by hand. Case-insensitive; the reverse direction is NOT implied. Invalid entries fail closed — suggestions are disabled. |

### Why `alt+/` is the default accept key

- **`tab`** — conflicts with pi's path-autocomplete and `/template` dropdown.
- **`ctrl+tab`** — many terminals send it as plain `tab`/`\t` or swallow it (window/tab switcher), so it's unreliable.
- **`ctrl+space`** — works (sends `\x00`, which pi-tui maps to `ctrl+space`); the extension intercepts it before the base editor so it no longer pollutes, but some terminals remap Ctrl-Space to IME toggle.
- **`alt+/`** — sends an unambiguous `\x1b/` sequence, not bound by pi or most terminals, and is memorable ("accept the suggested next command"). Recommended.

Override with any `KeyId`, e.g. `"acceptKey": "ctrl+space"`.

## Security: cross-provider transcript disclosure

The extension sends the conversation transcript (user + assistant text only — tool
results, thinking blocks, and tool-call arguments are skipped) to the suggestion
model. This is **no more** than what the active model already saw **if** the
suggestion model is on the **same destination** as the active model. A destination
is the provider label **plus** the endpoint origin **plus** the resolved model's
routing id: two different downstream models behind one gateway (e.g. `openai/gpt`
and `openai/claude` at the same `https://gateway.example/v1`) are **different**
destinations. If you configure a suggestion model on a **different** destination,
the transcript is sent to that second destination, which may have different
data-handling terms.

Cross-destination disclosure is **opt-in and fail-closed**:

- `allowCrossProvider` defaults to `false`. With `false`, a configured model on a
different destination is never used; the extension silently falls back to the
active model (and, when there is no active model, computes nothing).
- With `true`, the first time a different destination would receive the transcript,
the host shows a dialog naming the destination and the transcript size, with three
choices: **Allow once (this project)**, **Always allow for this provider pair**, and
**Decline**. "Allow once" persists consent per project + destination (provider +
endpoint + model route) in `<agent dir>/next-prompt-consent.json` (a 0600 file
outside the repository; `~/.pi/agent` on Pi, `~/.omp/agent` on OMP); declining
blocks that destination for the rest of the session without re-prompting. "Always
allow" additionally saves the directional provider pair (`[active provider,
suggestion provider]`) to the global config (via the same atomic 0600 write), so
that exact direction never prompts again in any project — the per-destination
consent record is kept too, so the dialog also stays silent when the config write
is refused.
- Consent is keyed by the full destination identity: changing the endpoint **or**
the model route invalidates a stored grant and prompts again. Records written by
older versions (without a model route) never match and also re-prompt — fail closed.
- Project config (`<cwd>/.pi/next-prompt.json` on Pi, `<cwd>/.omp/next-prompt.json`
  on OMP) is only honored for **trusted** projects, and can never loosen a global
  `allowCrossProvider: false` or increase a global `maxTranscriptChars` cap —
  repository content cannot silently redirect your transcript. Pi gates project
  config on its `isProjectTrusted()` API. **OMP exposes no project-trust API**, so
  OMP follows the configuration loader's default (trusted) and enforces the same
  global privacy floors and consent flow; there is simply no host project-trust
  signal to consult. An existing-but-unreadable or syntactically invalid
  global/project config disables suggestions entirely rather than falling back to
  defaults (both hosts).

Mitigations:

- `buildTranscript` redacts obvious high-entropy secrets (AWS `AKIA…`, OpenAI
  `sk-…`/`sk-proj-…`/`sk-ant-…`, GitHub `ghp_…`/`github_pat_…`, GitLab `glpat-…`,
  Google `AIza…`, Slack `xoxb-…`, JWTs, PEM private key blocks, and `key=value`
  assignment forms) from both user and assistant text before sending. This is
  defense-in-depth, **not** comprehensive secret detection — destination consent
  and least disclosure are the primary controls.
- `maxRecentTurns` minimizes what is sent by limiting the transcript to the last
  N turns.
- Suggestion output is sanitized before rendering: terminal control sequences
  (OSC/CSI/DCS/APC/PM/SOS — both ESC-prefixed and 8-bit forms), C0/C1 controls,
  DEL, carriage returns, bidi overrides, unpaired surrogates, and oversized
  zero-width payloads are stripped or bounded, so model text can never execute
  terminal commands (e.g. OSC 52 clipboard writes).

## How it works

1. On `session_start` (interactive mode only — Pi TUI `ctx.mode === "tui"`, OMP
`ctx.hasUI === true`; headless/RPC/JSON sessions never compute), a global
`ctx.ui.onTerminalInput` listener is registered to detect the accept key
**editor-independently**. `ghost`/`both` install a render-only `GhostEditor` via
`setEditorComponent` — never re-installed on settle. If another extension owns
the editor on Pi, the ghost is **still attempted** (with a warning); only if the
ghost install or its render pass actually fails does the extension restore the
prior owner and fall back to widget mode. On OMP there is no editor-owner getter,
so a failed ghost restores the **default** editor instead; OMP also has no
host-side extension-editor teardown, so next-prompt resets its editor to default
at the next `session_start`. The host clears extension listeners when the UI is
reset; each fresh `session_start` (reload/new/resume/fork) re-registers exactly
one listener and re-installs the editor once.
2. On completion:
   - **Pi:** `agent_settled` (its fully-settled contract) — if the editor is
     empty, the controller calls
     `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal, reasoning })`
     with the resolved model, the configured thinking level, and the (redacted,
     tail-truncated) transcript.
   - **OMP:** only a **terminal** `agent_end` (never when `event.willContinue`
     is true — continuations, automatic retries, and pending continuation turns
     produce no suggestion) — the controller lazily imports `completeSimple`
     from the remapped legacy pi-ai module and calls
     `completeSimple(model, { systemPrompt: [prompt], messages }, { apiKey: modelRegistry.resolver(model), signal, reasoning })`.
     OMP emits the extension `agent_end` **before** the session fully unwinds
     (`ctx.isIdle()` is still false at handler time), so the terminal event
     itself is treated as the settle signal on OMP; Pi keeps its
     `agent_settled` + real-time idle gates. Stale-output protection is
     identical on both hosts (input-generation bumps, aborts, and render-time
     guards). Pi never loads the OMP module; OMP never calls
     `modelRegistry.complete`.
3. The returned text is sanitized (terminal controls stripped, trimmed, de-quoted,
   de-fenced, collapsed to one line, capped) and shown — via `setWidget`
   (widget/both), via the inline ghost overlay (ghost/both), or both.
4. The accept key is intercepted **before** the base editor: if a suggestion is
   showing, it fills the editor via `ctx.ui.setEditorText` and swallows the key.
   Any other key dismisses the suggestion immediately (widget and ghost) and
   delegates to the base editor; deleting back to empty re-arms the last suggestion
   after `rearmDelayMs` (no new model call). Dismissing via Escape/arrows never
   re-arms, and typing invalidates any in-flight suggestion request.

## Develop

Clone and run the checks with [Bun](https://bun.sh):

```bash
bun install
bun run typecheck        # Pi API types (default tsconfig.json)
bun run typecheck:omp    # OMP 17.2.12 API types (tsconfig.omp.json)
bun test
bun run verify:package
```

The extension imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
`@earendil-works/pi-ai`. These are provided by your pi installation — list them in
`peerDependencies` with `"*"` (do not bundle). If your editor's TypeScript LSP can't
resolve them, link them from your pi install's `node_modules` (git-ignored here;
nothing is downloaded). The pinned `@oh-my-pi/*` packages are **dev-only** test
dependencies for `tsconfig.omp.json` — they never appear in `peerDependencies` or
runtime imports; on OMP the legacy `@earendil-works/pi-*` imports are remapped to
the host's bundled packages at load time.

Edit `next-prompt.ts` in place and restart the host (pi or OMP) to pick up changes.

## Compatibility

**Pi:** supported range **0.84.0 – latest (0.84.x at time of writing)**.
`ModelRegistry.complete()` — which the extension calls directly — was added in
pi 0.84.0, so older 0.80–0.83 releases are not supported. CI runs the unit suite
and typecheck against both the oldest supported and the latest published
`@earendil-works/pi-*` packages (`.github/workflows/test.yml` — `compat` job) on
every PR.

**OMP:** supported first against **17.2.12** (the researched API version). OMP
runs the extension through its legacy `pi.extensions` manifest and
`@earendil-works/pi-*` import remapping — the same published package works on both
hosts. OMP-specific behavior:

- Lifecycle: suggestions compute on a **terminal `agent_end`** only;
  `willContinue: true` events (tool-loop continuations, automatic retries) never
  compute. Pi keeps its `agent_settled` contract.
- Transport: OMP completes via `completeSimple` + the model registry's auth
  resolver; Pi keeps `modelRegistry.complete`.
- Rendering: OMP supports `widget`, `ghost`, and `both`; because OMP has no
  editor-owner getter, a ghost failure restores the default editor (Pi restores
  the captured prior owner) and another custom-editor extension installed first
  in the same session is not detected.
- Trust: OMP has no project-trust API; project config follows the loader default
  (global privacy floors and consent are unchanged).

CI adds an OMP job that typechecks against the pinned `@oh-my-pi/*` 17.2.12
surface (`bun run typecheck:omp`), runs the full unit suite, packs/inspects the
extension artifact, and validates plugin discovery + `omp plugin doctor` in an
isolated profile.

## Manual TUI smoke tests

Terminal-rendering and live-interaction behavior cannot be fully verified in unit
tests. Before a release, run the checklist in
[`TUI_SMOKE_TEST.md`](./TUI_SMOKE_TEST.md) in a real pi session AND a real OMP
session, and record the results.

## Design & development

Source and design discussion live in the
[GitHub repository](https://github.com/gamaraan/next-prompt-extension).

## License

MIT — see [LICENSE](https://github.com/gamaraan/next-prompt-extension/blob/main/LICENSE).
