# English Speaking Training VS Code Extension

Standalone VS Code speaking-practice cockpit for `EnglishSpeakingTraining`
materials.

The extension no longer depends on Hermes or Telegram for the main practice
loop. It reads local `prebuilt/` package files, records inside a VS Code webview,
stores API keys in VS Code SecretStorage, and writes session artifacts locally.

## Bring Your Own Materials

The extension does **not** ship lessons. You point it at a local `prebuilt/`
directory of your own, and it walks every `YYYY-MM-DD` subdirectory it finds.
There is no required curriculum length: 7 lessons or 365 lessons both work.

**First-run path** (no lessons yet):

1. Open the **English Training** sidebar. The Quick Setup card lists what's
   missing.
2. Click *Pick local folder* or run `English Training: Configure Local Materials
   Folder`.
3. Click *Create your first lesson* → pick a folder; the extension
   creates `prebuilt/` and `progress/` inside it and writes a starter
   `prebuilt/<today>/english-training.json` plus `followup-drill.json` you can edit.
4. Click *Connect Gemini* -> save a Gemini API key. That completes the core
   route: Gemini handles coaching, speech input, and native audio.
5. Press the red record button.

For the field-by-field schema, run `English Training: Open Materials Guide`
from the command palette.

## Local Materials Source

- **Local**: auto-detects a workspace or parent folder containing `prebuilt/`.
- **Fixed local path**: set `englishTraining.localMaterialsRoot` to a directory
  containing `prebuilt/` so the sidebar works from any VS Code workspace.
- **Picker**: run `English Training: Configure Local Materials Folder`, or click
  `Source -> Local Folder` in the sidebar.

## Source Diagnostics and Learner Profile

The Practice sidebar shows **Source Diagnostics** so you can verify what it
actually loaded: local root, lesson count, current package date, and the exact
`english-training.json` path.

To personalize coaching, add one of these files to your materials root:

- `profile/learner-profile.md`
- `profile/learner-profile.json`

When found, the sidebar shows **Profile loaded** and the coach receives that
profile with every practice turn. If no profile exists, the sidebar shows the
expected path.

## Reading Cards and Prosody

The sidebar now treats the generated Hermes package as the source of truth for
reading cards. For each `prebuilt/YYYY-MM-DD/` package, it displays these files
when present:

- `daily-card.png`
- `prosody-detail.png`
- `audio/demo.ogg`

If `manifest.json` is present, the extension reads `files.daily_card`,
`files.prosody_detail`, `files.audio_demo`, `files.audio_queue`, and
`files.telegram_task_card`; otherwise it falls back to the default paths above.

For new package generation, keep these JSON fields in `english-training.json`:

- `stress_guide`: text with stressed words marked, for example `ˈBROADER`.
- `intonation_guide`: thought groups separated by `|`, with contours such as
  `→` and `↘`.
- `word_level_prosody.groups[]`: `id`, `text`, `function`, `nucleus`,
  `contour`, and `pause_after`.
- `word_level_prosody.words[]`: `text`, `stress` (`weak`, `support`,
  `nucleus`), `pitch_role`, `arrow`, and `group`.

For FSI-style follow-up practice, include `followup-drill.json` with
`rounds[].examples[].text`. The sidebar turns those examples into Listen /
Practice / Skip choices after each result, and coach-generated
`drill_examples[]` can add extra targeted substitution sentences.

## Provider Defaults

- Coach: Gemini by default with `gemini-3-flash-preview`, plus
  `gemini-3.1-pro-preview`, `gemini-3.1-flash-lite`, and
  `gemini-3.1-flash-lite-preview` available from the model picker. MiniMax,
  MiMo, OpenAI, Kimi, and DeepSeek remain optional fallbacks.
- Speech input: Gemini by default for transcript matching; OpenAI Realtime
  `gpt-realtime-whisper` can be selected for low-latency transcript generation.
- Speech output: Gemini `gemini-3.1-flash-tts-preview` by default. MiniMax and
  OpenAI speech output remain optional fallbacks.
- The sidebar's **Routes & Models** panel shows the active route, key status,
  and model/voice controls in one place.

## Features

- `English Training` Activity Bar container with a `Practice` webview.
- Direct `Record` / `Stop` microphone flow inside the sidebar.
- Transcript, native-speaker version, concrete problems, repeat instruction,
  and follow-up question returned in the same sidebar.
- Reading Card panel for prebuilt `daily-card.png`, `prosody-detail.png`,
  `audio/demo.ogg`, stress guide, intonation guide, and word-level prosody.
- FSI drill choices after each result: listen to a substitution sentence,
  practice it as a shadowing target, or skip the extra drill.
- On-demand *Example audio*: click `Generate Example` to synthesize only the
  lesson example text (`clean_tts_text`, `audio_text`, or `demo_line`) with
  your configured speech-output provider. Scenario and goal background are not
  read aloud.
- Generated native-version audio saved locally and played in VS Code.
- API key commands:
  - `English Training: Configure OpenAI API Key`
  - `English Training: Configure Gemini API Key`
  - `English Training: Configure MiniMax API Key`
  - `English Training: Configure MiMo API Key`
  - `English Training: Configure Kimi API Key`
  - `English Training: Configure DeepSeek API Key`
- Route commands:
  - `English Training: Use Gemini Core Route`
  - `English Training: Use Gemini Only`
  - `English Training: Use OpenAI Realtime Speech Input`
- Local actions:
  - `English Training: Complete Current Package Locally`
  - `English Training: Open Current Task Card`
  - `English Training: Open Local Session Folder`
  - `English Training: Configure Local Materials Folder`

## Development

```sh
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Open this folder in VS Code and press `F5` to run an Extension Development
Host. The host needs a workspace folder that contains a `prebuilt/` directory
to activate the extension; you can point it at any folder with lessons, or use
`English Training: Configure Local Materials Folder` from the command palette.

The legacy Python tooling that originally generated the daily packages now
lives in `reference/` (gitignored). It is kept as a methodology archive only —
the extension does not depend on it at runtime.

## Notes

The recorder defaults to `englishTraining.recorderBackend = macLocal` on macOS.
That path records through `ffmpeg` AVFoundation, auto-selects a local Mac
microphone such as `iMac Microphone`, and avoids device names matching
`englishTraining.blockedMicrophoneNamePattern` such as iPhone/Continuity inputs.
Set `englishTraining.preferredMicrophoneName` if you want to pin a specific
local microphone.
