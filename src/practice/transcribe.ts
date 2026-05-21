import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import WebSocket from "ws";

import {
  config,
  extractGeminiText,
  fetchWithTimeout,
  getRequiredKey,
  MIMO_OPENAI_BASE_URL,
  parseLooseJson,
  resolveFfmpegPath,
  stringValue,
} from "../core.js";
import type { JsonObject } from "../types.js";

export async function transcribeAudio(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
  promptText = "",
): Promise<string> {
  const provider = config<string>("audioUnderstandingProvider") || "openai";
  if (provider === "openai") {
    const mode = (config<string>("openaiTranscriptionMode") || "file").toLowerCase();
    if (mode === "realtime") {
      return transcribeWithOpenAIRealtime(context, audioPath, sessionDir);
    }
    return transcribeWithOpenAIFile(context, audioPath, mimeType, promptText);
  }
  if (provider === "mimo") {
    return transcribeWithMimo(context, audioPath, mimeType, sessionDir);
  }
  return transcribeWithGemini(context, audioPath, mimeType, sessionDir);
}

async function transcribeWithOpenAIFile(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  promptText: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiFileTranscriptionModel") || "gpt-4o-transcribe";
  const stats = fs.statSync(audioPath);
  // /v1/audio/transcriptions enforces a 25 MB upload cap.
  if (stats.size > 24 * 1024 * 1024) {
    throw new Error(
      "OpenAI transcription upload limit is 25 MB. Shorten the recording or switch to realtime mode.",
    );
  }
  const buffer = fs.readFileSync(audioPath);
  const effectiveMime = mimeType && mimeType !== "application/octet-stream" ? mimeType : "audio/wav";
  const ext = extensionFromMime(effectiveMime);
  const blob = new Blob([buffer], { type: effectiveMime });
  const form = new FormData();
  form.append("file", blob, `recording.${ext}`);
  form.append("model", model);
  // gpt-4o-transcribe-diarize requires diarized_json and a chunking_strategy
  // for audio > 30s; pick "auto" so the service handles segment boundaries.
  if (model.endsWith("-diarize")) {
    form.append("response_format", "diarized_json");
    form.append("chunking_strategy", "auto");
  } else {
    form.append("response_format", "json");
  }
  form.append("language", "en");
  const trimmedPrompt = promptText.trim().slice(0, 1000);
  if (trimmedPrompt && !model.endsWith("-diarize")) {
    // Whisper/gpt-4o-transcribe accept a domain prompt to bias decoding.
    // Diarize does not support prompts; we drop it silently in that case.
    form.append("prompt", trimmedPrompt);
  }

  const response = await fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${body.slice(0, 1500)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  return extractOpenAIFileTranscript(parsed);
}

function extractOpenAIFileTranscript(parsed: JsonObject): string {
  const direct = stringValue(parsed.text).trim();
  if (direct) return direct;
  // gpt-4o-transcribe-diarize returns { segments: [{ speaker, text, ... }] }.
  const segments = parsed.segments;
  if (Array.isArray(segments)) {
    const parts = segments
      .map((segment) => stringValue((segment as JsonObject).text).trim())
      .filter(Boolean);
    if (parts.length) return parts.join(" ");
  }
  throw new Error("OpenAI transcription returned empty text.");
}

function mimoEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

async function transcribeWithMimo(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const baseUrl = config<string>("mimoAudioBaseUrl") || MIMO_OPENAI_BASE_URL;
  const model = config<string>("mimoAudioUnderstandingModel") || "mimo-v2.5";
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
  const transcript = extractMimoTranscript(JSON.parse(body) as JsonObject);
  if (!transcript) {
    throw new Error("MiMo audio understanding returned empty transcript.");
  }
  return transcript;
}

function extractMimoTranscript(parsed: JsonObject): string {
  const choices = parsed.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return "";
  }
  const message = (choices[0] as JsonObject).message as JsonObject | undefined;
  const raw =
    stringValue(message?.content).trim() || stringValue(message?.reasoning_content).trim();
  return raw
    .replace(/^```(?:json|text)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^transcript\s*:\s*/i, "")
    .replace(/^["“]|["”]$/g, "")
    .trim();
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
    throw new Error("Gemini inline audio limit is close to 20 MB. Shorten the recording or switch speech input to OpenAI Realtime.");
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
