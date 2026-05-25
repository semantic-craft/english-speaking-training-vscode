import { Blob } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import type {
  ActiveMaterialsSource,
  AvfoundationAudioDevice,
  CoachPriorTurn,
  CommandResult,
  JsonObject,
  KeyAvailability,
  LearnerProfile,
  NativeRecordingSession,
  PracticeResult,
  PracticeStage,
  PracticeTarget,
  ProgressCell,
  ProgressSnapshot,
  ProviderName,
  SourceDiagnostics,
  StageReporter,
  StageStatus,
  TrainingState,
  WebviewAudioMessage,
} from "./types.js";
import {
  appendOutput,
  arrayOfStrings,
  chatCompletionsUrl,
  config,
  configString,
  errorMessage,
  expandHomePath,
  extractGeminiText,
  extractOpenAIText,
  fetchWithTimeout,
  getRequiredKey,
  isAudioUnderstandingProvider,
  isCoachProvider,
  isProviderName,
  isTtsProvider,
  MIMO_ANTHROPIC_BASE_URL,
  normalizeTtsSpeed,
  parseLooseJson,
  parseFirstJson,
  parseJsonObject,
  providerLabel,
  readJson,
  readJsonDiagnosed,
  resolveFfmpegPath,
  secretKeys,
  setOutputChannel,
  showOutput,
  stamp,
  stringValue,
  userConfigurationTarget,
  writeJson,
} from "./core.js";
import {
  extensionFromMime,
  extractMimoTranscript,
  extractOpenAIFileTranscript,
  prepareInlineAudio,
  resolveAudioUnderstandingProvider,
} from "./practice/transcribe.js";
import {
  decodeBase64AudioData,
  ensureNonEmptyAudioData,
  extractGeminiInlineAudio,
  extractMimoTtsAudioData,
  extractQwenTtsAudioData,
  mimeTypeForAudioPath,
  normalizeSpeechOutputProvider,
  resolveOpenAITtsVoice,
  speechOutputExtension,
  synthesizeWithConfiguredTts,
} from "./practice/tts.js";
import {
  buildTranscriptionPrompt,
  createSessionDir,
  drillExamplesFromState,
  firstNonBlankString,
  nextDrillFromState,
  normalizeDrillExamples,
  processPracticeFile,
  readRecentSessionLog,
  splitPracticeText,
  appendSessionLog,
  writePracticeArtifacts,
  writeTextArtifact,
} from "./practice/pipeline.js";
import {
  coachingUserPrompt,
  drillGenUserPrompt,
  generateDrillLines as coachGenerateDrillLines,
} from "./practice/coach.js";
import { buildPracticeHtml } from "./webview/html.js";
import { openMaterialsGuide } from "./materials-guide.js";
import {
  clearRefreshHandlers,
  refreshAll,
  registerConfigureSetting,
  registerProviderSetupHint,
  registerRefreshHandler,
} from "./runtime/host.js";
import {
  type ConfigSettingName,
  type ProviderSettingName,
  isConfigSettingName,
  normalizedCoachProvider,
  normalizedGeminiTtsVoice,
  normalizedMimoTtsVoice,
  normalizedOpenAITranscriptionMode,
  normalizedOpenAITtsResponseFormat,
  normalizedOpenAITtsVoice,
  normalizedQwenTtsEndpoint,
  normalizedQwenTtsLanguageType,
  normalizedQwenTtsModel,
  normalizedQwenTtsVoice,
  normalizedRecorderBackend,
  normalizedSpeechInputProvider,
  normalizedTtsProvider,
  pythonPath,
  trainingSettings,
} from "./runtime/settings.js";
import {
  apiKeyAvailability,
  activeRouteProviders,
  clearApiKeys,
  configureApiKey,
  configureCoreRouteKeys,
  configureLocalMaterialsRoot,
  migrateGeminiSetting,
  migrateGeminiModelDefaults,
  migrateProviderSetting,
  normalizeProviderForSetting,
  setGeminiOnlyProviders,
  setOpenAIRealtimeSpeechInput,
  setOpenAIStackProviders,
  setProviderSetting,
  setQwenTtsVoice,
  setRecommendedHybridProviders,
  setTtsSpeedConfig,
} from "./commands/provider-routes.js";
import {
  completeLocalPackage,
  existingDirectoryPath,
  existingFilePath,
  microphoneQuickPickItems,
  openCurrentTaskCard,
  openSessionFolder,
  revealCurrentPackage,
  selectRecordingMicrophone,
} from "./commands/local-actions.js";
import {
  dateRangeLabel,
  completedPackageDates,
  execFile,
  expandHome,
  findTrainingRoot,
  isHttpUrl,
  isPackageDate,
  listPrebuiltPackageDates,
  looksLikeTrainingRoot,
  readLocalInventory,
  todayInConfiguredTimezone,
} from "./runtime/training-root.js";
import { loadLocalLearnerProfile } from "./runtime/learner-profile.js";
import {
  buildProgressSnapshot,
  buildLocalSourceDiagnostics,
  invalidateNextPackageCache,
  loadDrillPlan,
  loadState,
  packageAssets,
  resolveNextPackage,
  todayExampleText,
  toWebviewState,
} from "./runtime/state.js";
import {
  chooseLocalAvfoundationAudioDevice,
  invalidateResolvedAudioDevice,
  killActiveNativeRecording,
  listAvfoundationAudioDevices,
  parseAvfoundationAudioDevices,
  resolveNativeFfmpegAudioDevice,
  resolveRecordingSampleRate,
  startNativeFfmpegRecording,
  stopNativeFfmpegRecording,
} from "./audio/native-recording.js";
import { synthesizeOnDemandText, synthesizeTodayAudio } from "./audio/synthesis.js";
import { sampleFollowupDrillPackage, sampleTrainingPackage } from "./materials/sample-package.js";
import { createSamplePackage, generateNextPackage, validateLessonDateInput } from "./materials/scaffold.js";
import { composeMaterialPrompt } from "./materials/prompt-composer.js";
import { compactStatusValue, StatusProvider } from "./status/status-tree.js";
import {
  decodeWebviewAudioBase64,
  PracticeViewProvider,
  normalizePracticeTargetPayload,
  processPracticeAudio,
} from "./webview/practice-view.js";
import {
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
  CARD_SCHEMA_VERSION,
  cardSchemaContractJson,
} from "./card-schema.js";

let statusProvider: StatusProvider;
let practiceProvider: PracticeViewProvider;

const GEMINI_TEXT_MODEL_OPTIONS = [
  "gemini-3-flash-preview",
  "gemini-3.1-pro-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-flash-lite-preview",
];

const GEMINI_TTS_MODEL_OPTIONS = [
  "gemini-3.1-flash-tts-preview",
];

const QWEN_TTS_MODEL_OPTIONS = [
  "qwen3-tts-flash",
  "qwen3-tts-instruct-flash",
];

const QWEN_TTS_VOICE_OPTIONS = [
  "Cherry",
  "Serena",
  "Ethan",
  "Chelsie",
  "Momo",
  "Vivian",
  "Moon",
  "Maia",
];

const QWEN_TTS_LANGUAGE_TYPE_OPTIONS = [
  "Auto",
  "Chinese",
  "English",
  "German",
];

const QWEN_TTS_ENDPOINT_OPTIONS = [
  "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
  "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
];

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("English Training");
  setOutputChannel(output);
  statusProvider = new StatusProvider(context);
  practiceProvider = new PracticeViewProvider(context);

  clearRefreshHandlers();
  registerRefreshHandler(() => statusProvider.refresh());
  registerRefreshHandler(() => practiceProvider.postState());
  registerConfigureSetting((s) => configureSetting(s as ConfigSettingName));
  registerProviderSetupHint((provider) => providerSetupHint(provider as ProviderName));

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("englishTraining.status", statusProvider));
  // retainContextWhenHidden: the practice cockpit holds the whole live
  // session in webview JS memory (turn history, last coaching, generated
  // drill lines, armed reply/shadow context) and persists none of it via
  // vscode.setState. Without this, collapsing the view or clicking another
  // sidebar item tears the webview down and silently wipes an in-progress
  // session; it also strands a running native ffmpeg recorder whose only
  // stop hook is onDidDispose (which does not fire on hide), bricking the
  // recorder ("already running") on return. Keeping the context costs some
  // memory while hidden — the right trade for a practice session.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("englishTraining.practice", practiceProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(
      command,
      (...args: unknown[]) => runCommandTask(command, () => callback(...args)),
    ));
  };

  register("englishTraining.openPractice", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.englishTraining");
    await vscode.commands.executeCommand("englishTraining.practice.focus");
  });
  register("englishTraining.refresh", async () => {
    // Explicit user refresh must re-detect externally-changed packages or
    // completion, so drop the memoized next-package before re-resolving.
    invalidateNextPackageCache();
    await refreshAll();
  });
  register("englishTraining.configureLocalMaterials", async () => {
    await configureLocalMaterialsRoot({ onChanged: invalidateNextPackageCache });
  });
  register("englishTraining.configureOpenAIKey", async () => {
    await configureApiKey(context, "openai");
  });
  register("englishTraining.configureGeminiKey", async () => {
    await configureApiKey(context, "gemini");
  });
  register("englishTraining.configureDashScopeKey", async () => {
    await configureApiKey(context, "qwen");
  });
  register("englishTraining.configureMimoKey", async () => {
    await configureApiKey(context, "mimo");
  });
  register("englishTraining.clearApiKeys", async () => {
    await clearApiKeys(context);
  });
  register("englishTraining.useGeminiCoach", async () => {
    await setProviderSetting("coachProvider", "gemini");
  });
  register("englishTraining.useMimoCoach", async () => {
    await setProviderSetting("coachProvider", "mimo");
  });
  register("englishTraining.useOpenAICoach", async () => {
    await setProviderSetting("coachProvider", "openai");
  });
  register("englishTraining.useOpenAIRealtimeAudioUnderstanding", async () => {
    await setOpenAIRealtimeSpeechInput();
  });
  register("englishTraining.useQwenTts", async () => {
    await setProviderSetting("ttsProvider", "qwen");
  });
  register("englishTraining.useOpenAITts", async () => {
    await setProviderSetting("ttsProvider", "openai");
  });
  register("englishTraining.useGeminiTts", async () => {
    await setProviderSetting("ttsProvider", "gemini");
  });
  register("englishTraining.useGeminiOnly", async () => {
    await setGeminiOnlyProviders();
  });
  register("englishTraining.useRecommendedHybrid", async () => {
    await setRecommendedHybridProviders();
  });
  register("englishTraining.useOpenAIStack", async () => {
    await setOpenAIStackProviders();
  });
  register("englishTraining.completeLocal", async () => {
    await completeLocalPackage(context);
  });
  register("englishTraining.openTaskCard", async () => {
    await openCurrentTaskCard(context);
  });
  register("englishTraining.revealPackage", async () => {
    await revealCurrentPackage(context);
  });
  register("englishTraining.openSessionFolder", async () => {
    await openSessionFolder(context);
  });
  register("englishTraining.createSamplePackage", async () => {
    await createSamplePackage(context);
  });
  register("englishTraining.generateNextPackage", async () => {
    await generateNextPackage(context);
  });
  register("englishTraining.composeMaterialPrompt", async () => {
    await composeMaterialPrompt(context);
  });
  register("englishTraining.openMaterialsGuide", async () => {
    await openMaterialsGuide();
  });
  register("englishTraining.selectMicrophone", async () => {
    await selectRecordingMicrophone();
  });

  runStartupTask("initial refresh", refreshAll);
  runStartupTask("provider/model migration", migrateGeminiModelDefaults);
}

export function deactivate(): void {
  killActiveNativeRecording();
}

export function runStartupTask(label: string, task: () => Promise<unknown>): void {
  void task().catch((error) => {
    appendOutput(`English Training startup task failed (${label}): ${errorMessage(error)}`);
  });
}

export async function runCommandTask(label: string, task: () => unknown): Promise<unknown | undefined> {
  try {
    return await task();
  } catch (error) {
    const message = errorMessage(error);
    appendOutput(`English Training command failed (${label}): ${message}`);
    void vscode.window.showErrorMessage(`English Training: ${message}`);
    return undefined;
  }
}

export const __test__ = {
  activeRouteProviders,
  apiKeyAvailability,
  appendSessionLog,
  arrayOfStrings,
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
  buildTranscriptionPrompt,
  buildProgressSnapshot,
  buildLocalSourceDiagnostics,
  CARD_SCHEMA_VERSION,
  cardSchemaContractJson,
  chatCompletionsUrl,
  chooseLocalAvfoundationAudioDevice,
  coachingUserPrompt,
  configString,
  compactStatusValue,
  clearApiKeys,
  clearRefreshHandlers,
  completedPackageDates,
  configureSetting,
  composeMaterialPrompt,
  completeLocalPackage,
  configureApiKey,
  configureCoreRouteKeys,
  configureLocalMaterialsRoot,
  createSamplePackage,
  dateRangeLabel,
  decodeBase64AudioData,
  decodeWebviewAudioBase64,
  drillExamplesFromState,
  drillGenUserPrompt,
  ensureNonEmptyAudioData,
  existingDirectoryPath,
  existingFilePath,
  expandHome,
  expandHomePath,
  extensionFromMime,
  extractGeminiText,
  extractOpenAIText,
  extractGeminiInlineAudio,
  errorMessage,
  extractMimoTranscript,
  extractMimoTtsAudioData,
  extractQwenTtsAudioData,
  extractOpenAIFileTranscript,
  fetchWithTimeout,
  firstNonBlankString,
  findTrainingRoot,
  generateNextPackage,
  getRequiredKey,
  invalidateNextPackageCache,
  invalidateResolvedAudioDevice,
  killActiveNativeRecording,
  isPackageDate,
  isHttpUrl,
  listAvfoundationAudioDevices,
  listPrebuiltPackageDates,
  loadLocalLearnerProfile,
  loadDrillPlan,
  looksLikeTrainingRoot,
  mimeTypeForAudioPath,
  migrateGeminiSetting,
  migrateProviderSetting,
  microphoneQuickPickItems,
  normalizedCoachProvider,
  normalizedGeminiTtsVoice,
  normalizedMimoTtsVoice,
  normalizedOpenAITranscriptionMode,
  normalizedOpenAITtsResponseFormat,
  normalizedOpenAITtsVoice,
  normalizedQwenTtsEndpoint,
  normalizedQwenTtsLanguageType,
  normalizedQwenTtsModel,
  normalizedQwenTtsVoice,
  normalizedRecorderBackend,
  normalizedSpeechInputProvider,
  normalizedTtsProvider,
  nextDrillFromState,
  normalizeProviderForSetting,
  normalizeSpeechOutputProvider,
  normalizePracticeTargetPayload,
  normalizeDrillExamples,
  normalizeTtsSpeed,
  openCurrentTaskCard,
  openSessionFolder,
  packageAssets,
  parseAvfoundationAudioDevices,
  parseFirstJson,
  parseJsonObject,
  parseLooseJson,
  prepareInlineAudio,
  PracticeViewProvider,
  processPracticeAudio,
  pythonPath,
  readJson,
  readJsonDiagnosed,
  readLocalInventory,
  readRecentSessionLog,
  refreshAll,
  registerRefreshHandler,
  revealCurrentPackage,
  resolveAudioUnderstandingProvider,
  resolveNativeFfmpegAudioDevice,
  resolveFfmpegPath,
  resolveNextPackage,
  resolveOpenAITtsVoice,
  resolveRecordingSampleRate,
  runCommandTask,
  runStartupTask,
  selectRecordingMicrophone,
  setOpenAIRealtimeSpeechInput,
  setProviderSetting,
  setQwenTtsVoice,
  setTtsSpeedConfig,
  setOpenAIStackProviders,
  speechOutputExtension,
  startNativeFfmpegRecording,
  StatusProvider,
  stopNativeFfmpegRecording,
  synthesizeWithConfiguredTts,
  todayExampleText,
  trainingSettings,
  toWebviewState,
  validateLessonDateInput,
  writePracticeArtifacts,
  writeTextArtifact,
};

async function configureSetting(setting: ConfigSettingName): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const rawCurrent = stringValue(settings.get(setting));
  const current = configSettingEffectiveValue(setting, rawCurrent.trim());
  const options = configSettingOptions(setting);
  let nextValue: string | undefined;

  if (options.length) {
    const items: (vscode.QuickPickItem & { value?: string; custom?: boolean })[] = options.map((value) => ({
      label: value,
      value,
      description: value === current ? "current" : undefined,
    }));
    if (configSettingAllowsCustom(setting)) {
      items.push({
        label: "Custom...",
        description: current ? `current: ${current}` : undefined,
        custom: true,
      });
    }
    const picked = await vscode.window.showQuickPick(items, {
      title: `Set ${configSettingLabel(setting)}`,
      placeHolder: current || "Pick a value",
      ignoreFocusOut: true,
    });
    if (!picked) {
      return;
    }
    nextValue = picked.custom
      ? await promptForConfigValue(setting, current)
      : picked.value ?? picked.label;
  } else {
    nextValue = await promptForConfigValue(setting, current);
  }

  if (nextValue === undefined) {
    return;
  }
  const trimmed = stringValue(nextValue).trim();
  const allowBlank = configSettingAllowsBlank(setting);
  if (!trimmed && !allowBlank) {
    vscode.window.showWarningMessage(`English Training ${configSettingLabel(setting)} cannot be empty.`);
    return;
  }
  if (trimmed === current && rawCurrent === trimmed) {
    vscode.window.showInformationMessage(
      trimmed
        ? `English Training ${configSettingLabel(setting)} is already ${current}.`
        : `English Training ${configSettingLabel(setting)} is already blank.`,
    );
    return;
  }
  await settings.update(setting, trimmed, userConfigurationTarget());
  vscode.window.showInformationMessage(
    trimmed
      ? `English Training ${configSettingLabel(setting)} set to ${trimmed}.`
      : `English Training ${configSettingLabel(setting)} cleared.`,
  );
  await refreshAll();
}

function configSettingEffectiveValue(setting: ConfigSettingName, fallback: string): string {
  const settings = trainingSettings();
  switch (setting) {
    case "mimoCoachModel": return settings.mimoCoachModel;
    case "openaiRealtimeTranscriptionModel": return settings.openaiRealtimeTranscriptionModel;
    case "openaiFileTranscriptionModel": return settings.openaiFileTranscriptionModel;
    case "openaiCoachModel": return settings.openaiCoachModel;
    case "geminiCoachModel": return settings.geminiCoachModel;
    case "geminiAudioUnderstandingModel": return settings.geminiAudioUnderstandingModel;
    case "mimoAudioUnderstandingModel": return settings.mimoAudioUnderstandingModel;
    case "qwenTtsEndpoint": return normalizedQwenTtsEndpoint();
    case "qwenTtsModel": return normalizedQwenTtsModel();
    case "qwenTtsVoice": return normalizedQwenTtsVoice();
    case "qwenTtsLanguageType": return normalizedQwenTtsLanguageType();
    case "qwenTtsInstructions": return settings.qwenTtsInstructions;
    case "mimoTtsModel": return settings.mimoTtsModel;
    case "openaiTtsModel": return settings.openaiTtsModel;
    case "geminiTtsModel": return settings.geminiTtsModel;
    case "openaiTranscriptionMode": return normalizedOpenAITranscriptionMode();
    case "openaiTtsResponseFormat": return normalizedOpenAITtsResponseFormat();
    case "recorderBackend": return normalizedRecorderBackend();
    case "openaiTtsVoice": return normalizedOpenAITtsVoice();
    case "geminiTtsVoice": return normalizedGeminiTtsVoice();
    case "mimoTtsVoice": return normalizedMimoTtsVoice();
    default: return fallback;
  }
}

function configSettingAllowsBlank(setting: ConfigSettingName): boolean {
  return setting === "openaiTtsInstructions" || setting === "qwenTtsInstructions";
}

function configSettingAllowsCustom(setting: ConfigSettingName): boolean {
  return (
    setting !== "openaiTranscriptionMode" &&
    setting !== "openaiTtsResponseFormat" &&
    setting !== "recorderBackend" &&
    setting !== "qwenTtsEndpoint" &&
    setting !== "qwenTtsModel" &&
    setting !== "qwenTtsVoice" &&
    setting !== "qwenTtsLanguageType" &&
    setting !== "openaiTtsVoice" &&
    setting !== "geminiTtsVoice" &&
    setting !== "mimoTtsVoice"
  );
}

async function promptForConfigValue(setting: ConfigSettingName, current: string): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Set ${configSettingLabel(setting)}`,
    prompt: configSettingPrompt(setting),
    value: current,
    ignoreFocusOut: true,
  });
}

function configSettingLabel(setting: ConfigSettingName): string {
  switch (setting) {
    case "mimoCoachModel": return "MiMo coach model";
    case "openaiTranscriptionMode": return "OpenAI speech-input mode";
    case "openaiRealtimeTranscriptionModel": return "OpenAI Realtime speech-input model";
    case "openaiFileTranscriptionModel": return "OpenAI file speech-input model";
    case "openaiCoachModel": return "OpenAI coach model";
    case "geminiCoachModel": return "Gemini coach model";
    case "geminiAudioUnderstandingModel": return "Gemini speech-input model";
    case "mimoAudioUnderstandingModel": return "MiMo speech-input model";
    case "qwenTtsEndpoint": return "Qwen-TTS endpoint";
    case "qwenTtsModel": return "Qwen-TTS model";
    case "qwenTtsVoice": return "Qwen-TTS voice";
    case "qwenTtsLanguageType": return "Qwen-TTS language";
    case "qwenTtsInstructions": return "Qwen-TTS style";
    case "mimoTtsModel": return "MiMo speech-output model";
    case "mimoTtsVoice": return "MiMo voice";
    case "openaiTtsModel": return "OpenAI speech-output model";
    case "openaiTtsVoice": return "OpenAI voice";
    case "openaiTtsInstructions": return "OpenAI speech style";
    case "openaiTtsResponseFormat": return "OpenAI audio format";
    case "recorderBackend": return "recording backend";
    case "geminiTtsModel": return "Gemini speech-output model";
    case "geminiTtsVoice": return "Gemini voice";
  }
}

function configSettingPrompt(setting: ConfigSettingName): string {
  switch (setting) {
    case "openaiRealtimeTranscriptionModel": return "OpenAI Realtime transcription model id.";
    case "openaiTranscriptionMode": return "Choose file for accurate bounded recordings or realtime for low-latency transcription.";
    case "openaiTtsVoice": return "OpenAI TTS voice name.";
    case "openaiTtsInstructions": return "Optional OpenAI TTS instructions. Leave blank to let the coach choose per turn.";
    case "openaiTtsResponseFormat": return "OpenAI TTS audio container.";
    case "qwenTtsEndpoint": return "DashScope Qwen-TTS endpoint.";
    case "qwenTtsVoice": return "Qwen-TTS voice name.";
    case "qwenTtsLanguageType": return "Qwen-TTS language_type: Auto, Chinese, English, or German.";
    case "qwenTtsInstructions": return "Optional Qwen-TTS speaking instructions. Sent only to qwen3-tts-instruct-flash.";
    case "recorderBackend": return "Choose macLocal for ffmpeg/AVFoundation, webview for VS Code MediaRecorder, or auto for webview fallback.";
    case "geminiTtsVoice": return "Gemini prebuilt voice name.";
    case "mimoTtsVoice": return "MiMo built-in voice name.";
    default: return "Model id used by this provider.";
  }
}

function configSettingOptions(setting: ConfigSettingName): string[] {
  switch (setting) {
    case "mimoCoachModel": return ["mimo-v2.5-pro", "mimo-v2.5-flash"];
    case "openaiTranscriptionMode": return ["file", "realtime"];
    case "openaiRealtimeTranscriptionModel": return ["gpt-realtime-whisper"];
    case "openaiFileTranscriptionModel": return ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "gpt-4o-transcribe-diarize", "whisper-1"];
    case "openaiCoachModel": return ["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini"];
    case "geminiCoachModel": return GEMINI_TEXT_MODEL_OPTIONS;
    case "geminiAudioUnderstandingModel": return GEMINI_TEXT_MODEL_OPTIONS;
    case "mimoAudioUnderstandingModel": return ["mimo-v2.5", "mimo-v2-omni"];
    case "qwenTtsEndpoint": return QWEN_TTS_ENDPOINT_OPTIONS;
    case "qwenTtsModel": return QWEN_TTS_MODEL_OPTIONS;
    case "qwenTtsVoice": return QWEN_TTS_VOICE_OPTIONS;
    case "qwenTtsLanguageType": return QWEN_TTS_LANGUAGE_TYPE_OPTIONS;
    case "qwenTtsInstructions": return [];
    case "mimoTtsModel": return ["mimo-v2.5-tts"];
    case "mimoTtsVoice": return ["Mia", "Chloe", "Milo", "Dean", "mimo_default"];
    case "openaiTtsInstructions": return [];
    case "openaiTtsModel": return ["gpt-4o-mini-tts", "tts-1", "tts-1-hd"];
    case "openaiTtsVoice": return ["marin", "cedar", "coral", "alloy", "ash", "ballad", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse"];
    case "openaiTtsResponseFormat": return ["wav", "mp3", "opus", "aac", "flac", "pcm"];
    case "recorderBackend": return ["macLocal", "webview", "auto"];
    case "geminiTtsModel": return GEMINI_TTS_MODEL_OPTIONS;
    case "geminiTtsVoice": return ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"];
  }
}

function providerSetupHint(provider: ProviderName): string {
  switch (provider) {
    case "gemini": return "Gemini · alternate coach + speech input + native-version TTS";
    case "qwen": return "Qwen-TTS · DashScope speech-output provider";
    case "mimo": return "Xiaomi MiMo · coach + speech input + speech-output (Token Plan)";
    case "openai": return "OpenAI · default coach + file/realtime speech input + TTS";
  }
}
