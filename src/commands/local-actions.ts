import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { appendOutput, errorMessage, expandHomePath, resolveFfmpegPath, showOutput, stringValue, userConfigurationTarget } from "../core.js";
import type { JsonObject } from "../types.js";
import { refreshAll } from "../runtime/host.js";
import { pythonPath } from "../runtime/settings.js";
import { execFile, findTrainingRoot, isFile, isHttpUrl } from "../runtime/training-root.js";
import { invalidateNextPackageCache, loadState, packageAssets } from "../runtime/state.js";
import {
  blockedMicrophoneRegex,
  invalidateResolvedAudioDevice,
  listAvfoundationAudioDevices,
} from "../audio/native-recording.js";

export type MicrophoneQuickPickItem = vscode.QuickPickItem & { value: string; blocked?: boolean };

export async function completeLocalPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date);
  if (!packageDate) {
    throw new Error("No current package to complete.");
  }
  const script = path.join(state.root, "scripts", "english_training_progress.py");
  if (!isFile(script)) {
    throw new Error("Local completion requires scripts/english_training_progress.py to be a file in this workspace.");
  }
  const result = await execFile(state.root, [
    "scripts/english_training_progress.py",
    "complete",
    "--date",
    packageDate,
    "--due-date",
    state.today,
    "--no-todoist",
    "--note",
    "Completed in VS Code local practice.",
  ], 90_000);
  showOutput(true);
  appendOutput(`\n$ ${pythonPath()} scripts/english_training_progress.py complete --date ${packageDate} --due-date ${state.today} --no-todoist`);
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (stdout) appendOutput(stdout);
  if (stderr) appendOutput(stderr);
  if (result.code !== 0) {
    throw new Error(`Local completion failed: ${commandFailureSummary(result)}`);
  }
  vscode.window.showInformationMessage(`Completed ${packageDate} locally.`);
  // Completion advances which package is "next"; drop the memoized result
  // so the refresh below (and the next record/stop) re-resolve once.
  invalidateNextPackageCache();
  await refreshAll();
}

export async function openCurrentTaskCard(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const localAssets = state.sourceDiagnostics.currentPackageDate
    ? packageAssets(state.root, state.sourceDiagnostics.currentPackageDate)
    : {};
  const verifiedTaskCard = stringValue((localAssets as JsonObject).task_card).trim();
  if (verifiedTaskCard && isHttpUrl(verifiedTaskCard)) {
    await vscode.env.openExternal(vscode.Uri.parse(verifiedTaskCard));
    return;
  }
  const verifiedLocalTaskCard = existingFilePath(verifiedTaskCard);
  if (verifiedLocalTaskCard) {
    await vscode.window.showTextDocument(vscode.Uri.file(verifiedLocalTaskCard));
    return;
  }
  const currentJson = existingFilePath(state.sourceDiagnostics.currentJson);
  if (currentJson) {
    await vscode.window.showTextDocument(vscode.Uri.file(currentJson));
    return;
  }
  const taskCard = stringValue(assets.task_card).trim();
  if (taskCard && isHttpUrl(taskCard)) {
    await vscode.env.openExternal(vscode.Uri.parse(taskCard));
    return;
  }
  const fallbackTaskCard = existingFilePath(taskCard);
  if (!fallbackTaskCard) {
    throw new Error("No task card or english-training.json path is available.");
  }
  await vscode.window.showTextDocument(vscode.Uri.file(fallbackTaskCard));
}

export async function revealCurrentPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const packageDir = stringValue(assets.package_dir).trim();
  const localPackageDir = existingDirectoryPath(state.sourceDiagnostics.packageDir);
  if (localPackageDir) {
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(localPackageDir));
    return;
  }
  if (!packageDir) {
    throw new Error("No package directory is available.");
  }
  if (isHttpUrl(packageDir)) {
    await vscode.env.openExternal(vscode.Uri.parse(packageDir));
    return;
  }
  const existingPackageDir = existingDirectoryPath(packageDir);
  if (!existingPackageDir) {
    throw new Error(`Package directory does not exist: ${packageDir}`);
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(existingPackageDir));
}

export async function openSessionFolder(_context?: vscode.ExtensionContext): Promise<void> {
  const root = await findTrainingRoot();
  const dir = path.join(root, "runtime", "vscode-sessions");
  fs.mkdirSync(dir, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}

/**
 * Pick a recording microphone interactively. Lists AVFoundation audio
 * devices (skipping the blocked iPhone/Continuity set) and writes the
 * choice to englishTraining.preferredMicrophoneName so it survives across
 * sessions. "Auto" clears the preference and lets the existing local-Mac
 * heuristic pick. We invalidate the resolved-device cache so the next
 * record press re-detects with the new preference immediately.
 */
export async function selectRecordingMicrophone(): Promise<void> {
  if (process.platform !== "darwin") {
    vscode.window.showWarningMessage(
      "Interactive microphone picker currently supports macOS AVFoundation only. " +
        "Set englishTraining.preferredMicrophoneName manually on other platforms.",
    );
    return;
  }
  const ffmpegPath = resolveFfmpegPath();
  let devices: { index: string; name: string }[];
  try {
    devices = await listAvfoundationAudioDevices(ffmpegPath);
  } catch (error) {
    vscode.window.showErrorMessage(`Could not list microphones: ${errorMessage(error)}`);
    return;
  }
  if (devices.length === 0) {
    vscode.window.showWarningMessage(
      "No AVFoundation audio devices were detected. Check macOS Privacy & Security → Microphone " +
        "for VS Code (and any standalone ffmpeg you installed).",
    );
    return;
  }
  const blocked = blockedMicrophoneRegex();
  const settings = vscode.workspace.getConfiguration("englishTraining");
  const currentPreference = stringValue(settings.get<string>("preferredMicrophoneName")).trim();
  const items = microphoneQuickPickItems(devices, currentPreference, blocked);
  const picked = await vscode.window.showQuickPick(items, {
    title: "Choose Recording Microphone",
    placeHolder: "Pick a microphone for native macOS recording",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  if (picked.blocked) {
    vscode.window.showWarningMessage(
      `"${picked.label}" is excluded by englishTraining.blockedMicrophoneNamePattern; ` +
        "change that setting before selecting this microphone.",
    );
    return;
  }
  if (picked.value.trim().toLowerCase() === currentPreference.toLowerCase()) {
    vscode.window.showInformationMessage(
      picked.value
        ? `Recording microphone preference is already "${picked.value}".`
        : "Recording microphone preference is already automatic.",
    );
    return;
  }
  await settings.update("preferredMicrophoneName", picked.value, userConfigurationTarget());
  invalidateResolvedAudioDevice();
  if (picked.value) {
    vscode.window.showInformationMessage(
      `Recording microphone preference set to "${picked.value}". Next record press will use it.`,
    );
  } else {
    vscode.window.showInformationMessage(
      "Recording microphone preference cleared — using automatic Mac built-in selection.",
    );
  }
  await refreshAll();
  appendOutput(
    `Recording microphone preference: ${picked.value || "(auto)"}; cache invalidated.`,
  );
}

function commandFailureSummary(result: { code: number | null; stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr) return stderr;
  const stdout = result.stdout.trim();
  if (stdout) return stdout;
  return `exit code ${result.code ?? "unknown"} with no output`;
}

export function microphoneQuickPickItems(
  devices: { index: string; name: string }[],
  currentPreference: string,
  blocked: RegExp,
): MicrophoneQuickPickItem[] {
  const normalizedCurrentPreference = currentPreference.trim().toLowerCase();
  const items: MicrophoneQuickPickItem[] = [
    {
      label: "Auto (prefer Mac built-in)",
      description: normalizedCurrentPreference ? undefined : "current",
      detail: "Clears the preference and lets the extension pick an iMac/MacBook built-in microphone.",
      value: "",
    },
  ];
  for (const device of devices) {
    const isBlocked = blocked.test(device.name);
    const isCurrent =
      normalizedCurrentPreference.length > 0 && device.name.toLowerCase().includes(normalizedCurrentPreference);
    items.push({
      label: device.name,
      description: isBlocked ? "blocked by pattern" : isCurrent ? "current" : `[${device.index}]`,
      detail: isBlocked
        ? "Excluded by englishTraining.blockedMicrophoneNamePattern (typically iPhone/Continuity)."
        : `AVFoundation index ${device.index}`,
      value: device.name,
      ...(isBlocked ? { blocked: true } : {}),
    });
  }
  return items;
}

export function existingFilePath(value: unknown): string {
  const candidate = normalizedLocalPath(value);
  if (!candidate || isHttpUrl(candidate) || !fs.existsSync(candidate)) {
    return "";
  }
  try {
    return fs.statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

export function existingDirectoryPath(value: unknown): string {
  const candidate = normalizedLocalPath(value);
  if (!candidate || isHttpUrl(candidate) || !fs.existsSync(candidate)) {
    return "";
  }
  try {
    return fs.statSync(candidate).isDirectory() ? candidate : "";
  } catch {
    return "";
  }
}

function normalizedLocalPath(value: unknown): string {
  const text = stringValue(value).trim();
  return isHttpUrl(text) ? text : expandHomePath(text);
}
