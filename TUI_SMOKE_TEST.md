# Manual TUI smoke tests — next-prompt

Terminal-rendering and live-interaction behavior cannot be fully verified in
unit tests (the automated suite covers the editor/rendering contracts via real
pi-tui `Editor`/`CustomEditor` integration tests, but not a live terminal).
Before any release, run every check below in a real pi session (0.84.0+) AND a
real OMP session (17.2.x), ideally on **at least two terminal emulators** per
host, and record the result.

**Status legend:** `[ ]` not run · `[x]` passed · `[!]` failed (blocker: fix
before release, note the failure)

Record date, host + version, terminal emulators, configured render mode,
provider/model, and any failures at the bottom. **Do not publish until every
case passes.**

## Pi smoke cases

### Render modes

- [ ] `widget`, `ghost`, and `both` render correctly at narrow and wide
  terminal sizes; no border corruption, no overflow past the editor width.
- [ ] In `ghost`/`both`, the greyed ghost appears after the caret only when the
  editor is empty; with text present the editor is never clobbered.
- [ ] Switch terminal/app focus while a ghost is visible (unfocused editor):
  ghost still renders within the box, no overflow or corrupted styling.

### Input state machine (default key `Enter`)

Run each sequence in `widget`, `ghost`, and `both`:

- [ ] settle → show → non-accept printable key → all UI clears immediately;
- [ ] settle → show → Escape/up/down → clear with no later re-arm;
- [ ] settle → show → right or Alt+> → the next item in this turn's batch (or wrap to the
      first); left or Alt+< restores the previous; hint shows `1/3` / `2/3`; no extra model call;
- [ ] settle → show → left or Alt+< on the first item wraps to the last of this batch;
      a new turn replaces the list entirely;
- [ ] settle → show → Enter → editor fills exactly once, key is swallowed
  (the prompt is not sent); a second Enter submits;
- [ ] accept → edit but do not submit → delete back to empty → the last
  suggestion re-appears after `rearmDelayMs` (no new model call);
- [ ] accept → submit → next turn returns `NONE`/error → the old suggestion
  never re-arms;
- [ ] pending completion → type → delete-to-empty → resolve old completion →
  nothing renders;
- [ ] pending completion → session switch/shutdown → resolve → nothing
  renders (no consent persisted, no model call);
- [ ] delete-to-empty after dismissing with Escape does NOT re-arm.

### Autocomplete / conflicting keys

- [ ] Slash/path autocomplete still works (Tab, up/down, Enter) after typing
  `/` (which dismisses a visible suggestion); Enter never steals autocomplete
  because accept only fires on an empty editor.
- [ ] Configure `"acceptKey": "tab"` → extension warns and ignores it;
  Tab continues to drive autocomplete and never fills the editor.

### Editor integration

- [ ] IME input and wide Unicode cursor placement (CJK/emoji) work with the
  ghost installed; the cursor block stays on the correct grapheme.
- [ ] History browsing (up/down), undo, kill-ring, and paste behave normally
  with the ghost editor installed.
- [ ] Run `/reload`, `/new`, `/resume`, `/fork`, and `/clone`; acceptance and
  rendering continue without duplicate listeners or double-installed editors
  (no double ghost/widgets, no doubled accept key).
- [ ] Run alongside another custom-editor extension: next-prompt warns, still
  tries ghost mode, and only falls back to widget mode if ghost rendering
  actually fails (prior owner restored, suggestion still appears below the box).

### Model / lifecycle error paths

- [ ] Model error, abort, `NONE`, length stop, slow completion, and provider
  switch behave: no stale suggestion renders, no spurious error notify on
  abort.
- [ ] First cross-destination request requires a clear consent dialog naming
  the destination and transcript size; denial results in **no** request and no
  re-prompt for the session; grant persists across sessions and a route change
  re-prompts.
- [ ] Run print/JSON/RPC modes and confirm no hidden suggestion request
  occurs.

### Enhance prompt (default key `Ctrl+Up`)

- [ ] Type a prompt, press Ctrl+Up: the box is replaced by a clearer rewrite with
  the same meaning; a below-editor `↳ enhanced (Ctrl-Up · Esc to revert)` hint
  shows; exactly one model call.
- [ ] Press Ctrl+Up again → original text restored (`↳ original`); Ctrl+Up once
  more → enhanced text restored; NO additional model call on either toggle.
- [ ] Press Esc while enhanced → original restored, hint cleared.
- [ ] Edit the box after enhancing → the revert hint clears and Ctrl+Up starts a
  fresh rewrite of the edited text.
- [ ] Ctrl+Up on an empty editor or while the agent is running does nothing (no
  model call).
- [ ] Submit the enhanced prompt → it sends normally; an in-flight rewrite is
  aborted by submit/new turn/agent start with no stale replacement.
- [ ] Only the typed line is sent (verify no transcript in the request); a
  cross-destination enhance model triggers the same consent dialog as
  suggestions.
- [ ] `"enhanceEnabled": false` disables the key (falls through to the editor);
  `"enhanceKey": "enter"`/`"tab"` is rejected with a warning.

## OMP smoke cases

Setup: install the fork with `omp plugin install github:dnth/omp-autosuggest-reply`,
then run `omp plugin doctor` (expect zero plugin errors) before the interactive
checks.

- [ ] `omp plugin doctor` passes with the package installed and enabled.
- [ ] Interactive session reaches a below-editor widget suggestion after the
  **final** `agent_end` (editor empty, agent idle).
- [ ] Tool-loop / automatic-retry continuation shows **no** intermediate
  suggestion (only the terminal completion does).
- [ ] `renderMode: "ghost"` and `renderMode: "both"` render inline ghost text in
  the input box after the caret (empty editor), with a usable widget in `both`;
  accept fills the editor exactly once; delete-to-empty re-arms the last
  suggestion after `rearmDelayMs` without a second model call; ghost render
  failure falls back to the default editor + widget.
- [ ] Widget accept (Enter) fills the editor exactly once and the raw key is
  consumed so the prompt is not sent; left/right or Alt+< / Alt+> wrap this
  turn's batch; any other key dismisses and passes through; delete-to-empty
  re-arms the cached suggestion without a second model call.
- [ ] Input submit, new agent start, session reload, and shutdown prevent any
  stale widget output from an in-flight request.
- [ ] Headless / print / RPC modes create no completion request.
- [ ] Cross-destination consent: first request prompts once; decline blocks the
  destination for the session with no request; grant persists across sessions;
  a route change re-prompts.
- [ ] Widget renders correctly at narrow and wide terminal sizes; no overflow.
- [ ] Enhance prompt: type a prompt, press Ctrl+Up → box replaced by a clearer
  rewrite (one `completeSimple` call, only the typed text sent); Ctrl+Up or Esc
  revert to the original with no extra call; disabled cleanly with
  `"enhanceEnabled": false`.

## Record

- Date:
- Pi version(s):
- OMP version(s):
- Terminal emulators:
- Configured render mode:
- Provider/model:
- Results / failures:
