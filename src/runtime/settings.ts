import {
  config,
  MIMO_ANTHROPIC_BASE_URL,
  MIMO_OPENAI_BASE_URL,
  normalizeTtsSpeed,
} from "../core.js";
import type { TrainingState } from "../types.js";

export const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";

export type ProviderSettingName = "coachProvider" | "audioUnderstandingProvider" | "ttsProvider";
export type ConfigSettingName =
  | "mimoCoachModel"
  | "openaiRealtimeTranscriptionModel"
  | "openaiCoachModel"
  | "geminiCoachModel"
  | "geminiAudioUnderstandingModel"
  | "minimaxTtsModel"
  | "openaiTtsModel"
  | "openaiTtsVoice"
  | "geminiTtsModel"
  | "geminiTtsVoice";

export function pythonPath(): string {
  return config<string>("pythonPath") || "python3";
}

export function trainingSettings(): TrainingState["settings"] {
  return {
    localMaterialsRoot: config<string>("localMaterialsRoot") || "",
    coachProvider: config<string>("coachProvider") || "gemini",
    audioUnderstandingProvider: normalizedSpeechInputProvider(),
    ttsProvider: config<string>("ttsProvider") || "gemini",
    openaiRealtimeTranscriptionModel: config<string>("openaiRealtimeTranscriptionModel") || "gpt-realtime-whisper",
    openaiCoachModel: config<string>("openaiCoachModel") || "gpt-4o",
    geminiCoachModel: config<string>("geminiCoachModel") || "gemini-3-flash-preview",
    geminiTtsModel: config<string>("geminiTtsModel") || "gemini-3.1-flash-tts-preview",
    geminiTtsVoice: config<string>("geminiTtsVoice") || "Kore",
    geminiAudioUnderstandingModel: config<string>("geminiAudioUnderstandingModel") || "gemini-3-flash-preview",
    mimoAnthropicBaseUrl: config<string>("mimoAnthropicBaseUrl") || MIMO_ANTHROPIC_BASE_URL,
    mimoCoachModel: config<string>("mimoCoachModel") || "mimo-v2.5-pro",
    mimoAudioBaseUrl: config<string>("mimoAudioBaseUrl") || MIMO_OPENAI_BASE_URL,
    mimoAudioUnderstandingModel: config<string>("mimoAudioUnderstandingModel") || "mimo-v2.5",
    mimoTtsBaseUrl: config<string>("mimoTtsBaseUrl") || MIMO_OPENAI_BASE_URL,
    mimoTtsModel: config<string>("mimoTtsModel") || "mimo-v2.5-tts",
    mimoTtsVoice: config<string>("mimoTtsVoice") || "Mia",
    minimaxTtsModel: config<string>("minimaxTtsModel") || "speech-2.8-hd",
    minimaxTtsVoiceId: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
    ttsSpeed: normalizeTtsSpeed(config<unknown>("ttsSpeed"), 0.9),
    recorderBackend: config<string>("recorderBackend") || "macLocal",
    preferredMicrophoneName: config<string>("preferredMicrophoneName") || "",
    blockedMicrophoneNamePattern: config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN,
  };
}

export function normalizedSpeechInputProvider(): string {
  const provider = config<string>("audioUnderstandingProvider") || "gemini";
  return provider === "openai" || provider === "gemini" || provider === "mimo"
    ? provider
    : "gemini";
}

export function isConfigSettingName(value: unknown): value is ConfigSettingName {
  return (
    value === "mimoCoachModel" ||
    value === "openaiRealtimeTranscriptionModel" ||
    value === "openaiCoachModel" ||
    value === "geminiCoachModel" ||
    value === "geminiAudioUnderstandingModel" ||
    value === "minimaxTtsModel" ||
    value === "openaiTtsModel" ||
    value === "openaiTtsVoice" ||
    value === "geminiTtsModel" ||
    value === "geminiTtsVoice"
  );
}
