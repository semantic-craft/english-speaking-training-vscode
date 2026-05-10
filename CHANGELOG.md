# Changelog

All notable changes to the **English Speaking Training** VS Code extension will
be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
  surfaces missing pieces (source, GitHub token, lessons, AI key) and routes
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
- Multi-provider AI: 5 coach LLMs (MiMo, MiniMax, Gemini, Kimi, DeepSeek),
  3 speech-input providers (OpenAI, Gemini, MiMo), 4 TTS providers (OpenAI,
  Gemini, MiMo, MiniMax).
- Native ffmpeg AVFoundation fallback for VS Code microphone denial.
- GitHub materials source mode with private-repo PAT support and asset caching
  in VS Code global storage.
- API keys stored in VS Code SecretStorage; never written to settings.json.
