# Changelog

All notable changes to the **English Speaking Training** VS Code extension will
be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.45] — 2026-05-25

### Added
- Full Alibaba Cloud DashScope Qwen stack: a Qwen chat coach (`qwen-plus`
  by default) and Qwen-ASR speech input (`qwen3-asr-flash`) join the existing
  Qwen-TTS speech output. New `englishTraining.useQwenCoach`,
  `englishTraining.useQwenAudioUnderstanding`, and
  `englishTraining.useQwenStack` commands plus a sidebar "Use Qwen stack"
  preset pin coach + ASR + TTS to DashScope in one click.
- New `englishTraining.qwenCompatibleBaseUrl`, `englishTraining.qwenCoachModel`,
  and `englishTraining.qwenAudioUnderstandingModel` settings expose the
  DashScope OpenAI-compatible base URL and per-route Qwen model id, with
  trimmed/normalized fallbacks so dirty hand-edits cannot wedge the route.

### Changed
- Sidebar provider label for DashScope is now "Qwen" (the routes panel still
  reads "Qwen-ASR" for speech input and "Qwen-TTS" for speech output) so it
  matches the broader role the stack now plays.
- Qwen coach requests now send `response_format: { type: "json_object" }`
  alongside the OpenAI-compatible body, matching the OpenAI coach path. This
  cuts mid-turn JSON parse failures on Qwen3 models that otherwise emit
  `<think>` blocks or Markdown fences around the JSON. The
  `stripThinkBlocks` + `parseLooseJson` fallback stays in place for models
  that ignore the hint.
- Collapsed the duplicate `englishTraining.useRecommendedHybrid`
  ("Use Gemini Core Route") command into `englishTraining.useGeminiOnly`.
  Both wrote `gemini` to all three provider settings, so two Command Palette
  entries with different titles for the same action only added confusion.
- Playback-speed chips now show a tooltip when the active TTS provider is
  not OpenAI, explaining that `Qwen`/`Gemini`/`MiMo` TTS APIs do not honor a
  `speed` request field and the preference will apply once the user switches
  speech-output back to OpenAI.

## [0.1.44] — 2026-05-25

### Changed
- Replaced the user-facing MiniMax speech-output route with Alibaba Cloud
  DashScope Qwen-TTS. Qwen defaults to `qwen3-tts-flash`, stores its key as
  `dashscopeApiKey` / `DASHSCOPE_API_KEY`, supports `language_type` values for
  Auto, Chinese, English, and German, and sends style `instructions` only with
  `qwen3-tts-instruct-flash`.

### Fixed
- Provider fetch timeouts now stay active through response body reads, so a
  stalled `response.text()` or `response.arrayBuffer()` cannot wedge a practice
  turn after headers have arrived.
- Blank stored DashScope key values no longer mask a valid `DASHSCOPE_API_KEY`
  environment fallback.
- The Qwen-TTS voice picker now uses the migrated CSS selector instead of the
  old MiniMax selector.

## [0.1.43] — 2026-05-22

### Fixed
- MiMo speech output now sends the selected line as the assistant message and
  only uses a user message for optional style prompts, so drill-line Listen,
  slow reads, and follow-along audio read the chosen sentence instead of
  drifting back to a generic practice prompt.
- Provider network failures now include the target host and retry guidance
  instead of surfacing a bare `fetch failed` message during transcription,
  coaching, or TTS calls.

## [0.1.42] — 2026-05-22

### Fixed
- Webview recording now requests minimally processed 48 kHz, 16-bit, mono
  voice capture and a higher Opus bitrate while keeping layered fallbacks for
  older Electron builds, reducing the chance that the non-native recorder
  produces muffled takes or fails before capture starts.
- Recording controls now tolerate a missing timer or record button during
  webview recovery instead of throwing while starting, stopping, or sending a
  take.
- Webview recording now flushes chunks once per second and cleans up the
  microphone stream if `MediaRecorder.start()` fails, avoiding a hot mic or a
  heavier stop step on longer takes.
- Aborted webview recordings now detach both stop and data handlers before
  stopping the recorder, so discarded audio chunks cannot bleed into a later
  retry.
- Webview audio chunks are now scoped to the active recording attempt, making
  rapid retry cleanup resilient even if old recorder events arrive late.
- Webview recording submissions, host progress, and host results now carry
  request ids, so stale processing updates cannot reset the UI after a newer
  take has started.
- Native recorder stop and post-recording processing now reuse the same
  request id, keeping the default `macLocal` progress/result/error messages
  scoped to the recording that produced them.
- Webview microphone cleanup now stops tracks best-effort and still clears
  recorder state if one track fails to stop.
- Webview microphone selection now avoids an exact `deviceId` constraint when
  Electron exposes a named input without a usable id, falling back to broad
  capture instead of failing with an overconstrained recorder.
- Fixed webview control registration now tolerates missing fixed buttons
  during template drift, preventing one absent control from breaking the whole
  practice script at startup.

## [0.1.41] — 2026-05-22

### Fixed
- Practice webview provider, setup, and recorder controls now read state
  through the same scalar/object guards as rendering, so malformed or
  casing-drifted `settings`, `keys`, `progress`, or diagnostics payloads cannot
  leak `[object Object]` labels or force the wrong setup/recorder state.
- Provider key readiness in the practice webview now treats only explicit
  boolean `true` as saved, preventing malformed key payloads from enabling
  record, TTS, or provider cards prematurely.

## [0.1.40] — 2026-05-22

### Fixed
- String settings now ignore malformed non-string values before trimming, so a
  bad hand edit in `settings.json` falls back instead of throwing a `trim is
  not a function` error during activation, provider setup, TTS, or recording.
- Path settings such as `pythonPath`, `nativeRecorderFfmpegPath`, and
  `localMaterialsRoot` now share the same `~/...` expansion logic, so shells
  are no longer required to make home-relative executable paths work.
- MiniMax cloned-voice commands now compare the current voice id and TTS model
  through the same safe string-setting parser used by provider calls, avoiding
  redundant rewrites when older settings only differ by whitespace.
- The status tree now defensively string-normalizes compacted diagnostic
  fields and has regression coverage for its unavailable-workspace fallback.
- Local materials root configuration now repairs malformed existing
  `localMaterialsRoot` settings instead of crashing when comparing the selected
  folder with a hand-edited value.
- Shared string-array parsing now trims scalar entries and drops whitespace-only
  items before they reach prompts, tags, coach problems, or follow-up drill
  text.
- Runtime error reporting now extracts trimmed scalar `message`, `error`,
  `reason`, `statusText`, or `code` fields from non-`Error` failures instead
  of surfacing `[object Object]` in panels or fallback prompts.
- Practice webview numeric controls now accept only real numbers or numeric
  strings, so malformed array/boolean payloads cannot accidentally change TTS
  speed, request ids, slow-read speed, or generated-drill counts.
- Practice webview response matching now also rejects non-scalar request ids
  from host messages, preventing JavaScript's implicit number conversion from
  finishing the wrong pending audio, drill, setup, or recorder request.
- Practice webview speed chips now normalize dirty state payloads before
  deciding the active/custom speed, keeping the UI aligned with the clamped
  TTS speed used by provider calls.
- Practice turn history now keeps only the most recent 12 turns and releases
  pruned local recording object URLs, avoiding a heavier sidebar during long
  practice sessions.
- Practice webview status messages now coerce only scalar text, cap very long
  messages, and no-op safely if the status element is unavailable, avoiding
  `[object Object]` or oversized status updates from malformed host messages.
- Practice webview render recovery now restores the setup-blocked recording
  state after a failed state render, keeping the record button gate aligned
  with the last good lesson state.
- Practice result rendering now accepts camelCase and snake_case result fields,
  so older or diagnostic payloads still populate transcripts, fixes, audio,
  drill suggestions, and tags instead of rendering as blank cards.
- Practice context payloads now accept camelCase and snake_case reply/shadow
  fields, so older or diagnostic webview messages do not silently drop
  follow-up or shadow-practice context.
- MiniMax cloned-voice pinning now treats only explicit true-like payload flags
  as the turbo-model request, so a diagnostic `"false"` string cannot
  accidentally switch TTS to `speech-2.8-turbo`.
- String-shaped lesson frames now feed both transcription prompts and next
  drill suggestions, so hand-authored `frames: ["..."]` materials no longer
  fall back to a less relevant clean-TTS line.
- Coach and generated-drill prompts now share the same cleaned lesson-frame
  extraction, so whitespace-heavy or mixed string/object `frames` stay visible
  to the model without blank prompt entries.
- Fallback follow-up drills now choose the first cleaned nonblank frame as
  their base frame and normalize fallback examples before rendering, avoiding
  blank substitution prompts from hand-authored frame arrays.
- Reading-card frame rendering and lesson-reset identity now use the same
  cleaned frame text list, so malformed frame entries do not show up as empty
  bullets or noisy reset keys.
- Reading-card prosody details and drill-plan previews now ignore malformed
  object entries and render only cleaned scalar text, preventing noisy
  `[object Object]` chips, labels, and practice lines from dirty package JSON.
- Today hero, source chips, learner profile, source diagnostics, and lesson
  identity now read only scalar fields, so malformed package or state metadata
  no longer leaks object placeholders into the main practice surface.
- Generated drill-line results and prebuilt drill rounds now normalize labels,
  text, reasons, and error text before updating the workbench, preventing dirty
  provider payloads from adding unusable drill items.
- Webview host messages now normalize status and error text before touching the
  status bar, setup prompts, or TTS/drill progress labels, so object-shaped
  errors no longer render as `[object Object]`.
- Pipeline stage messages and progress heatmaps now whitelist stage/status
  values and coerce progress counters before rendering, preventing malformed
  state from breaking selectors or leaking arbitrary CSS classes.
- Practice, imitate, reply, and slow-read actions now normalize turn text,
  labels, and follow-up context before queuing a recording or TTS request, so
  stale or malformed UI state cannot become the next practice target.
- Setup/provider and practice action controls now normalize DOM dataset values
  and skip blank actions before posting back to the extension host, preventing
  malformed buttons or stale UI state from triggering empty provider, setting,
  command, speed, voice, drill, or slow-read changes.
- Routine/repair lists and recent-session cards now render only cleaned scalar
  text and skip malformed entries, preventing `[object Object]` placeholders
  from dirty local history or drill state.
- Task-card/package opening now trims hand-edited asset paths and URLs before
  checking or opening them, including local `~/...` paths.
- Local lesson completion now reports a clear exit-code message when the
  progress script fails without writing stdout or stderr.
- Progress records now trim package dates and case-normalize `completed`
  statuses before counting completed lessons, so small hand edits in the
  progress JSON do not make the sidebar lose completion state.
- Webview asset state now carries trimmed local/remote asset paths alongside
  generated `_uri` fields, keeping diagnostics and fallback display values
  aligned with the actual files used.
- Loose JSON reads now ignore non-object roots, preventing array or null
  package/manifest files from leaking malformed state into local lesson data.
- Recent session history now scans backward until it finds the requested number
  of valid object records, so trailing malformed JSONL lines do not hide useful
  prior-turn context.
- Follow-up drill state now accepts only positive-integer `required_frames`
  values and cleans shadowing chunks before rendering, so malformed local drill
  JSON cannot show negative frame counts or empty shadowing lines in the
  sidebar.
- Coach-generated drill prompts now compact `avoid_texts` before provider
  calls, keeping repeated drill generation from sending oversized history into
  the model.
- `localMaterialsRoot` now trims whitespace before expanding `~/...`, so a
  hand-edited value like ` ~/EnglishSpeakingTraining ` still resolves and is
  granted to the practice webview as an allowed local resource root through
  the same safe string-setting parser; if `HOME` is unavailable, the `~/...`
  path is left intact rather than rewritten to an accidental relative path.
- Startup provider/model migrations now trim and lowercase legacy defaults
  before deciding whether to repair them, so stale hand-edited values such as
  ` DeepSeek ` or ` GEMINI-2.5-FLASH ` no longer survive activation.
- Provider model settings and the MiniMax voice id now trim whitespace and fall
  back on blank values before rendering sidebar state or entering STT/coach/TTS
  request bodies, avoiding hard-to-spot failures from hand-edited settings.
- Model-setting pickers now mark those effective fallback defaults as current
  and repair blank hand-edited model settings when the default is selected.
- Free-form path, instruction, and microphone settings now trim whitespace
  before sidebar state or command use, and a blank Python path falls back to
  `python3` instead of trying to execute whitespace as a command.
- OpenAI/Gemini text extraction now scans later choices or candidates when an
  earlier provider candidate is empty or malformed, avoiding unnecessary JSON
  fallback text in coach/transcription paths.
- Stored API keys are now trimmed before readiness checks or provider requests,
  so older SecretStorage values with accidental whitespace no longer look
  configured but fail authentication at call time.
- TTS speed controls now repair hand-edited string or clamped speed settings
  back to numeric canonical values when the effective speed is selected.
- Provider base URL settings now trim whitespace and fall back on blank values
  before rendering sidebar state or building MiMo/MiniMax request endpoints,
  and MiMo chat-completions URLs no longer double-append the endpoint path.
- TTS provider entry points now read the normalized provider before naming
  audio files or dispatching synthesis, keeping practice turns, example audio,
  and slow-read audio aligned when `ttsProvider` was hand-edited.
- Sidebar API-key setup messages now normalize provider names before routing,
  so casing or whitespace in the payload no longer turns `OpenAI`/`Gemini`
  into an unknown provider route.
- Sidebar closed-enum pickers now use the runtime-normalized effective value
  when marking `current`, and choosing that value repairs dirty settings such
  as ` Auto ` back to their canonical form.
- Recorder backend settings now tolerate hand-edited casing or surrounding
  whitespace, so values like `Auto` or ` WEBVIEW ` keep their intended
  recording route instead of falling back to native recording.
- Provider route settings now tolerate hand-edited casing or surrounding
  whitespace before computing sidebar state, key readiness, and runtime
  coach/speech/TTS routing, avoiding accidental fallback to OpenAI.
- OpenAI transcription mode and TTS response format settings now normalize
  before sidebar state or provider calls, so hand-edited casing or stale
  protocol values do not appear as active runtime configuration.
- Runtime TTS voice resolution now normalizes stale or hand-edited
  OpenAI/Gemini/MiMo voice settings before rendering sidebar state or calling
  the providers, instead of letting invalid voice names fail mid-practice.
- Sidebar voice pickers now stay on provider-declared built-in voice enums
  instead of accepting arbitrary custom voice names that only fail later during
  TTS generation.
- Sidebar configuration pickers no longer offer `Custom...` for closed
  protocol enums such as recorder backend, OpenAI transcription mode, or
  OpenAI audio format, avoiding saved values that later silently fall back.
- The Gemini speech-output voice setting now exposes the same prebuilt voice
  enum in VS Code Settings that the sidebar already offers, preventing
  manifest/UI drift around invalid Gemini TTS voice values.
- Explicit `webview` recording now stays on VS Code's MediaRecorder path
  instead of silently falling back to native recording; only `auto` may fall
  back, and stale recorder backend settings now normalize to `macLocal`.
- Stale or removed `audioUnderstandingProvider` values such as `azure` and
  `deepseek` now fall back to OpenAI in the actual transcription runtime, not
  only in the sidebar state/key-readiness UI. This keeps legacy settings from
  silently routing a take to the wrong speech-input provider.
- If the native macOS recorder reports `nativeRecordingStarted` after the
  15-second start watchdog has already released the UI, the sidebar now
  restores the red button to stop mode so the user can finish or stop that
  late-started take instead of being left with a running recorder and no
  visible stop path.
- Native macOS recorder starts are now serialized at the recorder layer, so a
  retry after a slow start cannot spawn overlapping ffmpeg processes before
  the stale first take is reclaimed.
- Native recorder internals no longer leave raw NUL bytes in source files, so
  repo search and manifest/runtime drift checks keep seeing the recorder code.
- Practice webview refreshes and progress messages are now scoped to the
  webview instance that started them, so disposing an old sidebar view cannot
  detach a newer one or leak stale progress into it.
- Practice results now check that their originating webview is still active
  before converting local audio paths to webview URIs, avoiding stale-view
  errors after long transcribe/coach/TTS turns.
- Practice-result payloads are now normalized before rendering, so malformed
  URI, transcript, history, or drill-example fields cannot leak `[object
  Object]` into audio players, turn history, or follow-up practice controls.
- Drill example rendering now accepts only scalar text for labels, reasons,
  source tags, and lines, preventing malformed lesson or coach data from
  showing `[object Object]` in the drill workbench.
- The practice sidebar now registers its host message listener before loading
  the webview HTML, closing a first-load race where an early `ready` message
  could be missed on fast reloads.
- Opening the task card, session folder, or materials guide is now blocked
  during an active turn and reports request-scoped command results, so a failed
  open action cannot be mistaken for a practice-pipeline failure.
- The task-card and session-folder buttons now enter the same disabled
  in-progress state as setup actions while their open commands are running,
  avoiding duplicate taps that look like the first click was ignored.
- The OpenAI speech-input provider card now exposes its file/realtime transport
  mode, so users can switch transcription mode from the sidebar instead of
  hunting through settings or Command Palette commands.
- The OpenAI speech-output provider card now exposes its response format
  setting, making latency/size tradeoffs like `wav`, `mp3`, or `pcm`
  adjustable from the sidebar.
- The OpenAI speech-output provider card now exposes optional TTS style
  instructions, and that setting can be cleared back to coach-driven automatic
  style from the same configuration UI.
- The practice sidebar now shows recorder backend and microphone preference
  controls, making it easier to switch between native Mac recording and the
  webview recorder or choose a microphone without leaving the practice panel.
- MiMo speech-input and speech-output provider cards now expose their model and
  voice settings, matching the manifest settings instead of leaving MiMo users
  without sidebar controls for those routes.
- The practice stage strip now resets only at the start of a new transcription
  pipeline, so completed stages stay checked while coach, TTS, and save
  progress messages arrive.
- Hiding the practice stage strip now clears its active/done classes, avoiding
  stale progress indicators after an error, reset, or delayed hide.
- The sidebar refresh button now shows an in-progress state, blocks duplicate
  refresh clicks and other transient actions while state reloads, and self
  recovers if no state response arrives.
- State rendering in the practice sidebar is now fail-soft: a malformed or
  unexpected state payload reports a render error and releases the refresh
  button while preserving the previous valid state instead of leaving the UI
  stuck in a loading state.
- Failed state renders now also roll back derived sidebar context such as the
  current example line, lesson key, turn history, pending targets, and drill
  state, so a bad refresh cannot contaminate the previous usable lesson.
- Lesson-change cleanup is now committed only after the new state finishes
  rendering, so a failed refresh cannot revoke old turn audio, clear host reply
  context, or cancel drill watchdogs for the still-visible previous lesson.
- Lesson changes now also hide and reset the practice stage strip, preventing a
  previous turn's completed progress bar from briefly appearing on the next
  lesson.
- Example-audio and slow-read watchdogs now show a "still generating" message
  before the provider timeout window, instead of discarding valid audio that
  arrives after a normal slow provider call.
- In-flight example-audio and slow-read requests now keep their disabled/busy
  button state across sidebar re-renders, so refreshes no longer make pending
  audio actions look idle or clickable.
- While example audio is generating, slow-read/listen buttons now become
  temporarily disabled and are restored when the example request finishes,
  fails, or times out.
- Example-audio and slow-read watchdogs now key off the active request id
  rather than the original button element, so sidebar re-renders cannot split
  timeout recovery between stale and current DOM nodes.
- Rejected practice-webview `postMessage` calls are now logged instead of
  becoming unhandled promise rejections when VS Code closes or recreates the
  sidebar mid-refresh.
- Provider responses that come back as invalid JSON now surface contextual
  errors such as "OpenAI coach returned invalid JSON" or "Gemini TTS returned
  invalid JSON", with a short body preview, instead of a raw `SyntaxError`.
- Provider text extraction now skips `null` or malformed nested content parts
  instead of surfacing low-level property-access errors on dirty JSON shapes.
- Speech-input and TTS provider extractors now do the same for malformed
  `segments`, `choices`, `candidates`, and audio `parts` entries.
- `prebuilt/` lesson scanning now ignores date-shaped files, broken entries,
  and missing folders defensively instead of letting one bad directory entry
  crash the sidebar state load.
- `prebuilt/` lesson scanning now rejects invalid calendar dates such as
  `2026-02-30`, preventing package-generation date math from crashing on a
  merely date-shaped folder.
- Lesson creation and prompt-composition date prompts now reject invalid
  calendar dates too, so they cannot create invisible `prebuilt/` folders.
- Lesson overwrite cleanup now removes stale directory-shaped generated
  artifacts too, so an accidental `english-training.json/` or `daily-card.png/`
  folder no longer blocks sample or skeleton regeneration after confirmation.
- `english_training_progress.py next` results now have to reference an
  existing `prebuilt/` package date; stale or malformed script output falls
  back to local inventory instead of selecting a missing lesson.
- `english_training_progress.py next` stdout parsing now tolerates log lines
  around pretty-printed JSON while still rejecting non-object JSON roots.
- Valid `english_training_progress.py next` results are now completed with
  local package metadata and assets, so sparse script output cannot hide
  reading-card media or today's example text.
- Broken `followup-drill.json` files now show a Source Diagnostics warning
  while the drill workbench falls back to safe default lines, instead of
  silently ignoring the user's drill file.
- Valid `followup-drill.json` files with malformed `rounds` entries now skip
  those bad entries before webview rendering, preventing a broken drill panel.
- If every `followup-drill.json` round is unusable, the drill workbench now
  falls back to today's training frames instead of showing an empty rounds
  panel.
- Drill rounds now also skip malformed `examples` entries such as `null`,
  arrays, or empty strings before they reach the sidebar renderer.
- Broken progress JSON now shows a Source Diagnostics warning instead of
  silently making completed lessons look incomplete.
- Progress completion now ignores records for invalid or nonexistent lesson
  dates, so Source Diagnostics cannot count completed packages that are not in
  `prebuilt/`.
- Progress completion now skips non-object records such as `null` or accidental
  arrays instead of letting one malformed progress entry block sidebar state.
- Broken `manifest.json` files now show a Source Diagnostics warning while
  reading-card assets fall back to the package's default filenames.
- JSON diagnostics now flag existing-but-unreadable files such as accidental
  directories instead of treating them like optional missing files.
- JSON diagnostics now flag non-object roots such as arrays or `null`, which
  keeps structurally wrong materials from being treated as valid empty objects.
- Relative asset paths in `manifest.json` can no longer escape their lesson
  package folder; invalid escaping paths fall back to the default asset path.
- Broken or unreadable learner-profile files now degrade to a Profile panel
  warning instead of blocking the whole sidebar state load.
- Unreadable recent-session logs now fall back to an empty history instead of
  blocking the sidebar state load.
- Recent-session logs now skip malformed lines and non-object JSON entries so
  one bad history row cannot break the sidebar's Recent Sessions panel.
- Failed session-log writes are now logged without failing an otherwise
  completed practice result.
- Failed per-session artifact writes (`coach.json`, `session.json`, or
  `session.md`) are now logged per file so one broken artifact path does not
  discard the rest of a completed practice result.
- Failed `transcript.txt` writes are now logged without aborting the
  already-transcribed practice turn.
- Malformed or empty webview audio payloads are now rejected before workspace
  state loading, session-directory creation, disk writes, or STT calls.
- Invalid sidebar control messages now surface explicit errors instead of
  silently no-oping when a button command, provider, setting, voice, or speed
  payload drifts.
- Unknown sidebar message types and empty slow-read requests now return
  explicit errors, so protocol drift cannot leave a secondary action waiting
  until the client-side timeout.
- Sidebar error recovery now clears transient busy states for example audio,
  slow-read, drill-listen, and drill-generation controls so a failed backend
  route cannot leave secondary buttons stuck.
- Startup provider/model migrations now refresh the sidebar only when they
  actually changed a stale setting, avoiding a redundant activation-time state
  reload on normal workspaces.
- UI refresh now attempts every registered refresh handler before surfacing an
  error, so one failing panel cannot prevent the rest of the sidebar state
  from updating.
- Activation-time async tasks now log failures to the English Training output
  channel instead of risking an unhandled rejection during extension startup.
- Setting up all active-route API keys now batches the final sidebar/webview
  refresh, so first-time multi-provider setup no longer reloads after every
  saved key.
- Submitting a blank API key now shows the intended warning instead of being
  treated like a silent cancel.
- Command Palette failures are now logged and surfaced through a VS Code error
  message instead of escaping as bare async command rejections.
- Canceling the optional learner-brief prompt in `Generate Next Package` now
  cancels the command instead of creating a blank lesson skeleton.
- `package-lock.json` is aligned with the `0.1.39` package version again, so
  the manifest regression test starts from a green baseline.

## [0.1.39] — 2026-05-22

A recording-audio-quality pass. Native macOS recordings stopped sounding
muffled / phone-quality and the user can now switch microphones without
hand-editing settings.json.

### Fixed
- **Native ffmpeg recorder forced 16 kHz output, which made every take
  sound muffled and noisy on iMac/MacBook built-in microphones.** The
  built-in mic captures at the device's native rate (44.1 / 48 kHz);
  pinning ffmpeg's output to `-ar 16000` made AVFoundation's internal
  sample-rate converter run on every sample, throwing away everything
  above 8 kHz and adding an audible noise floor from the SRC itself. The
  recorder now writes 48 kHz mono PCM by default (matches the built-in
  rate, no SRC on capture). Downstream STT still works unchanged: the
  Gemini / MiMo path resamples to 16 kHz inside `convertAudioToWav` when
  it builds the inline-audio payload; the OpenAI file path uploads as-is
  and `gpt-4o-transcribe` / Whisper handle the rate internally. Net
  effect: dramatically cleaner playback for the same STT accuracy.

### Added
- **`englishTraining.recordSampleRate` setting.** Pin the capture rate to
  16000 / 22050 / 24000 / 32000 / 44100 / 48000 if you have an interface
  that prefers a non-48k native rate. Default is 48000.
- **`English Training: Select Recording Microphone` command** (Command
  Palette). Lists the live AVFoundation audio devices, marks the current
  preference and any blocked-by-pattern devices, and writes your pick to
  `englishTraining.preferredMicrophoneName` for you — including a clean
  "Auto" option that clears the preference back to the built-in
  heuristic. Invalidates the resolved-device cache so the next record
  press uses the new mic immediately, without a window reload.

## [0.1.38] — 2026-05-21

An OpenAI-first pass: the extension's default route is now the full OpenAI
stack (gpt-4o coach + gpt-4o-transcribe speech-in + gpt-4o-mini-tts speech-out
with the new `instructions` field driving voice style per turn), with Gemini /
MiniMax / MiMo kept as one-click fallbacks.

### Added
- **OpenAI TTS `instructions` field.** `gpt-4o-mini-tts` accepts a short
  English direction that controls accent, emotion, intonation, speed,
  emphasis, and whispering. The coach now emits a per-turn `tts_style`
  (e.g. *"Speak like a patient seminar professor; emphasize the modal
  verbs"*) that flows directly into the next native-version synthesis, so
  every reply has a fitted voice rather than one flat reading. A pinned
  `englishTraining.openaiTtsInstructions` overrides the coach if you want
  a fixed style; when both are blank a clear, patient academic default is
  used. The slow re-read button (↻) ships its own over-articulated
  instructions so word-by-word shadow practice is actually slower and
  clearer, not just lower-pitched.
- **`marin` / `cedar` voices.** The full set of 13 voices (alloy, ash,
  ballad, coral, echo, fable, nova, onyx, sage, shimmer, verse, marin,
  cedar) is in the manifest enum and the sidebar voice picker. Default is
  `marin`, OpenAI's recommended highest-quality voice.
- **Low-latency audio formats.** `englishTraining.openaiTtsResponseFormat`
  selects wav / mp3 / opus / aac / flac / pcm. Default is `wav` because it
  needs no decoding on first play, cutting native-version first-audio
  latency vs. the old mp3-only path. `pcm` is wrapped in a RIFF/WAVE
  header on disk so the webview's `<audio>` element plays it without an
  external decoder.
- **OpenAI file-mode transcription.** `englishTraining.openaiTranscriptionMode`
  picks between `file` (POST /v1/audio/transcriptions with `gpt-4o-transcribe`
  by default — or `gpt-4o-mini-transcribe` / `gpt-4o-transcribe-diarize` /
  `whisper-1`) and `realtime` (the existing /v1/realtime WebSocket).
  File mode is the new default and is fed a **domain prompt** built from
  the lesson's scenario / goal / frames / key expressions, biasing
  Whisper-family decoding toward your legal-academic vocabulary so terms
  like *stare decisis*, *prima facie*, *erga omnes* are far less likely to
  come back as plausible English nonsense.
- **OpenAI stack one-click command.**
  *English Training: Use OpenAI Stack (Coach + STT + TTS)* (palette and
  sidebar) pins coach + transcribe + TTS providers to OpenAI in one step
  and forces transcription to `file` mode so the domain prompt is active.

### Changed
- **Default providers flipped to OpenAI.** `coachProvider`,
  `audioUnderstandingProvider`, and `ttsProvider` all default to `openai`
  for fresh installs. Existing users keep whatever they had configured.
  Gemini / MiniMax / MiMo remain first-class alternates; the Gemini-only
  and Gemini-hybrid one-click presets still work.
- **Sidebar provider cards** lead with the OpenAI option and label it as
  the default route; the OpenAI speech-input card now exposes the
  file-mode model picker (`openaiFileTranscriptionModel`) instead of only
  the Realtime model.

### Fixed
- The OpenAI speech-input model picker only edited the Realtime model id,
  silently doing nothing when the user was on the (more common, more
  accurate) file path; it now edits the actively-routed model.
- Quick Setup and the record/drill gates no longer hard-code Gemini after the
  default route switched to OpenAI; they now ask for the missing key(s) for
  the active provider route.
- The Command Palette action named *Use OpenAI Realtime Speech Input* now also
  switches `openaiTranscriptionMode` to `realtime`, instead of merely selecting
  OpenAI and leaving the user on file transcription.
- The sidebar OpenAI speech-input card now edits the Realtime model when the
  active mode is `realtime`, and exposes the OpenAI stack preset promised by
  the release notes.
- First-run workspaces with no `prebuilt/` folder now render a Quick Setup
  recovery card with a visible *Choose folder* action instead of only showing
  a dead-end root-detection error.
- Removed the unsupported OpenAI TTS `language` request field, kept the full
  built-in OpenAI voice set available across speech models, and only suppress
  `instructions` for `tts-1` / `tts-1-hd`.
- `package-lock.json` now matches the `0.1.38` extension version.

## [0.1.37] — 2026-05-18

Supersedes the 0.1.36 Marketplace publish (that version number was
already taken, so this same fluidity pass ships as 0.1.37).

A recording-flow fluidity pass: both ends of the practice loop — pressing
record, and pressing stop through transcribe/coach/speak — are now fast
and *legible* instead of multi-second frozen stalls behind a wrong or
unchanging status line.

### Fixed
- **Pressing record stalled for seconds with zero feedback.** Every press
  paid an unconditional ~0.9 s sleep plus, when a previous recorder was
  still around, up to ~1.7 s of reclaim — and the device enumeration ran
  via `spawnSync`, which froze the single-threaded extension host so the
  webview could not even repaint. On machines with an iPhone/Continuity
  camera in range the enumeration alone added several more seconds. The
  press path now: (a) replaces the fixed 0.9 s sleep with an adaptive
  readiness poll that returns as soon as `ffmpeg` has actually opened the
  device and written the WAV header (typically well under the old floor,
  while still surfacing the old "exited before it could start" error);
  (b) reclaims a stale recorder with `SIGKILL` and a 0.6 s cap instead of
  `SIGTERM` + 1.5 s; (c) enumerates devices with async `spawn` instead of
  `spawnSync`, so the host stays responsive and progress can paint; and
  (d) memoizes the resolved audio device per session so repeated presses
  skip enumeration entirely (cache invalidated on failure or settings
  change).
- **The session timer counted microphone warm-up.** It started the moment
  you pressed record — i.e. during reclaim/enumeration/arming — so a turn
  read several seconds longer than you actually spoke. The timer now
  starts only when the recorder is genuinely listening.
- **Pressing stop showed "Transcribe" while it was still draining the
  recorder.** The progress strip lit its first stage *before* `ffmpeg`
  was actually stopped — a quit → `SIGINT` → `SIGTERM` → settle drain
  that can run several seconds — so the user watched "Transcribe" pulse
  during a wait that was not transcription, the same opaque mislabel
  record-start had. The strip now appears only when transcription truly
  begins; the drain keeps the honest "Stopping native recorder…" status.
- **Stopping paid an unconditional 150 ms settle every time.** `ffmpeg`
  finalizes and closes the WAV on exit, so the file is normally usable
  the instant it exits; the flat sleep was pure dead time on every turn
  (the stop-side cousin of the removed record-start sleep). It is now an
  adaptive check that returns immediately in the common case and only
  waits — up to a *longer* cap than the old 150 ms — if a slow disk
  flush genuinely needs it, so it is both faster and more robust.
- **The model answer and the follow-up question were spoken one after
  the other.** Their two text-to-speech calls are independent round
  trips to the same provider but were issued serially, so a turn with a
  follow-up question waited through both in sequence. They now run
  concurrently — each still degrading on its own (a failed clip is
  skipped, the turn and the other clip are kept) — which roughly halves
  the speak step whenever there is a follow-up.
- **The "which lesson is next" lookup re-ran a Python process ~4 times
  per turn.** Resolving the current package shells out to
  `english_training_progress.py` (a cold-started interpreter with a long
  timeout) — or, without that script, a directory + JSON scan — and it
  ran on *every* internal state load: once when you press record, once
  when you press stop, then twice more in the post-turn refresh. So a
  single practice turn cold-started Python up to four times for an answer
  that only changes when you complete or add a lesson. This was a large,
  invisible part of the "press record and wait" lag on setups that have
  that script. The result is now memoized per materials-root and day and
  reused across the turn; it is recomputed exactly when it can actually
  change — completing a lesson, adding a lesson, a date rollover, a
  changed materials root, or an explicit Refresh — so correctness is
  unchanged while the redundant process spawns are gone.
- **A normal-length turn tripped a "taking too long" reset and freed the
  record button mid-pipeline.** The webview's processing watchdog fired
  after a flat 45 s and called `setBusy(false)`, but a healthy turn — each
  of transcribe, coach, and speak is bounded host-side at 90 s and runs in
  sequence, and the coach step alone routinely takes 20–40 s — regularly
  exceeds 45 s. So on ordinary turns the watchdog un-busied the record
  button while the host was still working: the UI stopped looking busy and
  a second press could start an overlapping turn. The watchdog is now a
  *no-progress* detector — every stage transition re-arms it, so a long
  but progressing multi-leg turn never trips it — and it fires only after
  100 s with no progress at all (past the per-leg network ceiling, i.e. a
  genuinely wedged pipeline). It no longer touches the busy state: every
  reachable failure already self-recovers with a bounded error that clears
  busy and resets the recorder authoritatively, so the watchdog is now
  purely an advisory status line and can never strand a live turn.

### Changed
- **Record-start is now a visible, staged process.** Instead of one frozen
  "Using Mac local recorder…" line, the host streams the real phase it is
  in — *Resetting the previous recorder…* → *Preparing microphone…* →
  *Starting recorder…* → *Listening… speak now.* — so the wait is legible
  and obviously progressing rather than hung.
- **The webview recorder backend now also confirms the press immediately.**
  On the non-default in-webview recorder, the gap between pressing record
  and the browser microphone/permission prompt resolving showed nothing at
  all — the same opaque-press window the native backend now closes with
  its streamed phases. It now shows *Preparing microphone…* the instant
  you press, so both recorder backends give immediate, legible feedback.

## [0.1.35] — 2026-05-17

A runtime-stability pass: every place the practice flow could hang, lose a
good recording, or trap the user with a hot microphone is now closed, and
the coach provider lineup is simplified.

### Fixed
- **No network call had a timeout.** Node's global `fetch` never times out,
  so a stalled network (captive portal, dead VPN, a provider edge holding
  the socket) made the coach / transcribe / TTS step hang forever with no
  self-recovery. All LLM, speech-input, and speech-output HTTP calls now go
  through a bounded fetch (90 s) that surfaces a clear, retryable error.
- **A coach failure threw away a good recording.** A coach hiccup (timeout,
  missing/invalid key, provider 5xx) discarded the already-successful
  recording + transcript and skipped session persistence, forcing a
  re-record. The turn is now kept, the transcript is preserved, the session
  is saved, and you are told to press ↻ to re-analyze without re-recording.
- **A corrupt lesson file degraded silently.** A syntax error in the current
  package's `english-training.json` (e.g. a trailing comma) showed an
  enabled record button over a totally empty lesson with no hint why.
  Missing vs. malformed are now distinguished: record is gated and Source
  Diagnostics shows an error banner naming the JSON parse error.
- **A leftover recorder bricked the record button with the mic still hot.**
  Pressing record now reclaims and kills a stale `ffmpeg` instead of
  throwing "already running" into a dead end — important now that the
  retained webview no longer disposes (and thus no longer reaps it) on hide.
- **The default Mac recorder could trap the user forever.** If the host
  never confirmed start, the timer ran, record stayed locked, and stop was
  inert. A 15 s start watchdog now self-heals into a clear retryable error.
- The record timer could be orphaned (repainting forever) when the
  webview-recorder fallback reached `startTimer` twice; it is now idempotent.
- On any pipeline error a live webview `MediaRecorder` + mic stream was left
  running (hot mic + a zombie recorder that could post a second unsolicited
  take). The error path now tears the webview recorder down without firing
  its `onstop` pipeline, regardless of recorder mode.

### Changed
- The practice cockpit now **retains its context when hidden**. Collapsing
  the view or clicking another sidebar item no longer wipes an in-progress
  session or strands a running native recorder.
- **DeepSeek removed as a coach provider; OpenAI added as a real one.**
  Coach providers are now Gemini (default), Xiaomi MiMo, and OpenAI. The
  OpenAI coach uses the chat-completions JSON endpoint with a configurable
  `englishTraining.openaiCoachModel` (default `gpt-4o`). All DeepSeek
  plumbing — the configure-key command, the status-tree row, the
  `deepseekAnthropicBaseUrl` / `deepseekCoachModel` settings, and the
  provider enum member — is gone. A persisted `coachProvider: "deepseek"`
  is migrated to the Gemini default so it cannot wedge the coach step.

## [0.1.34] — 2026-05-17

Makes the syllable-stress card actually render, and closes the contract loop
so future generated materials can never silently lose it.

### Fixed
- The stress card now shows **which syllable carries the primary stress**
  (e.g. `ac·count·a·BIL·i·ty`). The renderer always supported this, but every
  shipped lesson package omitted `words[].syllables`, so the code path was
  dead and the card fell back to the bare word. All 120 local packages were
  backfilled (2179 specs) from a hand-vetted, mechanically-validated syllable
  lexicon — deterministic, reviewable, no network, no per-run cost. True
  monosyllables and initialisms are correctly left whole.
- Corrected a linguistic error baked into the Card Schema itself: the worked
  `accountability` example taught `ac·COUNT·a·bil·i·ty` (wrong stress). Since
  this is a pronunciation trainer and the schema is read by the generating
  LLM, that example actively taught the wrong word stress. Now
  `ac·count·a·BIL·i·ty`, parallel to `re·spon·si·BIL·i·ty`.

### Changed
- **Card Schema v1.1 → v1.2.** `words[].syllables` is now stated as
  **REQUIRED** for every multi-syllable listed word (the contract previously
  said "RECOMMENDED" in the field doc while `hardRules` said MUST — that
  contradiction is why packages shipped without it). The generation prompt
  now carries a prominent **"Render-critical invariants"** section that maps
  each rule to the card it silently breaks, so any LLM following the prompt
  produces materials this extension can fully render. `materials-guide.ts`
  now interpolates the schema version instead of a hardcoded literal so it
  cannot drift again.
- The `scripts/` maintenance tooling (syllable lexicon + backfill) is kept in
  git but excluded from the published VSIX (dev-only, like `src/`).

## [0.1.33] — 2026-05-17

### Fixed
- The pitch card no longer collapses to a single terminal arrow when a lesson
  package crams several sentences into one thought group. Such a degenerate
  single-group line is now split at sentence boundaries for display: non-final
  sentences take the level "→" continuation tone and the final sentence keeps
  the group's real nucleus, contour, and pause. This reproduces the exact
  →…→…↘ convention every well-formed package already uses, asserts no pitch
  the data did not imply, and is a strict no-op for correctly grouped
  packages (verified: 114/120 reference packages unchanged, only the 6
  single-group packages repaired, no multi-group package altered).

## [0.1.32] — 2026-05-17

A flow-stability and counter-intuitive-design pass over the full practice
loop: record → transcribe → coach → speak → save → drill.

### Fixed
- A speech-output (TTS) failure on the main coached reply no longer discards
  an already-successful transcribe + coach turn. The coaching result is kept
  and only playback is skipped, matching the existing follow-up TTS behaviour.
- The record button now ships disabled with a neutral "Checking setup…"
  status until the first state arrives, closing a window where an early click
  could start recording before setup had been verified.
- Stale turn history, drill state, and reply context are now cleared when the
  active lesson changes, instead of leaking from the previous lesson into the
  new one.
- Pressing stop during the brief native-recorder arming window no longer
  drops the request; it waits for the recorder to start listening.
- The slow-read host is reset after a slow-read failure so a later retry is
  no longer blocked.
- Missing API key errors now name the exact Command Palette command to run
  (for example "English Training: Configure Gemini API Key") instead of a
  vague "run the configure command first".

### Changed
- A deliberate MiniMax speech-output (TTS) choice is no longer silently
  reverted to Gemini on every activation.
- Selecting an unsupported provider value now reports a clear error instead
  of silently doing nothing.
- The drill "Generate" action is disabled with an explanatory hint until the
  core key and a lesson are ready, and a persistent reminder is shown while a
  shadowing example is armed for the next recording.

## [0.1.31] — 2026-05-17

Supersedes the 0.1.30 Marketplace build, which was published from an
incomplete state and is missing the changes below.

### Added
- Added a Reading Card panel that displays prebuilt `daily-card.png`,
  `prosody-detail.png`, `audio/demo.ogg`, stress guide, intonation guide, and
  word-level prosody from local lesson packages.
- Documented the package-generation contract for reading-card assets and
  structured prosody fields so future materials can stay aligned with the VS
  Code surface.
- Added interactive FSI drill choices after a practice result, with Listen,
  Practice, and Skip actions for generated or prebuilt substitution examples.
- Added Xiaomi MiMo as a speech-input (audio understanding) provider and as a
  speech-output (TTS) provider, both reusing the existing MiMo API key over the
  OpenAI-compatible endpoint.
- Added `English Training: Compose Material Prompt with Coach`: type a topic and
  a lesson date, the configured Coach model expands it into a tailored brief,
  and the extension writes one schema-conformant `material-generation-prompt.md`
  you can paste into any LLM. Surfaced as a "Generate training material" panel
  at the bottom of the Practice sidebar and documented in the README and
  Materials Guide.

### Changed
- Removed Azure from the active speech-input route. Gemini is now the default
  transcript-matching path, with OpenAI Realtime as the optional low-latency
  STT route.
- Shadowing checks now use simple transcript-vs-reference matching instead of
  Azure-style pronunciation scoring.
- Consolidated coach providers to Gemini, Xiaomi MiMo, and DeepSeek. Removed
  Kimi entirely; OpenAI and MiniMax remain available for speech input/output
  only. Stale `kimi`, `openai`, or `minimax` coach settings now migrate to
  Gemini automatically.

## [0.1.29] — 2026-05-14

### Added
- Added regression tests for activation, command/manifest drift, provider model
  schema alignment, local materials root detection, recorder microphone
  selection, malformed coaching JSON recovery, TTS speed normalization, and
  audio MIME handling.

### Fixed
- Treat a local materials folder with only `prebuilt/` as a valid bring-your-own
  lesson root, matching the README first-run flow.
- Aligned the MiniMax coach model picker with the package schema, including
  `MiniMax-M2.7-highspeed`.
- Restored the OpenAI TTS fallback voice to the package default `coral`.
- Report missing or unlaunchable `ffmpeg` directly in the native recorder path
  instead of falling through to a misleading microphone-selection error.
- Excluded local regression tests from the packaged VSIX.

## [0.1.28] — 2026-05-11

### Changed
- Removed Gemini 2.5 model choices from the current provider UI. Gemini coach
  and speech input now expose only the current Gemini 3 family, and Gemini TTS
  exposes only `gemini-3.1-flash-tts-preview`.
- Expanded migration so older saved Gemini 2.5 coach, speech-input, or TTS
  settings are lifted to the latest Gemini 3 / 3.1 equivalents automatically.

## [0.1.27] — 2026-05-11

### Changed
- Made Gemini + Azure the core recommended route: Gemini is now the default
  coach and speech-output provider, while Azure remains the default speech-input
  and pronunciation-scoring provider.
- Updated onboarding to require the two core keys (Gemini + Azure) instead of
  suggesting MiniMax or any single AI provider key as enough for the main loop.
- Moved MiniMax, OpenAI, MiMo, Kimi, and DeepSeek into optional fallback
  positions in the Routes & Models panel.

### Fixed
- Added migration for old saved MiniMax default route settings so an upgraded
  install does not keep requiring MiniMax when the intended route is Gemini +
  Azure.

## [0.1.26] — 2026-05-11

### Changed
- Updated Gemini model choices from Google AI Studio / Gemini API docs:
  Gemini coach and Gemini speech input now default to `gemini-3-flash-preview`
  and expose `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, and
  `gemini-3.1-flash-lite-preview` as selectable Gemini 3 family options.
- Kept Gemini speech output on the latest `gemini-3.1-flash-tts-preview` route
  while preserving older 2.5 TTS previews as fallback options.
- Added a small migration for old saved `gemini-2.5-flash` defaults so the
  Routes & Models panel does not keep showing the old Gemini speech-input model
  after upgrading the extension.

## [0.1.25] — 2026-05-11

### Added
- Added OpenAI Realtime as a selectable speech-input provider using
  `gpt-realtime-whisper` over a server-side WebSocket connection in the VS Code
  extension host.
- Added `englishTraining.openaiRealtimeTranscriptionModel` and a command/card
  for `English Training: Use OpenAI Realtime Speech Input`.

### Changed
- The provider UX now presents Azure, OpenAI Realtime, and Gemini as distinct
  speech-input routes: Azure remains the scoring/pronunciation-assessment route,
  while OpenAI Realtime is used for transcript generation.

## [0.1.24] — 2026-05-11

### Added
- Reworked the sidebar provider controls into a single `Routes & Models` panel
  with active route cards, key status, provider switching, and model/region/voice
  configuration entry points.
- Added a `Recommended hybrid` preset for MiniMax coach + Azure speech input +
  MiniMax speech output, keeping `Gemini only` as a one-click route.

### Fixed
- Corrected stale README/changelog provider descriptions from the old
  OpenAI/Gemini/MiMo speech-input era.

## [0.1.23] — 2026-05-11

### Added
- Added Gemini as a speech-input provider. The VS Code recorder can now send
  short practice audio to Gemini audio understanding for JSON transcript
  extraction instead of Azure Fast Transcription.
- Added a `Gemini only` preset/command that switches coach, speech input, and
  speech output to Gemini while keeping Azure available for precise
  Pronunciation Assessment workflows.

## [0.1.22] — 2026-05-11

### Fixed
- Split free-answer coaching from shadowing checks. After generating example
  audio or clicking `Imitate native`, the next recording now carries a
  reference target, and the generated native audio is forced to read that
  reference instead of replaying Azure STT mistakes.
- Shadowing results label the right-hand side as `Reference` / `Example text`
  rather than treating the learner's misrecognized transcript as a new native
  sentence.

## [0.1.21] — 2026-05-11

### Fixed
- Made coach-response parsing tolerant of provider JSON glitches: the extension
  now extracts fenced/embedded JSON, repairs common malformed output, and
  recovers partial coaching fields instead of blocking the practice turn with a
  raw `Could not parse coaching JSON` error.
- Tightened the coach prompt so MiMo/MiniMax-style providers return only compact
  one-line JSON strings with the expected coaching keys.

## [0.1.20] — 2026-05-11

### Fixed
- Guarded invalid `englishTraining.timezone` values so the sidebar falls back
  to `Asia/Shanghai` instead of crashing while loading state.
- Normalized `englishTraining.ttsSpeed` before it reaches the sidebar or TTS
  providers, preventing dirty settings such as `NaN`, `null`, or out-of-range
  numbers from breaking runtime speech generation.
- Cleaned up the webview recorder failure path: empty recordings are rejected
  before transcription, microphone streams are stopped on fallback/error, and
  retrying a failed follow-up reply preserves its prior-turn context.
- `Open Current Task Card` now falls back to the current
  `english-training.json` when a minimal local package does not include
  `telegram-task-card.md`.
- Published the existing OpenAI coach command and `openaiCoachModel` setting in
  the extension manifest so command palette/settings UI match the runtime code.

## [0.1.19] — 2026-05-11

### Added
- **Playback speed chips.** A new Speed row under the record button exposes
  0.6× / 0.8× / 0.9× / 1.0× / 1.2× as one-tap chips, persisting to
  `englishTraining.ttsSpeed` on the workspace. A "Custom" chip appears (and
  shows pressed) when the configured speed is outside the preset list.
- **Slow read.** Both the native version and the coach's follow-up question
  carry a 🐢 Slow read button that resynthesises the same text at 0.7× via the
  configured TTS provider; the audio appears inline next to the source block.
- **Turn breadcrumb.** Replaces the old decorative three-stage stepper with a
  real `Turn N` breadcrumb driven by `turnHistory.length`. Done chips are
  clickable (mouse + keyboard) and scroll to the matching conversation entry.
  Reply turns carry a `REPLY` tag.
- **Voice picker disclosure.** The MiniMax voice row defaults to six favourites
  plus an "Active" slot when the current voice isn't favourited; an
  "All voices ⌄ N" toggle expands to the full grouped catalogue, including
  cloned voices.

### Changed
- **Follow-up audio no longer autoplays.** It still preloads, but the user
  drives playback — the diff and the Quick Fix are now readable before the
  coach starts talking. Focus still moves to the "Answer follow-up →" button
  when playback ends.
- **Conversation history shows your audio for webview-mode turns.** Falls back
  to the local blob URL when the host hasn't shipped a `localAudioUri` field.
- **Result panel scrolls into view** after each `practiceResult` so the new
  diff is visible without manual scrolling.
- **`stopNativeRecording` preserves `pendingPriorTurn` on coach failure** so
  retrying a reply doesn't lose the prior turn context (now matches the
  webview-recorder path).

### Internal
- Practice pipeline modules split out under `src/practice/` (transcribe,
  coach, pronounce, save, tts), with shared helpers in `src/core.ts` and
  type aliases in `src/types.ts`. `src/extension.ts` is now ~3.6k lines.

## [0.1.18] — 2026-05-10

### Added
- **Follow-up question auto TTS.** After each practice round, the configured
  speech-output provider also synthesizes the coach's follow-up question; the
  sidebar embeds the resulting audio inline under the Follow-up card and
  autoplays it so the loop can be driven by ear without re-reading the text.

## [0.1.17] — 2026-05-10

### Changed
- **Speech input replaced with Azure Speech.** The older OpenAI/MiMo speech
  input paths were removed; recording is now transcribed via the Azure
  Fast Transcription REST API (`speechtotext/transcriptions:transcribe`,
  api-version `2025-10-15`). Configure with the new
  `English Training: Configure Azure Speech Key` command, which also prompts
  for `englishTraining.azureSpeechRegion`. Locale is controlled by
  `englishTraining.azureSpeechLocale` (default `en-US`).
- Sidebar **Speech in** selector collapses to a single Azure button; **Keys**
  panel adds an Azure entry; status tree exposes an Azure Speech Key item.
- `audioUnderstandingProvider` enum is reduced to `["azure"]`; default is now
  `azure`.

### Added
- New module `src/practice/pronounce.ts` wraps the Azure Pronunciation
  Assessment endpoint (Word granularity, prosody-on by default). Not yet wired
  to the practice pipeline — reserved for the upcoming multi-turn shadowing
  loop.

### Internal
- Continued the module split started in 0.1.16: the practice pipeline
  (transcribe / coach / TTS / save) is now factored out under `src/practice/`,
  bringing `src/extension.ts` from ~4.1k to ~3.0k lines.

## [0.1.16] — 2026-05-10

### Fixed
- MiniMax chat and TTS defaults now use the mainland `api.minimaxi.com`
  endpoints so resource-pack keys are not rejected as invalid.
- MiniMax TTS error 2049 now includes the active endpoint in the error message.
- Recording now defaults to the macOS local recorder, which selects a local Mac
  microphone and avoids iPhone/Continuity device names.
- Native ffmpeg recording now supports `auto` microphone selection plus optional
  `preferredMicrophoneName` and blocked-device regex settings.

## [0.1.15] — 2026-05-10

### Changed
- Renamed the sidebar reference player to *Example audio* and changed its
  button to `Generate Example`.
- On-demand reference TTS now uses only explicit example fields:
  `clean_tts_text`, `audio_text`, `demo_line`, or `frames[].text` as a fallback.
  Scenario, goal, and other background fields are never read aloud.

## [0.1.14] — 2026-05-10

### Changed
- *Today audio* now generates TTS on demand from the current
  `clean_tts_text` using the configured speech-output provider, then plays it
  from a webview data URI.
- Prebuilt lesson audio files such as `audio/demo.ogg` are no longer required
  for the sidebar reference audio flow.

## [0.1.13] — 2026-05-10

### Changed
- Materials are now local-only in the user-facing extension flow. The Practice
  sidebar and command palette expose a local folder picker instead of GitHub
  source/token configuration.
- Existing `github` materials settings are ignored at runtime; the extension
  always resolves local `prebuilt/` folders.
- Source diagnostics now report local folders and exact local JSON paths only.

## [0.1.12] — 2026-05-10

### Added
- **Source Diagnostics** panel showing the active source mode, local root or
  GitHub URL, lesson count, date range, current package date, and exact current
  `english-training.json` path or URL.
- **Learner Profile** support. The extension reads
  `profile/learner-profile.md` or `profile/learner-profile.json`, shows
  `Profile loaded` in the sidebar/status tree, and passes the profile into the
  coaching prompt.
- Session artifacts now record source diagnostics and learner profile metadata.

## [0.1.11] — 2026-05-10

### Added
- Marketplace icon (128×128 PNG with branded gradient).
- esbuild-based production bundle (`npm run bundle`) — `out/extension.js`
  shrinks from ~150 KB tsc output to ~106 KB minified.
- `npm run typecheck` script kept separate from emit.

### Changed
- Build pipeline split into `typecheck` + `bundle` phases. `vscode:prepublish`
  now runs both.

## [0.1.10] — 2026-05-10

First public Marketplace release.

### Added
- **Onboarding empty state**: a Quick Setup card in the Practice sidebar that
  surfaces missing pieces (source, lessons, AI key) and routes
  each step to the right configure flow.
- **Bring-your-own-materials path**: `English Training: Create Sample Package`
  writes a starter `prebuilt/<date>/english-training.json`. Bootstraps the
  whole `prebuilt/` + `progress/` layout when no root exists yet.
- **Materials guide**: `English Training: Open Materials Guide` opens an
  in-extension reference for the lesson schema and directory layout.
- **120-day progress strip**: heatmap of every dated lesson with completed /
  current / missed / pending states, plus `Day N/total · Week W · Day k/7`
  chips and a streak counter.
- **Practice cockpit visual overhaul**:
  - Sticky record panel with a single-button toggle CTA, pulse animation, VU
    meter canvas, and elapsed timer.
  - Four-stage pipeline progress (Transcribe → Coach → Speak → Save) wired
    through to the practice runner.
  - Three-state imitation/loop stepper (transcript → imitate → reply).
  - Dual-column word-level diff (You said vs Native says) with LCS-based
    alignment tolerant of punctuation and case.
  - Quick-fix card and highlighted follow-up card surfaced above details.

### Changed
- License switched to MIT.
- Publisher field set to `xianwei-zhang` for Marketplace publishing.
- README rewritten with a first-run quick-start path for users without
  pre-existing materials.

## [0.1.1] — [0.1.9]

Pre-public iterations distributed as `.vsix` files only. Highlights:

- VS Code webview practice cockpit decoupled from Hermes/Telegram.
- Multi-provider AI: coach LLMs across MiniMax, MiMo, OpenAI, Gemini, Kimi,
  and DeepSeek; speech input through Azure or Gemini; speech output through
  MiniMax, OpenAI, or Gemini.
- Native ffmpeg AVFoundation fallback for VS Code microphone denial.
- GitHub materials source mode with private-repo PAT support and asset caching
  in VS Code global storage.
- API keys stored in VS Code SecretStorage; never written to settings.json.
