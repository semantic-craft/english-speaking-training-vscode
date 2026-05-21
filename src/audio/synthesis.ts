import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { config, stamp, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { mimeTypeForAudioPath, speechOutputExtension, synthesizeWithConfiguredTts } from "../practice/tts.js";
import { loadState, todayExampleText } from "../runtime/state.js";

export function createReferenceAudioDir(root: string, packageDate: string): string {
  const dir = path.join(root, "runtime", "vscode-reference-audio", packageDate);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function synthesizeTodayAudio(context: vscode.ExtensionContext): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const text = todayExampleText(state.training, state.next);
  if (!text.trim()) {
    throw new Error("No example text is available for today's package. Add clean_tts_text, audio_text, demo_line, or frames[].text.");
  }
  const provider = config<string>("ttsProvider") || "openai";
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `today-${stamp()}.${speechOutputExtension(provider)}`);
  const result = await synthesizeWithConfiguredTts(context, text, outPath, provider);
  const audio = fs.readFileSync(result.filePath);
  const mimeType = mimeTypeForAudioPath(result.filePath);
  return {
    provider: result.provider,
    packageDate,
    text,
    filePath: result.filePath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}

export async function synthesizeOnDemandText(
  context: vscode.ExtensionContext,
  text: string,
  speed: number,
  ttsStyle?: string,
): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const provider = config<string>("ttsProvider") || "openai";
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `slow-${stamp()}.${speechOutputExtension(provider)}`);
  const result = await synthesizeWithConfiguredTts(context, text, outPath, provider, {
    speedOverride: speed,
    ttsStyle,
  });
  const audio = fs.readFileSync(result.filePath);
  const mimeType = mimeTypeForAudioPath(result.filePath);
  return {
    provider: result.provider,
    speed,
    text,
    filePath: result.filePath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}
