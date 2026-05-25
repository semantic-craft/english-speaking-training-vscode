import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { writeJson } from "../core.js";
import {
  blankFollowupDrillPackage,
  blankTrainingPackage,
  buildGenerationPrompt,
} from "../card-schema.js";
import { openMaterialsGuide } from "../materials-guide.js";
import { refreshAll } from "../runtime/host.js";
import { invalidateNextPackageCache } from "../runtime/state.js";
import { findTrainingRoot, isPackageDate, readLocalInventory, todayInConfiguredTimezone } from "../runtime/training-root.js";
import { updateLocalMaterialsRootSetting } from "../commands/provider-routes.js";
import { sampleFollowupDrillPackage, sampleTrainingPackage } from "./sample-package.js";

export async function createSamplePackage(context: vscode.ExtensionContext): Promise<void> {
  const resolved = await resolveOrBootstrapLocalRoot();
  if (!resolved) {
    return;
  }
  const { root } = resolved;
  let packageChanged = false;
  try {
    const today = todayInConfiguredTimezone();
    const dateInput = await vscode.window.showInputBox({
      title: "Create Sample Package",
      prompt: "Lesson date (YYYY-MM-DD). Defaults to today.",
      value: today,
      ignoreFocusOut: true,
      validateInput: validateLessonDateInput,
    });
    if (!dateInput) {
      return;
    }
    const targetDate = dateInput.trim();
    if (!ensureValidLessonDate(targetDate)) {
      return;
    }
    const packageDir = path.join(root, "prebuilt", targetDate);
    const targetFile = path.join(packageDir, "english-training.json");
    const targetDrillFile = path.join(packageDir, "followup-drill.json");
    const existingFiles = existingLessonFileNames(packageDir);
    if (existingFiles.length > 0) {
      const overwrite = await vscode.window.showWarningMessage(
        `${targetDate}/${existingFiles.join(" and ")} already exists. Overwrite?`,
        { modal: true },
        "Overwrite",
      );
      if (overwrite !== "Overwrite") {
        return;
      }
      removeGeneratedPackageArtifacts(packageDir);
    }
    fs.mkdirSync(packageDir, { recursive: true });
    packageChanged = true;
    writeJson(targetFile, sampleTrainingPackage(targetDate));
    writeJson(targetDrillFile, sampleFollowupDrillPackage(targetDate));
    vscode.window.showInformationMessage(`Sample lesson and FSI drill written to prebuilt/${targetDate}. Edit them and refresh the sidebar.`);
    await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
  } finally {
    await refreshMaterialsIfChanged(resolved.materialsChanged || packageChanged);
  }
}

function nextPackageDate(root: string): string {
  const today = todayInConfiguredTimezone();
  let latest = "";
  try {
    const { dates } = readLocalInventory(root);
    latest = dates.length ? dates[dates.length - 1] : "";
  } catch {
    latest = "";
  }
  const base = latest && latest >= today ? latest : "";
  if (!base) {
    return today;
  }
  const next = new Date(`${base}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export async function generateNextPackage(context: vscode.ExtensionContext): Promise<void> {
  const resolved = await resolveOrBootstrapLocalRoot();
  if (!resolved) {
    return;
  }
  const { root } = resolved;
  let packageChanged = false;
  try {
    const suggested = nextPackageDate(root);
    const dateInput = await vscode.window.showInputBox({
      title: "Generate Next Package",
      prompt: "Lesson date (YYYY-MM-DD). Defaults to the day after your latest lesson.",
      value: suggested,
      ignoreFocusOut: true,
      validateInput: validateLessonDateInput,
    });
    if (!dateInput) {
      return;
    }
    const targetDate = dateInput.trim();
    if (!ensureValidLessonDate(targetDate)) {
      return;
    }
    const packageDir = path.join(root, "prebuilt", targetDate);
    const targetFile = path.join(packageDir, "english-training.json");
    const targetDrillFile = path.join(packageDir, "followup-drill.json");
    const existingFiles = existingLessonFileNames(packageDir);
    if (existingFiles.length > 0) {
      const overwrite = await vscode.window.showWarningMessage(
        `${targetDate}/${existingFiles.join(" and ")} already exists. Overwrite with a blank skeleton?`,
        { modal: true },
        "Overwrite",
      );
      if (overwrite !== "Overwrite") {
        return;
      }
      removeGeneratedPackageArtifacts(packageDir);
    }
    const brief = await vscode.window.showInputBox({
      title: "Generate Next Package — Learner Brief",
      prompt: "Optional: topic / material / situation to practice. Leave blank to fill in the prompt later.",
      ignoreFocusOut: true,
    });
    if (brief === undefined) {
      return;
    }
    fs.mkdirSync(packageDir, { recursive: true });
    packageChanged = true;
    writeJson(targetFile, blankTrainingPackage(targetDate));
    writeJson(targetDrillFile, blankFollowupDrillPackage(targetDate));
    const prompt = buildGenerationPrompt({
      date: targetDate,
      brief: brief ?? "",
      sampleTraining: sampleTrainingPackage(targetDate),
      sampleDrill: sampleFollowupDrillPackage(targetDate),
    });
    const promptDoc = await vscode.workspace.openTextDocument({ language: "markdown", content: prompt });
    await vscode.window.showTextDocument(promptDoc, { preview: false });
    await vscode.window.showTextDocument(vscode.Uri.file(targetFile), { preview: false });
    vscode.window.showInformationMessage(
      `Blank skeleton written to prebuilt/${targetDate}. Feed the generation prompt to any LLM ` +
        "(OpenAI / Gemini / MiMo / ...), paste its two JSON blocks back into the skeleton files, then Refresh.",
    );
  } finally {
    await refreshMaterialsIfChanged(resolved.materialsChanged || packageChanged);
  }
}

export function validateLessonDateInput(value: string): string | null {
  return isPackageDate(value.trim()) ? null : "Use a real calendar date in YYYY-MM-DD format.";
}

export function ensureValidLessonDate(value: string): boolean {
  const message = validateLessonDateInput(value);
  if (!message) {
    return true;
  }
  vscode.window.showWarningMessage(message);
  return false;
}

function existingLessonFileNames(packageDir: string): string[] {
  return [
    "english-training.json",
    "followup-drill.json",
    "manifest.json",
    "telegram-task-card.md",
    "daily-card.png",
    "prosody-detail.png",
    path.join("audio", "demo.ogg"),
    "audio-queue.json",
    "validation-report.json",
  ].filter((name) =>
    fs.existsSync(path.join(packageDir, name)),
  );
}

function removeGeneratedPackageArtifacts(packageDir: string): void {
  for (const name of existingLessonFileNames(packageDir)) {
    const filePath = path.join(packageDir, name);
    try {
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { recursive: true, force: true });
      }
    } catch {
      // Best-effort cleanup only; the JSON writes below still surface real
      // filesystem failures if the package cannot be replaced.
    }
  }
}

interface LocalRootResolution {
  root: string;
  materialsChanged: boolean;
}

async function resolveOrBootstrapLocalRoot(): Promise<LocalRootResolution | undefined> {
  try {
    return { root: await findTrainingRoot(), materialsChanged: false };
  } catch {
    // fall through to bootstrap flow
  }
  const choice = await vscode.window.showInformationMessage(
    "No local materials folder found. Pick a folder to host your lessons — the extension will create prebuilt/ and progress/ inside it.",
    { modal: true },
    "Pick Folder",
    "Open Guide",
  );
  if (choice === "Open Guide") {
    await openMaterialsGuide();
    return undefined;
  }
  if (choice !== "Pick Folder") {
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this folder for English Training materials",
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  await updateLocalMaterialsRootSetting(vscode.workspace.getConfiguration("englishTraining"), root);
  vscode.window.showInformationMessage(`English Training materials root set to ${root}.`);
  return { root, materialsChanged: true };
}

async function refreshMaterialsIfChanged(changed: boolean): Promise<void> {
  if (!changed) {
    return;
  }
  invalidateNextPackageCache();
  await refreshAll();
}
