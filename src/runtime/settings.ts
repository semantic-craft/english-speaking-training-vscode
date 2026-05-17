import {
  config,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  MIMO_ANTHROPIC_BASE_URL,
  MINIMAX_ANTHROPIC_BASE_URL,
  normalizeTtsSpeed,
} from "../core.js";
import type { TrainingState } from "../types.js";

export const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";

export type ProviderSettingName = "coachProvider" | "audioUnderstandingProvider" | "ttsProvider";
export type ConfigSettingName =
  | "minimaxCoachModel"
  | "mimoCoachModel"
  | "openaiCoachModel"
  | "openaiRealtimeTranscriptionModel"
  | "geminiCoachModel"
  | "kimiCoachModel"
  | "deepseekCoachModel"
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
    openaiCoachModel: config<string>("openaiCoachModel") || "gpt-4o-mini",
    openaiRealtimeTranscriptionModel: config<string>("openaiRealtimeTranscriptionModel") || "gpt-realtime-whisper",
    geminiCoachModel: config<string>("geminiCoachModel") || "gemini-3-flash-preview",
    geminiTtsModel: config<string>("geminiTtsModel") || "gemini-3.1-flash-tts-preview",
    geminiTtsVoice: config<string>("geminiTtsVoice") || "Kore",
    geminiAudioUnderstandingModel: config<string>("geminiAudioUnderstandingModel") || "gemini-3-flash-preview",
    minimaxAnthropicBaseUrl: config<string>("minimaxAnthropicBaseUrl") || MINIMAX_ANTHROPIC_BASE_URL,
    minimaxCoachModel: config<string>("minimaxCoachModel") || "MiniMax-M2.7",
    mimoAnthropicBaseUrl: config<string>("mimoAnthropicBaseUrl") || MIMO_ANTHROPIC_BASE_URL,
    mimoCoachModel: config<string>("mimoCoachModel") || "mimo-v2.5-pro",
    kimiChatBaseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
    kimiCoachModel: config<string>("kimiCoachModel") || "kimi-for-coding",
    deepseekAnthropicBaseUrl: config<string>("deepseekAnthropicBaseUrl") || DEEPSEEK_ANTHROPIC_BASE_URL,
    deepseekCoachModel: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
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
  return provider === "openai" || provider === "gemini" ? provider : "gemini";
}

export function isConfigSettingName(value: unknown): value is ConfigSettingName {
  return (
    value === "minimaxCoachModel" ||
    value === "mimoCoachModel" ||
    value === "openaiCoachModel" ||
    value === "openaiRealtimeTranscriptionModel" ||
    value === "geminiCoachModel" ||
    value === "kimiCoachModel" ||
    value === "deepseekCoachModel" ||
    value === "geminiAudioUnderstandingModel" ||
    value === "minimaxTtsModel" ||
    value === "openaiTtsModel" ||
    value === "openaiTtsVoice" ||
    value === "geminiTtsModel" ||
    value === "geminiTtsVoice"
  );
}
