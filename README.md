# next-prompt — next-prompt suggestions for pi

A [pi](https://github.com/earendil-works/pi-coding-agent) coding-agent extension that,
after an agent turn fully settles and the input editor is empty, computes the single
most logical next instruction you'd type and shows it as a **colored below-editor
suggestion widget**:

```
↳ next: Show me the diff of the skill file you just patched  (Alt-/ to accept)
```

- **`Alt-/`** (default; configurable) → accept the suggestion: it fills the input box.
- **Any other key** → dismiss the suggestion; it's re-armed from the last computed one
  when you backspace down to empty (no new model call).
- **No suggestion while streaming** — only when the agent is idle and the editor is empty.
- **No stale suggestions** — the suggestion is cleared and any in-flight model call
  aborted the instant you submit, start a new turn, or the agent starts.

The suggestion is rendered as a below-editor widget via `ctx.ui.setWidget` (the
idiomatic pi mechanism), with the `↳ next:` prefix and the accept-key hint colored
cyan.

## Install

Pi auto-discovers extensions from standard locations. Pick one:

### Option A — copy the file (simplest)

Copy `next-prompt.ts` into your global pi extensions directory:

```bash
cp next-prompt.ts ~/.pi/agent/extensions/next-prompt.ts
```

Or, for a single project only, place it in the project-local extensions directory:

```bash
cp next-prompt.ts .pi/extensions/next-prompt.ts
```

Project-local extensions load only after the project is trusted.

### Option B — reference it from `settings.json`

Add the path to the `extensions` array in `~/.pi/agent/settings.json`:

```json
{
  "extensions": [
    "/absolute/or/relative/path/to/next-prompt.ts"
  ]
}
```

Restart `pi` (or start a new session) and the extension loads.

## Develop

Clone the repo and run the tests with [Bun](https://bun.sh):

```bash
bun test
```

The extension imports `@earendil-works/pi-coding-agent`, `@earendil-works/pi-tui`, and
`@earendil-works/pi-ai`. These are provided by your pi installation, so no extra
dependencies are installed for the extension itself. If your editor's TypeScript LSP
can't resolve those packages, link them from your pi install's `node_modules` (they're
git-ignored in this repo; nothing is downloaded).

Edit `next-prompt.ts` in place and restart pi to pick up changes.

## Config

All fields optional. Merged global + project (project overrides global on key
collisions):

- Global: `~/.pi/agent/next-prompt.json`
- Project: `<cwd>/.pi/next-prompt.json`

```json
{
  "model": { "provider": "ollama", "model": "deepseek-v4-flash:0731-cloud" },
  "thinking": "low",
  "acceptKey": "alt+/",
  "maxTranscriptChars": 12000,
  "maxSuggestionChars": 240,
  "allowCrossProvider": true
}
```

| Field | Default | Notes |
| --- | --- | --- |
| `model` | current model (`ctx.model`) | The model used to generate the suggestion. If the configured model isn't found, pi notifies once (`warning`) and falls back to the current model. |
| `thinking` | unset | Reasoning/thinking level for the suggestion model (`"minimal"`/`"low"`/`"medium"`/`"high"`/`"xhigh"`/`"max"`). Set `"low"` for faster suggestions. Passed as `reasoning` to the model call. |
| `acceptKey` | `"alt+/"` | Key id that accepts the suggestion (any pi-tui `KeyId`, e.g. `"alt+/"`, `"ctrl+space"`, `"shift+enter"`). The accept key is intercepted **before** the base editor sees it, so keys like `ctrl+space` (which sends `\x00`) won't pollute the editor. Accept only fires when the suggestion is showing and the autocomplete dropdown is closed. |
| `systemPrompt` | built-in extractor | See `SYSTEM_PROMPT` in `next-prompt.ts`. |
| `maxTranscriptChars` | `12000` | Tail-truncation of the conversation transcript sent to the model. |
| `maxSuggestionChars` | `240` | Cap on the returned suggestion length. |
| `allowCrossProvider` | `true` | When `false`, fall back to the current model if the configured suggestion model is on a **different** provider than the active one. See Security below. |

### Why `alt+/` is the default accept key

- **`tab`** — conflicts with pi's path-autocomplete and `/template` dropdown.
- **`ctrl+tab`** — many terminals send it as a plain `tab`/`\t` or swallow it (window/tab switcher), so it's unreliable.
- **`ctrl+space`** — works (sends `\x00`, which pi-tui maps to `ctrl+space`), but the extension intercepts it before the base editor so it no longer pollutes; still, some terminals remap Ctrl-Space to IME toggle.
- **`alt+/`** — sends an unambiguous `\x1b/` sequence, not bound by pi or most terminals, and is memorable ("accept the suggested next command"). Recommended.

You can always override with any `KeyId`, e.g. `"acceptKey": "ctrl+space"`.

## Security: cross-provider transcript disclosure

The extension sends the conversation transcript (user + assistant text only — tool
results, thinking blocks, and tool-call arguments are skipped) to the suggestion
model. This is **no more** than what the active model already saw **if** the
suggestion model is the same provider/model. If you configure a suggestion model on a
**different** provider (e.g. active = Claude, suggestion = OpenAI), the transcript is
sent to that second provider, which may have different data-handling terms.

Mitigations:

- `buildTranscript` redacts obvious high-entropy secrets (AWS `AKIA…`, OpenAI `sk-…`,
  GitHub `ghp_…`, Slack `xoxb-…`, PEM private key blocks) before sending. This is
  defense-in-depth, not a guarantee.
- Set `"allowCrossProvider": false` to force same-provider suggestions silently.
- The redaction patterns are in `redactSecrets()`; extend them if you handle other
  secret formats.

## How it works

1. On `session_start`, `setEditorComponent` installs a `NextPromptEditor` that wraps
   the default editor.
2. On `agent_settled` (one event per user-initiated turn, after the agent is truly
   idle), if the editor is empty, the controller calls
   `ctx.modelRegistry.complete(model, { systemPrompt, messages }, { signal, reasoning })`
   with the resolved model, the configured thinking level, and the (redacted,
   tail-truncated) transcript.
3. The returned text is sanitized (trimmed, de-quoted, de-fenced, collapsed to one
   line, capped) and shown via `setWidget("next-prompt", [...], { placement: "belowEditor" })`.
4. `handleInput` intercepts the configured `acceptKey` **before** delegating to the
   base editor: if a suggestion is showing and autocomplete is closed, it inserts the
   suggestion and swallows the key (so `ctrl+space`'s `\x00` never pollutes the box).
   Any other key delegates to the base editor and dismisses/re-arms the suggestion.

## Design doc

See [`PLAN.md`](./PLAN.md) for the full oracle-reviewed design, including the audit
trail of blockers found and fixed during adversarial review.

## License

MIT.
