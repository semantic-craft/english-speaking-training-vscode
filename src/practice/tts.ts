import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  config,
  fetchWithTimeout,
  getRequiredKey,
  isTtsProvider,
  MIMO_OPENAI_BASE_URL,
  MINIMAX_TTS_BASE_URL,
  normalizeTtsSpeed,
  stringValue,
} from "../core.js";
import type { JsonObject } from "../types.js";

export function speechOutputFileName(provider: string): string {
  return `native-version.${speechOutputExtension(provider)}`;
}

export function normalizeSpeechOutputProvider(provider: unknown): string {
  return isTtsProvider(provider) ? provider : "openai";
}

export function speechOutputExtension(provider: string): string {
  const selectedProvider = normalizeSpeechOutputProvider(provider);
  if (selectedProvider === "gemini" || selectedProvider === "mimo") return "wav";
  if (selectedProvider === "openai") {
    const fmt = openaiResponseFormat();
    // pcm has no container; we wrap it in a .wav header before writing.
    if (fmt === "pcm") return "wav";
    return fmt;
  }
  return "mp3";
}

export function mimeTypeForAudioPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  if (ext === ".aac") return "audio/aac";
  return "audio/mpeg";
}

function openaiResponseFormat(): string {
  const raw = (config<string>("openaiTtsResponseFormat") || "wav").toLowerCase();
  if (
    raw === "wav" ||
    raw === "mp3" ||
    raw === "opus" ||
    raw === "aac" ||
    raw === "flac" ||
    raw === "pcm"
  ) {
    return raw;
  }
  return "wav";
}

export const DEFAULT_OPENAI_TTS_INSTRUCTIONS =
  "Speak in clear, patient academic English with measured pace; emphasize key legal or scholarly terms; keep a warm, encouraging tone suitable for a learner shadowing the sentence.";

function resolveOpenAIInstructions(overrideStyle?: string): string {
  const explicit = (config<string>("openaiTtsInstructions") || "").trim();
  const fromCoach = (overrideStyle || "").trim();
  return explicit || fromCoach || DEFAULT_OPENAI_TTS_INSTRUCTIONS;
}

export function resolveOpenAITtsVoice(model: string): string {
  void model;
  return (config<string>("openaiTtsVoice") || "marin").trim() || "marin";
}

export interface SynthesizeOptions {
  speedOverride?: number;
  /**
   * Optional one-off OpenAI TTS `instructions` (style direction). When set,
   * it overrides nothing — it is used only if the user has not pinned a
   * value in englishTraining.openaiTtsInstructions. The typical caller is
   * the coach, which emits a per-turn tts_style suggestion.
   */
  ttsStyle?: string;
}

export async function synthesizeWithConfiguredTts(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  provider = config<string>("ttsProvider") || "openai",
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
  if (selectedProvider === "openai") {
    return { provider: selectedProvider, filePath: await synthesizeOpenAI(context, text, outPath, options) };
  }
  if (selectedProvider === "mimo") {
    return { provider: selectedProvider, filePath: await synthesizeMiMo(context, text, outPath) };
  }
  return {
    provider: "minimax",
    filePath: await synthesizeMiniMax(context, text, outPath, options.speedOverride),
  };
}

function resolveSpeed(speedOverride?: number): number {
  return normalizeTtsSpeed(speedOverride ?? config<unknown>("ttsSpeed"), 0.9);
}

async function synthesizeOpenAI(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  options: SynthesizeOptions = {},
): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiTtsModel") || "gpt-4o-mini-tts";
  const voice = resolveOpenAITtsVoice(model);
  const responseFormat = openaiResponseFormat();
  // gpt-4o-mini-tts supports instructions; the older tts-1 / tts-1-hd do not.
  const supportsInstructions = model.includes("gpt-4o-mini-tts") || model.includes("gpt-4o-tts");
  const instructions = supportsInstructions ? resolveOpenAIInstructions(options.ttsStyle) : "";

  const body: JsonObject = {
    model,
    voice,
    input: text,
    response_format: responseFormat,
    speed: resolveSpeed(options.speedOverride),
  };
  if (instructions) body.instructions = instructions;

  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`OpenAI TTS failed (${response.status}): ${payload.toString("utf8").slice(0, 1200)}`);
  }
  if (responseFormat === "pcm") {
    // OpenAI documents pcm as raw 24kHz 16-bit signed little-endian mono.
    // Wrap it in a RIFF/WAVE header so VS Code's media element (HTMLAudio)
    // can play it back without an external decoder.
    writePcm16Wav(outPath, payload, 24000, 1);
    return outPath;
  }
  fs.writeFileSync(outPath, payload);
  return outPath;
}

async function synthesizeGemini(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiTtsModel") || "gemini-3.1-flash-tts-preview";
  const voiceName = config<string>("geminiTtsVoice") || "Kore";
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
  const audio = extractGeminiInlineAudio(JSON.parse(body) as JsonObject);
  if (audio.mimeType.includes("wav")) {
    fs.writeFileSync(outPath, audio.data);
  } else {
    writePcm16Wav(outPath, audio.data, 24000, 1);
  }
  return outPath;
}

async function synthesizeMiniMax(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
  speedOverride?: number,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "minimax");
  const ttsBaseUrl = config<string>("minimaxTtsBaseUrl") || MINIMAX_TTS_BASE_URL;
  const response = await fetchWithTimeout(ttsBaseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("minimaxTtsModel") || "speech-2.8-hd",
      text,
      stream: false,
      output_format: "hex",
      language_boost: "auto",
      voice_setting: {
        voice_id: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
        speed: resolveSpeed(speedOverride),
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const baseResp = (parsed.base_resp as JsonObject | undefined) ?? {};
  if (Number(baseResp.status_code ?? 0) !== 0) {
    const statusCode = stringValue(baseResp.status_code);
    const statusMsg = stringValue(baseResp.status_msg);
    if (statusCode === "2049") {
      throw new Error(
        `MiniMax TTS API error 2049: invalid api key for ${ttsBaseUrl}. ` +
          `For the mainland/resource-pack key, use ${MINIMAX_TTS_BASE_URL} and reconfigure the MiniMax key.`,
      );
    }
    throw new Error(`MiniMax TTS API error ${statusCode}: ${statusMsg}`);
  }
  const audioHex = stringValue((parsed.data as JsonObject | undefined)?.audio);
  if (!audioHex) {
    throw new Error("MiniMax TTS returned empty audio data.");
  }
  fs.writeFileSync(outPath, Buffer.from(audioHex, "hex"));
  return outPath;
}

async function synthesizeMiMo(
  context: vscode.ExtensionContext,
  text: string,
  outPath: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const baseUrl = config<string>("mimoTtsBaseUrl") || MIMO_OPENAI_BASE_URL;
  const model = config<string>("mimoTtsModel") || "mimo-v2.5-tts";
  const voice = config<string>("mimoTtsVoice") || "Mia";
  const response = await fetchWithTimeout(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: "Read the following text aloud in clear, natural English." },
        { role: "assistant", content: text },
      ],
      audio: { format: "wav", voice },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const choices = parsed.choices;
  const message = Array.isArray(choices) && choices.length
    ? ((choices[0] as JsonObject).message as JsonObject | undefined)
    : undefined;
  const audio = message?.audio as JsonObject | undefined;
  const data = stringValue(audio?.data);
  if (!data) {
    throw new Error("MiMo TTS returned empty audio data.");
  }
  fs.writeFileSync(outPath, Buffer.from(data, "base64"));
  return outPath;
}

function extractGeminiInlineAudio(parsed: JsonObject): { data: Buffer; mimeType: string } {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error("Gemini TTS returned no candidates.");
  }
  for (const candidate of candidates) {
    const content = (candidate as JsonObject).content as JsonObject | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const partObj = part as JsonObject;
      const inlineData =
        (partObj.inlineData as JsonObject | undefined) ?? (partObj.inline_data as JsonObject | undefined);
      const data = stringValue(inlineData?.data);
      if (data) {
        return {
          data: Buffer.from(data, "base64"),
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

function writePcm16Wav(filePath: string, pcm: Buffer, sampleRate: number, channels: number): void {
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
