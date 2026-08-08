# next-prompt — next-prompt suggestions for pi

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that,
after an agent turn fully settles and the input editor is empty, computes the single
most logical next instruction you'd type and shows it. Three render modes:

- **`widget`** (default) — a colored below-editor line:
  `↳ next: <suggestion>  (Alt-/ to accept)`
- **`ghost`** — inline greyed ghost text **in the input box** (renders even when the
  editor is unfocused, e.g. after switching tabs/apps)
- **`both`** — inline ghost AND the below-editor widget simultaneously

Accept with **`Alt-/`** (default; configurable) to fill the input box. Any other key
dismisses; backspace down to empty re-arms the last suggestion after a short delay (no
new model call). No suggestion while streaming; the suggestion is cleared and any
in-flight model call aborted the instant you submit, start a turn, or the agent starts.

## Install

Pi auto-discovers extensions from standard locations.

### From npm / the pi package gallery

The published package is `@gamaraan/next-prompt`, published under the npm account `gamaraan`:

```bash
pi install npm:@gamaraan/next-prompt
```

A specific release can be pinned with:

```bash
pi install npm:@gamaraan/next-prompt@0.1.0
```

### From GitHub

The source repository is `gamaraan/next-prompt-extension`:

```bash
pi install git:github.com/gamaraan/next-prompt-extension
```

To pin a GitHub release or commit, append the tag or commit reference:

```bash
pi install git:github.com/gamaraan/next-prompt-extension@v0.1.0

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

Run the `/next-prompt-config` slash command in pi for a guided walkthrough of every
option — a model picker (lists all available models, like `/model`), render mode,
thinking level, accept key, re-arm delay, transcript/suggestion caps, and
cross-provider disclosure. Changes are saved to `~/.pi/agent/next-prompt.json` and pi
reloads so they take effect immediately.

### Config file

All fields optional. Merged global + project (project overrides global **per top-level
key**; the nested `model` block is replaced wholesale, not merged):

- Global: `~/.pi/agent/next-prompt.json`
- Project: `<cwd>/.pi/next-prompt.json`

```json
{
  "model": { "provider": "ollama", "model": "deepseek-v4-flash:0731-cloud" },
  "thinking": "low",
  "acceptKey": "alt+/",
  "renderMode": "both",
  "rearmDelayMs": 2000,
  "maxTranscriptChars": 12000,
  "maxSuggestionChars": 240,
  "allowCrossProvider": true
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | current model (`ctx.model`) | `{ provider, model }`. If the configured model isn't found, pi notifies once (`warning`) and falls back to the current model. |
| `thinking` | unset | Reasoning level for the suggestion model: `"minimal"`/`"low"`/`"medium"`/`"high"`/`"xhigh"`/`"max"`. Set `"low"` for faster suggestions. Passed as `reasoning` to the model call. |
| `acceptKey` | `"alt+/"` | Any pi-tui `KeyId` (e.g. `"alt+/"`, `"ctrl+space"`, `"shift+enter"`). Intercepted **before** the base editor, so keys like `ctrl+space` (`\x00`) won't pollute the box. Accept only fires when a suggestion is showing and the autocomplete dropdown is closed. |
| `renderMode` | `"widget"` | `"widget"` (below-editor line), `"ghost"` (inline greyed text in the box), or `"both"` (inline ghost + below-editor widget). |
| `rearmDelayMs` | `2000` | Delay (ms) before re-arming the last suggestion after the user deletes back to empty. No new model call. |
| `systemPrompt` | built-in extractor | See `SYSTEM_PROMPT` in `next-prompt.ts`. |
| `maxTranscriptChars` | `12000` | Tail-truncation of the conversation transcript sent to the model. |
| `maxSuggestionChars` | `240` | Cap on the returned suggestion length. |
| `allowCrossProvider` | `true` | When `false`, fall back to the current model if the configured suggestion model is on a **different** provider. See Security below. |

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
suggestion model is the same provider/model. If you configure a suggestion model on a
**different** provider (e.g. active = Claude, suggestion = OpenAI), the transcript is
sent to that second provider, which may have different data-handling terms.

Mitigations:

- `buildTranscript` redacts obvious high-entropy secrets (AWS `AKIA…`, OpenAI `sk-…`,
  GitHub `ghp_…` ≥36 chars, Slack `xoxb-…`, PEM private key blocks) before sending.
  This is defense-in-depth, not a guarantee.
- Set `"allowCrossProvider": false` to force same-provider suggestions silently.
- The redaction patterns are in `redactSecrets()`; extend them if you handle other
  secret formats.

## How it works

1. On `session_start`, a global `ctx.ui.onTerminalInput` listener is registered to
   detect the accept key **editor-independently** (survives pi's `resetExtensionUI`,
   which would otherwise orphan a custom editor). In `ghost`/`both` mode, a custom
   `GhostEditor` is also installed via `setEditorComponent` and re-installed on
   `agent_settled` to recover after resets.
2. On `agent_settled` (one event per user-initiated turn, after the agent is truly
   idle), if the editor is empty, the controller calls
   `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal, reasoning })`
   with the resolved model, the configured thinking level, and the (redacted,
   tail-truncated) transcript.
3. The returned text is sanitized (trimmed, de-quoted, de-fenced, collapsed to one
   line, capped) and shown — via `setWidget` (widget/both), via the inline ghost
   overlay (ghost/both), or both.
4. The accept key is intercepted **before** the base editor: if a suggestion is
   showing and autocomplete is closed, it fills the editor via
   `ctx.ui.setEditorText` and swallows the key. Any other key delegates to the base
   editor; if the user deletes back to empty, the last suggestion re-arms after
   `rearmDelayMs` (no new model call).

## Develop

Clone and run the tests with [Bun](https://bun.sh):

```bash
bun test
```

The extension imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
`@earendil-works/pi-ai`. These are provided by your pi installation — list them in
`peerDependencies` with `"*"` (do not bundle). If your editor's TypeScript LSP can't
resolve them, link them from your pi install's `node_modules` (git-ignored here;
nothing is downloaded).

Edit `next-prompt.ts` in place and restart pi to pick up changes.

## Publish to npm and pi.dev/packages

The package is named `@gamaraan/next-prompt` and is published under the npm account
[`gamaraan`](https://www.npmjs.com/~gamaraan). Its source repository is
[`gamaraan/next-prompt-extension`](https://github.com/gamaraan/next-prompt-extension).

The repository includes the required pi package manifest in [`package.json`](./package.json):

```json
{
  "name": "@gamaraan/next-prompt",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./next-prompt.ts"]
  }
}
```

To publish a new release as `gamaraan`:

```bash
npm login
npm whoami                 # should print: gamaraan
npm version patch          # or minor / major
npm publish
```

For a first release, the package is published as `@gamaraan/next-prompt@0.1.0`. After npm
publishes it, pi's package gallery can discover it through the `pi-package` keyword.
Users install it with:

```bash
pi install npm:@gamaraan/next-prompt
```

A GitHub-based installation is also available independently of npm:

```bash
pi install git:github.com/gamaraan/next-prompt-extension
```

When publishing, include the updated `README.md`, `package.json`, `next-prompt.ts`,
and any release metadata in the npm package. The `files` field in `package.json`
controls the published contents.

## Design & development

The design went through an adversarial review by an oracle subagent during
development — see the [GitHub repository](https://github.com/gamaraan/next-prompt-extension)
for the full commit history and design discussion.

## License

MIT — see [LICENSE](./LICENSE).
