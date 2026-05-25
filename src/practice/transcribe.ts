import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  chatCompletionsUrl,
  configString,
  extractGeminiText,
  fetchWithTimeout,
  getRequiredKey,
  MIMO_OPENAI_BASE_URL,
  parseJsonObject,
  parseLooseJson,
  resolveFfmpegPath,
  stringValue,
} from "../core.js";
import {
  normalizedQwenAudioUnderstandingModel,
  normalizedQwenCompatibleBaseUrl,
  normalizedSpeechInputProvider,
} from "../runtime/settings.js";
import type { JsonObject } from "../types.js";

export async function transcribeAudio(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
  promptText = "",
): Promise<string> {
  void promptText;
  const provider = resolveAudioUnderstandingProvider();
  if (provider === "mimo") {
    return transcribeWithMimo(context, audioPath, mimeType, sessionDir);
  }
  if (provider === "qwen") {
    return transcribeWithQwen(context, audioPath, mimeType, sessionDir);
  }
  return transcribeWithGemini(context, audioPath, mimeType, sessionDir);
}

export function resolveAudioUnderstandingProvider(): "gemini" | "qwen" | "mimo" {
  return normalizedSpeechInputProvider() as "gemini" | "qwen" | "mimo";
}

function mimoEndpoint(baseUrl: string): string {
  return chatCompletionsUrl(baseUrl);
}

async function transcribeWithMimo(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const baseUrl = configString("mimoAudioBaseUrl", MIMO_OPENAI_BASE_URL);
  const model = configString("mimoAudioUnderstandingModel", "mimo-v2.5");
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const byteLength = Buffer.byteLength(audio.base64, "base64");
  if (byteLength > 45 * 1024 * 1024) {
    throw new Error("MiMo inline audio limit is close to 50 MB. Shorten the recording.");
  }

  const response = await fetchWithTimeout(mimoEndpoint(baseUrl), {
    method: "POST",
    headers: {
      "api-key": apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You transcribe spoken English exactly. Do not correct grammar, do not replace domain terms, do not translate, and do not add commentary.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: `data:audio/wav;base64,${audio.base64}` },
            },
            {
              type: "text",
              text: "Transcribe this audio. Return only the literal transcript text with no quotes, labels, or extra words.",
            },
          ],
        },
      ],
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo audio understanding failed (${response.status}): ${body.slice(0, 1500)}`);
  }
  const transcript = extractMimoTranscript(parseJsonObject(body, "MiMo audio understanding"));
  if (!transcript) {
    throw new Error("MiMo audio understanding returned empty transcript.");
  }
  return transcript;
}

export function extractMimoTranscript(parsed: JsonObject): string {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const message = choices
    .map((choice) =>
      choice && typeof choice === "object" && !Array.isArray(choice)
        ? (choice as JsonObject).message
        : undefined,
    )
    .find((value) => value && typeof value === "object" && !Array.isArray(value)) as JsonObject | undefined;
  const raw =
    stringValue(message?.content).trim() || stringValue(message?.reasoning_content).trim();
  return raw
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^transcript\s*:\s*/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
}

async function transcribeWithQwen(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "qwen");
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const dataUri = `data:${audio.mimeType};base64,${audio.base64}`;
  if (Buffer.byteLength(dataUri, "utf8") > 10 * 1024 * 1024) {
    throw new Error("Qwen-ASR inline audio limit is 10 MB after Base64 encoding. Shorten the recording.");
  }

  const response = await fetchWithTimeout(chatCompletionsUrl(normalizedQwenCompatibleBaseUrl()), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: normalizedQwenAudioUnderstandingModel(),
      messages: [
        {
          role: "system",
          content:
            "Transcribe spoken English literally. Do not correct grammar, do not translate, and do not add commentary.",
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: { data: dataUri },
            },
          ],
        },
      ],
      stream: false,
      asr_options: {
        language: "en",
        enable_itn: false,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Qwen-ASR failed (${response.status}): ${body.slice(0, 1500)}`);
  }
  const transcript = extractQwenAsrTranscript(parseJsonObject(body, "Qwen-ASR"));
  if (!transcript) {
    throw new Error("Qwen-ASR returned empty transcript.");
  }
  return transcript;
}

export function extractQwenAsrTranscript(parsed: JsonObject): string {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  for (const choice of choices) {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
      continue;
    }
    const message = (choice as JsonObject).message;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const content = stringValue((message as JsonObject).content)
      .replace(/^```(?:text)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .replace(/^transcript\s*:\s*/i, "")
      .replace(/^["“]|["”]$/g, "")
      .trim();
    if (content) {
      return content;
    }
  }
  return "";
}

export async function prepareInlineAudio(
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<{ filePath: string; mimeType: string; base64: string }> {
  const wavPath = path.join(sessionDir, "audio-understanding-input.wav");
  if (!/audio\/(?:wav|x-wav)$/i.test(mimeType) || audioPath !== wavPath) {
    await convertAudioToWav(audioPath, wavPath);
  }
  const audio = fs.readFileSync(wavPath);
  if (audio.length === 0) {
    throw new Error("Inline audio input is empty after conversion.");
  }
  return {
    filePath: wavPath,
    mimeType: "audio/wav",
    base64: audio.toString("base64"),
  };
}

export function convertAudioToWav(inputPath: string, outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = cp.execFile(
      resolveFfmpegPath(),
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        inputPath,
        "-ac",
        "1",
        "-ar",
        "16000",
        "-sample_fmt",
        "s16",
        outPath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 2 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Audio conversion to WAV failed: ${stderr || error.message}`));
          return;
        }
        resolve();
      },
    );
    child.on("error", (error) => reject(error));
  });
}

export function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

async function transcribeWithGemini(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = configString("geminiAudioUnderstandingModel", "gemini-3-flash-preview");
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const byteLength = Buffer.byteLength(audio.base64, "base64");
  if (byteLength > 18 * 1024 * 1024) {
    throw new Error("Gemini inline audio limit is close to 20 MB. Shorten the recording or switch speech input to Qwen-ASR or MiMo.");
  }

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: [
                  "Transcribe the learner's spoken English exactly.",
                  "Return strict JSON only with this shape: {\"transcript\":\"...\"}.",
                  "Do not correct grammar, do not replace domain terms, do not translate, and do not add commentary.",
                  "If speech is unclear, preserve your best literal hearing rather than inventing a polished sentence.",
                ].join(" "),
              },
              {
                inlineData: {
                  mimeType: audio.mimeType,
                  data: audio.base64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
        },
      }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini audio understanding failed (${response.status}): ${body.slice(0, 1500)}`);
  }
  const text = extractGeminiText(parseJsonObject(body, "Gemini audio understanding")).trim();
  const transcript = extractGeminiTranscriptText(text);
  if (!transcript) {
    throw new Error("Gemini audio understanding returned empty transcript.");
  }
  return transcript;
}

function extractGeminiTranscriptText(text: string): string {
  try {
    const parsed = parseLooseJson(text);
    return stringValue(parsed.transcript).trim();
  } catch {
    return text
      .trim()
      .replace(/^```(?:json|text)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .replace(/^transcript\s*:\s*/i, "")
      .replace(/^["“]|["”]$/g, "")
      .trim();
  }
}
