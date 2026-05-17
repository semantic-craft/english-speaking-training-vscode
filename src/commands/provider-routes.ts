import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { normalizeTtsSpeed, providerLabel, secretKeys } from "../core.js";
import type { KeyAvailability, ProviderName } from "../types.js";
import { refreshAll, runProviderSetupHint } from "../runtime/host.js";
import type { ProviderSettingName } from "../runtime/settings.js";

export async function migrateGeminiModelDefaults(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await migrateProviderSetting(settings, "coachProvider", "minimax", "gemini");
  await migrateProviderSetting(settings, "coachProvider", "kimi", "gemini");
  // DeepSeek was removed as a coach provider; fall existing users back to
  // the default so a now-unrouteable value can't wedge the coach step.
  await migrateProviderSetting(settings, "coachProvider", "deepseek", "gemini");
  await migrateProviderSetting(settings, "audioUnderstandingProvider", "azure", "gemini");
  // NOTE: do not migrate `ttsProvider: minimax`. MiniMax is a currently
  // supported, UI-selectable speech-output provider. Migrating it here ran on
  // every activation and silently reverted a user's deliberate MiniMax TTS
  // choice back to Gemini after each VS Code restart.
  await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-flash", "gemini-3-flash-preview");
  await migrateGeminiSetting(settings, "geminiCoachModel", "gemini-2.5-pro", "gemini-3.1-pro-preview");
  await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-flash", "gemini-3-flash-preview");
  await migrateGeminiSetting(settings, "geminiAudioUnderstandingModel", "gemini-2.5-pro", "gemini-3.1-pro-preview");
  await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview");
  await migrateGeminiSetting(settings, "geminiTtsModel", "gemini-2.5-pro-preview-tts", "gemini-3.1-flash-tts-preview");
  await refreshAll();
}

export async function migrateProviderSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: ProviderSettingName,
  oldDefault: string,
  nextDefault: string,
): Promise<void> {
  const inspection = settings.inspect<string>(setting);
  const targets: Array<[string, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ].filter((entry): entry is [string, vscode.ConfigurationTarget] => entry[0] === oldDefault);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
}

export async function migrateGeminiSetting(
  settings: vscode.WorkspaceConfiguration,
  setting: "geminiCoachModel" | "geminiAudioUnderstandingModel" | "geminiTtsModel",
  oldDefault: string,
  nextDefault: string,
): Promise<void> {
  const inspection = settings.inspect<string>(setting);
  const targets: Array<[string, vscode.ConfigurationTarget]> = [
    [inspection?.workspaceValue, vscode.ConfigurationTarget.Workspace],
    [inspection?.globalValue, vscode.ConfigurationTarget.Global],
  ].filter((entry): entry is [string, vscode.ConfigurationTarget] => entry[0] === oldDefault);
  for (const [, target] of targets) {
    await settings.update(setting, nextDefault, target);
  }
}

export async function apiKeyAvailability(context: vscode.ExtensionContext): Promise<KeyAvailability> {
  return {
    openai: Boolean(await context.secrets.get(secretKeys.openai)),
    gemini: Boolean(await context.secrets.get(secretKeys.gemini)),
    minimax: Boolean(await context.secrets.get(secretKeys.minimax)),
    mimo: Boolean(await context.secrets.get(secretKeys.mimo)),
  };
}

export async function configureApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<void> {
  const label = providerLabel(provider);
  const value = await vscode.window.showInputBox({
    title: `Configure ${label} API Key`,
    prompt: `Paste the ${label} API key. It will be stored in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  await context.secrets.store(secretKeys[provider], value.trim());
  vscode.window.showInformationMessage(`${label} API key saved.`);
  await refreshAll();
}

export async function pickAndConfigureProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const providers: ProviderName[] = ["gemini", "openai", "minimax", "mimo"];
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
  const availability = await apiKeyAvailability(context);
  if (!availability.gemini) {
    await configureApiKey(context, "gemini");
  }
}

export async function clearApiKeys(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage("Clear all English Training API keys from VS Code SecretStorage?", { modal: true }, "Clear");
  if (choice !== "Clear") {
    return;
  }
  await Promise.all(Object.values(secretKeys).map((key) => context.secrets.delete(key)));
  vscode.window.showInformationMessage("English Training API keys cleared.");
  await refreshAll();
}

export async function configureLocalMaterialsRoot(): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this local folder for English Training",
    title: "Choose Local English Training Materials Folder",
  });
  if (!picked || picked.length === 0) {
    return;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  const config = vscode.workspace.getConfiguration("englishTraining");
  await config.update("localMaterialsRoot", root, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`English Training local materials folder set to ${root}.`);
  await refreshAll();
}

export async function setProviderSetting(setting: ProviderSettingName, value: string): Promise<void> {
  await vscode.workspace.getConfiguration("englishTraining").update(setting, value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider set to ${value}.`);
  await refreshAll();
}

export async function setGeminiOnlyProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("coachProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("audioUnderstandingProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("ttsProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("English Training Gemini-only mode enabled: Gemini coach + speech input + speech output.");
  await refreshAll();
}

export async function setRecommendedHybridProviders(): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("coachProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("audioUnderstandingProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  await settings.update("ttsProvider", "gemini", vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage("English Training recommended route enabled: Gemini coach + Gemini speech input + Gemini speech output.");
  await refreshAll();
}

export async function setTtsSpeedConfig(speed: number): Promise<void> {
  const clamped = normalizeTtsSpeed(speed, 0.9);
  await vscode.workspace.getConfiguration("englishTraining").update("ttsSpeed", clamped, vscode.ConfigurationTarget.Workspace);
  await refreshAll();
}

export async function setMinimaxVoiceId(voiceId: string, pinTurbo: boolean): Promise<void> {
  const settings = vscode.workspace.getConfiguration("englishTraining");
  await settings.update("minimaxTtsVoiceId", voiceId, vscode.ConfigurationTarget.Workspace);
  if (pinTurbo) {
    const currentModel = settings.get<string>("minimaxTtsModel") || "speech-2.8-hd";
    if (currentModel !== "speech-2.8-turbo") {
      await settings.update("minimaxTtsModel", "speech-2.8-turbo", vscode.ConfigurationTarget.Workspace);
      vscode.window.showInformationMessage(
        `MiniMax voice set to ${voiceId} (cloned voice — pinned model to speech-2.8-turbo to avoid HD billing).`,
      );
      await refreshAll();
      return;
    }
  }
  vscode.window.showInformationMessage(`MiniMax voice set to ${voiceId}.`);
  await refreshAll();
}

export function providerSettingLabel(setting: ProviderSettingName): string {
  if (setting === "coachProvider") return "coach";
  if (setting === "audioUnderstandingProvider") return "speech input";
  return "speech output";
}
