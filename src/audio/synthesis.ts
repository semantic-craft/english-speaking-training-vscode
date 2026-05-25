import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { configString, getRequiredKey, stamp, stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { mimeTypeForAudioPath, speechOutputExtension, synthesizeWithConfiguredTts } from "../practice/tts.js";
import { synthesizeQwenRealtime } from "../practice/qwen-tts-realtime.js";
import {
  normalizedQwenTtsLanguageType,
  normalizedQwenTtsModel,
  normalizedQwenTtsRealtimeEndpoint,
  normalizedQwenTtsVoice,
  normalizedTtsProvider,
  qwenTtsRealtimeModel,
} from "../runtime/settings.js";
import { loadState, todayExampleText } from "../runtime/state.js";

export interface QwenStreamSink {
  onStart: (info: { sampleRate: number; channels: number; provider: "qwen" }) => void;
  onChunk: (base64Pcm: string) => void;
}

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
  const provider = normalizedTtsProvider();
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
  const provider = normalizedTtsProvider();
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

export async function streamQwenOnDemandText(
  context: vscode.ExtensionContext,
  text: string,
  speed: number,
  ttsStyle: string | undefined,
  sink: QwenStreamSink,
): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `slow-${stamp()}.wav`);
  await streamQwenToFile(context, text, outPath, ttsStyle, sink);
  const audio = fs.readFileSync(outPath);
  const mimeType = "audio/wav";
  return {
    provider: "qwen",
    speed,
    text,
    packageDate,
    filePath: outPath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}

export async function streamQwenTodayAudio(
  context: vscode.ExtensionContext,
  sink: QwenStreamSink,
): Promise<JsonObject> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const text = todayExampleText(state.training, state.next);
  if (!text.trim()) {
    throw new Error("No example text is available for today's package. Add clean_tts_text, audio_text, demo_line, or frames[].text.");
  }
  const outDir = createReferenceAudioDir(state.root, packageDate);
  const outPath = path.join(outDir, `today-${stamp()}.wav`);
  await streamQwenToFile(context, text, outPath, undefined, sink);
  const audio = fs.readFileSync(outPath);
  const mimeType = "audio/wav";
  return {
    provider: "qwen",
    packageDate,
    text,
    filePath: outPath,
    mimeType,
    audioDataUri: `data:${mimeType};base64,${audio.toString("base64")}`,
  };
}

export async function streamQwenToFile(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  ttsStyle: string | undefined,
  sink: QwenStreamSink,
): Promise<void> {
  const apiKey = await getRequiredKey(context, "qwen");
  const baseModel = normalizedQwenTtsModel();
  const model = qwenTtsRealtimeModel(baseModel);
  const explicit = configString("qwenTtsInstructions");
  const fromCoach = (ttsStyle || "").trim();
  const instructions = model.includes("instruct") ? (explicit || fromCoach || "") : "";
  const sampleRate = 24000;
  await synthesizeQwenRealtime(
    {
      apiKey,
      endpoint: normalizedQwenTtsRealtimeEndpoint(),
      model,
      voice: normalizedQwenTtsVoice(),
      languageType: normalizedQwenTtsLanguageType(),
      text,
      outPath,
      sampleRate,
      ...(instructions ? { instructions } : {}),
    },
    {
      onStart: (info) => sink.onStart({
        sampleRate: info.sampleRate,
        channels: info.channels,
        provider: "qwen",
      }),
      onChunk: (base64Pcm) => sink.onChunk(base64Pcm),
    },
  );
}
