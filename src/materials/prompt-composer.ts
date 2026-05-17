import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { buildGenerationPrompt } from "../card-schema.js";
import { composeMaterialBrief } from "../practice/coach.js";
import { findTrainingRoot, todayInConfiguredTimezone } from "../runtime/training-root.js";
import { sampleFollowupDrillPackage, sampleTrainingPackage } from "./sample-package.js";

const PROMPT_FILE_NAME = "material-generation-prompt.md";

/**
 * Coach-assisted prompt composer. The learner types a terse topic; the
 * configured Coach model expands it into a tailored brief; that brief is
 * wrapped with the authoritative Card Schema contract via buildGenerationPrompt
 * and written to a folder the learner picks. The learner then pastes that one
 * file into any LLM to get a schema-correct lesson package.
 */
export async function composeMaterialPrompt(context: vscode.ExtensionContext): Promise<void> {
  const topic = await vscode.window.showInputBox({
    title: "Compose Material Prompt — Topic",
    prompt: "What do you want to practice? e.g. 'defending a research claim to a skeptical discussant'.",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length >= 4 ? null : "Describe the topic in a few words."),
  });
  if (!topic || !topic.trim()) {
    return;
  }

  const dateInput = await vscode.window.showInputBox({
    title: "Compose Material Prompt — Lesson Date",
    prompt: "Lesson date (YYYY-MM-DD). The generated package must live in prebuilt/<date>/.",
    value: todayInConfiguredTimezone(),
    ignoreFocusOut: true,
    validateInput: (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? null : "Use YYYY-MM-DD format."),
  });
  if (!dateInput) {
    return;
  }
  const targetDate = dateInput.trim();

  const brief = await resolveBrief(context, topic.trim());

  const prompt = buildGenerationPrompt({
    date: targetDate,
    brief,
    sampleTraining: sampleTrainingPackage(targetDate),
    sampleDrill: sampleFollowupDrillPackage(targetDate),
  });

  const targetDir = await pickTargetDirectory();
  if (!targetDir) {
    return;
  }
  const targetFile = path.join(targetDir, PROMPT_FILE_NAME);
  if (fs.existsSync(targetFile)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${PROMPT_FILE_NAME} already exists in that folder. Overwrite?`,
      { modal: true },
      "Overwrite",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }
  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetFile, `${prompt}\n`, "utf8");
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile), { preview: false });
  vscode.window.showInformationMessage(
    `Generation prompt written to ${targetFile}. Paste its full text into any LLM, then save the two ` +
      `JSON blocks it returns to prebuilt/${targetDate}/english-training.json and followup-drill.json, and Refresh.`,
  );
}

async function resolveBrief(context: vscode.ExtensionContext, topic: string): Promise<string> {
  try {
    return await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Composing brief with the Coach model…" },
      () => composeMaterialBrief(context, topic),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(
      `Coach could not compose a brief (${message}). Using your raw topic in the prompt instead.`,
    );
    return topic;
  }
}

async function pickTargetDirectory(): Promise<string | undefined> {
  let defaultUri: vscode.Uri | undefined;
  try {
    defaultUri = vscode.Uri.file(await findTrainingRoot());
  } catch {
    defaultUri = undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri,
    openLabel: "Save generation prompt here",
    title: "Choose a folder for the generation prompt",
  });
  return picked && picked.length ? picked[0].fsPath : undefined;
}
