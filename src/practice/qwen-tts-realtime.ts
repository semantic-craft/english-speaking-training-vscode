import * as fs from "node:fs";
import WebSocket from "ws";

import { stringValue } from "../core.js";
import type { JsonObject } from "../types.js";
import { writePcm16Wav } from "./tts.js";

export interface QwenTtsRealtimeOptions {
  apiKey: string;
  endpoint: string;
  model: string;
  voice: string;
  languageType: string;
  text: string;
  outPath: string;
  instructions?: string;
  sampleRate?: number;
  timeoutMs?: number;
  firstChunkTimeoutMs?: number;
}

export interface QwenTtsRealtimeStartInfo {
  sampleRate: number;
  channels: number;
  format: "pcm";
  sessionId: string;
}

export interface QwenTtsRealtimeDoneInfo {
  wavFilePath: string;
  totalBytes: number;
  sampleRate: number;
  channels: number;
  firstChunkLatencyMs: number;
}

export interface QwenTtsRealtimeSink {
  onStart?: (info: QwenTtsRealtimeStartInfo) => void;
  onChunk?: (base64Pcm: string, byteLength: number) => void;
  onDone?: (info: QwenTtsRealtimeDoneInfo) => void;
  onError?: (error: Error) => void;
}

const DEFAULT_SAMPLE_RATE = 24000;
const DEFAULT_CHANNELS = 1;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_FIRST_CHUNK_TIMEOUT_MS = 15_000;

export function synthesizeQwenRealtime(
  options: QwenTtsRealtimeOptions,
  sink: QwenTtsRealtimeSink = {},
): Promise<QwenTtsRealtimeDoneInfo> {
  const text = options.text.trim();
  if (!text) {
    return Promise.reject(new Error("Qwen-TTS Realtime text was empty."));
  }
  const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const channels = DEFAULT_CHANNELS;
  const overallTimeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const firstChunkTimeoutMs = options.firstChunkTimeoutMs ?? DEFAULT_FIRST_CHUNK_TIMEOUT_MS;

  const url = `${options.endpoint}?model=${encodeURIComponent(options.model)}`;
  const startedAt = Date.now();
  const pcmChunks: Buffer[] = [];
  let totalBytes = 0;
  let firstChunkAt = 0;

  return new Promise((resolve, reject) => {
    let settled = false;
    let sessionConfigured = false;
    let textCommitted = false;
    let sawAudioDone = false;
    let sessionId = "";

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
      },
    });

    const overallTimeout = setTimeout(() => {
      finish(new Error(`Qwen-TTS Realtime timed out after ${overallTimeoutMs}ms before completion.`));
    }, overallTimeoutMs);

    const firstChunkTimeout = setTimeout(() => {
      if (!firstChunkAt) {
        finish(new Error(`Qwen-TTS Realtime did not return any audio within ${firstChunkTimeoutMs}ms.`));
      }
    }, firstChunkTimeoutMs);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(overallTimeout);
      clearTimeout(firstChunkTimeout);
      try {
        ws.close();
      } catch {
        // best-effort
      }
      if (error) {
        sink.onError?.(error);
        reject(error);
        return;
      }
      try {
        const pcm = Buffer.concat(pcmChunks);
        writePcm16Wav(options.outPath, pcm, sampleRate, channels);
        const info: QwenTtsRealtimeDoneInfo = {
          wavFilePath: options.outPath,
          totalBytes: pcm.length,
          sampleRate,
          channels,
          firstChunkLatencyMs: firstChunkAt ? firstChunkAt - startedAt : 0,
        };
        sink.onDone?.(info);
        resolve(info);
      } catch (writeErr) {
        const e = writeErr instanceof Error ? writeErr : new Error(String(writeErr));
        sink.onError?.(e);
        reject(e);
      }
    };

    ws.on("open", () => {
      // The Qwen-TTS Realtime server emits session.created first; defer
      // session.update + text submission until we see it.
    });

    ws.on("message", (data) => {
      const event = parseRealtimeEvent(data);
      if (!event) return;
      const type = stringValue(event.type);

      if (type === "session.created") {
        sessionId = sessionValue(event, "id");
        try {
          ws.send(JSON.stringify({
            type: "session.update",
            session: {
              voice: options.voice,
              response_format: "pcm",
              sample_rate: sampleRate,
              mode: "commit",
              language_type: options.languageType,
              ...(options.instructions ? { instructions: options.instructions } : {}),
            },
          }));
        } catch (sendErr) {
          finish(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
          return;
        }
        sessionConfigured = true;
        sink.onStart?.({ sampleRate, channels, format: "pcm", sessionId });
        // Send the text immediately after configuring the session. The server
        // does not require waiting for an explicit session.updated reply; if
        // it later complains about an unconfigured session, we fall through
        // to the error branch below.
        try {
          ws.send(JSON.stringify({
            type: "input_text_buffer.append",
            text: options.text,
          }));
          ws.send(JSON.stringify({ type: "input_text_buffer.commit" }));
          textCommitted = true;
        } catch (sendErr) {
          finish(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
        }
        return;
      }

      if (type === "response.audio.delta") {
        const delta = stringValue(event.delta);
        if (!delta) return;
        const chunk = Buffer.from(delta, "base64");
        if (chunk.length === 0) return;
        if (!firstChunkAt) {
          firstChunkAt = Date.now();
          clearTimeout(firstChunkTimeout);
        }
        pcmChunks.push(chunk);
        totalBytes += chunk.length;
        sink.onChunk?.(delta, chunk.length);
        return;
      }

      if (type === "response.audio.done") {
        sawAudioDone = true;
        try {
          ws.send(JSON.stringify({ type: "session.finish" }));
        } catch (sendErr) {
          finish(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
        }
        return;
      }

      if (type === "session.finished" || type === "response.done") {
        if (sawAudioDone || totalBytes > 0) {
          finish();
        }
        return;
      }

      if (type === "error") {
        finish(new Error(`Qwen-TTS Realtime error: ${formatRealtimeError(event)}`));
      }
    });

    ws.on("error", (err) => {
      finish(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on("close", (code, reason) => {
      if (settled) return;
      if (sawAudioDone && totalBytes > 0) {
        finish();
        return;
      }
      const suffix = reason && reason.length ? `: ${reason.toString("utf8")}` : "";
      const stage = !sessionConfigured
        ? "before session.created"
        : !textCommitted
          ? "before text commit"
          : !firstChunkAt
            ? "before first audio chunk"
            : !sawAudioDone
              ? "mid-stream"
              : "after audio.done";
      finish(new Error(`Qwen-TTS Realtime socket closed ${stage} (${code})${suffix}`));
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

function sessionValue(event: JsonObject, key: string): string {
  const session = event.session;
  if (!session || typeof session !== "object" || Array.isArray(session)) return "";
  return stringValue((session as JsonObject)[key]);
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

export function isQwenRealtimeModel(model: string): boolean {
  return model.endsWith("-realtime");
}
