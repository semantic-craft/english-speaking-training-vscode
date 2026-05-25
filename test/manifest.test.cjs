const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));
const coreSource = fs.readFileSync(path.join(root, "src", "core.ts"), "utf8");
const extensionSource = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const nativeRecorderSource = fs.readFileSync(path.join(root, "src", "audio", "native-recording.ts"), "utf8");
const providerRoutesSource = fs.readFileSync(path.join(root, "src", "commands", "provider-routes.ts"), "utf8");
const localActionsSource = fs.readFileSync(path.join(root, "src", "commands", "local-actions.ts"), "utf8");
const scaffoldSource = fs.readFileSync(path.join(root, "src", "materials", "scaffold.ts"), "utf8");
const practiceViewSource = fs.readFileSync(path.join(root, "src", "webview", "practice-view.ts"), "utf8");
const stateSource = fs.readFileSync(path.join(root, "src", "runtime", "state.ts"), "utf8");
const settingsSource = fs.readFileSync(path.join(root, "src", "runtime", "settings.ts"), "utf8");
const trainingRootSource = fs.readFileSync(path.join(root, "src", "runtime", "training-root.ts"), "utf8");
const statusTreeSource = fs.readFileSync(path.join(root, "src", "status", "status-tree.ts"), "utf8");
const audioSynthesisSource = fs.readFileSync(path.join(root, "src", "audio", "synthesis.ts"), "utf8");
const coachSource = fs.readFileSync(path.join(root, "src", "practice", "coach.ts"), "utf8");
const pipelineSource = fs.readFileSync(path.join(root, "src", "practice", "pipeline.ts"), "utf8");
const transcribeSource = fs.readFileSync(path.join(root, "src", "practice", "transcribe.ts"), "utf8");
const ttsSource = fs.readFileSync(path.join(root, "src", "practice", "tts.ts"), "utf8");
const mediaSource = fs.readFileSync(path.join(root, "media", "practice.js"), "utf8");
const optionsSource = extensionSource.slice(
  extensionSource.indexOf("function configSettingOptions"),
  extensionSource.indexOf("function providerSetupHint"),
);

function quotedStrings(text) {
  return Array.from(text.matchAll(/"([^"]+)"/g), (match) => match[1]);
}

function sourceArray(name) {
  const match = extensionSource.match(new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\];`));
  return match ? quotedStrings(match[1]) : [];
}

function uiOptions(setting) {
  const match = optionsSource.match(new RegExp(`case "${setting}": return ([^;]+);`));
  assert.ok(match, `Missing configSettingOptions case for ${setting}`);
  const expr = match[1].trim();
  if (expr.startsWith("[")) {
    return quotedStrings(expr);
  }
  return sourceArray(expr);
}

function configurationEnum(setting) {
  return packageJson.contributes.configuration.properties[`englishTraining.${setting}`]?.enum ?? [];
}

test("every registered command is contributed exactly once", () => {
  const contributed = packageJson.contributes.commands.map((item) => item.command).sort();
  const registered = Array.from(
    extensionSource.matchAll(/register\("([^"]+)"/g),
    (match) => match[1],
  ).sort();

  assert.deepEqual(registered, contributed);
  assert.equal(new Set(contributed).size, contributed.length, "Duplicate command contribution");
});

test("sidebar model presets stay inside package configuration enums", () => {
  for (const setting of [
    "mimoCoachModel",
    "openaiTranscriptionMode",
    "openaiRealtimeTranscriptionModel",
    "openaiFileTranscriptionModel",
    "openaiCoachModel",
    "openaiTtsModel",
    "openaiTtsVoice",
    "openaiTtsResponseFormat",
    "recorderBackend",
    "geminiCoachModel",
    "geminiAudioUnderstandingModel",
    "qwenCompatibleBaseUrl",
    "qwenCoachModel",
    "qwenAudioUnderstandingModel",
    "mimoAudioUnderstandingModel",
    "qwenTtsEndpoint",
    "qwenTtsModel",
    "qwenTtsVoice",
    "qwenTtsLanguageType",
    "mimoTtsModel",
    "mimoTtsVoice",
    "geminiTtsModel",
    "geminiTtsVoice",
  ]) {
    const manifestValues = configurationEnum(setting);
    assert.ok(manifestValues.length > 0, `${setting} should have a manifest enum`);
    assert.deepEqual(uiOptions(setting).sort(), [...manifestValues].sort(), setting);
  }
});

test("OpenAI TTS source fallback matches package default", () => {
  const packageDefault = packageJson.contributes.configuration.properties["englishTraining.openaiTtsVoice"].default;
  assert.match(settingsSource, new RegExp(`configString\\("openaiTtsVoice", "${packageDefault}"\\)`));
  assert.match(settingsSource, new RegExp(`\\? voice : "${packageDefault}"`));
  assert.match(ttsSource, /return normalizedOpenAITtsVoice\(\)/);
});

test("runtime model strings are trimmed before UI state and provider calls", () => {
  for (const [source, pattern] of [
    [settingsSource, /openaiRealtimeTranscriptionModel: configString\("openaiRealtimeTranscriptionModel", "gpt-realtime-whisper"\)/],
    [settingsSource, /openaiFileTranscriptionModel: configString\("openaiFileTranscriptionModel", "gpt-4o-transcribe"\)/],
    [settingsSource, /openaiCoachModel: configString\("openaiCoachModel", "gpt-4o"\)/],
    [settingsSource, /openaiTtsModel: configString\("openaiTtsModel", "gpt-4o-mini-tts"\)/],
    [settingsSource, /geminiCoachModel: configString\("geminiCoachModel", "gemini-3-flash-preview"\)/],
    [settingsSource, /geminiTtsModel: configString\("geminiTtsModel", "gemini-3\.1-flash-tts-preview"\)/],
    [settingsSource, /geminiAudioUnderstandingModel: configString\("geminiAudioUnderstandingModel", "gemini-3-flash-preview"\)/],
    [settingsSource, /qwenCompatibleBaseUrl: normalizedQwenCompatibleBaseUrl\(\)/],
    [settingsSource, /qwenCoachModel: configString\("qwenCoachModel", "qwen-plus"\)/],
    [settingsSource, /qwenAudioUnderstandingModel: normalizedQwenAudioUnderstandingModel\(\)/],
    [settingsSource, /mimoCoachModel: configString\("mimoCoachModel", "mimo-v2\.5-pro"\)/],
    [settingsSource, /mimoAudioUnderstandingModel: configString\("mimoAudioUnderstandingModel", "mimo-v2\.5"\)/],
    [settingsSource, /mimoTtsModel: configString\("mimoTtsModel", "mimo-v2\.5-tts"\)/],
    [settingsSource, /qwenTtsEndpoint: normalizedQwenTtsEndpoint\(\)/],
    [settingsSource, /qwenTtsModel: normalizedQwenTtsModel\(\)/],
    [settingsSource, /qwenTtsVoice: normalizedQwenTtsVoice\(\)/],
    [settingsSource, /qwenTtsLanguageType: normalizedQwenTtsLanguageType\(\)/],
    [coachSource, /configString\("mimoCoachModel", "mimo-v2\.5-pro"\)/],
    [coachSource, /configString\("qwenCoachModel", "qwen-plus"\)/],
    [coachSource, /configString\("geminiCoachModel", "gemini-3-flash-preview"\)/],
    [coachSource, /configString\("openaiCoachModel", "gpt-4o"\)/],
    [transcribeSource, /configString\("openaiFileTranscriptionModel", "gpt-4o-transcribe"\)/],
    [transcribeSource, /configString\("mimoAudioUnderstandingModel", "mimo-v2\.5"\)/],
    [transcribeSource, /normalizedQwenAudioUnderstandingModel\(\)/],
    [transcribeSource, /normalizedQwenCompatibleBaseUrl\(\)/],
    [transcribeSource, /configString\("openaiRealtimeTranscriptionModel", "gpt-realtime-whisper"\)/],
    [transcribeSource, /configString\("geminiAudioUnderstandingModel", "gemini-3-flash-preview"\)/],
    [ttsSource, /configString\("openaiTtsModel", "gpt-4o-mini-tts"\)/],
    [ttsSource, /configString\("geminiTtsModel", "gemini-3\.1-flash-tts-preview"\)/],
    [ttsSource, /normalizedQwenTtsModel\(\)/],
    [ttsSource, /normalizedQwenTtsVoice\(\)/],
    [ttsSource, /normalizedQwenTtsLanguageType\(\)/],
    [ttsSource, /configString\("mimoTtsModel", "mimo-v2\.5-tts"\)/],
    [extensionSource, /const settings = trainingSettings\(\);[\s\S]*case "openaiCoachModel": return settings\.openaiCoachModel/],
    [extensionSource, /case "openaiTtsModel": return settings\.openaiTtsModel/],
  ]) {
    assert.match(source, pattern);
  }
});

test("runtime free-form path and microphone strings are trimmed before state or commands", () => {
  assert.match(coreSource, /export function configString\(key: string, fallback = ""\): string \{[\s\S]*const raw = config<unknown>\(key\);[\s\S]*typeof raw === "string" \? raw\.trim\(\) : ""/);
  assert.match(coreSource, /export function readJson\(filePath: string\): JsonObject \| undefined \{[\s\S]*const parsed = JSON\.parse[\s\S]*!Array\.isArray\(parsed\)[\s\S]*: undefined;/);
  assert.match(coreSource, /export function expandHomePath\(value: unknown\): string \{[\s\S]*typeof value === "string" \? value\.trim\(\) : ""[\s\S]*home \? path\.join\(home, trimmed\.slice\(2\)\) : trimmed/);
  assert.match(coreSource, /export function arrayOfStrings\(value: unknown\): string\[\] \{[\s\S]*stringValue\(item\)\.trim\(\)\)\.filter\(Boolean\)/);
  assert.match(coreSource, /export function errorMessage\(error: unknown\): string \{[\s\S]*for \(const key of \["message", "error", "reason", "statusText", "code"\]\)[\s\S]*return "Unknown error"/);
  assert.match(coachSource, /avoid_texts: compactPromptTexts\(existing, 40, 240\)/);
  assert.match(coachSource, /export function coachingUserPrompt\([\s\S]*const frames = promptFrameTexts\(training\);/);
  assert.match(coachSource, /export function drillGenUserPrompt\([\s\S]*const frames = promptFrameTexts\(training\);/);
  assert.match(coachSource, /function promptFrameTexts\(training: JsonObject\): string\[\] \{[\s\S]*!Array\.isArray\(item\)[\s\S]*stringValue\(item\)[\s\S]*replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(coachSource, /function compactPromptTexts\(values: unknown\[\], maxItems: number, maxLength: number\): string\[\] \{[\s\S]*items\.length >= maxItems/);
  assert.match(pipelineSource, /function frameTextsFromTraining\(training: JsonObject\): string\[\] \{[\s\S]*!Array\.isArray\(item\)[\s\S]*stringValue\(item\)[\s\S]*replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(pipelineSource, /export function nextDrillFromState\(state: TrainingState, errorTags: string\[\]\): string \{\s*const frames = frameTextsFromTraining\(state\.training\);/);
  assert.match(pipelineSource, /export function buildTranscriptionPrompt\(state: TrainingState, target\?: PracticeTarget\): string \{[\s\S]*const frames = frameTextsFromTraining\(state\.training\);/);
  assert.match(trainingRootSource, /export function isHttpUrl\(value: unknown\): boolean \{\s*return \/\^https\?:/);
  assert.match(trainingRootSource, /const date = stringValue\(item\.date\)\.trim\(\);[\s\S]*const status = stringValue\(item\.status\)\.trim\(\)\.toLowerCase\(\);[\s\S]*status === "completed"/);
  assert.match(localActionsSource, /function normalizedLocalPath\(value: unknown\): string \{[\s\S]*stringValue\(value\)\.trim\(\)[\s\S]*expandHomePath\(text\)/);
  assert.match(localActionsSource, /function commandFailureSummary\(result: \{ code: number \| null; stdout: string; stderr: string \}\): string \{[\s\S]*exit code \$\{result\.code \?\? "unknown"\} with no output/);
  assert.match(coreSource, /export function resolveFfmpegPath\(\): string \{\s*const configured = expandHomePath\(configString\("nativeRecorderFfmpegPath", "ffmpeg"\)\);/);
  assert.match(settingsSource, /export function pythonPath\(\): string \{\s*return expandHomePath\(configString\("pythonPath", "python3"\)\);/);
  assert.match(settingsSource, /localMaterialsRoot: configString\("localMaterialsRoot"\)/);
  assert.match(settingsSource, /openaiTtsInstructions: configString\("openaiTtsInstructions"\)/);
  assert.match(settingsSource, /preferredMicrophoneName: configString\("preferredMicrophoneName"\)/);
  assert.match(settingsSource, /blockedMicrophoneNamePattern: configString\("blockedMicrophoneNamePattern", DEFAULT_BLOCKED_MICROPHONE_PATTERN\)/);
  assert.match(practiceViewSource, /const configuredRoot = expandHome\(configString\("localMaterialsRoot"\)\)/);
  assert.match(providerRoutesSource, /const configuredRoot = configString\("localMaterialsRoot"\)/);
  assert.match(stateSource, /const filePath = stringValue\(value\)\.trim\(\);[\s\S]*assets\[key\] = filePath/);
  assert.match(trainingRootSource, /function expandHome\(value: unknown\): string \{\s*return expandHomePath\(value\);/);
  assert.match(statusTreeSource, /function compactStatusValue\(value: unknown, maxLength = 48\): string \{[\s\S]*const text = stringValue\(value\);/);
  assert.match(pipelineSource, /const maxItems = Number\.isFinite\(limit\) && limit > 0 \? Math\.floor\(limit\) : 0;[\s\S]*for \(let index = lines\.length - 1; index >= 0 && recent\.length < maxItems; index -= 1\)/);
  assert.match(stateSource, /required_frames: positiveInteger\(task\.required_frames\)/);
  assert.match(stateSource, /const fallbackFrameText =[\s\S]*spokenFrameTexts\(training\.frames\)\[0\][\s\S]*stringValue\(training\.clean_tts_text\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\)/);
  assert.match(stateSource, /base_frame: fallbackFrameText/);
  assert.match(stateSource, /function cleanDrillExamples\(value: unknown\): unknown\[\] \{[\s\S]*item\.replace\(\/\\s\+\/g, " "\)\.trim\(\)[\s\S]*\{ \.\.\.obj, text \}/);
  assert.match(stateSource, /function cleanShadowingLoop\(value: unknown, training: JsonObject\): JsonObject \{[\s\S]*const chunks = cleanShadowingChunks\(obj\.chunks\)/);
});

test("runtime source files stay text-searchable", () => {
  assert.equal(nativeRecorderSource.includes("\u0000"), false, "native recorder source must not contain raw NUL bytes");
  assert.match(nativeRecorderSource, /join\("\\u0000"\)/);
  assert.match(nativeRecorderSource, /let nativeStartLock: Promise<void> = Promise\.resolve\(\)/);
  assert.match(nativeRecorderSource, /await previousStart;[\s\S]*startNativeFfmpegRecordingLocked/);
});

test("speech input manifest no longer exposes Azure", () => {
  const speechInput = packageJson.contributes.configuration.properties["englishTraining.audioUnderstandingProvider"];
  // Default switched from gemini → openai when the OpenAI stack became the
  // primary route in 0.1.38 (gpt-4o-transcribe with domain prompt).
  assert.equal(speechInput.default, "openai");
  assert.deepEqual(speechInput.enum, ["gemini", "openai", "qwen", "mimo"]);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechRegion"], undefined);
  assert.equal(packageJson.contributes.configuration.properties["englishTraining.azureSpeechLocale"], undefined);
  assert.equal(
    packageJson.contributes.commands.some((item) => item.command.includes("Azure")),
    false,
  );
});

test("OpenAI-first UX and packaging metadata stay aligned", () => {
  assert.equal(packageLock.version, packageJson.version);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(
    packageJson.contributes.configuration.properties["englishTraining.openaiTtsLanguage"],
    undefined,
    "OpenAI speech endpoint has no language field; do not expose a dead setting",
  );
  assert.match(mediaSource, /function routeKeyStatus/);
  assert.match(mediaSource, /function normalizeProviderForSetting/);
  assert.match(mediaSource, /function renderMissingSourceSetup/);
  assert.match(mediaSource, /value: "openai", label: "OpenAI", note: "default STT[\s\S]*modelSetting: "openaiFileTranscriptionModel", extraSetting: "openaiTranscriptionMode", extraLabel: "Mode"/);
  assert.match(mediaSource, /extraSettings: \[[\s\S]*setting: "openaiTtsVoice", label: "Voice"[\s\S]*setting: "openaiTtsInstructions", label: "Style"[\s\S]*setting: "openaiTtsResponseFormat", label: "Format"[\s\S]*\]/);
  assert.match(mediaSource, /function providerExtraSettings\(option\)/);
  assert.match(mediaSource, /function recorderSettingsHtml\(settings\)/);
  assert.match(mediaSource, /data-config-setting="recorderBackend"/);
  assert.match(mediaSource, /data-sidebar-command="selectMicrophone"/);
  assert.match(coachSource, /normalizedCoachProvider\(\)/);
  assert.match(transcribeSource, /normalizedSpeechInputProvider\(\)/);
  assert.match(transcribeSource, /normalizedOpenAITranscriptionMode\(\)/);
  assert.match(transcribeSource, /chatCompletionsUrl\(baseUrl\)/);
  assert.match(transcribeSource, /chatCompletionsUrl\(normalizedQwenCompatibleBaseUrl\(\)\)/);
  assert.match(transcribeSource, /configString\("mimoAudioBaseUrl", MIMO_OPENAI_BASE_URL\)/);
  assert.match(coachSource, /configString\("mimoAnthropicBaseUrl", MIMO_ANTHROPIC_BASE_URL\)/);
  assert.match(coachSource, /chatCompletionsUrl\(baseUrl\)/);
  assert.match(providerRoutesSource, /normalizedProviderName\(raw\)/);
  assert.match(providerRoutesSource, /const provider = normalizedProviderName\(value\)/);
  assert.match(providerRoutesSource, /function normalizedMigrationValue\(value: unknown\): string \{[\s\S]*\.trim\(\)\.toLowerCase\(\)/);
  assert.match(providerRoutesSource, /normalizedMigrationValue\(entry\[0\]\) === oldDefaultKey/);
  assert.match(providerRoutesSource, /const rawCurrent = settings\.get<unknown>\("ttsSpeed"\)/);
  assert.match(providerRoutesSource, /const currentIsCanonical = typeof rawCurrent === "number" && rawCurrent === clamped/);
  assert.match(providerRoutesSource, /const currentVoice = configString\("qwenTtsVoice", "Cherry"\)/);
  assert.match(providerRoutesSource, /Boolean\(\(await context\.secrets\.get\(secretKeys\.openai\) \|\| ""\)\.trim\(\)\)/);
  assert.match(coreSource, /await context\.secrets\.get\(secretKeys\[provider\]\)/);
  assert.match(coreSource, /process\.env\.DASHSCOPE_API_KEY/);
  assert.match(practiceViewSource, /normalizedProviderName\(payload\.value\)/);
  assert.match(settingsSource, /configString\("recorderBackend", "macLocal"\)\.toLowerCase\(\)/);
  assert.match(settingsSource, /configString\("mimoAnthropicBaseUrl", MIMO_ANTHROPIC_BASE_URL\)/);
  assert.match(settingsSource, /configString\("mimoAudioBaseUrl", MIMO_OPENAI_BASE_URL\)/);
  assert.match(settingsSource, /configString\("mimoTtsBaseUrl", MIMO_OPENAI_BASE_URL\)/);
  assert.match(settingsSource, /normalizedQwenCompatibleBaseUrl\(\)/);
  assert.match(settingsSource, /normalizedQwenAudioUnderstandingModel\(\)/);
  assert.match(ttsSource, /normalizedOpenAITtsResponseFormat\(\)/);
  assert.match(ttsSource, /normalizedProviderName\(provider\)/);
  assert.match(ttsSource, /fetchWithTimeout\(normalizedQwenTtsEndpoint\(\)/);
  assert.match(ttsSource, /language_type: normalizedQwenTtsLanguageType\(\)/);
  assert.match(ttsSource, /qwenSupportsInstructions\(model\)/);
  assert.match(ttsSource, /output\.audio\.data or output\.audio\.url/);
  assert.match(ttsSource, /configString\("mimoTtsBaseUrl", MIMO_OPENAI_BASE_URL\)/);
  assert.match(ttsSource, /chatCompletionsUrl\(baseUrl\)/);
  assert.match(ttsSource, /provider = normalizedTtsProvider\(\)/);
  assert.match(pipelineSource, /const ttsProvider = normalizedTtsProvider\(\)/);
  assert.match(audioSynthesisSource, /const provider = normalizedTtsProvider\(\)/);
  assert.match(ttsSource, /normalizedOpenAITtsVoice\(\)/);
  assert.match(ttsSource, /const voiceName = normalizedGeminiTtsVoice\(\)/);
  assert.match(ttsSource, /const voice = normalizedMimoTtsVoice\(\)/);
  assert.match(mediaSource, /function recorderBackend\(\) \{[\s\S]*scalarField\(settings, "recorderBackend"\)\.toLowerCase\(\)[\s\S]*backend === "maclocal"[\s\S]*backend === "webview"[\s\S]*backend === "auto"[\s\S]*: "macLocal"/);
  assert.match(mediaSource, /const backend = recorderBackend\(\);[\s\S]*if \(backend === "macLocal"\) \{[\s\S]*startNativeRecording\("Using Mac local microphone\."\);/);
  assert.match(mediaSource, /if \(backend === "auto"\) \{[\s\S]*startNativeRecording\("Webview recorder unavailable\."\);/);
  assert.match(mediaSource, /Switch recorder backend to Auto or macLocal/);
  assert.match(mediaSource, /const fallbackToNative = backend === "auto"/);
  assert.match(mediaSource, /if \(fallbackToNative && \(!constraints \|\| !constraints\.deviceId\)\) \{[\s\S]*startNativeRecording\("Webview recorder could not find a local microphone\."\);/);
  assert.match(mediaSource, /const WEBVIEW_RECORDER_AUDIO_BITS_PER_SECOND = 128000/);
  assert.match(mediaSource, /const WEBVIEW_RECORDER_TIMESLICE_MS = 1000/);
  assert.match(mediaSource, /function webviewAudioConstraints\(\) \{[\s\S]*echoCancellation: \{ ideal: false \}[\s\S]*noiseSuppression: \{ ideal: false \}[\s\S]*autoGainControl: \{ ideal: false \}[\s\S]*channelCount: \{ ideal: 1 \}[\s\S]*sampleRate: \{ ideal: 48000 \}[\s\S]*sampleSize: \{ ideal: 16 \}/);
  assert.match(mediaSource, /function webviewRecorderOptions\(mimeType\) \{[\s\S]*audioBitsPerSecond: WEBVIEW_RECORDER_AUDIO_BITS_PER_SECOND[\s\S]*if \(mimeType\) options\.mimeType = mimeType/);
  assert.match(mediaSource, /function webviewMimeTypeSupported\(mimeType\) \{[\s\S]*typeof MediaRecorder\.isTypeSupported === "function"[\s\S]*MediaRecorder\.isTypeSupported\(mimeType\)/);
  assert.match(mediaSource, /function createWebviewMediaRecorder\(mediaStream\) \{[\s\S]*"audio\/webm;codecs=opus"[\s\S]*\.find\(webviewMimeTypeSupported\)[\s\S]*new MediaRecorder\(mediaStream, webviewRecorderOptions\(mimeType\)\)[\s\S]*new MediaRecorder\(mediaStream, \{ mimeType \}\)[\s\S]*catch \(_\)[\s\S]*new MediaRecorder\(mediaStream\);/);
  assert.match(mediaSource, /function stopWebviewStreamTracks\(mediaStream\) \{[\s\S]*typeof mediaStream\.getTracks !== "function"[\s\S]*typeof track\.stop === "function"[\s\S]*track\.stop\(\);[\s\S]*catch \(_\)/);
  assert.match(extensionSource, /function configSettingEffectiveValue\(setting: ConfigSettingName, fallback: string\): string \{[\s\S]*normalizedOpenAITranscriptionMode\(\)[\s\S]*normalizedOpenAITtsResponseFormat\(\)[\s\S]*normalizedRecorderBackend\(\)[\s\S]*normalizedOpenAITtsVoice\(\)[\s\S]*normalizedGeminiTtsVoice\(\)[\s\S]*normalizedMimoTtsVoice\(\)/);
  assert.match(extensionSource, /function configSettingAllowsBlank\(setting: ConfigSettingName\): boolean \{[\s\S]*openaiTtsInstructions/);
  assert.match(extensionSource, /function configSettingAllowsCustom\(setting: ConfigSettingName\): boolean \{[\s\S]*openaiTranscriptionMode[\s\S]*openaiTtsResponseFormat[\s\S]*recorderBackend[\s\S]*openaiTtsVoice[\s\S]*geminiTtsVoice[\s\S]*mimoTtsVoice/);
  assert.match(mediaSource, /value: "mimo", label: "MiMo", note: "Xiaomi audio understanding", modelSetting: "mimoAudioUnderstandingModel"/);
  assert.match(mediaSource, /value: "qwen", label: "Qwen"[\s\S]*modelSetting: "qwenCoachModel"/);
  assert.match(mediaSource, /value: "qwen", label: "Qwen-ASR"[\s\S]*modelSetting: "qwenAudioUnderstandingModel"/);
  assert.match(mediaSource, /value: "qwen"[\s\S]*label: "Qwen-TTS"[\s\S]*modelSetting: "qwenTtsModel"[\s\S]*setting: "qwenTtsLanguageType", label: "Language"/);
  assert.match(mediaSource, /value: "mimo", label: "MiMo", note: "Xiaomi voices", modelSetting: "mimoTtsModel", extraSetting: "mimoTtsVoice"/);
  assert.match(mediaSource, /Recorder started after a delay/);
  assert.match(mediaSource, /recorderMode = "native"/);
  assert.match(mediaSource, /function startTimer\(\) \{[\s\S]*setTimerText\("00:00"\)[\s\S]*setTimerText\(m \+ ":" \+ s\)/);
  assert.match(mediaSource, /function setTimerText\(text\) \{[\s\S]*const timer = \$\("timer"\);[\s\S]*if \(timer\) timer\.textContent = text;/);
  assert.match(mediaSource, /function setRecording\(active\) \{[\s\S]*const btn = \$\("record"\);[\s\S]*if \(!btn\) return;[\s\S]*btn\.classList\.toggle\("recording", active\)/);
  assert.match(mediaSource, /function setBusy\(active, label\) \{[\s\S]*const btn = \$\("record"\);[\s\S]*if \(btn\) \{[\s\S]*btn\.classList\.toggle\("busy", active\)[\s\S]*btn\.disabled = active \|\| recordingBlockedBySetup;[\s\S]*if \(label\) setStatus/);
  assert.match(mediaSource, /try \{\s*mediaRecorder\.start\(WEBVIEW_RECORDER_TIMESLICE_MS\);\s*\} catch \(error\) \{[\s\S]*recorderMode = null;[\s\S]*resetWebviewCapture\(\);[\s\S]*fallbackToNativeRecording\(error\);[\s\S]*return;[\s\S]*\}/);
  assert.match(mediaSource, /let nativeStartRequestSeq = 0/);
  assert.match(mediaSource, /let practiceRequestSeq = 0/);
  assert.match(mediaSource, /let activePracticeRequestId = 0/);
  assert.match(mediaSource, /let stageHideTimer = null/);
  assert.match(mediaSource, /function clearStageHideTimer/);
  assert.match(mediaSource, /function scheduleStageHide\(delayMs\)/);
  assert.match(mediaSource, /function showStages\(visible, resetVisible = true\) \{\s*clearStageHideTimer\(\);[\s\S]*const stages = \$\("stages"\);[\s\S]*if \(!stages\) return;/);
  assert.match(mediaSource, /function showStages\(visible, resetVisible = true\) \{[\s\S]*stages\.hidden = !visible;[\s\S]*if \(!visible\) \{[\s\S]*resetStages\(\);[\s\S]*return;[\s\S]*\}/);
  assert.match(mediaSource, /function stageName\(value\) \{[\s\S]*return STAGES\.includes\(name\) \? name : "";/);
  assert.match(mediaSource, /function stageStatus\(value, fallback = "active"\) \{[\s\S]*return text === "active" \|\| text === "done" \? text : fallback;/);
  assert.match(mediaSource, /function setStage\(stage, status\) \{[\s\S]*const name = stageName\(stage\);[\s\S]*const nextStatus = stageStatus\(status\);[\s\S]*data-stage="' \+ name \+ '"/);
  assert.match(mediaSource, /scheduleStageHide\(1500\)/);
  assert.match(mediaSource, /function isCurrentNativeStartMessage/);
  assert.match(mediaSource, /function isCurrentNativeStartMessage\(message\) \{[\s\S]*positiveInteger\(message && message\.requestId\)/);
  assert.match(mediaSource, /return requestId > 0 && requestId === activeNativeStartRequestId/);
  assert.match(mediaSource, /function activeTurnMessageRequestId\(message\) \{[\s\S]*requestId === activePracticeRequestId \|\| requestId === activeNativeStartRequestId/);
  assert.match(mediaSource, /function clearActiveTurnRequestId\(requestId\) \{[\s\S]*if \(requestId === activePracticeRequestId\) activePracticeRequestId = 0;[\s\S]*if \(requestId === activeNativeStartRequestId\) activeNativeStartRequestId = 0;/);
  assert.match(mediaSource, /function isCurrentTurnErrorMessage\(message\) \{[\s\S]*if \(!requestId\) return true;[\s\S]*requestId === activeNativeStartRequestId \|\| requestId === activePracticeRequestId/);
  assert.match(mediaSource, /function isCurrentStageMessage\(message\) \{[\s\S]*return !requestId \|\| requestId === activePracticeRequestId \|\| requestId === activeNativeStartRequestId;/);
  assert.match(mediaSource, /type: "startNativeRecording", practiceTarget, priorTurn, requestId/);
  assert.match(mediaSource, /vscode\.postMessage\(\{ type: "stopNativeRecording", requestId \}\)/);
  assert.match(mediaSource, /const requestId = \+\+practiceRequestSeq;\s*activePracticeRequestId = requestId;\s*vscode\.postMessage\(\{ type: "practiceAudio", mimeType, base64, priorTurn, practiceTarget, requestId \}\)/);
  assert.match(mediaSource, /if \(message\.type === "practiceResult"\) \{[\s\S]*const requestId = activeTurnMessageRequestId\(message\);[\s\S]*if \(message\.requestId && !requestId\) return;[\s\S]*if \(requestId\) clearActiveTurnRequestId\(requestId\);/);
  assert.match(mediaSource, /if \(message\.type === "stage"\) \{\s*if \(!isCurrentStageMessage\(message\)\) return;/);
  assert.match(mediaSource, /if \(!isCurrentNativeStartMessage\(message\)\) return;[\s\S]*clearNativeStartWatchdog\(\)/);
  assert.match(mediaSource, /nativeStartWatchdog = setTimeout\(\(\) => \{[\s\S]*setBusy\(false\);\s*clearPendingPracticeContexts\(true\);[\s\S]*The Mac local recorder did not start/);
  assert.match(practiceViewSource, /startNativeRecording\(\s*practiceTarget: PracticeTarget \| undefined,\s*priorTurn: CoachPriorTurn \| undefined,\s*requestId: number,/);
  assert.match(practiceViewSource, /const request = \{ requestId \}/);
  assert.match(practiceViewSource, /type: "nativeRecordingStarted",\s*\.\.\.request/);
  assert.match(practiceViewSource, /await this\.stopNativeRecording\(positiveRequestId\(payload\.requestId\)\)/);
  assert.match(practiceViewSource, /payload\.type === "startNativeRecording" \|\| payload\.type === "practiceAudio" \|\| payload\.type === "stopNativeRecording"/);
  assert.match(practiceViewSource, /stageReporter\(view = this\.view, requestId = 0\): StageReporter \{[\s\S]*\.\.\.\(requestId \? \{ requestId \} : \{\}\)/);
  assert.match(practiceViewSource, /type: "stage",\s*stage: "transcribe",\s*status: "active",\s*show: true,\s*\.\.\.\(requestId \? \{ requestId \} : \{\}\)/);
  assert.match(practiceViewSource, /processPracticeAudio\(this\.context, message, this\.stageReporter\(view, requestId\), priorTurn, practiceTarget\)/);
  assert.match(practiceViewSource, /const requestId = positiveRequestId\(message\.requestId\);[\s\S]*postPracticeResult\(view, result, \{ priorTurn, practiceTarget, requestId \}\)/);
  assert.match(practiceViewSource, /stopNativeRecording\(requestId = 0\): Promise<void>[\s\S]*this\.stageReporter\(view, requestId\)[\s\S]*postPracticeResult\(view, result, \{[\s\S]*requestId,/);
  assert.match(practiceViewSource, /\.\.\.\(options\.requestId \? \{ requestId: options\.requestId \} : \{\}\)/);
  assert.match(mediaSource, /followup-drill\.json/);
  assert.match(mediaSource, /drill workbench is using fallback lines/);
  assert.match(mediaSource, /progress\/english-speaking-training-progress\.json/);
  assert.match(mediaSource, /progress may look incomplete/);
  assert.match(mediaSource, /manifest\.json/);
  assert.match(mediaSource, /reading-card asset paths are using default package filenames/);
  assert.match(mediaSource, /function resetTransientActionBusyState/);
  assert.match(mediaSource, /function resetTransientActionBusyState\(errorText\) \{[\s\S]*clearTransientAudioRequests\(\);[\s\S]*restoreSlowReadButtons\(\);/);
  assert.match(mediaSource, /function clearLocalAudioSource/);
  assert.match(mediaSource, /const objectValue = \(value\) => value && typeof value === "object" && !Array\.isArray\(value\) \? value : null/);
  assert.match(mediaSource, /const textField = \(obj, key\) => obj && typeof obj\[key\] === "string" \? obj\[key\]\.trim\(\) : ""/);
  assert.match(mediaSource, /const scalarText = \(value\) => \{[\s\S]*typeof value === "number" \|\| typeof value === "boolean"[\s\S]*return "";\s*\}/);
  assert.match(mediaSource, /const positiveInteger = \(value\) => \{[\s\S]*Number\.isInteger\(parsed\) && parsed > 0 \? parsed : 0/);
  assert.match(mediaSource, /const normalizedTtsSpeed = \(value, fallback = 0\.9\) => \{[\s\S]*Math\.max\(0\.5, Math\.min\(1\.5, Number\(speed\.toFixed\(2\)\)\)\)/);
  assert.match(mediaSource, /function compactStatusText\(value, fallback\) \{[\s\S]*scalarText\(value\) \|\| fallback \|\| ""[\s\S]*text\.length > 260/);
  assert.match(mediaSource, /function setStatus\(text, tone\) \{[\s\S]*if \(!el\) return;[\s\S]*compactStatusText\(/);
  assert.match(mediaSource, /const scalarField = \(obj, key\) => obj \? scalarText\(obj\[key\]\) : ""/);
  assert.match(mediaSource, /const textList = \(value\) => Array\.isArray\(value\)[\s\S]*\.filter\(Boolean\)/);
  assert.match(mediaSource, /function addElementListener\(id, eventName, handler\) \{[\s\S]*const element = \$\(id\);[\s\S]*if \(!element\) return null;[\s\S]*element\.addEventListener\(eventName, handler\);[\s\S]*return element;/);
  assert.match(mediaSource, /const firstTextField = \(obj, \.\.\.keys\) => \{[\s\S]*for \(const key of keys\)[\s\S]*return "";/);
  assert.match(mediaSource, /const firstTextList = \(obj, \.\.\.keys\) => \{[\s\S]*const items = textList\(obj && obj\[key\]\)[\s\S]*return \[\];/);
  assert.match(coreSource, /function extractOpenAIText[\s\S]*for \(const choice of choices\)/);
  assert.match(coreSource, /function extractGeminiText[\s\S]*for \(const candidate of candidates\)/);
  assert.match(mediaSource, /function normalizePracticeDrillExamples\(value\)[\s\S]*const text = scalarField\(source, "text"\)[\s\S]*source: scalarField\(source, "source"\) \|\| "coach"/);
  assert.match(mediaSource, /function normalizePracticeResult\(value\) \{[\s\S]*nativeVersion: firstTextField\(result, "nativeVersion", "native_version"\)[\s\S]*quickFix: firstTextField\(result, "quickFix", "quick_fix"\)[\s\S]*errorTags: firstTextList\(result, "errorTags", "error_tags"\)[\s\S]*audioUri: firstTextField\(result, "audioUri", "audio_uri"\)[\s\S]*localAudioUri: firstTextField\(result, "localAudioUri", "local_audio_uri"\)[\s\S]*priorTurn: objectValue\(result\.priorTurn\)/);
  assert.match(mediaSource, /function practiceTarget\(referenceText, referenceLabel, followUpQuestion\) \{[\s\S]*const text = compactScalarText\(referenceText\);[\s\S]*referenceLabel: scalarText\(referenceLabel\) \|\| "Reference",[\s\S]*followUpQuestion: compactScalarText\(followUpQuestion\)/);
  assert.match(mediaSource, /const turnAudioObjectUrls = new Set\(\)/);
  assert.match(mediaSource, /const MAX_TURN_HISTORY = 12/);
  assert.match(mediaSource, /function retainLocalAudioForTurnHistory\(src\)/);
  assert.match(mediaSource, /function clearTurnAudioObjectUrls\(\)/);
  assert.match(mediaSource, /function pruneTurnHistory\(\) \{[\s\S]*turnHistory\.length > MAX_TURN_HISTORY[\s\S]*URL\.revokeObjectURL\(audioUrl\)/);
  assert.match(mediaSource, /retainLocalAudioForTurnHistory\(localAudioFallback\)/);
  assert.match(mediaSource, /const nativeVersion = compactScalarText\(r\.nativeVersion\);[\s\S]*const followUpQuestion = compactScalarText\(r\.followUpQuestion\);[\s\S]*const transcript = compactScalarText\(r\.transcript\);[\s\S]*lastTurn = \{[\s\S]*nativeVersion,[\s\S]*followUpQuestion,[\s\S]*transcript,/);
  assert.match(mediaSource, /turnHistory\.push\(\{[\s\S]*timestamp: Date\.now\(\),[\s\S]*\}\);\s*pruneTurnHistory\(\);/);
  assert.match(mediaSource, /clearTurnAudioObjectUrls\(\);\s*turnHistory = \[\]/);
  assert.match(mediaSource, /function clearTransientAudioRequests/);
  assert.match(mediaSource, /function removeSlowReadAudioPlayer/);
  assert.match(mediaSource, /function clearPendingPracticeContexts/);
  assert.match(mediaSource, /function stageLessonResetForRender\(nextInfo, trainingInfo, line\) \{[\s\S]*pendingReplyContext = null;[\s\S]*clearTransientAudioRequests\(\);[\s\S]*return true;/);
  assert.match(mediaSource, /function commitLessonResetAfterRender\(didReset\) \{[\s\S]*clearPendingPracticeContexts\(true\);[\s\S]*clearTodayGeneratedAudio\(\);/);
  assert.match(mediaSource, /function resetTransientActionBusyState\(errorText\) \{[\s\S]*clearTransientAudioRequests\(\);[\s\S]*restoreSlowReadButtons\(\);/);
  assert.match(mediaSource, /function commitLessonResetAfterRender\(didReset\) \{[\s\S]*clearTodayGeneratedAudio\(\);[\s\S]*clearLocalAudioSource\(\);[\s\S]*removeSlowReadAudioPlayer\(\);/);
  assert.match(mediaSource, /function handleStateMessage\(nextState\) \{[\s\S]*try \{[\s\S]*renderState\(nextState\);[\s\S]*resetRefreshBusyState\(\);[\s\S]*\} catch \(error\) \{[\s\S]*Could not render updated lesson state/);
  assert.match(mediaSource, /function renderState\(nextState\) \{[\s\S]*const previousState = state;[\s\S]*const previousRenderContext = \{[\s\S]*currentExampleText,[\s\S]*currentLessonKey,[\s\S]*recordingBlockedBySetup,[\s\S]*turnHistory,[\s\S]*\};[\s\S]*State payload was not an object\.[\s\S]*state = previousState;[\s\S]*currentExampleText = previousRenderContext\.currentExampleText;[\s\S]*recordingBlockedBySetup = previousRenderContext\.recordingBlockedBySetup;[\s\S]*turnHistory = previousRenderContext\.turnHistory;[\s\S]*throw error;/);
  assert.match(mediaSource, /const next = objectValue\(state\.next\) \|\| \{\};[\s\S]*const training = objectValue\(state\.training\) \|\| \{\};[\s\S]*const assets = objectValue\(next\.assets\) \|\| \{\};/);
  assert.match(mediaSource, /function startRecording\(\) \{\s*clearProcessingWatchdog\(\);\s*clearLocalAudioSource\(\);/);
  assert.match(mediaSource, /const resetWebviewCapture = \(\) => \{[\s\S]*if \(mediaRecorder\) \{[\s\S]*mediaRecorder\.ondataavailable = null;[\s\S]*mediaRecorder\.onstop = null;[\s\S]*\}[\s\S]*stopWebviewStreamTracks\(stream\);/);
  assert.match(mediaSource, /const recordingChunks = \[\];[\s\S]*mediaRecorder\.ondataavailable = \(event\) => \{[\s\S]*recordingChunks\.push\(event\.data\)[\s\S]*new Blob\(recordingChunks, \{ type: mimeType \}\)/);
  assert.doesNotMatch(mediaSource, /\blet chunks\b/);
  assert.match(mediaSource, /startRecording\(\)\s*\.catch\(recoverStartRecordingFailure\)/);
  assert.match(mediaSource, /function abortWebviewRecorder\(\) \{[\s\S]*if \(mediaRecorder\) \{[\s\S]*mediaRecorder\.ondataavailable = null;[\s\S]*mediaRecorder\.onstop = null;/);
  assert.match(mediaSource, /function abortWebviewRecorder\(\) \{[\s\S]*stopWebviewStreamTracks\(stream\);[\s\S]*stream = null;[\s\S]*mediaRecorder = null;/);
  assert.match(mediaSource, /function recoverStartRecordingFailure\(error\) \{[\s\S]*clearNativeStartWatchdog\(\);[\s\S]*abortWebviewRecorder\(\);[\s\S]*clearPendingPracticeContexts\(true\);[\s\S]*showStages\(false\);/);
  assert.match(mediaSource, /clearPendingPracticeContexts\(true\);\s*resetTransientActionBusyState\(""\);\s*clearLocalAudioSource\(\);\s*removeSlowReadAudioPlayer\(\);/);
  assert.match(mediaSource, /function renderResult\(result\) \{\s*removeSlowReadAudioPlayer\(\);/);
  assert.match(mediaSource, /clearPendingPracticeContexts\(true\);[\s\S]*showStages\(false\)/);
  assert.match(mediaSource, /Practice result was malformed\. Try again\./);
  assert.match(mediaSource, /const r = normalizePracticeResult\(message\.result\);\s*if \(!r\)/);
  assert.match(mediaSource, /const localAudio = \$\("localAudio"\);\s*const localAudioFallback = r\.localAudioUri \|\| \(localAudio \? localAudio\.src : ""\)/);
  assert.match(mediaSource, /showStages\(false\);\s*clearPendingPracticeContexts\(true\);\s*setStatus\(\(error && error\.message\) \|\| String\(error\), "error"\);/);
  assert.match(mediaSource, /const firstScalarField = \(obj, \.\.\.keys\) => \{[\s\S]*const text = scalarField\(obj, key\);[\s\S]*if \(text\) return text;/);
  assert.match(mediaSource, /function lessonIdentity\(nextInfo, trainingInfo, line\) \{[\s\S]*const diag = objectValue\(state && state\.sourceDiagnostics\) \|\| \{\};[\s\S]*json: scalarField\(diag, "currentJson"\),[\s\S]*goal: firstScalarField\(trainingInfo, "goal"\) \|\| firstScalarField\(nextInfo, "goal"\),[\s\S]*line: scalarText\(line\)/);
  assert.match(mediaSource, /const todayAudioText = firstScalarField\(training, "tts_example_text", "clean_tts_text", "audio_text", "demo_line"\)/);
  assert.match(mediaSource, /<span class="chip">\$\{esc\(scalarField\(state, "source"\) \|\| "local"\)\}<\/span>[\s\S]*shortSourceLabel\(scalarField\(state, "sourceLabel"\)\)/);
  assert.match(mediaSource, /function frames\(value\) \{[\s\S]*const items = frameTextList\(value\);[\s\S]*No frames\.[\s\S]*items\.map/);
  assert.match(mediaSource, /function frameTextList\(value\) \{[\s\S]*const obj = objectValue\(item\);[\s\S]*const text = obj \? scalarField\(obj, "text"\) : scalarText\(item\);[\s\S]*text\.replace\(\/\\s\+\/g, " "\)\.trim\(\);/);
  assert.match(mediaSource, /function simpleList\(value\) \{[\s\S]*const items = scalarTextList\(value\);[\s\S]*items\.map/);
  assert.match(mediaSource, /const compactScalarText = \(value\) => scalarText\(value\)\.replace\(\/\\s\+\/g, " "\)\.trim\(\);/);
  assert.match(mediaSource, /function scalarTextList\(value\) \{[\s\S]*compactScalarText\(item\)\)\.filter\(Boolean\)/);
  assert.match(mediaSource, /function recentSessions\(value\) \{[\s\S]*const sessions = Array\.isArray\(value\) \? value\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\) : \[\];[\s\S]*scalarField\(item, "native_version"\)/);
  assert.match(mediaSource, /function prosodyLineBlockHtml\(training, line\) \{[\s\S]*rawGroups\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\)[\s\S]*wl\.words\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\)/);
  assert.match(mediaSource, /function prosodyGroupLineHtml\(groups, words\) \{[\s\S]*const id = scalarField\(group, "id"\) \|\| String\(index \+ 1\);[\s\S]*const tokens = scalarField\(group, "text"\)\.split/);
  assert.match(mediaSource, /function prosodyGroupsHtml\(wordLevel\) \{[\s\S]*wordLevel\.groups\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\)[\s\S]*scalarField\(group, "text"\)/);
  assert.match(mediaSource, /function prosodyWordsHtml\(wordLevel\) \{[\s\S]*wordLevel\.words\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\)[\s\S]*scalarField\(word, "group"\) \|\| "all"/);
  assert.match(mediaSource, /function drillRounds\(value\) \{[\s\S]*const obj = objectValue\(round\);[\s\S]*const text = example \? compactScalarField\(example, "text"\) : compactScalarText\(item\);/);
  assert.match(mediaSource, /function shadowing\(value\) \{[\s\S]*const obj = objectValue\(value\);[\s\S]*scalarTextList\(obj\.chunks\)/);
  assert.match(mediaSource, /function renderDrillPanel\(\) \{[\s\S]*const drill = objectValue\(state && state\.drill\) \|\| \{\};[\s\S]*const tags = scalarTextList\(drill\.primary_tags\)/);
  assert.match(mediaSource, /function renderSourceDiagnostics\(diagnostics\) \{[\s\S]*const value = objectValue\(diagnostics\) \|\| \{\};[\s\S]*\["Current JSON", scalarField\(value, "currentJson"\)\][\s\S]*scalarField\(value, "packageJsonError"\)/);
  assert.match(mediaSource, /function renderTodayHero\(ctx\) \{[\s\S]*const next = objectValue\(ctx && ctx\.next\) \|\| \{\};[\s\S]*const line = scalarText\(ctx && ctx\.todayAudioText\);[\s\S]*const goal = firstScalarField\(training, "goal"\) \|\| firstScalarField\(next, "goal", "completion_label"\)/);
  assert.match(mediaSource, /function shortSourceLabel\(value\) \{[\s\S]*const text = scalarText\(value\);/);
  assert.match(mediaSource, /function renderOnboarding\(currentState\) \{[\s\S]*const progress = objectValue\(currentState && currentState\.progress\) \|\| \{\};[\s\S]*const lessonCount = positiveInteger\(progress\.total\);/);
  assert.match(mediaSource, /function renderProgress\(progress\) \{[\s\S]*const value = objectValue\(progress\) \|\| \{\};[\s\S]*const cells = Array\.isArray\(value\.cells\) \? value\.cells\.map\(\(cell\) => objectValue\(cell\)\)\.filter\(Boolean\) : \[\];[\s\S]*const total = positiveInteger\(value\.total\) \|\| cells\.length/);
  assert.match(mediaSource, /function progressCellStatus\(cell\) \{[\s\S]*return \["completed", "current", "missed", "pending"\]\.includes\(status\) \? status : "pending";/);
  assert.match(mediaSource, /function renderDayStrip\(ctx\) \{[\s\S]*const progress = objectValue\(ctx && ctx\.progress\) \|\| \{\};[\s\S]*const cells = Array\.isArray\(progress\.cells\) \? progress\.cells\.map\(\(cell\) => objectValue\(cell\)\)\.filter\(Boolean\) : \[\];/);
  assert.match(mediaSource, /function stageLessonResetForRender\(nextInfo, trainingInfo, line\) \{[\s\S]*clearTransientAudioRequests\(\);[\s\S]*return true;/);
  assert.match(mediaSource, /function commitLessonResetAfterRender\(didReset\) \{[\s\S]*clearTurnAudioObjectUrls\(\);[\s\S]*clearPendingPracticeContexts\(true\);[\s\S]*clearTodayGeneratedAudio\(\);[\s\S]*clearLocalAudioSource\(\);[\s\S]*clearDrillLineWatchdog\(\);[\s\S]*showStages\(false\);/);
  assert.match(mediaSource, /const lessonDidReset = stageLessonResetForRender\(next, training, todayAudioText\);[\s\S]*commitLessonResetAfterRender\(lessonDidReset\);/);
  assert.match(practiceViewSource, /refreshAfterPracticeResult\(\)/);
  assert.match(practiceViewSource, /Practice result posted, but follow-up refresh failed/);
  assert.match(practiceViewSource, /if \(this\.view && this\.view !== view\) \{[\s\S]*release the native microphone before adopting the new webview\.[\s\S]*killActiveNativeRecording\(\);/);
  assert.match(nativeRecorderSource, /export function killNativeRecordingSession\(session: NativeRecordingSession\): void \{[\s\S]*nativeRecording === session[\s\S]*session\.process\.kill\("SIGTERM"\)/);
  assert.match(practiceViewSource, /if \(this\.view !== view\) \{\s*killNativeRecordingSession\(session\);\s*return;\s*\}/);
  assert.match(practiceViewSource, /resolveWebviewView\(view: vscode\.WebviewView\): void \{[\s\S]*\/\/ A resolved webview starts with fresh in-page state\.[\s\S]*this\.pendingPriorTurn = undefined;/);
  assert.match(practiceViewSource, /onDidReceiveMessage\(\(message: unknown\) => \{[\s\S]*void this\.handleMessage\(view, message\);[\s\S]*\}\);\s*view\.webview\.html = this\.html\(view\.webview\)/);
  assert.match(practiceViewSource, /killActiveNativeRecording\(\);\s*this\.pendingPriorTurn = undefined;\s*this\.view = undefined;/);
  assert.match(scaffoldSource, /fs\.rmSync\(filePath, \{ recursive: true, force: true \}\)/);
  assert.match(practiceViewSource, /if \(\(payload\.type === "startNativeRecording" \|\| payload\.type === "practiceAudio" \|\| payload\.type === "stopNativeRecording"\) && this\.view === view\) \{\s*this\.pendingPriorTurn = undefined;\s*\}/);
  assert.match(practiceViewSource, /webviewFileUri\(view, result\.audioFile, "audio"\)/);
  assert.match(practiceViewSource, /Practice result \$\{label\} URI unavailable/);
  assert.match(practiceViewSource, /function positiveRequestId\(value/);
  assert.match(practiceViewSource, /function firstPayloadString\(obj: JsonObject \| undefined, \.\.\.keys: string\[\]\): string \{[\s\S]*stringValue\(obj\?\.\[key\]\)\.trim\(\)/);
  assert.match(practiceViewSource, /const referenceText = firstPayloadString\(obj, "referenceText", "reference_text"\)/);
  assert.match(practiceViewSource, /const nativeVersion = firstPayloadString\(obj, "nativeVersion", "native_version"\)/);
  assert.match(practiceViewSource, /setQwenTtsVoice\(voiceId\)/);
  assert.match(practiceViewSource, /function positiveScalarNumber\(value: unknown\): number \| undefined \{[\s\S]*typeof value === "number"[\s\S]*typeof value === "string" && value\.trim\(\)[\s\S]*Number\.isFinite\(parsed\) && parsed > 0/);
  assert.match(practiceViewSource, /const value = positiveScalarNumber\(payload\.value\)/);
  assert.match(practiceViewSource, /const speed = positiveScalarNumber\(payload\.speed\)/);
  assert.match(practiceViewSource, /const count = positiveScalarNumber\(payload\.count\)/);
  assert.match(practiceViewSource, /Slow-read request id was missing/);
  assert.match(practiceViewSource, /Example audio request id was missing/);
  assert.match(practiceViewSource, /Drill generation request id was missing/);
  assert.match(practiceViewSource, /Native recording request id was missing/);
  assert.match(stateSource, /function webviewAssetUri/);
  assert.match(stateSource, /Webview asset URI unavailable for \$\{key\}/);
  assert.match(stateSource, /const rounds = followupRounds && followupRounds\.length \? followupRounds : fallbackFrames/);
  assert.match(stateSource, /if \(!examples\.length && !baseFrame\.trim\(\)\) \{\s*return undefined;\s*\}/);
  assert.match(practiceViewSource, /Promise\.resolve\(view\.webview\.postMessage\(message\)\)\.catch/);
  assert.match(practiceViewSource, /catch \(error\) \{\s*appendOutput\(`Practice webview postMessage failed/);
  assert.match(mediaSource, /querySelectorAll\('\[data-slow-read\]'\)/);
  assert.match(mediaSource, /querySelectorAll\('\[data-drill-listen\]'\)/);
  assert.match(mediaSource, /drillGenerating = false/);
  assert.match(mediaSource, /function setupBlockMessage/);
  assert.match(mediaSource, /function isPracticeSetupReady/);
  assert.match(mediaSource, /function ttsActionBlockMessage/);
  assert.match(mediaSource, /function todayTtsBlockMessage/);
  assert.match(mediaSource, /let activeTodayTtsRequest = null/);
  assert.match(mediaSource, /function beginTodayTtsRequest/);
  assert.match(mediaSource, /function beginTodayTtsRequest\(button\) \{[\s\S]*if \(activeSlowReadRequest\) \{[\s\S]*Slow-read audio is still generating/);
  assert.match(mediaSource, /function beginSlowReadRequest\(button, busyLabel, host\) \{[\s\S]*if \(activeTodayTtsRequest\) \{[\s\S]*Example audio is still generating/);
  assert.match(mediaSource, /function renderSpeedChips\(settings\) \{[\s\S]*const current = normalizedTtsSpeed\(settings && settings\.ttsSpeed\)/);
  assert.match(mediaSource, /const AUDIO_REQUEST_STILL_WORKING_MS = 20000/);
  assert.match(mediaSource, /const AUDIO_REQUEST_HARD_TIMEOUT_MS = 100000/);
  assert.match(mediaSource, /let drillLineWatchdog = null/);
  assert.match(mediaSource, /function armDrillLineWatchdog/);
  assert.match(mediaSource, /armDrillLineWatchdog\(requestId\)/);
  assert.match(mediaSource, /function finishDrillLineRequest\(requestId\) \{[\s\S]*clearDrillLineWatchdog\(\);/);
  assert.match(mediaSource, /vscode\.postMessage\(\{ type: "todayTts", requestId \}\)/);
  assert.match(mediaSource, /setStatus\("Generating example audio…", "busy"\);\s*vscode\.postMessage\(\{ type: "todayTts", requestId \}\)/);
  assert.match(mediaSource, /function armTodayTtsWatchdogs\(requestId\) \{[\s\S]*if \(activeTodayTtsRequest !== requestId\) return;[\s\S]*Still generating example audio[\s\S]*AUDIO_REQUEST_STILL_WORKING_MS[\s\S]*Example audio took too long — press Generate audio to try again\.[\s\S]*AUDIO_REQUEST_HARD_TIMEOUT_MS/);
  assert.match(mediaSource, /function armTodayTtsWatchdogs\(requestId\) \{[\s\S]*finishTodayTtsRequest\(requestId\);[\s\S]*restoreSlowReadButtons\(\);[\s\S]*document\.querySelector\('\[data-action="today-tts"\]'\)/);
  assert.match(mediaSource, /function armSlowReadWatchdogs\(requestId, retryLabel\) \{[\s\S]*if \(!activeSlowReadRequest \|\| activeSlowReadRequest\.id !== requestId\) return;[\s\S]*Still generating slow-read audio[\s\S]*AUDIO_REQUEST_STILL_WORKING_MS[\s\S]*Slow-read audio took too long[\s\S]*AUDIO_REQUEST_HARD_TIMEOUT_MS/);
  assert.match(mediaSource, /function slowReadButtonDescriptor\(button\) \{[\s\S]*kind: "drill"[\s\S]*kind: "slow"/);
  assert.match(mediaSource, /function applyTransientAudioBusyState\(\) \{[\s\S]*activeTodayTtsRequest[\s\S]*querySelectorAll\('\[data-slow-read\], \[data-drill-listen\]'\)[\s\S]*activeSlowReadRequest[\s\S]*dataset\.transientDisabled = "1"/);
  assert.match(mediaSource, /renderSpeedChips\(settings\);\s*applyTransientAudioBusyState\(\);\s*applySidebarCommandBusyState\(\);/);
  assert.match(mediaSource, /armTodayTtsWatchdogs\(requestId\)/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId \|\| activeTodayTtsRequest !== requestId\) return/);
  assert.match(mediaSource, /const statusText = messageText\(message\.message, "Generating example audio…"\);[\s\S]*setStatus\(statusText, "busy"\)/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId \|\| !finishTodayTtsRequest\(requestId\)\) return;\s*restoreSlowReadButtons\(\);/);
  assert.match(mediaSource, /let activeSlowReadRequest = null/);
  assert.match(mediaSource, /let turnResetArmTimer = null/);
  assert.match(mediaSource, /function clearTurnResetArmTimer/);
  assert.match(mediaSource, /function showStages\(visible, resetVisible = true\)/);
  assert.match(mediaSource, /message\.type === "stage"[\s\S]*const name = stageName\(message\.stage\);[\s\S]*const status = stageStatus\(message\.status\);[\s\S]*const isFreshPipelineStart = name === "transcribe" && status === "active";[\s\S]*if \(name\) setStage\(name, status\);[\s\S]*if \(name\) armProcessingWatchdog\(\);/);
  assert.match(mediaSource, /function practiceTurnInProgress\(\) \{[\s\S]*classList\.contains\("busy"\)[\s\S]*recordTransition[\s\S]*nativeStarting[\s\S]*processingWatchdog[\s\S]*pipelineBusy[\s\S]*isRecording\(\)/);
  assert.match(mediaSource, /function blockIfPracticeTurnInProgress\(message\) \{[\s\S]*practiceTurnInProgress\(\)[\s\S]*setStatus\(message, "busy"\)/);
  assert.match(mediaSource, /function blockSetupChangeDuringPractice\(\) \{[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before changing setup\."\)[\s\S]*blockIfTransientActionInProgress\("changing setup"\)/);
  assert.match(mediaSource, /function blockPromptChangeDuringPractice\(\) \{[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before choosing another practice prompt\."\)[\s\S]*blockIfTransientActionInProgress\("choosing another practice prompt"\)/);
  assert.match(mediaSource, /function transientActionBlockMessage\(actionLabel\) \{[\s\S]*activeTodayTtsRequest[\s\S]*Example audio is still generating — wait for it to finish/);
  assert.match(mediaSource, /function transientActionBlockMessage\(actionLabel\) \{[\s\S]*activeSlowReadRequest[\s\S]*Slow-read audio is still generating — wait for it to finish/);
  assert.match(mediaSource, /function transientActionBlockMessage\(actionLabel\) \{[\s\S]*drillGenerating[\s\S]*Drill lines are still generating — wait for them to finish/);
  assert.match(mediaSource, /let refreshInFlight = false/);
  assert.match(mediaSource, /let refreshWatchdog = null/);
  assert.match(mediaSource, /function beginRefreshRequest\(button\)/);
  assert.match(mediaSource, /refreshWatchdog = setTimeout\(\(\) => \{[\s\S]*Refresh took too long — press ↻ to try again\./);
  assert.match(mediaSource, /function transientActionBlockMessage\(actionLabel\) \{[\s\S]*refreshInFlight[\s\S]*Refresh is still loading — wait for it to finish/);
  assert.match(mediaSource, /let activeSidebarCommandRequest = null/);
  assert.match(mediaSource, /function beginSidebarCommand\(button, label\)/);
  assert.match(mediaSource, /function finishSidebarCommand\(requestId\)/);
  assert.match(mediaSource, /"#openTask",\s*"#openFolder",/);
  assert.match(mediaSource, /function markSidebarCommandButton\(button\)/);
  assert.match(mediaSource, /activeSidebarCommandRequest = \{ id: requestId, label \};\s*markSidebarCommandButton\(button\);\s*applySidebarCommandBusyState\(\);/);
  assert.match(mediaSource, /function applySidebarCommandBusyState\(\)/);
  assert.match(mediaSource, /renderSpeedChips\(settings\);\s*applyTransientAudioBusyState\(\);\s*applySidebarCommandBusyState\(\);/);
  assert.match(mediaSource, /const datasetText = \(element, key\) => element && element\.dataset \? scalarText\(element\.dataset\[key\]\) : "";/);
  assert.match(mediaSource, /function renderProviderPanel\(settings, keys\) \{[\s\S]*const safeSettings = objectValue\(settings\) \|\| \{\};[\s\S]*const safeKeys = objectValue\(keys\) \|\| \{\};[\s\S]*providerRoleHtml\("Coach", "coachProvider", safeSettings, safeKeys\)/);
  assert.match(mediaSource, /function providerModelSummary\(setting, option, settings\) \{[\s\S]*const model = scalarField\(settings, modelSetting\);[\s\S]*\.map\(\(item\) => scalarField\(settings, item\.setting\)\)/);
  assert.match(mediaSource, /function normalizeProviderForSetting\(setting, raw\) \{[\s\S]*const provider = scalarText\(raw\)\.toLowerCase\(\);[\s\S]*provider === "qwen"/);
  assert.match(mediaSource, /function providerCardHtml\(setting, option, settings, keys\) \{[\s\S]*normalizeProviderForSetting\(setting, scalarField\(settings, setting\)\) === option\.value/);
  assert.match(mediaSource, /function providerKeySaved\(keys, provider\) \{[\s\S]*const safeKeys = objectValue\(keys\) \|\| \{\};[\s\S]*return safeKeys\[provider\] === true;/);
  assert.match(mediaSource, /function keyStripHtml\(keys\) \{[\s\S]*const saved = providerKeySaved\(safeKeys, name\)/);
  assert.match(mediaSource, /function recorderSettingsHtml\(settings\) \{[\s\S]*const backend = scalarField\(settings, "recorderBackend"\) \|\| "macLocal";[\s\S]*const mic = scalarField\(settings, "preferredMicrophoneName"\) \|\| "Auto \(prefer Mac built-in\)"/);
  assert.match(mediaSource, /renderQwenVoicePicker\(objectValue\(state && state\.settings\) \|\| safeSettings\);\s*applySidebarCommandBusyState\(\);/);
  assert.match(mediaSource, /function postSetupAction\(payload, label, button\)/);
  assert.match(mediaSource, /function postSidebarCommand\(command, label, button\)/);
  assert.match(mediaSource, /function postSidebarCommand\(command, label, button\) \{\s*return postSetupAction\(\{ type: "command", command \}, label, button\);\s*\}/);
  assert.match(mediaSource, /message\.type === "commandResult"/);
  assert.match(practiceViewSource, /private async runSidebarCommand/);
  assert.match(practiceViewSource, /type: "commandResult"/);
  assert.match(practiceViewSource, /command === "openTask"[\s\S]*runOptionalSidebarCommand\(view, command, requestId, \(\) => openCurrentTaskCard/);
  assert.match(practiceViewSource, /command === "openSessionFolder"[\s\S]*runOptionalSidebarCommand\(view, command, requestId, \(\) => openSessionFolder/);
  assert.match(practiceViewSource, /command === "openMaterialsGuide"[\s\S]*runOptionalSidebarCommand\(view, command, requestId, \(\) => openMaterialsGuide\(\)\)/);
  assert.match(practiceViewSource, /command === "selectMicrophone"[\s\S]*runSidebarCommand\(view, command, requestId, \(\) => selectRecordingMicrophone\(\)\)/);
  assert.match(practiceViewSource, /const rawProvider = stringValue\(payload\.provider\)\.trim\(\);[\s\S]*const provider = normalizedProviderName\(rawProvider\);[\s\S]*configureApiKey\(this\.context, provider\)/);
  assert.match(mediaSource, /function blockIfTransientActionInProgress\(actionLabel\) \{[\s\S]*transientActionBlockMessage\(actionLabel\)[\s\S]*setStatus\(message, "busy"\)/);
  assert.match(mediaSource, /function toggleRecording\(\) \{[\s\S]*if \(isRecording\(\)\) \{[\s\S]*stopRecording\(\);[\s\S]*return;[\s\S]*if \(blockIfTransientActionInProgress\("recording"\)\) return;[\s\S]*startRecording\(\)/);
  assert.match(mediaSource, /function startDrillPractice\(example\) \{[\s\S]*const text = compactScalarText\(example && example\.text\);[\s\S]*const label = scalarField\(example, "label"\) \|\| "FSI drill";[\s\S]*pendingPracticeTarget = practiceTarget\(text, label, ""\)/);
  assert.match(mediaSource, /data-loop-action[\s\S]*const action = datasetText\(trigger, "loopAction"\);[\s\S]*blockPromptChangeDuringPractice\(\)[\s\S]*const lastNativeVersion = compactScalarText\(lastTurn && lastTurn\.nativeVersion\);[\s\S]*const lastFollowUpQuestion = compactScalarText\(lastTurn && lastTurn\.followUpQuestion\);[\s\S]*type: "setReplyContext"/);
  assert.match(mediaSource, /function drillExampleFromTrigger\(trigger\) \{[\s\S]*Number\(datasetText\(trigger, "drillIndex"\)\)[\s\S]*compactScalarText\(datasetText\(trigger, "drillText"\)\)[\s\S]*datasetText\(trigger, "drillLabel"\) \|\| "FSI drill"/);
  assert.match(mediaSource, /\[data-drill-listen\]"[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before listening to another line\."\)[\s\S]*const exampleText = compactScalarText\(example && example\.text\);[\s\S]*type: "slowRead", text: exampleText/);
  assert.match(mediaSource, /\[data-drill-generate\]"[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before generating new drill lines\."\)[\s\S]*blockIfTransientActionInProgress\("generating new drill lines"\)[\s\S]*positiveInteger\(datasetText\(drillGenerateTrigger, "drillGenerate"\)\) \|\| 5[\s\S]*type: "generateDrillLines"/);
  assert.match(mediaSource, /\[data-slow-read\]"[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before generating slow-read audio\."\)[\s\S]*const target = datasetText\(slowTrigger, "slowRead"\);[\s\S]*type: "slowRead", text, target/);
  assert.match(mediaSource, /datasetText\(actionTrigger, "action"\) === "today-tts"[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before generating example audio\."\)[\s\S]*blockIfTransientActionInProgress\("generating example audio"\)[\s\S]*type: "todayTts", requestId/);
  assert.match(mediaSource, /button\[data-speed\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*Number\(datasetText\(button, "speed"\)\)[\s\S]*type: "setTtsSpeed"/);
  assert.match(mediaSource, /button\[data-voice-id\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*const voiceId = datasetText\(button, "voiceId"\);[\s\S]*if \(!voiceId\) return;[\s\S]*type: "setQwenVoice"/);
  assert.match(mediaSource, /#useOpenAIStack"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*type: "useOpenAIStack"/);
  assert.match(mediaSource, /\[data-key\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*const provider = datasetText\(keyTrigger, "key"\);[\s\S]*if \(!provider\) return;[\s\S]*type: "configureKey"/);
  assert.match(mediaSource, /\[data-provider-setting\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*const setting = datasetText\(providerTrigger, "providerSetting"\);[\s\S]*const value = datasetText\(providerTrigger, "providerValue"\);[\s\S]*if \(!setting \|\| !value\) return;[\s\S]*type: "setProvider"/);
  assert.match(mediaSource, /\[data-config-setting\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*const setting = datasetText\(configTrigger, "configSetting"\);[\s\S]*if \(!setting\) return;[\s\S]*type: "configureSetting"/);
  assert.match(mediaSource, /\[data-sidebar-command\]"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*const command = datasetText\(sidebarCommandTrigger, "sidebarCommand"\);[\s\S]*if \(!command\) return;[\s\S]*postSidebarCommand\(command, label, sidebarCommandTrigger\)/);
  assert.match(mediaSource, /action === "generate-next"[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*postSidebarCommand\("generateNextPackage"/);
  assert.match(mediaSource, /action === "materials-guide"[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before opening the materials guide\."\)[\s\S]*postSidebarCommand\("openMaterialsGuide"/);
  assert.match(mediaSource, /addElementListener\("configureMaterials", "click", \(event\) => \{[\s\S]*blockSetupChangeDuringPractice\(\)[\s\S]*postSidebarCommand\("configureMaterials", "Choosing materials folder", event\.currentTarget \|\| \$\("configureMaterials"\)\)/);
  assert.match(mediaSource, /addElementListener\("openTask", "click", \(event\) => \{[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before opening the task card\."\)[\s\S]*postSidebarCommand\("openTask", "Opening task card", event\.currentTarget \|\| \$\("openTask"\)\)/);
  assert.match(mediaSource, /addElementListener\("openFolder", "click", \(event\) => \{[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before opening the session folder\."\)[\s\S]*postSidebarCommand\("openSessionFolder", "Opening session folder", event\.currentTarget \|\| \$\("openFolder"\)\)/);
  assert.match(mediaSource, /Still working — this is taking longer than usual\. Keep waiting; avoid refreshing until this turn finishes\./);
  assert.match(mediaSource, /addElementListener\("record", "click", toggleRecording\)/);
  assert.match(mediaSource, /addElementListener\("refresh", "click", \(event\) => \{[\s\S]*blockIfPracticeTurnInProgress\("Current turn is still running — wait for it to finish before refreshing\."\)[\s\S]*blockIfTransientActionInProgress\("refreshing"\)[\s\S]*beginRefreshRequest\(event\.currentTarget \|\| \$\("refresh"\)\)[\s\S]*type: "refresh"/);
  assert.doesNotMatch(mediaSource, /\$\("(record|refresh|completeLocal|configureMaterials|openTask|openFolder)"\)\.addEventListener/);
  assert.match(mediaSource, /if \(message\.type === "state"\) \{[\s\S]*handleStateMessage\(message\.state\);[\s\S]*\}/);
  assert.match(mediaSource, /blockIfPracticeTurnInProgress\("Finish or stop the current turn before resetting the conversation\."\)/);
  assert.match(mediaSource, /blockIfTransientActionInProgress\("resetting the conversation"\)/);
  assert.match(mediaSource, /addElementListener\("completeLocal", "click", \(event\) => \{[\s\S]*blockIfPracticeTurnInProgress\("Finish or stop the current turn before completing this lesson\."\)[\s\S]*blockIfTransientActionInProgress\("completing this lesson"\)[\s\S]*beginSidebarCommand\(event\.currentTarget \|\| \$\("completeLocal"\)[\s\S]*type: "completeLocal", requestId/);
  assert.match(mediaSource, /clearTurnResetArmTimer\(\);[\s\S]*if \(turnHistory\.length <= 1\)/);
  assert.match(mediaSource, /if \(!reset\.isConnected\) return/);
  assert.match(mediaSource, /function beginSlowReadRequest/);
  assert.match(mediaSource, /if \(message\.type === "busy"\) setStatus\(messageText\(message\.message, "Working…"\), "busy"\)/);
  assert.match(mediaSource, /message\.type === "commandResult"[\s\S]*setStatus\("Action failed: " \+ messageErrorText\(message\.error, "Unknown action error"\), "error"\)[\s\S]*setStatus\(messageText\(message\.message, "Action finished\."\)\)/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId \|\| !activeSlowReadRequest \|\| activeSlowReadRequest\.id !== requestId\) return;\s*setStatus\(messageText\(message\.message, "Generating slow-read audio…"\), "busy"\);/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId\) return;\s*const request = finishSlowReadRequest\(requestId\);\s*if \(!request\) return/);
  assert.match(mediaSource, /setStatus\("Slow-read audio ready\."\);\s*playAudioOrPrompt\(player, "Slow-read audio ready — press play\."\)/);
  assert.match(mediaSource, /setStatus\("Slow read returned no audio\. Try again\.", "error"\)/);
  assert.match(mediaSource, /const audioDataUri = textField\(result, "audioDataUri"\);[\s\S]*player\.src = audioDataUri/);
  assert.match(mediaSource, /let activeDrillLineRequest = null/);
  assert.match(mediaSource, /function beginDrillLineRequest/);
  assert.match(mediaSource, /function messageText\(value, fallback = ""\) \{[\s\S]*firstScalarField\(obj, "message", "error", "detail"\)[\s\S]*function messageErrorText\(value, fallback = "Unknown error"\) \{[\s\S]*return messageText\(value, fallback\);/);
  assert.match(mediaSource, /function pushDrillExample\(list, item, fallbackLabel, source\) \{[\s\S]*const obj = objectValue\(item\)[\s\S]*scalarField\(obj, "label"\)[\s\S]*source: scalarText\(source\) \|\| scalarField\(obj, "source"\)/);
  assert.match(mediaSource, /function pushDrillExample\(list, item, fallbackLabel, source\) \{[\s\S]*const cleanText = obj \? compactScalarField\(obj, "text"\) : compactScalarText\(item\);/);
  assert.match(mediaSource, /const rounds = Array\.isArray\(drill\.rounds\) \? drill\.rounds\.map\(\(item\) => objectValue\(item\)\)\.filter\(Boolean\) : \[\];[\s\S]*const roundLabel = firstScalarField\(round, "label", "id"\) \|\| "FSI drill"/);
  assert.match(mediaSource, /vscode\.postMessage\(\{ type: "generateDrillLines", count, existing, requestId \}\)/);
  assert.match(mediaSource, /setStatus\("Generating new drill lines…", "busy"\);\s*const existing = drillLibrary\.map/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId \|\| activeDrillLineRequest !== requestId\) return/);
  assert.match(mediaSource, /const statusText = messageText\(message\.message, "Generating new drill lines…"\);[\s\S]*setStatus\(statusText, "busy"\)/);
  assert.match(mediaSource, /const requestId = positiveInteger\(message\.requestId\);\s*if \(!requestId \|\| !finishDrillLineRequest\(requestId\)\) return/);
  assert.match(mediaSource, /if \(message\.type === "drillLinesResult"\) \{[\s\S]*const errorText = messageErrorText\(message\.error, "Drill generation failed\."\)[\s\S]*const obj = objectValue\(item\);[\s\S]*const text = obj \? compactScalarField\(obj, "text"\) : compactScalarText\(item\);[\s\S]*label: obj \? firstScalarField\(obj, "label", "cue", "id"\) \|\| "AI drill" : "AI drill"/);
  assert.match(mediaSource, /message\.type === "error"[\s\S]*if \(!isCurrentTurnErrorMessage\(message\)\) return;[\s\S]*clearActiveTurnRequestId\(activeTurnMessageRequestId\(message\)\);[\s\S]*const errorText = messageErrorText\(message\.message, "Error\."\)[\s\S]*resetTransientActionBusyState\(errorText\)[\s\S]*renderMissingSourceSetup\(errorText\)[\s\S]*setStatus\(errorText, "error"\)/);
  assert.equal(/Number\(message\.requestId\)/.test(mediaSource), false);
  assert.match(practiceViewSource, /drillLinesStatus", \.\.\.request/);
  assert.match(practiceViewSource, /drillLinesResult", \.\.\.request/);
  assert.match(mediaSource, /function activeRouteProviders\(settings\) \{[\s\S]*const safeSettings = objectValue\(settings\) \|\| \{\};[\s\S]*const raw = scalarField\(safeSettings, setting\) \|\| defaults\[setting\]/);
  assert.match(mediaSource, /function routeKeyStatus\(currentState\) \{[\s\S]*const safeState = objectValue\(currentState\) \|\| \{\};[\s\S]*const keys = objectValue\(safeState\.keys\) \|\| \{\};[\s\S]*activeRouteProviders\(safeState\.settings\)[\s\S]*providers\.filter\(\(provider\) => !providerKeySaved\(keys, provider\)\)/);
  assert.match(mediaSource, /function setupReady\(currentState\) \{[\s\S]*const progress = objectValue\(currentState && currentState\.progress\) \|\| \{\};[\s\S]*const hasLessons = positiveInteger\(progress\.total\) > 0/);
  assert.match(mediaSource, /function setupBlockMessage\(currentState\) \{[\s\S]*const diag = objectValue\(currentState && currentState\.sourceDiagnostics\) \|\| \{\};[\s\S]*const packageJsonError = scalarField\(diag, "packageJsonError"\);[\s\S]*scalarField\(diag, "currentPackageDate"\) \|\| "\?"/);
  assert.match(mediaSource, /const settings = objectValue\(currentState && currentState\.settings\) \|\| \{\};[\s\S]*const keys = objectValue\(currentState && currentState\.keys\) \|\| \{\};[\s\S]*normalizeProviderForSetting\("ttsProvider", scalarField\(settings, "ttsProvider"\) \|\| "openai"\)[\s\S]*!providerKeySaved\(keys, provider\)/);
  assert.match(mediaSource, /todayTtsBlocked = todayTtsBlockMessage\(state, line\)/);
  assert.match(mediaSource, /blockMessage = todayTtsBlockMessage\(state, currentExampleText\)/);
  assert.match(mediaSource, /function ensurePracticeSetupReady/);
  assert.match(mediaSource, /function ensureTtsActionReady/);
  assert.match(mediaSource, /function playAudioOrPrompt\(audio, fallbackStatus\)/);
  assert.match(mediaSource, /function clearTodayGeneratedAudio/);
  assert.match(mediaSource, /function currentSettings\(\) \{\s*return objectValue\(state && state\.settings\) \|\| \{\};\s*\}/);
  assert.match(mediaSource, /function recorderBackend\(\) \{[\s\S]*const backend = scalarField\(settings, "recorderBackend"\)\.toLowerCase\(\);[\s\S]*if \(backend === "maclocal"\) return "macLocal";[\s\S]*return backend === "webview" \|\| backend === "auto" \? backend : "macLocal"/);
  assert.match(mediaSource, /function blockedMicrophonePattern\(\) \{[\s\S]*const pattern = scalarField\(settings, "blockedMicrophoneNamePattern"\) \|\| "iphone\|ipad\|continuity\|karios"/);
  assert.match(mediaSource, /async function localAudioConstraints\(\) \{[\s\S]*const base = webviewAudioConstraints\(\);[\s\S]*const deviceId = scalarText\(chosen\.deviceId\);[\s\S]*if \(deviceId\) return \{ \.\.\.base, deviceId: \{ exact: deviceId \} \};[\s\S]*return base;/);
  assert.match(mediaSource, /const preferred = scalarField\(settings, "preferredMicrophoneName"\)\.toLowerCase\(\);/);
  assert.match(mediaSource, /const requestId = beginTodayTtsRequest\(actionTrigger\);\s*if \(!requestId\) return;\s*clearTodayGeneratedAudio\(\);/);
  assert.match(mediaSource, /playAudioOrPrompt\(player, "Slow-read audio ready — press play\."\)/);
  assert.match(mediaSource, /playAudioOrPrompt\(audio, "Example audio ready — press play\. Your next recording will shadow this text\."\)/);
  assert.match(mediaSource, /const audioDataUri = textField\(result, "audioDataUri"\);\s*if \(!audioDataUri\) \{[\s\S]*Example audio returned no audio\. Try again\.[\s\S]*return;/);
  assert.match(mediaSource, /const resultText = textField\(result, "text"\);[\s\S]*pendingPracticeTarget = practiceTarget\(resultText, "Example text", ""\)/);
  assert.match(mediaSource, /listenDisabled: Boolean\(listenBlockMessage\)/);
  assert.match(mediaSource, /listenDisabled: Boolean\(ttsActionBlockMessage\(state, example && example\.text, "listen to this line"\)\)/);
  assert.match(mediaSource, /slowDisabled = ttsActionBlockMessage\(state, result\.followUpQuestion, "slow-read the follow-up"\)/);
  assert.match(mediaSource, /nativeSlowDisabled = ttsActionBlockMessage\(state, result && result\.nativeVersion, "slow-read the native version"\)/);
  assert.match(mediaSource, /if \(!ensureTtsActionReady\(exampleText, "listen to this line"\)\) return/);
  assert.match(mediaSource, /type: "slowRead", text: exampleText, target: "drill", speed: 0\.85, requestId/);
  assert.match(mediaSource, /armSlowReadWatchdogs\(requestId, "Listen"\)/);
  assert.match(mediaSource, /if \(!ensureTtsActionReady\(text, target === "followUp" \? "slow-read the follow-up" : "slow-read the native version"\)\) return/);
  assert.match(mediaSource, /type: "slowRead", text, target, speed: 0\.7, requestId/);
  assert.match(mediaSource, /armSlowReadWatchdogs\(requestId, "Slow"\)/);
  assert.match(mediaSource, /if \(message\.error\) \{[\s\S]*const text = "Example audio failed: " \+ messageErrorText\(message\.error, "Unknown audio error"\)/);
  assert.match(mediaSource, /setupMessage = setupBlockMessage\(state\)/);
  assert.match(mediaSource, /practiceDisabled: Boolean\(setupMessage\)/);
  assert.match(mediaSource, /if \(!ensurePracticeSetupReady\(\)\) return;[\s\S]*beginDrillLineRequest\(\)/);
  assert.match(mediaSource, /if \(!startDrillPractice\(example\)\) return;[\s\S]*bumpDrillAttempt/);
  assert.match(mediaSource, /No prebuilt\/ folder was found/);
  assert.match(mediaSource, /setting === "coachProvider"/);
  assert.match(mediaSource, /id="useOpenAIStack"/);
  assert.match(mediaSource, /type: "useOpenAIStack"/);
  assert.match(mediaSource, /openaiRealtimeTranscriptionModel/);
  assert.match(mediaSource, /Realtime model/);
  assert.doesNotMatch(mediaSource, /Connect Gemini/);
  assert.doesNotMatch(mediaSource, /Add a Gemini API key/);
  assert.match(
    extensionSource,
    /englishTraining\.useOpenAIRealtimeAudioUnderstanding"[\s\S]*setOpenAIRealtimeSpeechInput/,
  );
  assert.match(providerRoutesSource, /const providers: ProviderName\[\] = \["openai", "gemini", "qwen", "mimo"\]/);
  assert.match(providerRoutesSource, /API key was empty; nothing was saved/);
});
