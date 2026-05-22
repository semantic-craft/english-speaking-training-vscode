import {
  config,
  configString,
  expandHomePath,
  isCoachProvider,
  isTtsProvider,
  MIMO_ANTHROPIC_BASE_URL,
  MIMO_OPENAI_BASE_URL,
  normalizedProviderName,
  normalizeTtsSpeed,
} from "../core.js";
import type { TrainingState } from "../types.js";

export const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";
const OPENAI_TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"] as const;
const OPENAI_TRANSCRIPTION_MODES = ["file", "realtime"] as const;
const OPENAI_TTS_RESPONSE_FORMATS = ["wav", "mp3", "opus", "aac", "flac", "pcm"] as const;
const GEMINI_TTS_VOICES = ["Kore", "Puck", "Charon", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"] as const;
const MIMO_TTS_VOICES = ["Mia", "Chloe", "Milo", "Dean", "mimo_default"] as const;

export type ProviderSettingName = "coachProvider" | "audioUnderstandingProvider" | "ttsProvider";
export type ConfigSettingName =
  | "mimoCoachModel"
  | "openaiTranscriptionMode"
  | "openaiRealtimeTranscriptionModel"
  | "openaiFileTranscriptionModel"
  | "openaiCoachModel"
  | "geminiCoachModel"
  | "geminiAudioUnderstandingModel"
  | "mimoAudioUnderstandingModel"
  | "minimaxTtsModel"
  | "mimoTtsModel"
  | "mimoTtsVoice"
  | "openaiTtsModel"
  | "openaiTtsVoice"
  | "openaiTtsInstructions"
  | "openaiTtsResponseFormat"
  | "recorderBackend"
  | "geminiTtsModel"
  | "geminiTtsVoice";

export function pythonPath(): string {
  return expandHomePath(configString("pythonPath", "python3"));
}

export function trainingSettings(): TrainingState["settings"] {
  return {
    localMaterialsRoot: configString("localMaterialsRoot"),
    coachProvider: normalizedCoachProvider(),
    audioUnderstandingProvider: normalizedSpeechInputProvider(),
    ttsProvider: normalizedTtsProvider(),
    openaiRealtimeTranscriptionModel: configString("openaiRealtimeTranscriptionModel", "gpt-realtime-whisper"),
    openaiTranscriptionMode: normalizedOpenAITranscriptionMode(),
    openaiFileTranscriptionModel: configString("openaiFileTranscriptionModel", "gpt-4o-transcribe"),
    openaiCoachModel: configString("openaiCoachModel", "gpt-4o"),
    openaiTtsModel: configString("openaiTtsModel", "gpt-4o-mini-tts"),
    openaiTtsVoice: normalizedOpenAITtsVoice(),
    openaiTtsInstructions: configString("openaiTtsInstructions"),
    openaiTtsResponseFormat: normalizedOpenAITtsResponseFormat(),
    geminiCoachModel: configString("geminiCoachModel", "gemini-3-flash-preview"),
    geminiTtsModel: configString("geminiTtsModel", "gemini-3.1-flash-tts-preview"),
    geminiTtsVoice: normalizedGeminiTtsVoice(),
    geminiAudioUnderstandingModel: configString("geminiAudioUnderstandingModel", "gemini-3-flash-preview"),
    mimoAnthropicBaseUrl: configString("mimoAnthropicBaseUrl", MIMO_ANTHROPIC_BASE_URL),
    mimoCoachModel: configString("mimoCoachModel", "mimo-v2.5-pro"),
    mimoAudioBaseUrl: configString("mimoAudioBaseUrl", MIMO_OPENAI_BASE_URL),
    mimoAudioUnderstandingModel: configString("mimoAudioUnderstandingModel", "mimo-v2.5"),
    mimoTtsBaseUrl: configString("mimoTtsBaseUrl", MIMO_OPENAI_BASE_URL),
    mimoTtsModel: configString("mimoTtsModel", "mimo-v2.5-tts"),
    mimoTtsVoice: normalizedMimoTtsVoice(),
    minimaxTtsModel: configString("minimaxTtsModel", "speech-2.8-hd"),
    minimaxTtsVoiceId: configString("minimaxTtsVoiceId", "English_expressive_narrator"),
    ttsSpeed: normalizeTtsSpeed(config<unknown>("ttsSpeed"), 0.9),
    recorderBackend: normalizedRecorderBackend(),
    preferredMicrophoneName: configString("preferredMicrophoneName"),
    blockedMicrophoneNamePattern: configString("blockedMicrophoneNamePattern", DEFAULT_BLOCKED_MICROPHONE_PATTERN),
  };
}

export function normalizedSpeechInputProvider(): string {
  const provider = normalizedProviderName(config<string>("audioUnderstandingProvider"));
  return provider === "openai" || provider === "gemini" || provider === "mimo"
    ? provider
    : "openai";
}

export function normalizedCoachProvider(): string {
  const provider = normalizedProviderName(config<string>("coachProvider"));
  return isCoachProvider(provider) ? provider : "openai";
}

export function normalizedTtsProvider(): string {
  const provider = normalizedProviderName(config<string>("ttsProvider"));
  return isTtsProvider(provider) ? provider : "openai";
}

export function normalizedRecorderBackend(): string {
  const backend = configString("recorderBackend", "macLocal").toLowerCase();
  if (backend === "maclocal") return "macLocal";
  if (backend === "webview" || backend === "auto") return backend;
  return "macLocal";
}

export function normalizedOpenAITranscriptionMode(): string {
  const mode = configString("openaiTranscriptionMode", "file").toLowerCase();
  return includesValue(OPENAI_TRANSCRIPTION_MODES, mode) ? mode : "file";
}

export function normalizedOpenAITtsResponseFormat(): string {
  const format = configString("openaiTtsResponseFormat", "wav").toLowerCase();
  return includesValue(OPENAI_TTS_RESPONSE_FORMATS, format) ? format : "wav";
}

export function normalizedOpenAITtsVoice(): string {
  const voice = configString("openaiTtsVoice", "marin");
  return includesValue(OPENAI_TTS_VOICES, voice) ? voice : "marin";
}

export function normalizedGeminiTtsVoice(): string {
  const voice = configString("geminiTtsVoice", "Kore");
  return includesValue(GEMINI_TTS_VOICES, voice) ? voice : "Kore";
}

export function normalizedMimoTtsVoice(): string {
  const voice = configString("mimoTtsVoice", "Mia");
  return includesValue(MIMO_TTS_VOICES, voice) ? voice : "Mia";
}

function includesValue(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export function isConfigSettingName(value: unknown): value is ConfigSettingName {
  return (
    value === "mimoCoachModel" ||
    value === "openaiTranscriptionMode" ||
    value === "openaiRealtimeTranscriptionModel" ||
    value === "openaiFileTranscriptionModel" ||
    value === "openaiCoachModel" ||
    value === "geminiCoachModel" ||
    value === "geminiAudioUnderstandingModel" ||
    value === "mimoAudioUnderstandingModel" ||
    value === "minimaxTtsModel" ||
    value === "mimoTtsModel" ||
    value === "mimoTtsVoice" ||
    value === "openaiTtsModel" ||
    value === "openaiTtsVoice" ||
    value === "openaiTtsInstructions" ||
    value === "openaiTtsResponseFormat" ||
    value === "recorderBackend" ||
    value === "geminiTtsModel" ||
    value === "geminiTtsVoice"
  );
}
