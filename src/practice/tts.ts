import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  normalizedGeminiTtsVoice,
  normalizedMimoTtsVoice,
  normalizedQwenTtsEndpoint,
  normalizedQwenTtsLanguageType,
  normalizedQwenTtsModel,
  normalizedQwenTtsVoice,
  normalizedTtsProvider,
} from "../runtime/settings.js";
import {
  chatCompletionsUrl,
  config,
  configString,
  fetchWithTimeout,
  getRequiredKey,
  MIMO_OPENAI_BASE_URL,
  normalizedProviderName,
  normalizeTtsSpeed,
  parseJsonObject,
  stringValue,
} from "../core.js";
import type { JsonObject } from "../types.js";

export function speechOutputFileName(provider: string): string {
  return `native-version.${speechOutputExtension(provider)}`;
}

export function normalizeSpeechOutputProvider(provider: unknown): string {
  const normalized = normalizedProviderName(provider);
  return normalized === "qwen" || normalized === "gemini" || normalized === "mimo"
    ? normalized
    : "qwen";
}

export function speechOutputExtension(provider: string): string {
  void normalizeSpeechOutputProvider(provider);
  return "wav";
}

export function mimeTypeForAudioPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".aac") return "audio/aac";
  return "audio/mpeg";
}

export interface SynthesizeOptions {
  speedOverride?: number;
  /**
   * Optional one-off style direction. Qwen sends it only when
   * qwen3-tts-instruct-flash is selected. MiMo sends it as an optional user
   * style prompt while keeping the text to read in the assistant message.
   */
  ttsStyle?: string;
}

export async function synthesizeWithConfiguredTts(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  provider = normalizedTtsProvider(),
  optionsOrSpeed?: number | SynthesizeOptions,
): Promise<{ provider: string; filePath: string }> {
  const selectedProvider = normalizeSpeechOutputProvider(provider);
  const options: SynthesizeOptions =
    typeof optionsOrSpeed === "number"
      ? { speedOverride: optionsOrSpeed }
      : optionsOrSpeed ?? {};
  if (selectedProvider === "gemini") {
    return { provider: selectedProvider, filePath: await synthesizeGemini(context, text, outPath) };
  }
  if (selectedProvider === "mimo") {
    return { provider: selectedProvider, filePath: await synthesizeMiMo(context, text, outPath, options) };
  }
  return {
    provider: "qwen",
    filePath: await synthesizeQwen(context, text, outPath, options),
  };
}

function resolveSpeed(speedOverride?: number): number {
  return normalizeTtsSpeed(speedOverride ?? config<unknown>("ttsSpeed"), 0.9);
}

async function synthesizeGemini(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = configString("geminiTtsModel", "gemini-3.1-flash-tts-preview");
  const voiceName = normalizedGeminiTtsVoice();
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text }],
          },
        ],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName,
              },
            },
          },
        },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const audio = extractGeminiInlineAudio(parseJsonObject(body, "Gemini TTS"));
  if (audio.mimeType.includes("wav")) {
    fs.writeFileSync(outPath, audio.data);
  } else {
    writePcm16Wav(outPath, audio.data, 24000, 1);
  }
  return outPath;
}

async function synthesizeQwen(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  options: SynthesizeOptions = {},
): Promise<string> {
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("Qwen-TTS text was empty.");
  }
  const apiKey = await getRequiredKey(context, "qwen");
  const model = normalizedQwenTtsModel();
  const input: JsonObject = {
    text: trimmedText,
    voice: normalizedQwenTtsVoice(),
    language_type: normalizedQwenTtsLanguageType(),
  };
  const instructions = qwenSupportsInstructions(model)
    ? configString("qwenTtsInstructions") || (options.ttsStyle || "").trim()
    : "";
  if (instructions) {
    input.instructions = instructions;
  }
  const response = await fetchWithTimeout(normalizedQwenTtsEndpoint(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen-TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = parseJsonObject(body, "Qwen-TTS");
  if (parsed.code || parsed.message) {
    throw new Error(`Qwen-TTS API error ${stringValue(parsed.code) || "unknown"}: ${stringValue(parsed.message)}`);
  }
  fs.writeFileSync(outPath, await extractQwenTtsAudioData(parsed));
  return outPath;
}

function qwenSupportsInstructions(model: string): boolean {
  return model === "qwen3-tts-instruct-flash";
}

export async function extractQwenTtsAudioData(parsed: JsonObject): Promise<Buffer> {
  const output = parsed.output && typeof parsed.output === "object" && !Array.isArray(parsed.output)
    ? parsed.output as JsonObject
    : undefined;
  const audio = output?.audio && typeof output.audio === "object" && !Array.isArray(output.audio)
    ? output.audio as JsonObject
    : undefined;
  const data = stringValue(audio?.data);
  if (data) {
    return decodeBase64AudioData(data, "Qwen-TTS");
  }
  const url = stringValue(audio?.url);
  if (url) {
    return downloadQwenAudioUrl(url);
  }
  throw new Error("Qwen-TTS returned no output.audio.data or output.audio.url.");
}

async function downloadQwenAudioUrl(url: string): Promise<Buffer> {
  const response = await fetchWithTimeout(url);
  const payload = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`Qwen-TTS audio download failed (${response.status}): ${payload.toString("utf8").slice(0, 1200)}`);
  }
  return ensureNonEmptyAudioData(payload, "Qwen-TTS");
}

async function synthesizeMiMo(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  options: SynthesizeOptions = {},
): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const baseUrl = configString("mimoTtsBaseUrl", MIMO_OPENAI_BASE_URL);
  const model = configString("mimoTtsModel", "mimo-v2.5-tts");
  const voice = normalizedMimoTtsVoice();
  const trimmedText = text.trim();
  if (!trimmedText) {
    throw new Error("MiMo TTS text was empty.");
  }
  const response = await fetchWithTimeout(chatCompletionsUrl(baseUrl), {
    method: "POST",
    headers: {
      "api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: buildMimoTtsMessages(trimmedText, options.ttsStyle),
      audio: { format: "wav", voice },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = parseJsonObject(body, "MiMo TTS");
  fs.writeFileSync(outPath, extractMimoTtsAudioData(parsed));
  return outPath;
}

function buildMimoTtsMessages(
  text: string,
  stylePrompt?: string,
): Array<{ role: "user" | "assistant"; content: string }> {
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const style = (stylePrompt || "").trim();
  if (style) {
    messages.push({ role: "user", content: style });
  }
  messages.push({ role: "assistant", content: text });
  return messages;
}

export function extractMimoTtsAudioData(parsed: JsonObject): Buffer {
  const choices = parsed.choices;
  const message = Array.isArray(choices)
    ? choices
        .map((choice) =>
          choice && typeof choice === "object" && !Array.isArray(choice)
            ? (choice as JsonObject).message
            : undefined,
        )
        .find((value) => value && typeof value === "object" && !Array.isArray(value)) as JsonObject | undefined
    : undefined;
  const audioValue = message?.audio;
  const audio = audioValue && typeof audioValue === "object" && !Array.isArray(audioValue)
    ? audioValue as JsonObject
    : undefined;
  const data = stringValue(audio?.data);
  if (!data) {
    throw new Error("MiMo TTS returned empty audio data.");
  }
  return decodeBase64AudioData(data, "MiMo TTS");
}

export function decodeBase64AudioData(data: string, label: string): Buffer {
  const compact = data.trim().replace(/\s+/g, "");
  if (!compact) {
    throw new Error(`${label} returned empty audio data.`);
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    throw new Error(`${label} returned invalid base64 audio data.`);
  }
  const audio = Buffer.from(compact, "base64");
  ensureNonEmptyAudioData(audio, label);
  const normalizedInput = compact.replace(/=+$/, "");
  const normalizedOutput = audio.toString("base64").replace(/=+$/, "");
  if (normalizedInput !== normalizedOutput) {
    throw new Error(`${label} returned invalid base64 audio data.`);
  }
  return audio;
}

export function ensureNonEmptyAudioData(audio: Buffer, label: string): Buffer {
  if (!audio.length) {
    throw new Error(`${label} returned empty audio data.`);
  }
  return audio;
}

export function extractGeminiInlineAudio(parsed: JsonObject): { data: Buffer; mimeType: string } {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error("Gemini TTS returned no candidates.");
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const contentValue = (candidate as JsonObject).content;
    const content = contentValue && typeof contentValue === "object" && !Array.isArray(contentValue)
      ? contentValue as JsonObject
      : undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        continue;
      }
      const partObj = part as JsonObject;
      const inlineDataValue = partObj.inlineData ?? partObj.inline_data;
      const inlineData = inlineDataValue && typeof inlineDataValue === "object" && !Array.isArray(inlineDataValue)
        ? inlineDataValue as JsonObject
        : undefined;
      const data = stringValue(inlineData?.data);
      if (data) {
        return {
          data: decodeBase64AudioData(data, "Gemini TTS"),
          mimeType:
            stringValue(inlineData?.mimeType) ||
            stringValue(inlineData?.mime_type) ||
            "audio/L16;rate=24000",
        };
      }
    }
  }
  throw new Error("Gemini TTS returned no inline audio data.");
}

export function writePcm16Wav(filePath: string, pcm: Buffer, sampleRate: number, channels: number): void {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}
