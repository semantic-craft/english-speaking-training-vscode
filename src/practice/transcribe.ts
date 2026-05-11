import { Blob } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";

import {
  config,
  extractGeminiText,
  getRequiredKey,
  parseLooseJson,
  resolveFfmpegPath,
  stringValue,
} from "../core.js";
import type { JsonObject } from "../types.js";

const FAST_TRANSCRIPTION_API_VERSION = "2025-10-15";

export async function transcribeAudio(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const provider = config<string>("audioUnderstandingProvider") || "azure";
  if (provider === "openai") {
    return transcribeWithOpenAIRealtime(context, audioPath, sessionDir);
  }
  if (provider === "gemini") {
    return transcribeWithGemini(context, audioPath, mimeType, sessionDir);
  }
  return transcribeWithAzure(context, audioPath, mimeType, sessionDir);
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
  return {
    filePath: wavPath,
    mimeType: "audio/wav",
    base64: fs.readFileSync(wavPath).toString("base64"),
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

export function convertAudioToPcm16(
  inputPath: string,
  outPath: string,
  sampleRate = 24000,
): Promise<void> {
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
        String(sampleRate),
        "-sample_fmt",
        "s16",
        "-f",
        "s16le",
        outPath,
      ],
      { timeout: 60_000, maxBuffer: 1024 * 1024 * 2 },
      (error, _stdout, stderr) => {
        if (error) {
          reject(new Error(`Audio conversion to PCM16 failed: ${stderr || error.message}`));
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

async function transcribeWithAzure(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "azure");
  const region = (config<string>("azureSpeechRegion") || "eastus").trim();
  const locale = (config<string>("azureSpeechLocale") || "en-US").trim();
  const uploadPath = await ensureAzureUploadPath(audioPath, mimeType, sessionDir);
  const audioMime = uploadMimeType(uploadPath);
  const audioBuffer = fs.readFileSync(uploadPath);

  const form = new FormData();
  form.append("audio", new Blob([audioBuffer], { type: audioMime }), path.basename(uploadPath));
  form.append(
    "definition",
    JSON.stringify({
      locales: [locale],
      profanityFilterMode: "Masked",
    }),
  );

  const url = `https://${encodeURIComponent(region)}.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=${FAST_TRANSCRIPTION_API_VERSION}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
      Accept: "application/json",
    },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Azure fast transcription failed (${response.status}): ${body.slice(0, 1500)}`,
    );
  }
  const text = extractAzureTranscript(JSON.parse(body) as JsonObject).trim();
  if (!text) {
    throw new Error("Azure fast transcription returned empty text.");
  }
  return text;
}

async function ensureAzureUploadPath(
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  if (isAzureSupportedAudio(audioPath, mimeType)) {
    return audioPath;
  }
  const wavPath = path.join(sessionDir, "azure-fast-transcribe.wav");
  await convertAudioToWav(audioPath, wavPath);
  return wavPath;
}

function isAzureSupportedAudio(audioPath: string, mimeType: string): boolean {
  const lower = (mimeType || "").toLowerCase();
  if (
    lower.includes("wav") ||
    lower.includes("mpeg") ||
    lower.includes("mp3") ||
    lower.includes("ogg") ||
    lower.includes("flac") ||
    lower.includes("opus")
  ) {
    return true;
  }
  const ext = path.extname(audioPath).toLowerCase();
  return [".wav", ".mp3", ".ogg", ".opus", ".flac"].includes(ext);
}

function uploadMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".ogg" || ext === ".opus") return "audio/ogg";
  if (ext === ".flac") return "audio/flac";
  return "application/octet-stream";
}

function extractAzureTranscript(parsed: JsonObject): string {
  const combined = parsed.combinedPhrases;
  if (Array.isArray(combined) && combined.length) {
    const parts = combined
      .map((entry) => stringValue((entry as JsonObject).text))
      .filter(Boolean);
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }
  const phrases = parsed.phrases;
  if (Array.isArray(phrases) && phrases.length) {
    const parts = phrases
      .map((entry) => stringValue((entry as JsonObject).text))
      .filter(Boolean);
    if (parts.length) {
      return parts.join(" ").trim();
    }
  }
  return stringValue(parsed.displayText);
}

async function transcribeWithOpenAIRealtime(
  context: vscode.ExtensionContext,
  audioPath: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiRealtimeTranscriptionModel") || "gpt-realtime-whisper";
  const pcmPath = path.join(sessionDir, "openai-realtime-input.pcm");
  await convertAudioToPcm16(audioPath, pcmPath, 24000);
  const pcm = fs.readFileSync(pcmPath);
  if (pcm.length === 0) {
    throw new Error("OpenAI Realtime transcription input audio is empty.");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      },
    );
    const timeout = setTimeout(() => {
      finish(new Error("OpenAI Realtime transcription timed out before a final transcript arrived."));
    }, 60_000);

    const finish = (error?: Error, transcript?: string) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        // Best-effort cleanup after the promise is already settled.
      }
      if (error) {
        reject(error);
        return;
      }
      resolve(transcript?.trim() || "");
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: 24000,
              },
              transcription: {
                model,
                language: "en",
              },
              turn_detection: null,
            },
          },
        },
      }));

      const chunkSize = 64 * 1024;
      for (let offset = 0; offset < pcm.length; offset += chunkSize) {
        ws.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: pcm.subarray(offset, Math.min(offset + chunkSize, pcm.length)).toString("base64"),
        }));
      }
      ws.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    });

    ws.on("message", (data) => {
      const event = parseRealtimeEvent(data);
      if (!event) {
        return;
      }
      const type = stringValue(event.type);
      if (type === "conversation.item.input_audio_transcription.completed") {
        const transcript = stringValue(event.transcript).trim();
        if (!transcript) {
          finish(new Error("OpenAI Realtime transcription returned empty text."));
          return;
        }
        finish(undefined, transcript);
        return;
      }
      if (type === "conversation.item.input_audio_transcription.failed" || type === "error") {
        finish(new Error(`OpenAI Realtime transcription failed: ${formatRealtimeError(event)}`));
      }
    });

    ws.on("error", (error) => {
      finish(error instanceof Error ? error : new Error(String(error)));
    });

    ws.on("close", (code, reason) => {
      if (!settled) {
        const suffix = reason.length ? `: ${reason.toString("utf8")}` : "";
        finish(new Error(`OpenAI Realtime transcription socket closed before completion (${code})${suffix}`));
      }
    });
  });
}

function parseRealtimeEvent(data: WebSocket.RawData): JsonObject | undefined {
  const raw = Buffer.isBuffer(data)
    ? data.toString("utf8")
    : Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : Buffer.from(data).toString("utf8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as JsonObject
      : undefined;
  } catch {
    return undefined;
  }
}

function formatRealtimeError(event: JsonObject): string {
  const error = event.error;
  if (error && typeof error === "object" && !Array.isArray(error)) {
    const message = stringValue((error as JsonObject).message).trim();
    const code = stringValue((error as JsonObject).code).trim();
    return [code, message].filter(Boolean).join(" - ") || JSON.stringify(error).slice(0, 600);
  }
  return JSON.stringify(event).slice(0, 600);
}

async function transcribeWithGemini(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiAudioUnderstandingModel") || "gemini-3-flash-preview";
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const byteLength = Buffer.byteLength(audio.base64, "base64");
  if (byteLength > 18 * 1024 * 1024) {
    throw new Error("Gemini inline audio limit is close to 20 MB. Use Azure Speech or shorten the recording.");
  }

  const response = await fetch(
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
  const text = extractGeminiText(JSON.parse(body) as JsonObject).trim();
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
