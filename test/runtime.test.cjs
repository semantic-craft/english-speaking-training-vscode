const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const configValues = {
  blockedMicrophoneNamePattern: "iphone|ipad|continuity|karios",
  preferredMicrophoneName: "",
};

const mockVscode = {
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  EventEmitter: class {
    constructor() {
      this.event = () => undefined;
    }
    fire() {}
  },
  TreeItem: class {
    constructor(label, collapsibleState) {
      this.label = label;
      this.collapsibleState = collapsibleState;
    }
  },
  TreeItemCollapsibleState: { None: 0 },
  Uri: {
    file(fsPath) {
      return {
        fsPath,
        toString() {
          return `file://${fsPath}`;
        },
      };
    },
    parse(value) {
      return {
        fsPath: value,
        toString() {
          return value;
        },
      };
    },
  },
  commands: {
    executeCommand: async () => undefined,
    registerCommand: () => ({ dispose() {} }),
  },
  env: {
    openExternal: async () => undefined,
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    showTextDocument: async () => undefined,
    showWarningMessage: async () => undefined,
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value) => {
        configValues[key] = value;
      },
    }),
    openTextDocument: async (value) => value,
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

const extension = require("../out/extension.js");
const api = extension.__test__;

test.after(() => {
  Module._load = originalLoad;
});

test("activates without a workspace and registers the command surface", async () => {
  const registered = [];
  const previousRegisterCommand = mockVscode.commands.registerCommand;
  mockVscode.commands.registerCommand = (command) => {
    registered.push(command);
    return { dispose() {} };
  };

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };

  extension.activate(context);
  await new Promise((resolve) => setImmediate(resolve));
  // 26 includes the useOpenAIStack one-click command added in 0.1.38 to
  // pin coach + transcribe + TTS all to OpenAI in a single Command Palette
  // action. Bumping this number must stay in lockstep with the contributes
  // block in package.json so a stray rename can't silently lose a command.
  // 27 includes englishTraining.selectMicrophone (0.1.39) — the interactive
  // microphone picker added so users can switch the AVFoundation input
  // without editing settings.json by hand.
  assert.equal(registered.length, 27);
  assert.ok(registered.includes("englishTraining.openPractice"));
  assert.ok(registered.includes("englishTraining.createSamplePackage"));
  assert.ok(registered.includes("englishTraining.generateNextPackage"));
  // DeepSeek coach was fully removed in favor of OpenAI; guard the rename so
  // the dead configure-key command can't silently reappear.
  assert.ok(registered.includes("englishTraining.useOpenAICoach"));
  assert.ok(registered.includes("englishTraining.useOpenAIStack"));
  assert.ok(registered.includes("englishTraining.selectMicrophone"));
  assert.ok(!registered.includes("englishTraining.useDeepSeekCoach"));
  assert.ok(!registered.includes("englishTraining.configureDeepSeekKey"));
  extension.deactivate();
  mockVscode.commands.registerCommand = previousRegisterCommand;
});

test("exposes a versioned card-schema contract any LLM can consume", () => {
  const raw = api.cardSchemaContractJson();
  const schema = JSON.parse(raw);
  assert.equal(schema.version, api.CARD_SCHEMA_VERSION);
  assert.equal(schema.schema, "english-training/card-schema");
  assert.ok(schema.prosodyContract.word_level_prosody.groups, "documents prosody groups");
  assert.ok(schema.prosodyContract.word_level_prosody.words, "documents sparse stress words");
  assert.ok(schema.prosodyContract.stress_guide, "documents the stress card fallback");
  assert.ok(schema.prosodyContract.intonation_guide, "documents the falling-tone card fallback");
  assert.ok(schema.assets.keys.daily_card && schema.assets.keys.prosody_detail, "documents image assets");
  assert.ok(Array.isArray(schema.hardRules) && schema.hardRules.length > 0, "states hard rules");
});

test("scaffolds schema-conformant blank skeletons", () => {
  const training = api.blankTrainingPackage("2026-06-01");
  assert.equal(training.date, "2026-06-01");
  for (const key of ["scenario", "goal", "chinese_setup", "frames", "clean_tts_text", "word_level_prosody"]) {
    assert.ok(key in training, `skeleton has ${key}`);
  }
  const groups = training.word_level_prosody.groups;
  const words = training.word_level_prosody.words;
  assert.ok(Array.isArray(groups) && groups.length >= 1);
  const fallingGroup = groups.find((g) => g.contour === "↘");
  assert.ok(fallingGroup, "skeleton includes a falling-tone group");
  assert.ok(words.some((w) => w.stress === "nucleus"), "skeleton includes a nucleus word");

  const drill = api.blankFollowupDrillPackage("2026-06-01");
  assert.equal(drill.date, "2026-06-01");
  assert.ok(Array.isArray(drill.rounds) && drill.rounds.length >= 1);
  assert.ok(drill.shadowing_loop && Array.isArray(drill.shadowing_loop.chunks));
});

test("builds a provider-agnostic generation prompt embedding the contract and an example", () => {
  const prompt = api.buildGenerationPrompt({
    date: "2026-06-02",
    brief: "Conference small talk about my research",
    sampleTraining: { date: "2026-06-02", scenario: "demo", clean_tts_text: "Demo line." },
    sampleDrill: { schema_version: 1, date: "2026-06-02", rounds: [] },
  });
  assert.match(prompt, /Card Schema v/);
  assert.ok(prompt.includes(api.CARD_SCHEMA_VERSION));
  assert.ok(prompt.includes("2026-06-02"), "targets the requested date");
  assert.ok(prompt.includes("Conference small talk about my research"), "embeds the learner brief");
  assert.ok(prompt.includes("english-training/card-schema"), "embeds the machine-readable contract");
  assert.ok(prompt.includes("english-training.json") && prompt.includes("followup-drill.json"), "states the output contract");
});

test("accepts a bring-your-own-materials root that only has prebuilt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.mkdirSync(path.join(root, "prebuilt"));
  assert.equal(api.looksLikeTrainingRoot(root), true);

  const notRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.writeFileSync(path.join(notRoot, "prebuilt"), "not a directory");
  assert.equal(api.looksLikeTrainingRoot(notRoot), false);
});

test("resolves prebuilt reading-card assets from manifest paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-assets-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-17");
  fs.mkdirSync(path.join(packageDir, "cards"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "speech"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify({
    files: {
      daily_card: "cards/daily.png",
      prosody_detail: "cards/prosody.png",
      audio_demo: "speech/demo.ogg",
      telegram_task_card: "card.md",
    },
  }));

  const assets = api.packageAssets(root, "2026-05-17");
  assert.equal(assets.daily_card, path.join(packageDir, "cards", "daily.png"));
  assert.equal(assets.prosody_detail, path.join(packageDir, "cards", "prosody.png"));
  assert.equal(assets.demo_audio, path.join(packageDir, "speech", "demo.ogg"));
  assert.equal(assets.task_card, path.join(packageDir, "card.md"));
  assert.equal(assets.audio_queue, path.join(packageDir, "audio-queue.json"));
});

test("converts local reading-card assets to webview URIs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-webview-assets-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-17");
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "daily-card.png"), "png");
  fs.writeFileSync(path.join(packageDir, "prosody-detail.png"), "png");
  fs.writeFileSync(path.join(packageDir, "audio", "demo.ogg"), "ogg");
  const assets = api.packageAssets(root, "2026-05-17");
  const webview = {
    asWebviewUri(uri) {
      return {
        toString() {
          return `webview:${uri.fsPath}`;
        },
      };
    },
  };

  const nextState = api.toWebviewState(webview, { next: { assets } });
  assert.equal(nextState.next.assets.daily_card_uri, `webview:${path.join(packageDir, "daily-card.png")}`);
  assert.equal(nextState.next.assets.prosody_detail_uri, `webview:${path.join(packageDir, "prosody-detail.png")}`);
  assert.equal(nextState.next.assets.demo_audio_uri, `webview:${path.join(packageDir, "audio", "demo.ogg")}`);
});

test("normalizes dirty TTS speeds before provider calls or UI state", () => {
  assert.equal(api.normalizeTtsSpeed(undefined), 0.9);
  assert.equal(api.normalizeTtsSpeed("1.234"), 1.23);
  assert.equal(api.normalizeTtsSpeed(Number.NaN), 0.9);
  assert.equal(api.normalizeTtsSpeed(0), 0.9);
  assert.equal(api.normalizeTtsSpeed(99), 1.5);
  assert.equal(api.normalizeTtsSpeed(0.1), 0.5);
});

test("normalizes legacy/unknown speech-input settings to the current default", () => {
  // The default route is now openai (was gemini before 0.1.38). Any
  // unknown legacy value (azure, deepseek, kimi, etc.) must fall back to
  // the current default rather than crash or silently pick a removed
  // provider. gemini/mimo/openai stay as-is.
  configValues.audioUnderstandingProvider = "azure";
  assert.equal(api.normalizedSpeechInputProvider(), "openai");
  configValues.audioUnderstandingProvider = "openai";
  assert.equal(api.normalizedSpeechInputProvider(), "openai");
  configValues.audioUnderstandingProvider = "mimo";
  assert.equal(api.normalizedSpeechInputProvider(), "mimo");
  configValues.audioUnderstandingProvider = "gemini";
  assert.equal(api.normalizedSpeechInputProvider(), "gemini");
});

test("normalizes stale coach and speech-output providers to OpenAI", () => {
  configValues.coachProvider = "deepseek";
  configValues.ttsProvider = "unknown";
  assert.equal(api.normalizedCoachProvider(), "openai");
  assert.equal(api.normalizedTtsProvider(), "openai");
  assert.equal(api.normalizeSpeechOutputProvider("deepseek"), "openai");
  assert.equal(api.speechOutputExtension("deepseek"), "wav");

  configValues.coachProvider = "mimo";
  configValues.ttsProvider = "minimax";
  assert.equal(api.normalizedCoachProvider(), "mimo");
  assert.equal(api.normalizedTtsProvider(), "minimax");
});

test("active route key readiness follows configured providers instead of hard-coded Gemini", () => {
  configValues.coachProvider = undefined;
  configValues.audioUnderstandingProvider = undefined;
  configValues.ttsProvider = undefined;
  assert.deepEqual(api.activeRouteProviders(), ["openai"]);
  assert.equal(api.normalizeProviderForSetting("coachProvider", "minimax"), "openai");
  assert.equal(api.normalizeProviderForSetting("audioUnderstandingProvider", "minimax"), "openai");
  assert.equal(api.normalizeProviderForSetting("ttsProvider", "minimax"), "minimax");

  configValues.coachProvider = "gemini";
  configValues.audioUnderstandingProvider = "openai";
  configValues.ttsProvider = "minimax";
  assert.deepEqual(api.activeRouteProviders(), ["gemini", "openai", "minimax"]);

  configValues.coachProvider = "openai";
  configValues.audioUnderstandingProvider = "openai";
  configValues.ttsProvider = "openai";
  assert.deepEqual(api.activeRouteProviders(), ["openai"]);

  configValues.coachProvider = "deepseek";
  configValues.audioUnderstandingProvider = "azure";
  configValues.ttsProvider = "bogus";
  assert.deepEqual(api.activeRouteProviders(), ["openai"]);

  configValues.coachProvider = "minimax";
  configValues.audioUnderstandingProvider = "openai";
  configValues.ttsProvider = "gemini";
  assert.deepEqual(api.activeRouteProviders(), ["openai", "gemini"]);
});

test("OpenAI TTS voices are preserved across supported speech models", () => {
  configValues.openaiTtsVoice = "marin";
  assert.equal(api.resolveOpenAITtsVoice("gpt-4o-mini-tts"), "marin");
  assert.equal(api.resolveOpenAITtsVoice("tts-1"), "marin");
  assert.equal(api.resolveOpenAITtsVoice("tts-1-hd"), "marin");

  configValues.openaiTtsVoice = "ash";
  assert.equal(api.resolveOpenAITtsVoice("tts-1"), "ash");
  configValues.openaiTtsVoice = " ";
  assert.equal(api.resolveOpenAITtsVoice("tts-1"), "marin");
  configValues.openaiTtsVoice = "";
});

test("repairs common malformed coaching JSON responses", () => {
  assert.deepEqual(api.parseLooseJson("```json\n{\"native_version\":\"Hello\",}\n```"), {
    native_version: "Hello",
  });
  assert.deepEqual(api.parseLooseJson('{"native_version":"Hello"'), {
    native_version: "Hello",
  });
  assert.deepEqual(api.parseLooseJson('prefix {"native_version":"Hello"} suffix'), {
    native_version: "Hello",
  });
});

test("distinguishes a missing package file from a corrupt one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "est-readjson-"));

  const missing = api.readJsonDiagnosed(path.join(dir, "nope.json"));
  assert.equal(missing.data, undefined);
  assert.equal(missing.parseError, undefined);

  const badPath = path.join(dir, "bad.json");
  fs.writeFileSync(badPath, '{"goal":"Speak",}\n', "utf8");
  const bad = api.readJsonDiagnosed(badPath);
  assert.equal(bad.data, undefined);
  assert.equal(typeof bad.parseError, "string");
  assert.ok(bad.parseError.length > 0);

  const goodPath = path.join(dir, "good.json");
  fs.writeFileSync(goodPath, '{"goal":"Speak"}\n', "utf8");
  const good = api.readJsonDiagnosed(goodPath);
  assert.deepEqual(good.data, { goal: "Speak" });
  assert.equal(good.parseError, undefined);
});

test("selects example text from explicit fields before frame fallback", () => {
  const training = {
    clean_tts_text: " Clean text. ",
    audio_text: "Audio text.",
    frames: [{ text: "Frame one." }],
  };
  assert.equal(api.todayExampleText(training), "Clean text.");
  assert.equal(api.todayExampleText({ frames: [{ text: " A   frame. " }, "Next frame."] }), "A frame. Next frame.");
});

test("builds progress cells for completed, current, missed, and pending dates", () => {
  const completed = new Set(["2026-05-10"]);
  const progress = api.buildProgressSnapshot(
    ["2026-05-10", "2026-05-11", "2026-05-12", "2026-05-14"],
    completed,
    "2026-05-13",
    "2026-05-12",
  );

  assert.equal(progress.total, 4);
  assert.equal(progress.completedCount, 1);
  assert.equal(progress.currentIndex, 3);
  assert.deepEqual(progress.cells.map((cell) => cell.status), ["completed", "missed", "current", "pending"]);
});

test("normalizes shadow-practice target payloads defensively", () => {
  assert.equal(api.normalizePracticeTargetPayload({ referenceText: "   " }), undefined);
  assert.deepEqual(api.normalizePracticeTargetPayload({
    referenceText: " Repeat this. ",
    referenceLabel: "",
    followUpQuestion: " Then answer. ",
  }), {
    mode: "shadow",
    referenceText: "Repeat this.",
    referenceLabel: "Reference",
    followUpQuestion: "Then answer.",
  });
});

test("collects FSI drill examples from prebuilt rounds and shadowing chunks", () => {
  const state = {
    drill: {
      rounds: [
        {
          label: "Substitution",
          examples: [
            { cue: "base", text: "Repeat the base sentence." },
            { cue: "slot", text: "Replace the claim slot." },
          ],
        },
      ],
      shadowing_loop: {
        chunks: [
          "Repeat the base sentence.",
          "Close with a cleaner claim.",
        ],
      },
    },
  };

  assert.deepEqual(api.drillExamplesFromState(state, "Repeat the base sentence."), [
    {
      label: "Substitution: slot",
      text: "Replace the claim slot.",
      source: "prebuilt",
    },
    {
      label: "Shadowing chunk 2",
      text: "Close with a cleaner claim.",
      source: "prebuilt",
    },
  ]);
});

test("normalizes coach-generated drill examples into practice targets", () => {
  assert.deepEqual(api.normalizeDrillExamples([
    "A plain extra sentence.",
    { label: "claim", text: "My claim is narrower.", reason: "替换 claim slot" },
    { label: "empty", text: "   " },
  ]), [
    {
      label: "Example 1",
      text: "A plain extra sentence.",
      source: "coach",
    },
    {
      label: "claim",
      text: "My claim is narrower.",
      reason: "替换 claim slot",
      source: "coach",
    },
  ]);
});

test("maps audio MIME types to stable file extensions and output MIME types", () => {
  assert.equal(api.extensionFromMime("audio/webm;codecs=opus"), "webm");
  assert.equal(api.extensionFromMime("audio/ogg"), "ogg");
  assert.equal(api.extensionFromMime("audio/mpeg"), "mp3");
  assert.equal(api.speechOutputExtension("gemini"), "wav");
  // OpenAI's extension now reflects englishTraining.openaiTtsResponseFormat
  // (wav is the low-latency default in 0.1.38; mp3 stays available). pcm has
  // no container so we wrap it in WAV and report .wav. The MiniMax/unknown
  // branch still falls back to mp3 because that provider returns mp3 bytes.
  configValues.openaiTtsResponseFormat = "wav";
  assert.equal(api.speechOutputExtension("openai"), "wav");
  configValues.openaiTtsResponseFormat = "mp3";
  assert.equal(api.speechOutputExtension("openai"), "mp3");
  configValues.openaiTtsResponseFormat = "pcm";
  assert.equal(api.speechOutputExtension("openai"), "wav");
  configValues.openaiTtsResponseFormat = "";
  assert.equal(api.speechOutputExtension("minimax"), "mp3");
  assert.equal(api.mimeTypeForAudioPath("/tmp/native-version.wav"), "audio/wav");
  assert.equal(api.mimeTypeForAudioPath("/tmp/native-version.mp3"), "audio/mpeg");
});

test("parses and chooses AVFoundation microphones without selecting blocked continuity devices", () => {
  const devices = api.parseAvfoundationAudioDevices(`
[AVFoundation indev @ 0x123] AVFoundation video devices:
[AVFoundation indev @ 0x123] [0] FaceTime HD Camera
[AVFoundation indev @ 0x123] AVFoundation audio devices:
[AVFoundation indev @ 0x123] [0] iPhone Microphone
[AVFoundation indev @ 0x123] [1] MacBook Pro Microphone
[AVFoundation indev @ 0x123] [2] External USB Mic
`);

  assert.deepEqual(devices, [
    { index: "0", name: "iPhone Microphone" },
    { index: "1", name: "MacBook Pro Microphone" },
    { index: "2", name: "External USB Mic" },
  ]);
  assert.deepEqual(api.chooseLocalAvfoundationAudioDevice(devices), {
    index: "1",
    name: "MacBook Pro Microphone",
  });

  configValues.preferredMicrophoneName = "External";
  assert.deepEqual(api.chooseLocalAvfoundationAudioDevice(devices), {
    index: "2",
    name: "External USB Mic",
  });
  configValues.preferredMicrophoneName = "";
});

test("native recorder reports missing ffmpeg as ffmpeg, not as missing microphone", async () => {
  // listAvfoundationAudioDevices is async now (cp.spawn, not the host-freezing
  // cp.spawnSync) — a bad ffmpeg path must still surface as an ffmpeg error.
  await assert.rejects(
    api.listAvfoundationAudioDevices("/definitely/not/a/real/ffmpeg"),
    /Could not run ffmpeg/,
  );
});

test("device resolution: explicit device skips enumeration; auto enumerates", async () => {
  api.invalidateResolvedAudioDevice();

  // An explicit configured device must resolve WITHOUT invoking ffmpeg even
  // when the binary path is bogus — this is the per-take hot path that
  // P-CACHE keeps off the slow enumeration. The second call exercises the
  // cache-hit branch (a broken cache key/return would surface here).
  configValues.nativeRecorderFfmpegAudioDevice = "3";
  assert.equal(await api.resolveNativeFfmpegAudioDevice("/definitely/not/a/real/ffmpeg"), "3");
  assert.equal(await api.resolveNativeFfmpegAudioDevice("/definitely/not/a/real/ffmpeg"), "3");

  // "auto" must actually enumerate, so a bogus ffmpeg surfaces as an ffmpeg
  // error — and asynchronously (rejects, never a sync throw that would have
  // frozen the host the way the old cp.spawnSync did).
  api.invalidateResolvedAudioDevice();
  configValues.nativeRecorderFfmpegAudioDevice = "auto";
  await assert.rejects(
    api.resolveNativeFfmpegAudioDevice("/definitely/not/a/real/ffmpeg"),
    /Could not run ffmpeg/,
  );

  delete configValues.nativeRecorderFfmpegAudioDevice;
  api.invalidateResolvedAudioDevice();
});
