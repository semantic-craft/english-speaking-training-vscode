import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  appendOutput,
  configString,
  errorMessage,
  isAudioUnderstandingProvider,
  isCoachProvider,
  isTtsProvider,
  normalizedProviderName,
  stringValue,
} from "../core.js";
import type {
  CoachPriorTurn,
  JsonObject,
  PracticeResult,
  PracticeTarget,
  StageReporter,
  WebviewAudioMessage,
} from "../types.js";
import { extensionFromMime } from "../practice/transcribe.js";
import { createSessionDir, processPracticeFile } from "../practice/pipeline.js";
import { generateDrillLines as coachGenerateDrillLines } from "../practice/coach.js";
import { buildPracticeHtml } from "./html.js";
import { openMaterialsGuide } from "../materials-guide.js";
import { refreshAll, runConfigureSetting } from "../runtime/host.js";
import { isConfigSettingName, normalizedTtsProvider } from "../runtime/settings.js";
import {
  configureApiKey,
  configureCoreRouteKeys,
  configureLocalMaterialsRoot,
  setGeminiOnlyProviders,
  setProviderSetting,
  setQwenStackProviders,
  setQwenTtsVoice,
  setTtsSpeedConfig,
} from "../commands/provider-routes.js";
import {
  completeLocalPackage,
  openCurrentTaskCard,
  openSessionFolder,
  selectRecordingMicrophone,
} from "../commands/local-actions.js";
import { createSamplePackage, generateNextPackage } from "../materials/scaffold.js";
import { composeMaterialPrompt } from "../materials/prompt-composer.js";
import { expandHome } from "../runtime/training-root.js";
import { invalidateNextPackageCache, loadState, toWebviewState } from "../runtime/state.js";
import {
  killActiveNativeRecording,
  killNativeRecordingSession,
  startNativeFfmpegRecording,
  stopNativeFfmpegRecording,
} from "../audio/native-recording.js";
import {
  type QwenStreamSink,
  streamQwenOnDemandText,
  streamQwenTodayAudio,
  synthesizeOnDemandText,
  synthesizeTodayAudio,
} from "../audio/synthesis.js";

export class PracticeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private pendingPriorTurn?: CoachPriorTurn;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    if (this.view && this.view !== view) {
      // A replacement view cannot stop an old panel's recorder from the UI, so
      // release the native microphone before adopting the new webview.
      killActiveNativeRecording();
    }
    // A resolved webview starts with fresh in-page state. Do not carry a
    // previous panel's armed follow-up reply into the first recording here.
    this.pendingPriorTurn = undefined;
    this.view = view;
    this.applyResourceRoots();
    // Register the host listener before loading the webview document. The
    // script posts `ready` as soon as it executes, and installing the listener
    // after assigning html leaves a tiny first-load race where that message can
    // be missed on a fast reload.
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(view, message);
    });
    view.webview.html = this.html(view.webview);
    // If the practice view is torn down (panel closed/moved) while a native
    // ffmpeg recorder is running, deactivate() never fires, so the recorder
    // would keep holding the microphone and a re-resolved view could never
    // start a new recording ("already running"). Stop it on disposal.
    view.onDidDispose(() => {
      if (this.view !== view) {
        return;
      }
      killActiveNativeRecording();
      this.pendingPriorTurn = undefined;
      this.view = undefined;
    });
    void this.postState();
  }

  async postState(): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    try {
      const state = await loadState(this.context);
      if (this.view !== view) {
        return;
      }
      this.applyResourceRoots(state.root);
      this.postToActiveView(view, { type: "state", state: toWebviewState(view.webview, state) });
    } catch (error) {
      this.postToActiveView(view, { type: "error", message: errorMessage(error) });
    }
  }

  private applyResourceRoots(materialsRoot?: string): void {
    if (!this.view) {
      return;
    }
    const configuredRoot = expandHome(configString("localMaterialsRoot"));
    const roots = [
      vscode.Uri.file(this.context.extensionPath),
      this.context.globalStorageUri,
      ...((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)),
      ...(configuredRoot ? [vscode.Uri.file(configuredRoot)] : []),
      ...(materialsRoot ? [vscode.Uri.file(materialsRoot)] : []),
    ];
    this.view.webview.options = {
      enableScripts: true,
      localResourceRoots: dedupeUris(roots),
    };
  }

  private async handleMessage(view: vscode.WebviewView, message: unknown): Promise<void> {
    if (this.view !== view || typeof message !== "object" || !message) {
      return;
    }
    const payload = message as JsonObject;
    try {
      if (payload.type === "ready" || payload.type === "refresh") {
        // An explicit user refresh must re-detect externally-changed
        // packages/completion; "ready" is the initial load (a cache miss
        // anyway), so only the explicit refresh drops the cache.
        if (payload.type === "refresh") {
          invalidateNextPackageCache();
        }
        await this.postState();
        return;
      }
      if (payload.type === "configureKey") {
        const rawProvider = stringValue(payload.provider).trim();
        const provider = normalizedProviderName(rawProvider);
        const requestId = positiveRequestId(payload.requestId);
        if (provider) {
          await this.runOptionalSidebarCommand(
            view,
            "configureKey",
            requestId,
            () => configureApiKey(this.context, provider),
          );
        } else {
          this.postOptionalSidebarError(
            view,
            "configureKey",
            requestId,
            `Unknown provider key route: ${messageValue(rawProvider)}.`,
          );
        }
        return;
      }
      if (payload.type === "setProvider") {
        const providerSetting = stringValue(payload.setting).trim();
        const providerValue = normalizedProviderName(payload.value);
        const requestId = positiveRequestId(payload.requestId);
        if (providerSetting === "coachProvider" && isCoachProvider(providerValue)) {
          await this.runOptionalSidebarCommand(
            view,
            "setProvider",
            requestId,
            () => setProviderSetting("coachProvider", providerValue),
          );
        } else if (providerSetting === "audioUnderstandingProvider" && isAudioUnderstandingProvider(providerValue)) {
          await this.runOptionalSidebarCommand(
            view,
            "setProvider",
            requestId,
            () => setProviderSetting("audioUnderstandingProvider", providerValue),
          );
        } else if (providerSetting === "ttsProvider" && isTtsProvider(providerValue)) {
          await this.runOptionalSidebarCommand(
            view,
            "setProvider",
            requestId,
            () => setProviderSetting("ttsProvider", providerValue),
          );
        } else {
          // Never let a provider "Use" click silently no-op: the card would
          // look clickable but dead. Tell the user why it was rejected.
          this.postOptionalSidebarError(
            view,
            "setProvider",
            requestId,
            `Cannot use "${messageValue(payload.value)}" for ${messageValue(payload.setting)}.`,
          );
        }
        return;
      }
      if (payload.type === "configureSetting") {
        const setting = stringValue(payload.setting).trim();
        const requestId = positiveRequestId(payload.requestId);
        if (isConfigSettingName(setting)) {
          await this.runOptionalSidebarCommand(
            view,
            "configureSetting",
            requestId,
            () => runConfigureSetting(setting),
          );
        } else {
          this.postOptionalSidebarError(
            view,
            "configureSetting",
            requestId,
            `Unknown setting: ${messageValue(setting)}.`,
          );
        }
        return;
      }
      if (payload.type === "setQwenVoice") {
        const voiceId = stringValue(payload.voiceId).trim();
        const requestId = positiveRequestId(payload.requestId);
        if (voiceId) {
          await this.runOptionalSidebarCommand(
            view,
            "setQwenVoice",
            requestId,
            () => setQwenTtsVoice(voiceId),
          );
        } else {
          this.postOptionalSidebarError(view, "setQwenVoice", requestId, "Qwen-TTS voice was missing.");
        }
        return;
      }
      if (payload.type === "setTtsSpeed") {
        const value = positiveScalarNumber(payload.value);
        const requestId = positiveRequestId(payload.requestId);
        if (value !== undefined) {
          await this.runOptionalSidebarCommand(
            view,
            "setTtsSpeed",
            requestId,
            () => setTtsSpeedConfig(value),
          );
        } else {
          this.postOptionalSidebarError(
            view,
            "setTtsSpeed",
            requestId,
            `Invalid TTS speed: ${messageValue(payload.value)}.`,
          );
        }
        return;
      }
      if (payload.type === "useGeminiOnly") {
        await this.runOptionalSidebarCommand(
          view,
          "useGeminiOnly",
          positiveRequestId(payload.requestId),
          () => setGeminiOnlyProviders(),
        );
        return;
      }
      if (payload.type === "useQwenStack") {
        await this.runOptionalSidebarCommand(
          view,
          "useQwenStack",
          positiveRequestId(payload.requestId),
          () => setQwenStackProviders(),
        );
        return;
      }
      if (payload.type === "slowRead") {
        const text = stringValue(payload.text);
        const target = stringValue(payload.target).trim() || "native";
        const speed = positiveScalarNumber(payload.speed);
        const requestId = positiveRequestId(payload.requestId);
        if (!requestId) {
          this.postToActiveView(view, {
            type: "error",
            message: "Slow-read request id was missing. Refresh the practice view and try again.",
          });
          return;
        }
        await this.slowReadText(
          text,
          target,
          speed ?? 0.7,
          requestId,
        );
        return;
      }
      if (payload.type === "setReplyContext") {
        this.pendingPriorTurn = normalizeCoachPriorTurnPayload(payload.priorTurn);
        return;
      }
      if (payload.type === "clearReplyContext") {
        this.pendingPriorTurn = undefined;
        return;
      }
      if (payload.type === "completeLocal") {
        await this.runSidebarCommand(
          view,
          "completeLocal",
          positiveRequestId(payload.requestId),
          () => completeLocalPackage(this.context),
        );
        return;
      }
      if (payload.type === "command") {
        const command = stringValue(payload.command).trim();
        const requestId = positiveRequestId(payload.requestId);
        if (command === "configureMaterials") {
          await this.runSidebarCommand(
            view,
            command,
            requestId,
            () => configureLocalMaterialsRoot({ onChanged: invalidateNextPackageCache }),
          );
        } else if (command === "openTask") {
          await this.runOptionalSidebarCommand(view, command, requestId, () => openCurrentTaskCard(this.context));
        } else if (command === "openSessionFolder") {
          await this.runOptionalSidebarCommand(view, command, requestId, () => openSessionFolder(this.context));
        } else if (command === "setupProviderKey") {
          await this.runSidebarCommand(view, command, requestId, () => configureCoreRouteKeys(this.context));
        } else if (command === "createSamplePackage") {
          await this.runSidebarCommand(view, command, requestId, () => createSamplePackage(this.context));
        } else if (command === "generateNextPackage") {
          await this.runSidebarCommand(view, command, requestId, () => generateNextPackage(this.context));
        } else if (command === "composeMaterialPrompt") {
          await this.runSidebarCommand(view, command, requestId, () => composeMaterialPrompt(this.context));
        } else if (command === "openMaterialsGuide") {
          await this.runOptionalSidebarCommand(view, command, requestId, () => openMaterialsGuide());
        } else if (command === "selectMicrophone") {
          await this.runSidebarCommand(view, command, requestId, () => selectRecordingMicrophone());
        } else {
          const message = `Unknown sidebar command: ${messageValue(command)}.`;
          if (requestId) {
            this.postSidebarCommandResult(view, command || "(missing)", requestId, { error: message });
          } else {
            this.postToActiveView(view, { type: "error", message });
          }
        }
        return;
      }
      if (payload.type === "startNativeRecording") {
        const requestId = positiveRequestId(payload.requestId);
        if (!requestId) {
          this.pendingPriorTurn = undefined;
          this.postToActiveView(view, {
            type: "error",
            message: "Native recording request id was missing. Refresh the practice view and try again.",
          });
          return;
        }
        const priorTurn = normalizeCoachPriorTurnPayload(payload.priorTurn) ?? this.pendingPriorTurn;
        this.pendingPriorTurn = undefined;
        await this.startNativeRecording(
          normalizePracticeTargetPayload(payload.practiceTarget),
          priorTurn,
          requestId,
        );
        return;
      }
      if (payload.type === "stopNativeRecording") {
        await this.stopNativeRecording(positiveRequestId(payload.requestId));
        return;
      }
      if (payload.type === "practiceAudio") {
        await this.runPractice(payload as unknown as WebviewAudioMessage);
        return;
      }
      if (payload.type === "todayTts") {
        const requestId = positiveRequestId(payload.requestId);
        if (!requestId) {
          this.postToActiveView(view, {
            type: "error",
            message: "Example audio request id was missing. Refresh the practice view and try again.",
          });
          return;
        }
        await this.generateTodayTts(requestId);
        return;
      }
      if (payload.type === "generateDrillLines") {
        const count = positiveScalarNumber(payload.count);
        const requestId = positiveRequestId(payload.requestId);
        if (!requestId) {
          this.postToActiveView(view, {
            type: "error",
            message: "Drill generation request id was missing. Refresh the practice view and try again.",
          });
          return;
        }
        const existing = Array.isArray(payload.existing)
          ? payload.existing.map((item) => stringValue(item).trim()).filter(Boolean)
          : [];
        await this.generateDrillLines(
          count ?? 5,
          existing,
          requestId,
        );
        return;
      }
      this.postToActiveView(view, {
        type: "error",
        message: `Unknown sidebar message: ${messageValue(payload.type)}.`,
      });
    } catch (error) {
      const requestId = payload.type === "startNativeRecording" || payload.type === "practiceAudio" || payload.type === "stopNativeRecording"
        ? positiveRequestId(payload.requestId)
        : 0;
      if ((payload.type === "startNativeRecording" || payload.type === "practiceAudio" || payload.type === "stopNativeRecording") && this.view === view) {
        this.pendingPriorTurn = undefined;
      }
      this.postToActiveView(view, {
        type: "error",
        message: errorMessage(error),
        ...(Number.isFinite(requestId) && requestId > 0 ? { requestId } : {}),
      });
    }
  }

  private async generateTodayTts(requestId?: number): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const request = requestId ? { requestId } : {};
    this.postToActiveView(view, { type: "todayTtsStatus", ...request, message: "Generating example audio…" });
    if (normalizedTtsProvider() === "qwen") {
      let streamStarted = false;
      try {
        const result = await streamQwenTodayAudio(this.context, {
          onStart: (info) => {
            streamStarted = true;
            this.postToActiveView(view, {
              type: "todayTtsStream",
              phase: "start",
              ...request,
              sampleRate: info.sampleRate,
              channels: info.channels,
            });
          },
          onChunk: (base64) => this.postToActiveView(view, {
            type: "todayTtsStream",
            phase: "chunk",
            ...request,
            base64,
          }),
        });
        if (streamStarted) {
          this.postToActiveView(view, { type: "todayTtsStream", phase: "done", ...request });
        }
        this.postToActiveView(view, { type: "todayTtsResult", ...request, result, streamed: streamStarted });
      } catch (error) {
        if (streamStarted) {
          this.postToActiveView(view, { type: "todayTtsStream", phase: "error", ...request });
        }
        this.postToActiveView(view, { type: "todayTtsResult", ...request, error: errorMessage(error) });
      }
      return;
    }
    try {
      const result = await synthesizeTodayAudio(this.context);
      this.postToActiveView(view, { type: "todayTtsResult", ...request, result });
    } catch (error) {
      this.postToActiveView(view, { type: "todayTtsResult", ...request, error: errorMessage(error) });
    }
  }

  private async generateDrillLines(count: number, existing: string[], requestId?: number): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const request = requestId ? { requestId } : {};
    this.postToActiveView(view, { type: "drillLinesStatus", ...request, message: "Generating new lines…" });
    try {
      const state = await loadState(this.context);
      const lines = await coachGenerateDrillLines(this.context, state, count, existing);
      this.postToActiveView(view, { type: "drillLinesResult", ...request, lines });
    } catch (error) {
      this.postToActiveView(view, { type: "drillLinesResult", ...request, error: errorMessage(error) });
    }
  }

  private async slowReadText(text: string, target: string, speed: number, requestId?: number): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const request = requestId ? { requestId } : {};
    const trimmed = text.trim();
    if (!trimmed) {
      this.postToActiveView(view, {
        type: "slowReadResult",
        target,
        ...request,
        error: "Slow-read text was missing.",
      });
      return;
    }
    const slowSpeed = Number.isFinite(speed) && speed > 0 ? Math.max(0.5, Math.min(1.5, speed)) : 0.7;
    this.postToActiveView(view, { type: "slowReadStatus", target, ...request, message: "Re-reading…" });
    // For slow re-reads the learner is shadowing word-by-word, so we ask the
    // TTS to over-articulate and pause between sense groups. Qwen carries
    // this only on the instruct model; MiMo passes it as a user style
    // prompt; Gemini ignores the hint and just honors its normal route.
    const slowInstructions =
      "Read this sentence very slowly and clearly. Over-articulate each word, " +
      "lengthen the stressed syllables, and pause briefly between sense groups so " +
      "a learner can shadow you word by word.";
    if (normalizedTtsProvider() === "qwen") {
      let streamStarted = false;
      try {
        const result = await streamQwenOnDemandText(this.context, trimmed, slowSpeed, slowInstructions, {
          onStart: (info) => {
            streamStarted = true;
            this.postToActiveView(view, {
              type: "slowReadStream",
              phase: "start",
              target,
              ...request,
              sampleRate: info.sampleRate,
              channels: info.channels,
            });
          },
          onChunk: (base64) => this.postToActiveView(view, {
            type: "slowReadStream",
            phase: "chunk",
            target,
            ...request,
            base64,
          }),
        });
        if (streamStarted) {
          this.postToActiveView(view, { type: "slowReadStream", phase: "done", target, ...request });
        }
        this.postToActiveView(view, { type: "slowReadResult", target, ...request, result, streamed: streamStarted });
      } catch (error) {
        if (streamStarted) {
          this.postToActiveView(view, { type: "slowReadStream", phase: "error", target, ...request });
        }
        this.postToActiveView(view, {
          type: "slowReadResult",
          target,
          ...request,
          error: errorMessage(error),
        });
      }
      return;
    }
    try {
      const result = await synthesizeOnDemandText(this.context, trimmed, slowSpeed, slowInstructions);
      this.postToActiveView(view, { type: "slowReadResult", target, ...request, result });
    } catch (error) {
      this.postToActiveView(view, {
        type: "slowReadResult",
        target,
        ...request,
        error: errorMessage(error),
      });
    }
  }

  private stageReporter(view = this.view, requestId = 0): StageReporter {
    return (stage, status) => {
      if (view) {
        this.postToActiveView(view, {
          type: "stage",
          stage,
          status,
          show: true,
          ...(requestId ? { requestId } : {}),
        });
      }
    };
  }

  private async runPractice(message: WebviewAudioMessage): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const priorTurn = message.priorTurn ?? this.pendingPriorTurn;
    this.pendingPriorTurn = undefined;
    const requestId = positiveRequestId(message.requestId);
    this.postToActiveView(view, {
      type: "stage",
      stage: "transcribe",
      status: "active",
      show: true,
      ...(requestId ? { requestId } : {}),
    });
    const practiceTarget = normalizePracticeTargetPayload(message.practiceTarget);
    const tts = this.buildNativeTtsStream(view, requestId);
    const result = await processPracticeAudio(
      this.context,
      message,
      this.stageReporter(view, requestId),
      priorTurn,
      practiceTarget,
      tts.sink,
    );
    tts.finalize();
    this.postPracticeResult(view, result, { priorTurn, practiceTarget, requestId });
    await this.refreshAfterPracticeResult();
  }

  private buildNativeTtsStream(
    view: vscode.WebviewView,
    requestId?: number,
  ): { sink: QwenStreamSink | undefined; finalize: () => void } {
    if (normalizedTtsProvider() !== "qwen") {
      return { sink: undefined, finalize: () => undefined };
    }
    const meta = requestId ? { requestId } : {};
    let started = false;
    const sink: QwenStreamSink = {
      onStart: (info) => {
        started = true;
        this.postToActiveView(view, {
          type: "practiceTtsStream",
          phase: "start",
          sampleRate: info.sampleRate,
          channels: info.channels,
          ...meta,
        });
      },
      onChunk: (base64) => this.postToActiveView(view, {
        type: "practiceTtsStream",
        phase: "chunk",
        base64,
        ...meta,
      }),
    };
    return {
      sink,
      finalize: () => {
        if (started) {
          this.postToActiveView(view, { type: "practiceTtsStream", phase: "done", ...meta });
        }
      },
    };
  }

  private async startNativeRecording(
    practiceTarget: PracticeTarget | undefined,
    priorTurn: CoachPriorTurn | undefined,
    requestId: number,
  ): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const request = { requestId };
    // Stream the prep phases so "press record → can speak" is a visible,
    // moving progression instead of one frozen line. Now that device
    // enumeration is async (no spawnSync host freeze), these flush live.
    const session = await startNativeFfmpegRecording(this.context, practiceTarget, priorTurn, (phase) => {
      this.postToActiveView(view, { type: "nativeRecordingPreparing", ...request, phase });
    });
    if (this.view !== view) {
      killNativeRecordingSession(session);
      return;
    }
    this.postToActiveView(view, {
      type: "nativeRecordingStarted",
      ...request,
      sessionDir: session.sessionDir,
    });
  }

  private async stopNativeRecording(requestId = 0): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    // Do NOT light the "transcribe" stage here: stopNativeFfmpegRecording()
    // is a 0.15–5s ffmpeg drain (q → SIGINT → SIGTERM → settle), and showing
    // the strip with Transcribe blinking during that window mislabels a
    // multi-second wait exactly the way record-start used to. The webview
    // already shows an honest "Stopping native recorder…" status on the stop
    // press; the strip should appear only when transcription truly starts,
    // which the pipeline's own progress("transcribe","active") reports.
    let priorTurn = this.pendingPriorTurn;
    this.pendingPriorTurn = undefined;
    const session = await stopNativeFfmpegRecording();
    priorTurn = session.priorTurn ?? priorTurn;
    const state = await loadState(this.context);
    const practiceTarget = session.practiceTarget;
    const tts = this.buildNativeTtsStream(view, requestId);
    const result = await processPracticeFile(
      this.context,
      state,
      session.filePath,
      "audio/wav",
      session.sessionDir,
      session.packageDate,
      this.stageReporter(view, requestId),
      priorTurn,
      practiceTarget,
      tts.sink,
    );
    tts.finalize();
    this.postPracticeResult(view, result, {
      localAudioFile: session.filePath,
      priorTurn,
      practiceTarget,
      requestId,
    });
    await this.refreshAfterPracticeResult();
  }

  private async refreshAfterPracticeResult(): Promise<void> {
    try {
      await refreshAll();
    } catch (error) {
      appendOutput(`Practice result posted, but follow-up refresh failed: ${errorMessage(error)}`);
    }
  }

  private async runSidebarCommand(
    view: vscode.WebviewView,
    command: string,
    requestId: number,
    task: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await task();
      this.postSidebarCommandResult(view, command, requestId, {});
    } catch (error) {
      this.postSidebarCommandResult(view, command, requestId, { error: errorMessage(error) });
    }
  }

  private async runOptionalSidebarCommand(
    view: vscode.WebviewView,
    command: string,
    requestId: number,
    task: () => Promise<unknown>,
  ): Promise<void> {
    if (requestId) {
      await this.runSidebarCommand(view, command, requestId, task);
      return;
    }
    await task();
  }

  private postOptionalSidebarError(
    view: vscode.WebviewView,
    command: string,
    requestId: number,
    message: string,
  ): void {
    if (requestId) {
      this.postSidebarCommandResult(view, command, requestId, { error: message });
      return;
    }
    this.postToActiveView(view, { type: "error", message });
  }

  private postSidebarCommandResult(
    view: vscode.WebviewView,
    command: string,
    requestId: number,
    result: { error?: string },
  ): void {
    this.postToActiveView(view, {
      type: "commandResult",
      command,
      ...(requestId ? { requestId } : {}),
      ...result,
    });
  }

  private postPracticeResult(
    view: vscode.WebviewView,
    result: PracticeResult,
    options: {
      localAudioFile?: string;
      priorTurn?: CoachPriorTurn;
      practiceTarget?: PracticeTarget;
      requestId?: number;
    } = {},
  ): void {
    if (this.view !== view) {
      return;
    }
    const audioUri = result.audioFile ? this.webviewFileUri(view, result.audioFile, "audio") ?? "" : "";
    const followUpAudioUri = result.followUpAudioFile
      ? this.webviewFileUri(view, result.followUpAudioFile, "follow-up audio") ?? ""
      : "";
    const localAudioUri = options.localAudioFile
      ? this.webviewFileUri(view, options.localAudioFile, "local recording")
      : undefined;
    this.postToActiveView(view, {
      type: "practiceResult",
      ...(options.requestId ? { requestId: options.requestId } : {}),
      result: {
        ...result,
        audioUri,
        followUpAudioUri,
        ...(localAudioUri ? { localAudioUri } : {}),
        priorTurn: options.priorTurn ?? null,
        practiceTarget: options.practiceTarget ?? null,
      },
    });
  }

  private webviewFileUri(view: vscode.WebviewView, filePath: string, label: string): string | undefined {
    try {
      return view.webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
    } catch (error) {
      appendOutput(`Practice result ${label} URI unavailable: ${errorMessage(error)}`);
      return undefined;
    }
  }

  private html(webview: vscode.Webview): string {
    return buildPracticeHtml(webview, this.context.extensionUri);
  }

  private postToActiveView(view: vscode.WebviewView, message: JsonObject): void {
    if (this.view === view) {
      try {
        void Promise.resolve(view.webview.postMessage(message)).catch((error) => {
          appendOutput(`Practice webview postMessage failed: ${errorMessage(error)}`);
        });
      } catch (error) {
        appendOutput(`Practice webview postMessage failed: ${errorMessage(error)}`);
      }
    }
  }
}

function messageValue(value: unknown): string {
  return stringValue(value).trim() || "(missing)";
}

export async function processPracticeAudio(
  context: vscode.ExtensionContext,
  message: WebviewAudioMessage,
  progress?: StageReporter,
  priorTurn?: CoachPriorTurn,
  practiceTarget?: PracticeTarget,
  nativeTtsStreamSink?: QwenStreamSink,
): Promise<PracticeResult> {
  const audioBuffer = decodeWebviewAudioBase64(message.base64);
  if (audioBuffer.length < 1000) {
    throw new Error("Recorded audio is empty or too short to process.");
  }
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const mimeType = typeof message.mimeType === "string" && message.mimeType.trim()
    ? message.mimeType
    : "audio/webm";
  const inputExt = extensionFromMime(mimeType);
  const inputPath = path.join(sessionDir, `input.${inputExt}`);
  fs.writeFileSync(inputPath, audioBuffer);
  return processPracticeFile(
    context,
    state,
    inputPath,
    mimeType,
    sessionDir,
    packageDate,
    progress,
    priorTurn,
    practiceTarget,
    nativeTtsStreamSink,
  );
}

export function decodeWebviewAudioBase64(value: unknown): Buffer {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new Error("Recorded audio payload was missing.");
  }
  const commaIndex = raw.indexOf(",");
  const compact = (raw.startsWith("data:") && commaIndex >= 0 ? raw.slice(commaIndex + 1) : raw)
    .replace(/\s+/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    throw new Error("Recorded audio payload was not valid base64.");
  }
  const buffer = Buffer.from(compact, "base64");
  const normalizedInput = compact.replace(/=+$/, "");
  const normalizedOutput = buffer.toString("base64").replace(/=+$/, "");
  if (normalizedOutput !== normalizedInput) {
    throw new Error("Recorded audio payload was not valid base64.");
  }
  return buffer;
}

export function normalizePracticeTargetPayload(value: unknown): PracticeTarget | undefined {
  const obj = (value && typeof value === "object" ? value : undefined) as JsonObject | undefined;
  const referenceText = firstPayloadString(obj, "referenceText", "reference_text");
  if (!referenceText) {
    return undefined;
  }
  return {
    mode: "shadow",
    referenceText,
    referenceLabel: firstPayloadString(obj, "referenceLabel", "reference_label") || "Reference",
    followUpQuestion: firstPayloadString(obj, "followUpQuestion", "follow_up_question"),
  };
}

function normalizeCoachPriorTurnPayload(value: unknown): CoachPriorTurn | undefined {
  const obj = (value && typeof value === "object" ? value : undefined) as JsonObject | undefined;
  const nativeVersion = firstPayloadString(obj, "nativeVersion", "native_version");
  if (!nativeVersion) {
    return undefined;
  }
  return {
    nativeVersion,
    followUpQuestion: firstPayloadString(obj, "followUpQuestion", "follow_up_question"),
    userTranscript: firstPayloadString(obj, "userTranscript", "user_transcript"),
  };
}

function firstPayloadString(obj: JsonObject | undefined, ...keys: string[]): string {
  for (const key of keys) {
    const value = stringValue(obj?.[key]).trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function dedupeUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const result: vscode.Uri[] = [];
  for (const uri of uris) {
    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(uri);
    }
  }
  return result;
}

function positiveRequestId(value: unknown): number {
  const requestId = positiveScalarNumber(value);
  return requestId !== undefined && Number.isInteger(requestId) ? requestId : 0;
}

function positiveScalarNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : undefined;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
