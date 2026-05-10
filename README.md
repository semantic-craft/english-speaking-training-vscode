# English Speaking Training VS Code Extension

Standalone VS Code speaking-practice cockpit for `EnglishSpeakingTraining`
materials.

The extension no longer depends on Hermes or Telegram for the main practice
loop. It reads `prebuilt/` package files from either the current workspace or a
configured GitHub raw/repo URL, records inside a VS Code webview, stores API keys
in VS Code SecretStorage, and writes session artifacts locally.

## Bring Your Own Materials

The extension does **not** ship lessons. You point it at a `prebuilt/` directory
of your own — local folder or GitHub repo — and it walks every `YYYY-MM-DD`
subdirectory it finds. There is no required curriculum length: 7 lessons or 365
lessons both work.

**First-run path** (no lessons yet):

1. Open the **English Training** sidebar. The Quick Setup card lists what's
   missing.
2. Click *Pick where lessons live* → choose `Local` (or `GitHub`).
3. Click *Create your first lesson* (local mode) → pick a folder; the extension
   creates `prebuilt/` and `progress/` inside it and writes a starter
   `prebuilt/<today>/english-training.json` you can edit.
4. Click *Add your first AI key* → pick a provider (MiMo recommended for the
   default coach + STT + TTS combo).
5. Press the red record button.

For the field-by-field schema, run `English Training: Open Materials Guide`
from the command palette.

## Materials Source

- **Local**: auto-detects a workspace or parent folder containing `prebuilt/`.
- **Fixed local path**: set `englishTraining.localMaterialsRoot` to a directory
  containing `prebuilt/` so the sidebar works from any VS Code workspace.
- **GitHub**: set `englishTraining.githubMaterialsBaseUrl` to a GitHub repo/tree
  URL or a `raw.githubusercontent.com` base URL that contains `prebuilt/`.

Use `English Training: Configure GitHub Materials Source` from the command
palette, or click `Source -> GitHub` in the sidebar. GitHub mode keeps practice
logs and completion progress under VS Code global storage, so the VS Code
workspace does not need to be the training repository.

For a private materials repository, run `English Training: Configure GitHub
Token` or click `Source -> GitHub Token`. Store a fine-grained GitHub token with
read access to the repository. The token is kept only in VS Code SecretStorage;
it is not written to `settings.json`. Remote JSON, Markdown task cards, and the
daily audio file are fetched by the extension with that token. The audio is
cached under VS Code global storage so the sidebar player can use a local
webview URI instead of exposing the private raw URL.

## Provider Defaults

- Speech input: OpenAI `gpt-4o-transcribe` by default, with Gemini
  `gemini-2.5-flash` and MiMo `mimo-v2.5` as options
- Coach: Xiaomi MiMo `mimo-v2.5`, with MiniMax `MiniMax-M2.7-highspeed` and
  Gemini `gemini-2.5-flash`, Kimi Code `kimi-for-coding`, and DeepSeek `deepseek-v4-pro`
  as language-model options
- Speech output: MiniMax `speech-2.8-hd` with `English_expressive_narrator` by
  default, with OpenAI `gpt-4o-mini-tts`, Gemini
  `gemini-2.5-flash-preview-tts`, and MiMo `mimo-v2.5-tts` as options

## Features

- `English Training` Activity Bar container with a `Practice` webview.
- Direct `Record` / `Stop` microphone flow inside the sidebar.
- Transcript, native-speaker version, concrete problems, repeat instruction,
  and follow-up question returned in the same sidebar.
- Generated native-version audio saved locally and played in VS Code.
- API key commands:
  - `English Training: Configure OpenAI API Key`
  - `English Training: Configure Gemini API Key`
  - `English Training: Configure MiniMax API Key`
  - `English Training: Configure MiMo API Key`
  - `English Training: Configure Kimi API Key`
  - `English Training: Configure DeepSeek API Key`
  - `English Training: Configure GitHub Token`
- Local actions:
  - `English Training: Complete Current Package Locally`
  - `English Training: Open Current Task Card`
  - `English Training: Open Local Session Folder`
  - `English Training: Configure GitHub Materials Source`

## Development

```sh
cd vscode-extension
npm install
npm run compile
npx @vscode/vsce package --allow-missing-repository
```

Open this folder in VS Code and press `F5` to run an Extension Development Host.
Open the `EnglishSpeakingTraining` project folder in that host to activate the
extension.

## Notes

The recorder first tries browser `MediaRecorder` inside the VS Code webview. If
VS Code denies microphone access, it falls back to native macOS recording
through `ffmpeg` AVFoundation and keeps the resulting session files local.
