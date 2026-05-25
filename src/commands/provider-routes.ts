import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  configString,
  isAudioUnderstandingProvider,
  isCoachProvider,
  isTtsProvider,
  normalizedProviderName,
  normalizeTtsSpeed,
  providerLabel,
  secretKeys,
  storedOrEnvApiKey,
  stringValue,
  userConfigurationTarget,
} from "../core.js";
import type { KeyAvailability, ProviderName } from "../types.js";
import { refreshAll, runProviderSetupHint } from "../runtime/host.js";
import type { ProviderSettingName } from "../runtime/settings.js";
import { expandHome } from "../runtime/training-root.js";

export async function migrateGeminiModelDefaults(): Promise<boolean> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  let changed = false;
  changed = (await migrateProviderSetting(settings, "coachProvider", "kimi", "openai")) || changed;
  // DeepSeek was removed as a coach provider; fall existing users back to
  // the current default so a now-unrouteable value can't wedge the coach step.
  changed = (await migrateProviderSetting(settings, "coachProvider", "deepseek", "openai")) || changed;
  changed = (await migrateProviderSetting(settings, "audioUnderstandingProvider", "azure", "openai")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-flash", "gemini-3-flash-preview")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-pro", "gemini-3.1-pro-preview")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-flash", "gemini-3-flash-preview")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-pro", "gemini-3.1-pro-preview")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview")) || changed;
  changed = (await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-pro-preview-tts", "gemini-3.1-flash-tts-preview")) || changed;
  if (changed) {
    await refreshAll();
  }
  return changed;
}

export async function migrateProviderSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: ProviderSettingName,
  oldDefault: string,
  nextDefault: string,
): Promise<boolean> {
  const inspection = settings.inspect<string>(setting);
  const oldDefaultKey = normalizedMigrationValue(oldDefault);
  const candidates: Array<[unknown, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ];
  const targets = candidates.filter((entry) => normalizedMigrationValue(entry[0]) === oldDefaultKey);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
  return targets.length > 0;
}

export async function migrateGeminiSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: "geminiCoachModel" | "geminiAudioUnderstandingModel" | "geminiTtsModel",
  oldDefault: string,
  nextDefault: string,
): Promise<boolean> {
  const inspection = settings.inspect<string>(setting);
  const oldDefaultKey = normalizedMigrationValue(oldDefault);
  const candidates: Array<[unknown, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ];
  const targets = candidates.filter((entry) => normalizedMigrationValue(entry[0]) === oldDefaultKey);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
  return targets.length > 0;
}

function normalizedMigrationValue(value: unknown): string {
  return stringValue(value).trim().toLowerCase();
}

export async function apiKeyAvailability(context: vscode.ExtensionContext): Promise<KeyAvailability> {
  return {
    openai: Boolean((await context.secrets.get(secretKeys.openai) || "").trim()),
    gemini: Boolean((await context.secrets.get(secretKeys.gemini) || "").trim()),
    qwen: Boolean(storedOrEnvApiKey(await context.secrets.get(secretKeys.qwen), "qwen")),
    mimo: Boolean((await context.secrets.get(secretKeys.mimo) || "").trim()),
  };
}

export async function configureApiKey(
  context: vscode.ExtensionContext,
  provider: ProviderName,
  options: { refresh?: boolean } = {},
): Promise<boolean> {
  const label = providerLabel(provider);
  const value = await vscode.window.showInputBox({
    title: `Configure ${label} API Key`,
    prompt: `Paste the ${label} API key. It will be stored in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (value === undefined) {
    return false;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    vscode.window.showWarningMessage(`${label} API key was empty; nothing was saved.`);
    return false;
  }
  if (((await context.secrets.get(secretKeys[provider])) || "").trim() === trimmed) {
    vscode.window.showInformationMessage(`${label} API key is already saved.`);
    return true;
  }
  await context.secrets.store(secretKeys[provider], trimmed);
  vscode.window.showInformationMessage(`${label} API key saved.`);
  if (options.refresh !== false) {
    await refreshAll();
  }
  return true;
}

export async function pickAndConfigureProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const providers: ProviderName[] = ["openai", "gemini", "qwen", "mimo"];
  const availability = await apiKeyAvailability(context);
  const items: (vscode.QuickPickItem & { provider: ProviderName })[] = providers.map((provider) => ({
    provider,
    label: providerLabel(provider),
    description: availability[provider] ? "saved" : "not set",
    detail: runProviderSetupHint(provider),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Set up an AI provider key",
    placeHolder: "Pick a provider to configure (you only need one to start)",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await configureApiKey(context, picked.provider);
}

export async function configureCoreRouteKeys(context: vscode.ExtensionContext): Promise<void> {
  const providers = activeRouteProviders();
  const availability = await apiKeyAvailability(context);
  const missing = providers.filter((provider) => !availability[provider]);
  if (missing.length === 0) {
    vscode.window.showInformationMessage("English Training active route API keys are already saved.");
    return;
  }
  let savedAny = false;
  for (const provider of missing) {
    const saved = await configureApiKey(context, provider, { refresh: false });
    if (!saved) {
      if (savedAny) {
        await refreshAll();
      }
      return;
    }
    savedAny = true;
  }
  if (savedAny) {
    await refreshAll();
  }
}

export function activeRouteProviders(
  settings = vscode.workspace.getConfiguration("englishTraining"),
): ProviderName[] {
  const values: ProviderName[] = [
    normalizeProviderForSetting("coachProvider", settings.get<string>("coachProvider")),
    normalizeProviderForSetting("audioUnderstandingProvider", settings.get<string>("audioUnderstandingProvider")),
    normalizeProviderForSetting("ttsProvider", settings.get<string>("ttsProvider")),
  ];
  return Array.from(new Set(values));
}

export function normalizeProviderForSetting(
  setting: ProviderSettingName,
  raw: unknown,
): ProviderName {
  const provider = normalizedProviderName(raw);
  if (setting === "coachProvider") {
    return isCoachProvider(provider) ? provider : "openai";
  }
  if (setting === "audioUnderstandingProvider") {
    return isAudioUnderstandingProvider(provider) ? provider : "openai";
  }
  return isTtsProvider(provider) ? provider : "openai";
}

export async function clearApiKeys(context: vscode.ExtensionContext): Promise<void> {
  const availability = await apiKeyAvailability(context);
  if (!Object.values(availability).some(Boolean)) {
    vscode.window.showInformationMessage("No English Training API keys are saved.");
    return;
  }
  const choice = await vscode.window.showWarningMessage("Clear all English Training API keys from VS Code SecretStorage?", { modal: true }, "Clear");
  if (choice !== "Clear") {
    return;
  }
  await Promise.all(Object.values(secretKeys).map((key) => context.secrets.delete(key)));
  vscode.window.showInformationMessage("English Training API keys cleared.");
  await refreshAll();
}

export async function configureLocalMaterialsRoot(options: { onChanged?: () => void } = {}): Promise<boolean> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this local folder for English Training",
    title: "Choose Local English Training Materials Folder",
  });
  if (!picked || picked.length === 0) {
    return false;
  }
  const root = picked[0].fsPath;
  const prebuiltDir = path.join(root, "prebuilt");
  const progressDir = path.join(root, "progress");
  const hadScaffold = fs.existsSync(prebuiltDir) && fs.existsSync(progressDir);
  fs.mkdirSync(prebuiltDir, { recursive: true });
  fs.mkdirSync(progressDir, { recursive: true });
  const config = vscode.workspace.getConfiguration("englishTraining");
  const configuredRoot = configString("localMaterialsRoot");
  const sameRoot = Boolean(configuredRoot) && path.resolve(expandHome(configuredRoot)) === path.resolve(root);
  if (sameRoot && hadScaffold) {
    vscode.window.showInformationMessage(`English Training local materials folder is already ${root}.`);
    return false;
  }
  if (!sameRoot) {
    await updateLocalMaterialsRootSetting(config, root);
  }
  options.onChanged?.();
  vscode.window.showInformationMessage(
    sameRoot
      ? `English Training local materials folder is already ${root}; created missing prebuilt/progress folders.`
      : `English Training local materials folder set to ${root}.`,
  );
  await refreshAll();
  return true;
}

export async function setProviderSetting(setting: ProviderSettingName, value: unknown): Promise<void> {
  const provider = normalizedProviderName(value);
  if (!provider || !isValidProviderForSetting(setting, provider)) {
    const display = provider ?? stringValue(value).trim();
    vscode.window.showWarningMessage(
      `English Training ${providerSettingLabel(setting)} provider cannot use ${display || "(missing)"}.`,
    );
    return;
  }
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const currentRaw = settings.get<string>(setting);
  const current = normalizeProviderForSetting(setting, currentRaw);
  const currentIsCanonical = stringValue(currentRaw).trim() === provider;
  if (current === provider && currentIsCanonical) {
    vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider is already ${provider}.`);
    return;
  }
  await settings.update(setting, provider, userConfigurationTarget());
  vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider set to ${provider}.`);
  await refreshAll();
}

function isValidProviderForSetting(setting: ProviderSettingName, provider: string): provider is ProviderName {
  if (setting === "coachProvider") {
    return isCoachProvider(provider);
  }
  if (setting === "audioUnderstandingProvider") {
    return isAudioUnderstandingProvider(provider);
  }
  return isTtsProvider(provider);
}

export async function setOpenAIRealtimeSpeechInput(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  let changed = false;
  changed = (await updateUserSettingIfChanged(settings, "audioUnderstandingProvider", "openai")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "openaiTranscriptionMode", "realtime")) || changed;
  if (!changed) {
    vscode.window.showInformationMessage("English Training OpenAI Realtime speech input is already enabled.");
    return;
  }
  vscode.window.showInformationMessage("English Training OpenAI Realtime speech input enabled.");
  await refreshAll();
}

export async function setGeminiOnlyProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  let changed = false;
  changed = (await updateUserSettingIfChanged(settings, "coachProvider", "gemini")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "audioUnderstandingProvider", "gemini")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "ttsProvider", "gemini")) || changed;
  if (!changed) {
    vscode.window.showInformationMessage("English Training Gemini-only mode is already enabled.");
    return;
  }
  vscode.window.showInformationMessage("English Training Gemini-only mode enabled: Gemini coach + speech input + speech output.");
  await refreshAll();
}

export async function setOpenAIStackProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  let changed = false;
  changed = (await updateUserSettingIfChanged(settings, "coachProvider", "openai")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "audioUnderstandingProvider", "openai")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "ttsProvider", "openai")) || changed;
  // file mode benefits from the domain prompt and is more accurate for
  // bounded recordings; users can switch back to realtime in settings.
  changed = (await updateUserSettingIfChanged(settings, "openaiTranscriptionMode", "file")) || changed;
  if (!changed) {
    vscode.window.showInformationMessage("English Training OpenAI stack is already enabled.");
    return;
  }
  vscode.window.showInformationMessage(
    "English Training OpenAI stack enabled: coach (gpt-4o) + transcribe (gpt-4o-transcribe, domain prompt) + TTS (gpt-4o-mini-tts, marin, coach-driven style).",
  );
  await refreshAll();
}

export async function setQwenStackProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  let changed = false;
  changed = (await updateUserSettingIfChanged(settings, "coachProvider", "qwen")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "audioUnderstandingProvider", "qwen")) || changed;
  changed = (await updateUserSettingIfChanged(settings, "ttsProvider", "qwen")) || changed;
  if (!changed) {
    vscode.window.showInformationMessage("English Training Qwen stack is already enabled.");
    return;
  }
  vscode.window.showInformationMessage(
    "English Training Qwen stack enabled: Qwen coach + Qwen-ASR speech input + Qwen-TTS speech output.",
  );
  await refreshAll();
}

export async function setTtsSpeedConfig(speed: unknown): Promise<void> {
  const parsedSpeed = parseTtsSpeedInput(speed);
  if (parsedSpeed === undefined) {
    vscode.window.showWarningMessage("English Training TTS speed must be a positive number.");
    return;
  }
  const clamped = normalizeTtsSpeed(parsedSpeed, 0.9);
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const rawCurrent = settings.get<unknown>("ttsSpeed");
  const current = normalizeTtsSpeed(rawCurrent, 0.9);
  const currentIsCanonical = typeof rawCurrent === "number" && rawCurrent === clamped;
  if (current === clamped && currentIsCanonical) {
    vscode.window.showInformationMessage(`English Training TTS speed is already ${clamped}.`);
    return;
  }
  await settings.update("ttsSpeed", clamped, userConfigurationTarget());
  vscode.window.showInformationMessage(`English Training TTS speed set to ${clamped}.`);
  await refreshAll();
}

function parseTtsSpeedInput(speed: unknown): number | undefined {
  const parsed =
    typeof speed === "number"
      ? speed
      : typeof speed === "string" && speed.trim()
        ? Number(speed)
        : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

export async function setQwenTtsVoice(voiceId: unknown): Promise<void> {
  const trimmedVoiceId = stringValue(voiceId).trim();
  if (!trimmedVoiceId) {
    vscode.window.showWarningMessage("Qwen-TTS voice cannot be empty.");
    return;
  }
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const currentVoice = configString("qwenTtsVoice", "Cherry");
  if (currentVoice === trimmedVoiceId) {
    vscode.window.showInformationMessage(`Qwen-TTS voice is already ${trimmedVoiceId}.`);
    return;
  }
  await settings.update("qwenTtsVoice", trimmedVoiceId, userConfigurationTarget());
  vscode.window.showInformationMessage(`Qwen-TTS voice set to ${trimmedVoiceId}.`);
  await refreshAll();
}

export function providerSettingLabel(setting: ProviderSettingName): string {
  if (setting === "coachProvider") return "coach";
  if (setting === "audioUnderstandingProvider") return "speech input";
  return "speech output";
}

async function updateUserSettingIfChanged<T>(
  settings: vscode.WorkspaceConfiguration,
  setting: string,
  value: T,
): Promise<boolean> {
  if (settings.get<T>(setting) === value) {
    return false;
  }
  await settings.update(setting, value, userConfigurationTarget());
  return true;
}

export async function updateLocalMaterialsRootSetting(
  settings: vscode.WorkspaceConfiguration,
  root: string,
): Promise<vscode.ConfigurationTarget> {
  const inspection = settings.inspect<string>("localMaterialsRoot");
  const target = inspection?.workspaceValue !== undefined
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await settings.update("localMaterialsRoot", root, target);
  return target;
}
