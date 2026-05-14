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
  assert.equal(registered.length, 30);
  assert.ok(registered.includes("englishTraining.openPractice"));
  assert.ok(registered.includes("englishTraining.createSamplePackage"));
  extension.deactivate();
  mockVscode.commands.registerCommand = previousRegisterCommand;
});

test("accepts a bring-your-own-materials root that only has prebuilt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.mkdirSync(path.join(root, "prebuilt"));
  assert.equal(api.looksLikeTrainingRoot(root), true);

  const notRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.writeFileSync(path.join(notRoot, "prebuilt"), "not a directory");
  assert.equal(api.looksLikeTrainingRoot(notRoot), false);
});

test("normalizes dirty TTS speeds before provider calls or UI state", () => {
  assert.equal(api.normalizeTtsSpeed(undefined), 0.9);
  assert.equal(api.normalizeTtsSpeed("1.234"), 1.23);
  assert.equal(api.normalizeTtsSpeed(Number.NaN), 0.9);
  assert.equal(api.normalizeTtsSpeed(0), 0.9);
  assert.equal(api.normalizeTtsSpeed(99), 1.5);
  assert.equal(api.normalizeTtsSpeed(0.1), 0.5);
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

test("maps audio MIME types to stable file extensions and output MIME types", () => {
  assert.equal(api.extensionFromMime("audio/webm;codecs=opus"), "webm");
  assert.equal(api.extensionFromMime("audio/ogg"), "ogg");
  assert.equal(api.extensionFromMime("audio/mpeg"), "mp3");
  assert.equal(api.speechOutputExtension("gemini"), "wav");
  assert.equal(api.speechOutputExtension("openai"), "mp3");
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

test("native recorder reports missing ffmpeg as ffmpeg, not as missing microphone", () => {
  assert.throws(
    () => api.listAvfoundationAudioDevices("/definitely/not/a/real/ffmpeg"),
    /Could not run ffmpeg/,
  );
});
