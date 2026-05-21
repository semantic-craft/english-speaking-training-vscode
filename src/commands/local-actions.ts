import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { appendOutput, resolveFfmpegPath, showOutput, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { refreshAll } from "../runtime/host.js";
import { pythonPath } from "../runtime/settings.js";
import { execFile, isHttpUrl } from "../runtime/training-root.js";
import { invalidateNextPackageCache, loadState } from "../runtime/state.js";
import {
  blockedMicrophoneRegex,
  invalidateResolvedAudioDevice,
  listAvfoundationAudioDevices,
} from "../audio/native-recording.js";

export async function completeLocalPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date);
  if (!packageDate) {
    throw new Error("No current package to complete.");
  }
  const script = path.join(state.root, "scripts", "english_training_progress.py");
  if (!fs.existsSync(script)) {
    throw new Error("Local completion requires scripts/english_training_progress.py in this workspace.");
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
  appendOutput(result.stdout.trim());
  if (result.stderr.trim()) appendOutput(result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`Local completion failed: ${result.stderr || result.stdout}`);
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
  const taskCard = stringValue(assets.task_card);
  if (taskCard && isHttpUrl(taskCard)) {
    await vscode.env.openExternal(vscode.Uri.parse(taskCard));
    return;
  }
  const localTaskCard = existingFilePath(taskCard);
  const currentJson = existingFilePath(state.sourceDiagnostics.currentJson);
  const target = localTaskCard || currentJson;
  if (!target) {
    throw new Error("No task card or english-training.json path is available.");
  }
  await vscode.window.showTextDocument(vscode.Uri.file(target));
}

export async function revealCurrentPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const packageDir = stringValue(assets.package_dir);
  if (!packageDir) {
    throw new Error("No package directory is available.");
  }
  if (isHttpUrl(packageDir)) {
    await vscode.env.openExternal(vscode.Uri.parse(packageDir));
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(packageDir));
}

export async function openSessionFolder(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const dir = path.join(state.root, "runtime", "vscode-sessions");
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
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Could not list microphones: ${message}`);
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
  const currentPreference = stringValue(settings.get<string>("preferredMicrophoneName")).trim().toLowerCase();
  const items: (vscode.QuickPickItem & { value: string })[] = [
    {
      label: "Auto (prefer Mac built-in)",
      description: currentPreference ? undefined : "current",
      detail: "Clears the preference and lets the extension pick an iMac/MacBook built-in microphone.",
      value: "",
    },
  ];
  for (const device of devices) {
    const isBlocked = blocked.test(device.name);
    const isCurrent =
      currentPreference.length > 0 && device.name.toLowerCase().includes(currentPreference);
    items.push({
      label: device.name,
      description: isCurrent ? "current" : isBlocked ? "blocked by pattern" : `[${device.index}]`,
      detail: isBlocked
        ? "Excluded by englishTraining.blockedMicrophoneNamePattern (typically iPhone/Continuity)."
        : `AVFoundation index ${device.index}`,
      value: device.name,
    });
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: "Choose Recording Microphone",
    placeHolder: "Pick a microphone for native macOS recording",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await settings.update("preferredMicrophoneName", picked.value, vscode.ConfigurationTarget.Workspace);
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

export function existingFilePath(value: string): string {
  if (!value || isHttpUrl(value) || !fs.existsSync(value)) {
    return "";
  }
  try {
    return fs.statSync(value).isFile() ? value : "";
  } catch {
    return "";
  }
}
