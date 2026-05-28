import {
  config,
  configString,
  expandHomePath,
  isCoachProvider,
  isTtsProvider,
  MIMO_ANTHROPIC_BASE_URL,
  MIMO_OPENAI_BASE_URL,
  QWEN_COMPATIBLE_BASE_URL,
  QWEN_COMPATIBLE_INTL_BASE_URL,
  normalizedProviderName,
  normalizeTtsSpeed,
  QWEN_TTS_ENDPOINT,
  QWEN_TTS_INTL_ENDPOINT,
  QWEN_TTS_REALTIME_ENDPOINT,
  QWEN_TTS_REALTIME_INTL_ENDPOINT,
} from "../core.js";
import type { TrainingState } from "../types.js";

export const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";
// Full official Gemini prebuilt voice catalog (ai.google.dev speech-generation).
// The package.json dropdown surfaces a curated English subset; the validator
// accepts every official voice so a manually-typed name is not reset to Kore.
const GEMINI_TTS_VOICES = [
  "Zephyr", "Puck", "Charon", "Kore", "Fenrir", "Leda", "Orus", "Aoede",
  "Callirrhoe", "Autonoe", "Enceladus", "Iapetus", "Umbriel", "Algieba",
  "Despina", "Erinome", "Algenib", "Rasalgethi", "Laomedeia", "Achernar",
  "Alnilam", "Schedar", "Gacrux", "Pulcherrima", "Achird", "Zubenelgenubi",
  "Vindemiatrix", "Sadachbia", "Sadaltager", "Sulafat",
] as const;
const MIMO_TTS_VOICES = ["Mia", "Chloe", "Milo", "Dean", "mimo_default"] as const;
const QWEN_COMPATIBLE_BASE_URLS = [QWEN_COMPATIBLE_BASE_URL, QWEN_COMPATIBLE_INTL_BASE_URL] as const;
const QWEN_AUDIO_UNDERSTANDING_MODELS = ["qwen3-asr-flash", "qwen3-asr-flash-2026-02-10", "qwen3-asr-flash-2025-09-08"] as const;
const QWEN_TTS_MODELS = ["qwen3-tts-flash", "qwen3-tts-instruct-flash"] as const;
// Full official Qwen3-TTS system-voice catalog (help.aliyun.com Qwen-TTS voice
// list). The package.json dropdown surfaces a curated English subset, but the
// validator accepts every official id so a manually-typed voice is not reset.
const QWEN_TTS_VOICES = [
  "Jennifer", "Aiden", "Ryan", "Katerina", "Cherry", "Serena", "Ethan", "Chelsie",
  "Maia", "Kai", "Neil", "Elias", "Momo", "Vivian", "Moon", "Nofish", "Bella",
  "Eldric Sage", "Mia", "Mochi", "Bellona", "Vincent", "Bunny", "Arthur", "Nini",
  "Seren", "Pip", "Stella", "Bodega", "Sonrisa", "Alek", "Dolce", "Sohee",
  "Ono Anna", "Lenn", "Emilien", "Andre", "Radio Gol", "Jada", "Dylan", "Li",
  "Marcus", "Roy", "Peter", "Sunny", "Eric", "Rocky", "Kiki",
] as const;
// Voices available on qwen3-tts-instruct-flash. The premium English-only voices
// (Jennifer/Aiden/Ryan/Katerina) and many character/dialect voices exist only
// on qwen3-tts-flash, so an instruct model paired with one of those must fall
// back to qwen3-tts-flash to avoid a 400. See effectiveQwenTtsBaseModel.
const QWEN_TTS_INSTRUCT_VOICES = new Set([
  "Cherry", "Serena", "Ethan", "Chelsie", "Momo", "Vivian", "Moon", "Maia",
  "Kai", "Nofish", "Bella", "Eldric Sage", "Mia", "Mochi", "Bellona", "Vincent",
  "Bunny", "Neil", "Elias", "Arthur", "Nini", "Seren", "Pip", "Stella",
]);
const QWEN_TTS_LANGUAGE_TYPES = ["Auto", "Chinese", "English", "German"] as const;

export type ProviderSettingName = "coachProvider" | "audioUnderstandingProvider" | "ttsProvider";
export type ConfigSettingName =
  | "mimoCoachModel"
  | "geminiCoachModel"
  | "geminiAudioUnderstandingModel"
  | "qwenCompatibleBaseUrl"
  | "qwenCoachModel"
  | "qwenAudioUnderstandingModel"
  | "mimoAudioUnderstandingModel"
  | "qwenTtsEndpoint"
  | "qwenTtsModel"
  | "qwenTtsVoice"
  | "qwenTtsLanguageType"
  | "qwenTtsInstructions"
  | "mimoTtsModel"
  | "mimoTtsVoice"
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
    geminiCoachModel: configString("geminiCoachModel", "gemini-3.5-flash"),
    geminiTtsModel: configString("geminiTtsModel", "gemini-3.1-flash-tts-preview"),
    geminiTtsVoice: normalizedGeminiTtsVoice(),
    geminiAudioUnderstandingModel: configString("geminiAudioUnderstandingModel", "gemini-3.5-flash"),
    qwenCompatibleBaseUrl: normalizedQwenCompatibleBaseUrl(),
    qwenCoachModel: configString("qwenCoachModel", "qwen3.6-plus"),
    qwenAudioUnderstandingModel: normalizedQwenAudioUnderstandingModel(),
    mimoAnthropicBaseUrl: configString("mimoAnthropicBaseUrl", MIMO_ANTHROPIC_BASE_URL),
    mimoCoachModel: configString("mimoCoachModel", "mimo-v2.5-pro"),
    mimoAudioBaseUrl: configString("mimoAudioBaseUrl", MIMO_OPENAI_BASE_URL),
    mimoAudioUnderstandingModel: configString("mimoAudioUnderstandingModel", "mimo-v2.5"),
    mimoTtsBaseUrl: configString("mimoTtsBaseUrl", MIMO_OPENAI_BASE_URL),
    mimoTtsModel: configString("mimoTtsModel", "mimo-v2.5-tts"),
    mimoTtsVoice: normalizedMimoTtsVoice(),
    qwenTtsEndpoint: normalizedQwenTtsEndpoint(),
    qwenTtsModel: normalizedQwenTtsModel(),
    qwenTtsVoice: normalizedQwenTtsVoice(),
    qwenTtsLanguageType: normalizedQwenTtsLanguageType(),
    qwenTtsInstructions: configString("qwenTtsInstructions"),
    ttsSpeed: normalizeTtsSpeed(config<unknown>("ttsSpeed"), 0.9),
    recorderBackend: normalizedRecorderBackend(),
    preferredMicrophoneName: configString("preferredMicrophoneName"),
    blockedMicrophoneNamePattern: configString("blockedMicrophoneNamePattern", DEFAULT_BLOCKED_MICROPHONE_PATTERN),
  };
}

export function normalizedSpeechInputProvider(): string {
  const provider = normalizedProviderName(config<string>("audioUnderstandingProvider"));
  return provider === "gemini" || provider === "qwen" || provider === "mimo"
    ? provider
    : "qwen";
}

export function normalizedCoachProvider(): string {
  const provider = normalizedProviderName(config<string>("coachProvider"));
  return isCoachProvider(provider) ? provider : "qwen";
}

export function normalizedTtsProvider(): string {
  const provider = normalizedProviderName(config<string>("ttsProvider"));
  return isTtsProvider(provider) ? provider : "qwen";
}

export function normalizedRecorderBackend(): string {
  const backend = configString("recorderBackend", "macLocal").toLowerCase();
  if (backend === "maclocal") return "macLocal";
  if (backend === "webview" || backend === "auto") return backend;
  return "macLocal";
}

export function normalizedGeminiTtsVoice(): string {
  const voice = configString("geminiTtsVoice", "Kore");
  return includesValue(GEMINI_TTS_VOICES, voice) ? voice : "Kore";
}

export function normalizedMimoTtsVoice(): string {
  const voice = configString("mimoTtsVoice", "Mia");
  return includesValue(MIMO_TTS_VOICES, voice) ? voice : "Mia";
}

export function normalizedQwenCompatibleBaseUrl(): string {
  const baseUrl = configString("qwenCompatibleBaseUrl", QWEN_COMPATIBLE_BASE_URL).replace(/\/+$/, "");
  return includesValue(QWEN_COMPATIBLE_BASE_URLS, baseUrl) ? baseUrl : QWEN_COMPATIBLE_BASE_URL;
}

export function normalizedQwenAudioUnderstandingModel(): string {
  const model = configString("qwenAudioUnderstandingModel", "qwen3-asr-flash");
  return includesValue(QWEN_AUDIO_UNDERSTANDING_MODELS, model) ? model : "qwen3-asr-flash";
}

export function normalizedQwenTtsEndpoint(): string {
  const endpoint = configString("qwenTtsEndpoint", QWEN_TTS_ENDPOINT).replace(/\/+$/, "");
  return endpoint === QWEN_TTS_INTL_ENDPOINT ? QWEN_TTS_INTL_ENDPOINT : QWEN_TTS_ENDPOINT;
}

export function normalizedQwenTtsRealtimeEndpoint(): string {
  return normalizedQwenTtsEndpoint() === QWEN_TTS_INTL_ENDPOINT
    ? QWEN_TTS_REALTIME_INTL_ENDPOINT
    : QWEN_TTS_REALTIME_ENDPOINT;
}

export function qwenTtsRealtimeModel(baseModel: string): string {
  if (baseModel.endsWith("-realtime")) return baseModel;
  return `${baseModel}-realtime`;
}

export function normalizedQwenTtsModel(): string {
  const model = configString("qwenTtsModel", "qwen3-tts-flash");
  return includesValue(QWEN_TTS_MODELS, model) ? model : "qwen3-tts-flash";
}

export function normalizedQwenTtsVoice(): string {
  const voice = configString("qwenTtsVoice", "Jennifer");
  return includesValue(QWEN_TTS_VOICES, voice) ? voice : "Jennifer";
}

export function qwenVoiceSupportsInstruct(voice: string): boolean {
  return QWEN_TTS_INSTRUCT_VOICES.has(voice);
}

/**
 * Resolve the Qwen-TTS base model to actually call. The premium English voices
 * and many character/dialect voices only exist on qwen3-tts-flash, not the
 * instruct variant; pairing them would 400. When an instruct model is selected
 * with a flash-only voice, fall back to qwen3-tts-flash for that synthesis.
 * Pass the realtime/non-realtime base model id (without the -realtime suffix).
 */
export function effectiveQwenTtsBaseModel(baseModel: string, voice: string): string {
  if (baseModel.includes("instruct") && !qwenVoiceSupportsInstruct(voice)) {
    return "qwen3-tts-flash";
  }
  return baseModel;
}

export function normalizedQwenTtsLanguageType(): string {
  const languageType = configString("qwenTtsLanguageType", "English");
  return includesValue(QWEN_TTS_LANGUAGE_TYPES, languageType) ? languageType : "English";
}

function includesValue(values: readonly string[], value: string): boolean {
  return values.includes(value);
}

export function isConfigSettingName(value: unknown): value is ConfigSettingName {
  return (
    value === "mimoCoachModel" ||
    value === "geminiCoachModel" ||
    value === "geminiAudioUnderstandingModel" ||
    value === "qwenCompatibleBaseUrl" ||
    value === "qwenCoachModel" ||
    value === "qwenAudioUnderstandingModel" ||
    value === "mimoAudioUnderstandingModel" ||
    value === "qwenTtsEndpoint" ||
    value === "qwenTtsModel" ||
    value === "qwenTtsVoice" ||
    value === "qwenTtsLanguageType" ||
    value === "qwenTtsInstructions" ||
    value === "mimoTtsModel" ||
    value === "mimoTtsVoice" ||
    value === "recorderBackend" ||
    value === "geminiTtsModel" ||
    value === "geminiTtsVoice"
  );
}
