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
const outputLines = [];
const errorMessages = [];
const warningMessages = [];

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
  ProgressLocation: { Notification: 15 },
  Uri: {
    file(fsPath) {
      return {
        fsPath,
        toString() {
          return `file://${fsPath}`;
        },
      };
    },
    joinPath(base, ...parts) {
      const fsPath = path.join(base.fsPath, ...parts);
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
    createOutputChannel: () => ({ appendLine(line) { outputLines.push(line); }, show() {}, dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showInformationMessage: async () => undefined,
    showInputBox: async () => undefined,
    showOpenDialog: async () => undefined,
    showQuickPick: async () => undefined,
    withProgress: async (_options, task) => task(),
    showErrorMessage: async (message) => {
      errorMessages.push(message);
      return undefined;
    },
    showTextDocument: async () => undefined,
    showWarningMessage: async (message) => {
      warningMessages.push(message);
      return undefined;
    },
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

function createPracticeWebviewView(messages, options = {}) {
  let disposeHandler = () => undefined;
  return {
    webview: {
      cspSource: "vscode-resource:",
      html: "",
      options: {},
      asWebviewUri(uri) {
        if (options.throwAsWebviewUri) {
          throw new Error("disposed webview uri");
        }
        return {
          toString() {
            return `webview:${uri.fsPath}`;
          },
        };
      },
      onDidReceiveMessage: () => ({ dispose() {} }),
      postMessage: async (message) => {
        if (options.rejectPostMessage) {
          throw new Error("disposed webview");
        }
        messages.push(message);
        return true;
      },
    },
    onDidDispose(handler) {
      disposeHandler = handler;
      return { dispose() {} };
    },
    dispose() {
      disposeHandler();
    },
  };
}

async function waitForAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

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
  // 24 reflects the post-0.1.46 command surface: OpenAI coach/stack/TTS/realtime
  // commands and configureOpenAIKey were retired with the OpenAI provider.
  // Bumping this number must stay in lockstep with the contributes block in
  // package.json so a stray rename can't silently lose a command.
  assert.equal(registered.length, 24);
  assert.ok(registered.includes("englishTraining.openPractice"));
  assert.ok(registered.includes("englishTraining.createSamplePackage"));
  assert.ok(registered.includes("englishTraining.generateNextPackage"));
  assert.ok(registered.includes("englishTraining.useQwenCoach"));
  assert.ok(registered.includes("englishTraining.useQwenAudioUnderstanding"));
  assert.ok(registered.includes("englishTraining.useQwenStack"));
  assert.ok(registered.includes("englishTraining.useGeminiOnly"));
  assert.ok(registered.includes("englishTraining.selectMicrophone"));
  assert.ok(!registered.includes("englishTraining.useDeepSeekCoach"));
  assert.ok(!registered.includes("englishTraining.useOpenAICoach"));
  assert.ok(!registered.includes("englishTraining.useOpenAIStack"));
  assert.ok(!registered.includes("englishTraining.useOpenAIRealtimeAudioUnderstanding"));
  assert.ok(!registered.includes("englishTraining.configureOpenAIKey"));
  // useRecommendedHybrid was an exact duplicate of useGeminiOnly; both wrote
  // gemini to all three provider settings, so collapsing them is safe and
  // removes a confusing second Command Palette entry.
  assert.ok(!registered.includes("englishTraining.useRecommendedHybrid"));
  assert.ok(!registered.includes("englishTraining.configureDeepSeekKey"));
  extension.deactivate();
  mockVscode.commands.registerCommand = previousRegisterCommand;
});

test("status tree falls back cleanly when no training root is available", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const provider = new api.StatusProvider({
    extensionPath: "/tmp/english-training-extension-test",
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  });

  try {
    const items = await provider.getChildren();
    assert.equal(items.length, 1);
    assert.equal(items[0].label, "English Training unavailable");
    assert.match(items[0].description, /Could not find an EnglishSpeakingTraining root/);
    assert.equal(api.compactStatusValue({ bad: "value" }), "");
    assert.equal(api.compactStatusValue("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"), "abcdefghijklmnopqrstuv...DEFGHIJKLMNOPQRSTUVWXYZ");
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("disposing a stale practice webview does not detach the current view", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const firstMessages = [];
  const secondMessages = [];
  const firstView = createPracticeWebviewView(firstMessages);
  const secondView = createPracticeWebviewView(secondMessages);

  try {
    provider.resolveWebviewView(firstView);
    provider.resolveWebviewView(secondView);
    await waitForAsyncWork();
    secondMessages.length = 0;

    firstView.dispose();
    await provider.postState();

    assert.equal(firstMessages.length, 0);
    assert.ok(
      secondMessages.some((message) =>
        message.type === "error" &&
        /Could not find an EnglishSpeakingTraining root/.test(message.message),
      ),
      "current view should still receive refresh errors after an old view is disposed",
    );
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("practice webview resource roots use the normalized configured materials root", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-webview-home-"));
  const root = path.join(home, "English Training Materials");
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  configValues.localMaterialsRoot = " ~/English Training Materials ";
  mockVscode.workspace.workspaceFolders = [];
  process.env.HOME = home;

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const view = createPracticeWebviewView([]);

  try {
    provider.resolveWebviewView(view);
    const roots = view.webview.options.localResourceRoots.map((uri) => uri.fsPath);
    assert.ok(roots.includes(root), "configured materials root should be granted to the webview");
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("rejected practice webview messages are logged, not left unhandled", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const unhandled = [];
  const onUnhandled = (error) => {
    unhandled.push(error);
  };
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];
  outputLines.length = 0;
  process.on("unhandledRejection", onUnhandled);

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const view = createPracticeWebviewView([], { rejectPostMessage: true });

  try {
    extension.activate(context);
    provider.resolveWebviewView(view);
    await provider.postState();
    await waitForAsyncWork();

    assert.deepEqual(unhandled, []);
    assert.ok(
      outputLines.some((line) => /Practice webview postMessage failed: disposed webview/.test(line)),
      "postMessage rejection should be recorded in the output channel",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    extension.deactivate();
  }
});

test("synchronous practice webview postMessage failures are logged, not thrown", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];
  outputLines.length = 0;

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);
  const result = {
    transcript: "hello",
    nativeVersion: "Hello.",
    mode: "free",
    problems: [],
    quickFix: "",
    followUpQuestion: "",
    shadowingInstruction: "",
    errorTags: [],
    nextDrill: "",
    scores: {},
    sessionDir: "/tmp/session",
    packageDate: "2026-05-22",
  };

  try {
    extension.activate(context);
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    outputLines.length = 0;
    messages.length = 0;
    view.webview.postMessage = () => {
      throw new Error("disposed webview sync");
    };

    assert.doesNotThrow(() => provider.postPracticeResult(view, result));
    assert.equal(messages.length, 0);
    assert.ok(
      outputLines.some((line) => /Practice webview postMessage failed: disposed webview sync/.test(line)),
      "sync postMessage failure should be recorded in the output channel",
    );
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    api.clearRefreshHandlers();
    extension.deactivate();
  }
});

test("stale practice results do not touch a replaced webview", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const firstMessages = [];
  const secondMessages = [];
  const firstView = createPracticeWebviewView(firstMessages);
  const secondView = createPracticeWebviewView(secondMessages);
  const result = {
    transcript: "hello",
    nativeVersion: "Hello.",
    mode: "free",
    problems: [],
    quickFix: "",
    followUpQuestion: "",
    shadowingInstruction: "",
    errorTags: [],
    nextDrill: "",
    scores: {},
    audioFile: "/tmp/native.wav",
    followUpAudioFile: "/tmp/follow-up.wav",
    sessionDir: "/tmp/session",
    packageDate: "2026-05-22",
  };

  try {
    provider.resolveWebviewView(firstView);
    provider.resolveWebviewView(secondView);
    await waitForAsyncWork();
    secondMessages.length = 0;
    firstView.webview.asWebviewUri = () => {
      throw new Error("disposed webview uri");
    };

    assert.doesNotThrow(() => provider.postPracticeResult(firstView, result));
    assert.equal(firstMessages.length, 0);
    assert.equal(secondMessages.length, 0);

    provider.postPracticeResult(secondView, result, { localAudioFile: "/tmp/local.wav" });
    assert.equal(secondMessages.length, 1);
    assert.equal(secondMessages[0].type, "practiceResult");
    assert.equal(secondMessages[0].result.audioUri, "webview:/tmp/native.wav");
    assert.equal(secondMessages[0].result.followUpAudioUri, "webview:/tmp/follow-up.wav");
    assert.equal(secondMessages[0].result.localAudioUri, "webview:/tmp/local.wav");
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("practice result URI mapping failures do not replace a successful result with an error", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);
  const result = {
    transcript: "hello",
    nativeVersion: "Hello.",
    mode: "free",
    problems: [],
    quickFix: "",
    followUpQuestion: "",
    shadowingInstruction: "",
    errorTags: [],
    nextDrill: "",
    scores: {},
    audioFile: "/tmp/native.wav",
    followUpAudioFile: "/tmp/follow-up.wav",
    sessionDir: "/tmp/session",
    packageDate: "2026-05-22",
  };

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    view.webview.asWebviewUri = () => {
      throw new Error("disposed webview uri");
    };

    assert.doesNotThrow(() => provider.postPracticeResult(view, result, { localAudioFile: "/tmp/local.wav" }));

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "practiceResult");
    assert.equal(messages[0].result.audioUri, "");
    assert.equal(messages[0].result.followUpAudioUri, "");
    assert.equal(messages[0].result.localAudioUri, undefined);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("invalid practice webview control messages surface errors instead of no-oping", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, { type: "command", command: "notACommand" });
    await provider.handleMessage(view, { type: "configureKey", provider: "azure" });
    await provider.handleMessage(view, { type: "configureSetting", setting: "deadSetting" });
    await provider.handleMessage(view, { type: "setTtsSpeed", value: "fast" });
    await provider.handleMessage(view, { type: "setTtsSpeed", value: "   " });
    await provider.handleMessage(view, { type: "setTtsSpeed", value: true });
    await provider.handleMessage(view, { type: "setTtsSpeed", value: [1] });
    await provider.handleMessage(view, { type: "setQwenVoice", voiceId: "" });
    await provider.handleMessage(view, { type: "setQwenVoice", voiceId: "   " });
    await provider.handleMessage(view, { type: "slowRead", text: "hello", target: "native" });
    await provider.handleMessage(view, { type: "todayTts" });
    await provider.handleMessage(view, { type: "generateDrillLines", count: 5, existing: [] });
    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "Could you clarify?",
        followUpQuestion: "What changed?",
        userTranscript: "I need a moment.",
      },
    });
    assert.ok(provider.pendingPriorTurn);
    await provider.handleMessage(view, { type: "startNativeRecording" });
    assert.equal(provider.pendingPriorTurn, undefined);
    await provider.handleMessage(view, { type: "unknownThing" });

    assert.deepEqual(messages.map((message) => message.message), [
      "Unknown sidebar command: notACommand.",
      "Unknown provider key route: azure.",
      "Unknown setting: deadSetting.",
      "Invalid TTS speed: fast.",
      "Invalid TTS speed: (missing).",
      "Invalid TTS speed: true.",
      "Invalid TTS speed: (missing).",
      "Qwen-TTS voice was missing.",
      "Qwen-TTS voice was missing.",
      "Slow-read request id was missing. Refresh the practice view and try again.",
      "Example audio request id was missing. Refresh the practice view and try again.",
      "Drill generation request id was missing. Refresh the practice view and try again.",
      "Native recording request id was missing. Refresh the practice view and try again.",
      "Unknown sidebar message: unknownThing.",
    ]);
    assert.ok(messages.every((message) => message.type === "error"));
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("practice webview provider messages trim setting and provider values before writing config", async () => {
  const previousProvider = configValues.coachProvider;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const updates = [];
  let refreshes = 0;
  configValues.coachProvider = "gemini";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "setProvider",
      setting: " coachProvider ",
      value: " Qwen ",
    });
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "coachProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(messages, []);
});

test("practice webview Qwen voice messages trim before writing config", async () => {
  const previous = {
    qwenTtsVoice: configValues.qwenTtsVoice,
  };
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const updates = [];
  const info = [];
  let refreshes = 0;
  configValues.qwenTtsVoice = " Cherry ";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "setQwenVoice",
      voiceId: " Serena ",
      requestId: 83,
    });
    await provider.handleMessage(view, {
      type: "setQwenVoice",
      voiceId: " Ethan ",
      requestId: 84,
    });
  } finally {
    Object.assign(configValues, previous);
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "qwenTtsVoice", value: "Serena", target: mockVscode.ConfigurationTarget.Global },
    { key: "qwenTtsVoice", value: "Ethan", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 2);
  assert.equal(info[0], "Qwen-TTS voice set to Serena.");
  assert.equal(info[1], "Qwen-TTS voice set to Ethan.");
  assert.deepEqual(messages, [
    { type: "commandResult", command: "setQwenVoice", requestId: 83 },
    { type: "commandResult", command: "setQwenVoice", requestId: 84 },
  ]);
});

test("setup actions return request-scoped results when request ids are provided", async () => {
  const previousProvider = configValues.coachProvider;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const updates = [];
  let refreshes = 0;
  configValues.coachProvider = "gemini";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, {
      type: "setProvider",
      setting: " coachProvider ",
      value: " qwen ",
      requestId: 81,
    });

    await provider.handleMessage(view, {
      type: "configureKey",
      provider: "azure",
      requestId: 82,
    });
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "coachProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(messages, [
    { type: "commandResult", command: "setProvider", requestId: 81 },
    {
      type: "commandResult",
      command: "configureKey",
      requestId: 82,
      error: "Unknown provider key route: azure.",
    },
  ]);
});

test("practice webview configure-key messages normalize provider names before saving keys", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const stored = [];
  const info = [];
  let refreshes = 0;
  mockVscode.window.showInputBox = async () => " dashscope-key ";
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async (key, value) => {
        stored.push({ key, value });
      },
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "configureKey",
      provider: " Qwen ",
    });
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(stored, [
    { key: "englishTraining.dashscopeApiKey", value: "dashscope-key" },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(info, ["Qwen API key saved."]);
  assert.deepEqual(messages, []);
});

test("practice webview configure-setting messages trim setting names before opening pickers", async () => {
  const previousModel = configValues.mimoTtsModel;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.mimoTtsModel = "mimo-v2.5-tts";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => items.find((item) => item.label === "mimo-v2.5-tts");
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "configureSetting",
      setting: " mimoTtsModel ",
    });
  } finally {
    configValues.mimoTtsModel = previousModel;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  // Re-selecting the already-active default writes the canonical value once
  // (the picker normalizes whitespace-padded inputs) and triggers refresh.
  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(messages, []);
});

test("practice webview command messages trim command names before dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-webview-command-trim-"));
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousExecuteCommand = mockVscode.commands.executeCommand;
  const revealed = [];
  configValues.localMaterialsRoot = root;
  mockVscode.commands.executeCommand = async (command, uri) => {
    revealed.push({ command, fsPath: uri.fsPath });
  };

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "command",
      command: " openSessionFolder ",
    });
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.commands.executeCommand = previousExecuteCommand;
  }

  assert.deepEqual(revealed, [
    { command: "revealFileInOS", fsPath: path.join(root, "runtime", "vscode-sessions") },
  ]);
  assert.deepEqual(messages, []);
});

test("sidebar command failures return request-scoped results", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, {
      type: "completeLocal",
      requestId: 77,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "commandResult");
    assert.equal(messages[0].command, "completeLocal");
    assert.equal(messages[0].requestId, 77);
    assert.match(messages[0].error, /Could not find an EnglishSpeakingTraining root/);

    messages.length = 0;
    await provider.handleMessage(view, {
      type: "command",
      command: "openSessionFolder",
      requestId: 78,
    });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "commandResult");
    assert.equal(messages[0].command, "openSessionFolder");
    assert.equal(messages[0].requestId, 78);
    assert.match(messages[0].error, /Could not find an EnglishSpeakingTraining root/);

    messages.length = 0;
    await provider.handleMessage(view, {
      type: "command",
      command: "doesNotExist",
      requestId: 79,
    });

    assert.deepEqual(messages, [{
      type: "commandResult",
      command: "doesNotExist",
      requestId: 79,
      error: "Unknown sidebar command: doesNotExist.",
    }]);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("practice webview microphone picker command returns a request-scoped result", async () => {
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);
  warningMessages.length = 0;

  try {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "command",
      command: "selectMicrophone",
      requestId: 80,
    });
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
  }

  assert.deepEqual(messages, [{
    type: "commandResult",
    command: "selectMicrophone",
    requestId: 80,
  }]);
  assert.deepEqual(warningMessages, [
    "Interactive microphone picker currently supports macOS AVFoundation only. Set englishTraining.preferredMicrophoneName manually on other platforms.",
  ]);
  warningMessages.length = 0;
});

test("native recording start failures echo request ids for stale-message filtering", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;
    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "Could you explain?",
        followUpQuestion: "What would you do next?",
        userTranscript: "I would check the plan.",
      },
    });
    assert.ok(provider.pendingPriorTurn);

    await provider.handleMessage(view, { type: "startNativeRecording", requestId: 37 });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "error");
    assert.equal(messages[0].requestId, 37);
    assert.match(messages[0].message, /supports macOS AVFoundation only/);
    assert.equal(provider.pendingPriorTurn, undefined);
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("native recording stop failures echo request ids for stale-message filtering", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, { type: "stopNativeRecording", requestId: 38 });

    assert.equal(messages.length, 1);
    assert.equal(messages[0].type, "error");
    assert.equal(messages[0].requestId, 38);
    assert.match(messages[0].message, /Native recorder is not running/);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("stale native recording start failures do not clear replacement view reply context", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const firstMessages = [];
  const secondMessages = [];
  const firstView = createPracticeWebviewView(firstMessages);
  const secondView = createPracticeWebviewView(secondMessages);

  try {
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
    provider.resolveWebviewView(firstView);
    await waitForAsyncWork();
    firstMessages.length = 0;

    const staleStart = provider.handleMessage(firstView, { type: "startNativeRecording", requestId: 41 });
    provider.resolveWebviewView(secondView);
    await provider.handleMessage(secondView, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "Could you restate the finding?",
        followUpQuestion: "What changed after the audit?",
        userTranscript: "The route became explicit.",
      },
    });
    assert.ok(provider.pendingPriorTurn);

    await staleStart;

    assert.ok(provider.pendingPriorTurn);
    assert.equal(provider.pendingPriorTurn.nativeVersion, "Could you restate the finding?");
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("failed practice audio consumes stale reply context before the next turn", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "What do you mean by that?",
        followUpQuestion: "Can you give an example?",
        userTranscript: "I think it depends.",
      },
    });
    assert.ok(provider.pendingPriorTurn);

    await provider.handleMessage(view, {
      type: "practiceAudio",
      mimeType: "audio/webm",
      base64: "not-base64!",
      requestId: 42,
    });

    assert.equal(provider.pendingPriorTurn, undefined);
    assert.ok(messages.some((message) =>
      message.type === "error" &&
      message.requestId === 42 &&
      /Recorded audio payload was not valid base64/.test(message.message),
    ));
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("reply context payloads trim useful fields and skip blank native versions", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const view = createPracticeWebviewView([]);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "   ",
        followUpQuestion: " What changed? ",
        userTranscript: " I need a moment. ",
      },
    });
    assert.equal(provider.pendingPriorTurn, undefined);

    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: " Could you clarify? ",
        followUpQuestion: " What changed? ",
        userTranscript: " I need a moment. ",
      },
    });
    assert.deepEqual(provider.pendingPriorTurn, {
      nativeVersion: "Could you clarify?",
      followUpQuestion: "What changed?",
      userTranscript: "I need a moment.",
    });

    await provider.handleMessage(view, {
      type: "setReplyContext",
      priorTurn: {
        native_version: " Could you restate it? ",
        follow_up_question: " What changed next? ",
        user_transcript: " I narrowed the point. ",
      },
    });
    assert.deepEqual(provider.pendingPriorTurn, {
      nativeVersion: "Could you restate it?",
      followUpQuestion: "What changed next?",
      userTranscript: "I narrowed the point.",
    });
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("coach text selection trims fields and skips whitespace-only values", () => {
  assert.equal(api.firstNonBlankString("   ", "\n Could you clarify? \n", "fallback"), "Could you clarify?");
  assert.equal(api.firstNonBlankString("  ", "\tSpeak clearly.\n"), "Speak clearly.");
  assert.equal(api.firstNonBlankString(undefined, null, "   "), "");
});

test("error messages prefer trimmed scalar fields over object placeholders", () => {
  assert.equal(api.errorMessage(new Error("  failed politely  ")), "failed politely");
  assert.equal(api.errorMessage({ message: " provider said no " }), "provider said no");
  assert.equal(api.errorMessage({ error: "bad token" }), "bad token");
  assert.equal(api.errorMessage({ reason: "network closed" }), "network closed");
  assert.equal(api.errorMessage({ statusText: "Too Many Requests" }), "Too Many Requests");
  assert.equal(api.errorMessage({ code: "ECONNRESET" }), "ECONNRESET");
  assert.equal(api.errorMessage({ nested: { message: "hidden" } }), "Unknown error");
  assert.equal(api.errorMessage(null), "Unknown error");
});

test("fetch network failures include the provider host and retry guidance", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => {
    const error = new TypeError("fetch failed");
    error.cause = { code: "ENOTFOUND", hostname: "api.openai.com" };
    throw error;
  };

  try {
    await assert.rejects(
      () => api.fetchWithTimeout("https://api.openai.com/v1/audio/transcriptions?key=secret", {}, 100),
      /Network request to api\.openai\.com failed before a response arrived \(fetch failed; ENOTFOUND; api\.openai\.com\)\. Check your VPN\/proxy\/DNS connection and press ↻ to retry\./,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetch timeout stays armed through stalled body reads", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, init) => {
    const waitForAbort = () => new Promise((_resolve, reject) => {
      const signal = init.signal;
      const rejectAbort = () => {
        const error = new Error("body read aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) {
        rejectAbort();
        return;
      }
      signal.addEventListener("abort", rejectAbort, { once: true });
    });
    return {
      ok: true,
      status: 200,
      arrayBuffer: waitForAbort,
      blob: waitForAbort,
      formData: waitForAbort,
      json: waitForAbort,
      text: waitForAbort,
    };
  };

  try {
    const response = await api.fetchWithTimeout("https://api.openai.com/v1/chat/completions", {}, 25);
    await Promise.race([
      assert.rejects(
        () => response.text(),
        /Request timed out after 25ms .*press ↻ to retry\./,
      ),
      new Promise((_resolve, reject) => setTimeout(
        () => reject(new Error("stalled response body did not time out")),
        250,
      )),
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("reply context does not survive a rebuilt practice webview", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const firstView = createPracticeWebviewView([]);
  const secondView = createPracticeWebviewView([]);

  try {
    provider.resolveWebviewView(firstView);
    await waitForAsyncWork();
    await provider.handleMessage(firstView, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "What do you mean by that?",
        followUpQuestion: "Can you give an example?",
        userTranscript: "I think it depends.",
      },
    });
    assert.ok(provider.pendingPriorTurn);

    provider.resolveWebviewView(secondView);
    await waitForAsyncWork();
    assert.equal(provider.pendingPriorTurn, undefined);

    await provider.handleMessage(secondView, {
      type: "setReplyContext",
      priorTurn: {
        nativeVersion: "Could you clarify?",
        followUpQuestion: "What happened next?",
        userTranscript: "The project changed.",
      },
    });
    assert.ok(provider.pendingPriorTurn);

    secondView.dispose();
    assert.equal(provider.pendingPriorTurn, undefined);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("practice-result refresh failures are logged instead of reported as turn errors", async () => {
  const provider = new api.PracticeViewProvider({
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  });
  outputLines.length = 0;
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    throw new Error("refresh after result failed");
  });

  try {
    await assert.doesNotReject(() => provider.refreshAfterPracticeResult());
  } finally {
    api.clearRefreshHandlers();
  }

  assert.ok(outputLines.some((line) =>
    /Practice result posted, but follow-up refresh failed: refresh after result failed/.test(line),
  ));
});

test("slow-read messages with missing text return a result error", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, { type: "slowRead", text: "  ", target: " native ", requestId: 7 });

    assert.deepEqual(messages, [
      {
        type: "slowReadResult",
        target: "native",
        requestId: 7,
        error: "Slow-read text was missing.",
      },
    ]);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("slow-read messages reject non-scalar speed payloads", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);
  const calls = [];

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    provider.slowReadText = async (text, target, speed, requestId) => {
      calls.push({ text, target, speed, requestId });
    };

    await provider.handleMessage(view, { type: "slowRead", text: "hello", target: "native", speed: [1.2], requestId: 8 });
    await provider.handleMessage(view, { type: "slowRead", text: "again", target: "native", speed: "0.8", requestId: 9 });

    assert.deepEqual(calls, [
      { text: "hello", target: "native", speed: 0.7, requestId: 8 },
      { text: "again", target: "native", speed: 0.8, requestId: 9 },
    ]);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("today TTS failures return an inline result error instead of a generic wedged state", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, { type: "todayTts", requestId: 11 });

    assert.equal(messages[0].type, "todayTtsStatus");
    assert.equal(messages[0].requestId, 11);
    assert.equal(messages[1].type, "todayTtsResult");
    assert.equal(messages[1].requestId, 11);
    assert.match(messages[1].error, /Could not find an EnglishSpeakingTraining root with a prebuilt\/ folder/);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("drill generation trims existing examples before provider calls", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);
  const calls = [];

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    provider.generateDrillLines = async (count, existing, requestId) => {
      calls.push({ count, existing, requestId });
    };

    await provider.handleMessage(view, {
      type: "generateDrillLines",
      count: "3",
      existing: ["  keep me  ", "   ", "", 42, null, "next  "],
      requestId: 21,
    });
    await provider.handleMessage(view, {
      type: "generateDrillLines",
      count: [3],
      existing: [],
      requestId: 22,
    });

    assert.deepEqual(calls, [
      { count: 3, existing: ["keep me", "42", "next"], requestId: 21 },
      { count: 5, existing: [], requestId: 22 },
    ]);
    assert.equal(messages.length, 0);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("drill generation prompt bounds avoid texts before provider calls", () => {
  const longLine = ` ${"overlong phrase ".repeat(40)} `;
  const prompt = api.drillGenUserPrompt(
    {
      next: { package_date: "2026-05-22", goal: "Argue clearly", scenario: "Seminar" },
      training: { goal: "Argue clearly", scenario: "Seminar", frames: [] },
      learnerProfile: { loaded: false },
      drill: {},
    },
    5,
    [
      "   ",
      longLine,
      "  short one  ",
      ...Array.from({ length: 50 }, (_value, index) => `line ${index}`),
    ],
  );
  const payload = JSON.parse(prompt);

  assert.equal(payload.avoid_texts.length, 40);
  assert.equal(payload.avoid_texts[0].length, 240);
  assert.equal(payload.avoid_texts[0].endsWith("..."), true);
  assert.equal(payload.avoid_texts[1], "short one");
  assert.equal(payload.avoid_texts.some((item) => !item.trim()), false);
});

test("coach and drill prompts share cleaned lesson frame text", () => {
  const state = {
    next: { package_date: "2026-05-22", goal: "Argue clearly", scenario: "Seminar" },
    training: {
      goal: "Argue clearly",
      scenario: "Seminar",
      frames: [
        "  The authority must justify the measure.  ",
        { text: "The review should stay proportionate.\n" },
        ["bad frame"],
        { text: "   " },
      ],
    },
    learnerProfile: { loaded: false },
    drill: {},
  };

  const coachingPayload = JSON.parse(api.coachingUserPrompt(state, " I need clearer phrasing. "));
  const drillPayload = JSON.parse(api.drillGenUserPrompt(state, 3, []));

  assert.deepEqual(coachingPayload.task.frames, [
    "The authority must justify the measure.",
    "The review should stay proportionate.",
  ]);
  assert.deepEqual(drillPayload.task.frames, coachingPayload.task.frames);
});

test("drill generation failures echo request ids for stale-result filtering", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];

  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  const provider = new api.PracticeViewProvider(context);
  const messages = [];
  const view = createPracticeWebviewView(messages);

  try {
    provider.resolveWebviewView(view);
    await waitForAsyncWork();
    messages.length = 0;

    await provider.handleMessage(view, { type: "generateDrillLines", count: 5, existing: [], requestId: 19 });

    assert.equal(messages.length, 2);
    assert.deepEqual(messages.map((message) => message.requestId), [19, 19]);
    assert.equal(messages[0].type, "drillLinesStatus");
    assert.equal(messages[1].type, "drillLinesResult");
    assert.match(messages[1].error, /Could not find an EnglishSpeakingTraining root with a prebuilt\/ folder/);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
  }
});

test("startup async task failures are logged, not left unhandled", async () => {
  const unhandled = [];
  const onUnhandled = (error) => {
    unhandled.push(error);
  };
  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  outputLines.length = 0;
  process.on("unhandledRejection", onUnhandled);

  try {
    extension.activate(context);
    api.runStartupTask("demo failure", async () => {
      throw new Error("startup exploded");
    });
    await waitForAsyncWork();

    assert.deepEqual(unhandled, []);
    assert.ok(
      outputLines.some((line) =>
        /English Training startup task failed \(demo failure\): startup exploded/.test(line),
      ),
      "startup task rejection should be recorded in the output channel",
    );
  } finally {
    process.off("unhandledRejection", onUnhandled);
    extension.deactivate();
  }
});

test("command task failures are logged and surfaced without rejecting", async () => {
  const context = {
    extensionPath: "/tmp/english-training-extension-test",
    extensionUri: mockVscode.Uri.file("/tmp/english-training-extension-test"),
    globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined,
    },
    subscriptions: [],
  };
  outputLines.length = 0;
  errorMessages.length = 0;

  try {
    extension.activate(context);
    await assert.doesNotReject(() => api.runCommandTask("englishTraining.demo", async () => {
      throw new Error("demo command exploded");
    }));

    assert.ok(
      outputLines.some((line) =>
        /English Training command failed \(englishTraining\.demo\): demo command exploded/.test(line),
      ),
      "command rejection should be recorded in the output channel",
    );
    assert.deepEqual(errorMessages, ["English Training: demo command exploded"]);
  } finally {
    extension.deactivate();
  }
});

test("refreshAll still runs later handlers after one refresh handler fails", async () => {
  const calls = [];
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    calls.push("first");
    throw new Error("first refresh failed");
  });
  api.registerRefreshHandler(async () => {
    calls.push("second");
  });

  try {
    await assert.rejects(() => api.refreshAll(), /first refresh failed/);
    assert.deepEqual(calls, ["first", "second"]);
  } finally {
    api.clearRefreshHandlers();
  }
});

test("generate-next package treats learner-brief cancel as cancel, not blank", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-generate-next-"));
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const previousOpenTextDocument = mockVscode.workspace.openTextDocument;
  const opened = [];

  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) => {
    if (options.title === "Generate Next Package") {
      return "2026-05-23";
    }
    if (options.title === "Generate Next Package — Learner Brief") {
      return undefined;
    }
    return undefined;
  };
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };
  mockVscode.workspace.openTextDocument = async (value) => {
    opened.push(value);
    return value;
  };
  api.clearRefreshHandlers();

  try {
    await api.generateNextPackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    mockVscode.workspace.openTextDocument = previousOpenTextDocument;
  }

  assert.equal(fs.existsSync(path.join(root, "prebuilt", "2026-05-23")), false);
  assert.deepEqual(opened, []);
});

test("generate-next package refuses invalid dates even if input validation is bypassed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-generate-invalid-date-"));
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousOpenTextDocument = mockVscode.workspace.openTextDocument;
  warningMessages.length = 0;
  const inputTitles = [];
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) => {
    inputTitles.push(options.title);
    if (options.title === "Generate Next Package") {
      return "2026-02-30";
    }
    throw new Error("learner brief should not be requested after an invalid date");
  };
  mockVscode.workspace.openTextDocument = async (value) => {
    opened.push(value);
    return value;
  };

  try {
    await api.generateNextPackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.workspace.openTextDocument = previousOpenTextDocument;
  }

  assert.deepEqual(inputTitles, ["Generate Next Package"]);
  assert.equal(fs.existsSync(path.join(root, "prebuilt", "2026-02-30")), false);
  assert.deepEqual(opened, []);
  assert.deepEqual(warningMessages, ["Use a real calendar date in YYYY-MM-DD format."]);
  warningMessages.length = 0;
});

test("sample package refuses to overwrite an existing drill-only package without confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-sample-overwrite-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-24");
  const drillFile = path.join(packageDir, "followup-drill.json");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(drillFile, "{\"keep\":true}\n", "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  warningMessages.length = 0;
  let refreshes = 0;
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) =>
    options.title === "Create Sample Package" ? "2026-05-24" : undefined;
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.createSamplePackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(packageDir, "english-training.json")), false);
  assert.equal(fs.readFileSync(drillFile, "utf8"), "{\"keep\":true}\n");
  assert.equal(refreshes, 0);
  assert.deepEqual(opened, []);
  assert.deepEqual(warningMessages, ["2026-05-24/followup-drill.json already exists. Overwrite?"]);
  warningMessages.length = 0;
});

test("sample package refuses invalid dates even if input validation is bypassed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-sample-invalid-date-"));
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  warningMessages.length = 0;
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) =>
    options.title === "Create Sample Package" ? "2026-13-01" : undefined;
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };

  try {
    await api.createSamplePackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showTextDocument = previousShowTextDocument;
  }

  assert.equal(fs.existsSync(path.join(root, "prebuilt", "2026-13-01")), false);
  assert.deepEqual(opened, []);
  assert.deepEqual(warningMessages, ["Use a real calendar date in YYYY-MM-DD format."]);
  warningMessages.length = 0;
});

test("sample package removes stale generated assets after overwrite confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-sample-clean-assets-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-27");
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), "{\"old\":true}\n", "utf8");
  fs.writeFileSync(path.join(packageDir, "manifest.json"), "{\"files\":{\"audio_demo\":\"audio/demo.ogg\"}}\n", "utf8");
  fs.writeFileSync(path.join(packageDir, "daily-card.png"), "old image", "utf8");
  fs.writeFileSync(path.join(packageDir, "audio", "demo.ogg"), "old audio", "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousWarningMessage = mockVscode.window.showWarningMessage;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const warnings = [];
  let refreshes = 0;
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) =>
    options.title === "Create Sample Package" ? "2026-05-27" : undefined;
  mockVscode.window.showWarningMessage = async (message, _options, ...items) => {
    warnings.push(message);
    return items.includes("Overwrite") ? "Overwrite" : undefined;
  };
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.createSamplePackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showWarningMessage = previousWarningMessage;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(packageDir, "english-training.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "followup-drill.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "manifest.json")), false);
  assert.equal(fs.existsSync(path.join(packageDir, "daily-card.png")), false);
  assert.equal(fs.existsSync(path.join(packageDir, "audio", "demo.ogg")), false);
  assert.equal(refreshes, 1);
  assert.equal(opened.length, 1);
  assert.deepEqual(warnings, [
    "2026-05-27/english-training.json and manifest.json and daily-card.png and audio/demo.ogg already exists. Overwrite?",
  ]);
});

test("sample package removes directory-shaped generated artifacts after overwrite confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-sample-clean-dirs-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-28");
  fs.mkdirSync(path.join(packageDir, "english-training.json", "nested"), { recursive: true });
  fs.mkdirSync(path.join(packageDir, "daily-card.png"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json", "nested", "oops.txt"), "not json", "utf8");
  fs.writeFileSync(path.join(packageDir, "daily-card.png", "oops.txt"), "not image", "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousWarningMessage = mockVscode.window.showWarningMessage;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const warnings = [];
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) =>
    options.title === "Create Sample Package" ? "2026-05-28" : undefined;
  mockVscode.window.showWarningMessage = async (message, _options, ...items) => {
    warnings.push(message);
    return items.includes("Overwrite") ? "Overwrite" : undefined;
  };
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };

  try {
    await api.createSamplePackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showWarningMessage = previousWarningMessage;
    mockVscode.window.showTextDocument = previousShowTextDocument;
  }

  assert.equal(fs.statSync(path.join(packageDir, "english-training.json")).isFile(), true);
  assert.equal(fs.statSync(path.join(packageDir, "followup-drill.json")).isFile(), true);
  assert.equal(fs.existsSync(path.join(packageDir, "daily-card.png")), false);
  assert.equal(opened.length, 1);
  assert.deepEqual(warnings, [
    "2026-05-28/english-training.json and daily-card.png already exists. Overwrite?",
  ]);
});

test("generate-next package refuses to overwrite an existing drill-only package without confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-generate-overwrite-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-25");
  const drillFile = path.join(packageDir, "followup-drill.json");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(drillFile, "{\"keep\":true}\n", "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const previousOpenTextDocument = mockVscode.workspace.openTextDocument;
  warningMessages.length = 0;
  let refreshes = 0;
  const opened = [];
  const inputTitles = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) => {
    inputTitles.push(options.title);
    if (options.title === "Generate Next Package") {
      return "2026-05-25";
    }
    if (options.title === "Generate Next Package — Learner Brief") {
      throw new Error("learner brief should not be requested before overwrite confirmation");
    }
    return undefined;
  };
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };
  mockVscode.workspace.openTextDocument = async (value) => {
    opened.push(value);
    return value;
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.generateNextPackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    mockVscode.workspace.openTextDocument = previousOpenTextDocument;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(packageDir, "english-training.json")), false);
  assert.equal(fs.readFileSync(drillFile, "utf8"), "{\"keep\":true}\n");
  assert.equal(refreshes, 0);
  assert.deepEqual(opened, []);
  assert.deepEqual(inputTitles, ["Generate Next Package"]);
  assert.deepEqual(warningMessages, [
    "2026-05-25/followup-drill.json already exists. Overwrite with a blank skeleton?",
  ]);
  warningMessages.length = 0;
});

test("generate-next package removes stale generated assets after overwrite confirmation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-generate-clean-assets-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-26");
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), "{\"old\":true}\n", "utf8");
  fs.writeFileSync(path.join(packageDir, "manifest.json"), "{\"files\":{\"daily_card\":\"daily-card.png\"}}\n", "utf8");
  fs.writeFileSync(path.join(packageDir, "daily-card.png"), "old image", "utf8");
  fs.writeFileSync(path.join(packageDir, "audio", "demo.ogg"), "old audio", "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousWarningMessage = mockVscode.window.showWarningMessage;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const previousOpenTextDocument = mockVscode.workspace.openTextDocument;
  const warnings = [];
  let refreshes = 0;
  const opened = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showInputBox = async (options) => {
    if (options.title === "Generate Next Package") {
      return "2026-05-26";
    }
    if (options.title === "Generate Next Package — Learner Brief") {
      return "";
    }
    return undefined;
  };
  mockVscode.window.showWarningMessage = async (message, _options, ...items) => {
    warnings.push(message);
    return items.includes("Overwrite") ? "Overwrite" : undefined;
  };
  mockVscode.window.showTextDocument = async (value) => {
    opened.push(value);
    return undefined;
  };
  mockVscode.workspace.openTextDocument = async (value) => {
    opened.push(value);
    return value;
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.generateNextPackage({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showWarningMessage = previousWarningMessage;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    mockVscode.workspace.openTextDocument = previousOpenTextDocument;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(packageDir, "english-training.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "followup-drill.json")), true);
  assert.equal(fs.existsSync(path.join(packageDir, "manifest.json")), false);
  assert.equal(fs.existsSync(path.join(packageDir, "daily-card.png")), false);
  assert.equal(fs.existsSync(path.join(packageDir, "audio", "demo.ogg")), false);
  assert.equal(refreshes, 1);
  assert.equal(opened.length, 3);
  assert.deepEqual(warnings, [
    "2026-05-26/english-training.json and manifest.json and daily-card.png and audio/demo.ogg already exists. Overwrite with a blank skeleton?",
  ]);
});

test("bootstrapped materials root refreshes even when sample creation is canceled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-bootstrap-cancel-"));

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousInputBox = mockVscode.window.showInputBox;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const info = [];
  const inputTitles = [];
  let refreshes = 0;
  configValues.localMaterialsRoot = "";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.window.showInformationMessage = async (message, _options, ...items) => {
    info.push(message);
    return items.includes("Pick Folder") ? "Pick Folder" : undefined;
  };
  mockVscode.window.showOpenDialog = async () => [mockVscode.Uri.file(root)];
  mockVscode.window.showInputBox = async (options) => {
    inputTitles.push(options.title);
    return undefined;
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });
  api.invalidateNextPackageCache();
  let configuredRootAfterCall = "";

  try {
    await api.createSamplePackage({});
    configuredRootAfterCall = configValues.localMaterialsRoot;
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
    api.invalidateNextPackageCache();
  }

  assert.equal(configuredRootAfterCall, root);
  assert.equal(fs.existsSync(path.join(root, "prebuilt")), true);
  assert.equal(fs.existsSync(path.join(root, "progress")), true);
  assert.deepEqual(inputTitles, ["Create Sample Package"]);
  assert.equal(refreshes, 1);
  assert.deepEqual(info, [
    "No local materials folder found. Pick a folder to host your lessons — the extension will create prebuilt/ and progress/ inside it.",
    `English Training materials root set to ${root}.`,
  ]);
  assert.deepEqual(fs.readdirSync(path.join(root, "prebuilt")), []);
});

test("compose material prompt skips coach call when save folder is canceled", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousWithProgress = mockVscode.window.withProgress;
  const calls = [];

  mockVscode.window.showInputBox = async (options) => {
    if (options.title === "Compose Material Prompt — Topic") {
      return "conference discussant response";
    }
    if (options.title === "Compose Material Prompt — Lesson Date") {
      return "2026-05-24";
    }
    return undefined;
  };
  mockVscode.window.showOpenDialog = async () => undefined;
  mockVscode.window.withProgress = async () => {
    calls.push("coach");
    return "expanded brief";
  };

  try {
    await api.composeMaterialPrompt({});
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.withProgress = previousWithProgress;
  }

  assert.deepEqual(calls, []);
});

test("compose material prompt refuses too-short topics before asking for date", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousWithProgress = mockVscode.window.withProgress;
  const inputTitles = [];
  const calls = [];
  warningMessages.length = 0;
  mockVscode.window.showInputBox = async (options) => {
    inputTitles.push(options.title);
    if (options.title === "Compose Material Prompt — Topic") {
      return " IP ";
    }
    throw new Error("lesson date should not be requested after a too-short topic");
  };
  mockVscode.window.showOpenDialog = async () => {
    calls.push("openDialog");
    return undefined;
  };
  mockVscode.window.withProgress = async () => {
    calls.push("coach");
    return "expanded brief";
  };

  try {
    await api.composeMaterialPrompt({});
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.withProgress = previousWithProgress;
  }

  assert.deepEqual(inputTitles, ["Compose Material Prompt — Topic"]);
  assert.deepEqual(calls, []);
  assert.deepEqual(warningMessages, ["Describe the topic in a few words."]);
  warningMessages.length = 0;
});

test("compose material prompt refuses invalid dates before picking a save folder", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousWithProgress = mockVscode.window.withProgress;
  const inputTitles = [];
  const calls = [];
  warningMessages.length = 0;
  mockVscode.window.showInputBox = async (options) => {
    inputTitles.push(options.title);
    if (options.title === "Compose Material Prompt — Topic") {
      return "conference discussant response";
    }
    if (options.title === "Compose Material Prompt — Lesson Date") {
      return "not-a-date";
    }
    return undefined;
  };
  mockVscode.window.showOpenDialog = async () => {
    calls.push("openDialog");
    return undefined;
  };
  mockVscode.window.withProgress = async () => {
    calls.push("coach");
    return "expanded brief";
  };

  try {
    await api.composeMaterialPrompt({});
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.withProgress = previousWithProgress;
  }

  assert.deepEqual(inputTitles, [
    "Compose Material Prompt — Topic",
    "Compose Material Prompt — Lesson Date",
  ]);
  assert.deepEqual(calls, []);
  assert.deepEqual(warningMessages, ["Use a real calendar date in YYYY-MM-DD format."]);
  warningMessages.length = 0;
});

test("configuring the already active materials root does not rewrite or refresh", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-current-root-"));
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const info = [];
  const updates = [];
  let refreshes = 0;
  configValues.localMaterialsRoot = root;
  mockVscode.window.showOpenDialog = async () => [mockVscode.Uri.file(root)];
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureLocalMaterialsRoot();
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(info, [`English Training local materials folder is already ${root}.`]);
});

test("configuring a materials root repairs a malformed existing root setting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-malformed-root-"));

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const info = [];
  const updates = [];
  let refreshes = 0;
  configValues.localMaterialsRoot = { stale: root };
  mockVscode.window.showOpenDialog = async () => [mockVscode.Uri.file(root)];
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    const changed = await api.configureLocalMaterialsRoot();
    assert.equal(changed, true);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(root, "prebuilt")), true);
  assert.equal(fs.existsSync(path.join(root, "progress")), true);
  assert.deepEqual(updates, [
    {
      key: "localMaterialsRoot",
      value: root,
      target: mockVscode.ConfigurationTarget.Global,
    },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(info, [`English Training local materials folder set to ${root}.`]);
});

test("configuring a materials root updates an existing workspace-scoped root at workspace scope", async () => {
  const oldRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-workspace-root-old-"));
  const newRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-workspace-root-new-"));
  fs.mkdirSync(path.join(oldRoot, "prebuilt"), { recursive: true });

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const info = [];
  const updates = [];
  let refreshes = 0;
  configValues.localMaterialsRoot = oldRoot;
  mockVscode.window.showOpenDialog = async () => [mockVscode.Uri.file(newRoot)];
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: (key) => {
        assert.equal(key, "localMaterialsRoot");
        return {
          globalValue: "/tmp/global-materials-root",
          workspaceValue: oldRoot,
        };
      },
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    const changed = await api.configureLocalMaterialsRoot();
    assert.equal(changed, true);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(newRoot, "prebuilt")), true);
  assert.equal(fs.existsSync(path.join(newRoot, "progress")), true);
  assert.deepEqual(updates, [
    {
      key: "localMaterialsRoot",
      value: newRoot,
      target: mockVscode.ConfigurationTarget.Workspace,
    },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(info, [`English Training local materials folder set to ${newRoot}.`]);
});

test("configuring a materials root invalidates before refresh when scaffold is created", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-current-root-missing-scaffold-"));

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousOpenDialog = mockVscode.window.showOpenDialog;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const events = [];
  const info = [];
  const updates = [];
  configValues.localMaterialsRoot = root;
  mockVscode.window.showOpenDialog = async () => [mockVscode.Uri.file(root)];
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    events.push("refresh");
  });

  try {
    const changed = await api.configureLocalMaterialsRoot({
      onChanged: () => events.push("invalidate"),
    });
    assert.equal(changed, true);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.window.showOpenDialog = previousOpenDialog;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.equal(fs.existsSync(path.join(root, "prebuilt")), true);
  assert.equal(fs.existsSync(path.join(root, "progress")), true);
  assert.deepEqual(updates, []);
  assert.deepEqual(events, ["invalidate", "refresh"]);
  assert.deepEqual(info, [
    `English Training local materials folder is already ${root}; created missing prebuilt/progress folders.`,
  ]);
});

test("reveal current package prefers the verified local package directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-reveal-package-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Seminar answer",
    goal: "Use the real local package directory.",
  }), "utf8");
  fs.writeFileSync(path.join(scriptsDir, "english_training_progress.py"), [
    "console.log(JSON.stringify({",
    "  result: {",
    `    package_date: '${packageDate}',`,
    "    assets: { package_dir: '/tmp/stale-script-package-dir' },",
    "  },",
    "}));",
  ].join("\n"), "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousPythonPath = configValues.pythonPath;
  const previousExecuteCommand = mockVscode.commands.executeCommand;
  const revealed = [];
  configValues.localMaterialsRoot = root;
  configValues.pythonPath = process.execPath;
  mockVscode.commands.executeCommand = async (command, uri) => {
    revealed.push({ command, fsPath: uri.fsPath });
  };
  api.invalidateNextPackageCache();

  try {
    await api.revealCurrentPackage({
      secrets: {
        get: async () => undefined,
      },
    });
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.pythonPath = previousPythonPath;
    mockVscode.commands.executeCommand = previousExecuteCommand;
    api.invalidateNextPackageCache();
  }

  assert.deepEqual(revealed, [
    { command: "revealFileInOS", fsPath: packageDir },
  ]);
});

test("open current task card prefers the verified local package card", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-open-task-card-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const scriptsDir = path.join(root, "scripts");
  const cardPath = path.join(packageDir, "telegram-task-card.md");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Seminar answer",
    goal: "Open the real local task card.",
  }), "utf8");
  fs.writeFileSync(cardPath, "# Real current card\n", "utf8");
  fs.writeFileSync(path.join(scriptsDir, "english_training_progress.py"), [
    "console.log(JSON.stringify({",
    "  result: {",
    `    package_date: '${packageDate}',`,
    "    assets: { task_card: 'https://example.invalid/stale-card' },",
    "  },",
    "}));",
  ].join("\n"), "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousPythonPath = configValues.pythonPath;
  const previousOpenExternal = mockVscode.env.openExternal;
  const previousShowTextDocument = mockVscode.window.showTextDocument;
  const external = [];
  const opened = [];
  configValues.localMaterialsRoot = root;
  configValues.pythonPath = process.execPath;
  mockVscode.env.openExternal = async (uri) => {
    external.push(uri.toString());
  };
  mockVscode.window.showTextDocument = async (uri) => {
    opened.push(uri.fsPath);
  };
  api.invalidateNextPackageCache();

  try {
    await api.openCurrentTaskCard({
      secrets: {
        get: async () => undefined,
      },
    });
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.pythonPath = previousPythonPath;
    mockVscode.env.openExternal = previousOpenExternal;
    mockVscode.window.showTextDocument = previousShowTextDocument;
    api.invalidateNextPackageCache();
  }

  assert.deepEqual(external, []);
  assert.deepEqual(opened, [cardPath]);
});

test("path and URL helpers trim hand-edited asset values before opening", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-trim-open-paths-"));
  const filePath = path.join(root, "telegram-task-card.md");
  fs.writeFileSync(filePath, "# Card\n", "utf8");

  assert.equal(api.isHttpUrl(" https://example.test/card "), true);
  assert.equal(api.isHttpUrl(" /tmp/not-a-url "), false);
  assert.equal(api.existingFilePath(` ${filePath} `), filePath);
  assert.equal(api.existingDirectoryPath(` ${root} `), root);
  assert.equal(api.existingFilePath(` https://example.test/card `), "");
  assert.equal(api.existingDirectoryPath({ bad: root }), "");
});

test("open session folder resolves the root without running next-package scripts", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-open-session-folder-"));
  const scriptsDir = path.join(root, "scripts");
  const markerPath = path.join(root, "script-ran.txt");
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(scriptsDir, "english_training_progress.py"), [
    "require('node:fs').writeFileSync('script-ran.txt', 'ran');",
    "console.log(JSON.stringify({ result: { package_date: '2026-05-22' } }));",
  ].join("\n"), "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousPythonPath = configValues.pythonPath;
  const previousExecuteCommand = mockVscode.commands.executeCommand;
  const revealed = [];
  configValues.localMaterialsRoot = root;
  configValues.pythonPath = process.execPath;
  mockVscode.commands.executeCommand = async (command, uri) => {
    revealed.push({ command, fsPath: uri.fsPath });
  };
  api.invalidateNextPackageCache();

  try {
    await api.openSessionFolder({});
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.pythonPath = previousPythonPath;
    mockVscode.commands.executeCommand = previousExecuteCommand;
    api.invalidateNextPackageCache();
  }

  assert.equal(fs.existsSync(markerPath), false);
  assert.deepEqual(revealed, [
    { command: "revealFileInOS", fsPath: path.join(root, "runtime", "vscode-sessions") },
  ]);
});

test("complete local package rejects a progress-script directory before spawning Python", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-complete-script-dir-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const scriptDir = path.join(root, "scripts", "english_training_progress.py");
  const markerPath = path.join(root, "complete-script-ran.txt");
  const runnerPath = path.join(root, "python-runner.js");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Seminar answer",
    goal: "Complete should fail before running a directory as Python.",
  }), "utf8");
  fs.writeFileSync(
    runnerPath,
    `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(markerPath)}, "ran");\n`,
    "utf8",
  );
  fs.chmodSync(runnerPath, 0o755);

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousPythonPath = configValues.pythonPath;
  configValues.localMaterialsRoot = root;
  configValues.pythonPath = runnerPath;
  api.invalidateNextPackageCache();

  try {
    await assert.rejects(
      () => api.completeLocalPackage({
        secrets: {
          get: async () => undefined,
        },
      }),
      /requires scripts\/english_training_progress\.py to be a file/,
    );
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.pythonPath = previousPythonPath;
    api.invalidateNextPackageCache();
  }

  assert.equal(fs.existsSync(markerPath), false);
});

test("complete local package reports empty script failures with an exit code", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-complete-empty-fail-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const scriptsDir = path.join(root, "scripts");
  const scriptPath = path.join(scriptsDir, "english_training_progress.py");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Seminar answer",
    goal: "Complete should explain an empty script failure.",
  }), "utf8");
  fs.writeFileSync(scriptPath, [
    "if (process.argv[2] === 'next') {",
    `  console.log(JSON.stringify({ result: { package_date: '${packageDate}' } }));`,
    "  process.exit(0);",
    "}",
    "if (process.argv[2] === 'complete') {",
    "  process.exit(2);",
    "}",
    "process.exit(0);",
  ].join("\n"), "utf8");

  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousPythonPath = configValues.pythonPath;
  configValues.localMaterialsRoot = root;
  configValues.pythonPath = process.execPath;
  api.invalidateNextPackageCache();

  try {
    await assert.rejects(
      () => api.completeLocalPackage({
        secrets: {
          get: async () => undefined,
        },
      }),
      /Local completion failed: exit code 2 with no output/,
    );
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.pythonPath = previousPythonPath;
    api.invalidateNextPackageCache();
  }
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

test("lesson date input rejects invalid calendar dates", () => {
  assert.equal(api.validateLessonDateInput("2026-06-01"), null);
  assert.match(api.validateLessonDateInput("2026-02-30"), /real calendar date/);
  assert.match(api.validateLessonDateInput("not-a-date"), /real calendar date/);
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

test("string-shaped lesson frames feed transcription prompts and next-drill suggestions", () => {
  const state = {
    training: {
      scenario: "Conference Q&A",
      goal: "Answer a question about AI governance.",
      key_expressions: ["  public accountability  "],
      frames: [
        "  The public authority should justify the intervention.  ",
        { text: "The burden of proof remains with the regulator." },
        ["bad frame"],
        "   ",
      ],
      clean_tts_text: "Fallback line should not be the first drill.",
    },
    next: {},
    drill: {},
  };

  assert.match(
    api.buildTranscriptionPrompt(state),
    /Example sentences: The public authority should justify the intervention\. \/ The burden of proof remains with the regulator\./,
  );
  assert.match(
    api.nextDrillFromState(state, ["[TA]"]),
    /repeat "The public authority should justify the intervention\."/,
  );
  assert.doesNotMatch(api.nextDrillFromState(state, []), /Fallback line/);
});

test("accepts a bring-your-own-materials root that only has prebuilt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.mkdirSync(path.join(root, "prebuilt"));
  assert.equal(api.looksLikeTrainingRoot(root), true);

  const notRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-root-"));
  fs.writeFileSync(path.join(notRoot, "prebuilt"), "not a directory");
  assert.equal(api.looksLikeTrainingRoot(notRoot), false);
});

test("configured materials root trims whitespace before home expansion", async () => {
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousActiveEditor = mockVscode.window.activeTextEditor;
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-home-"));
  const root = path.join(home, "English Training Materials");
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  configValues.localMaterialsRoot = " ~/English Training Materials ";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.window.activeTextEditor = undefined;
  process.env.HOME = home;

  try {
    assert.equal(api.expandHome(" ~/English Training Materials "), root);
    assert.equal(await api.findTrainingRoot(), root);
  } finally {
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.window.activeTextEditor = previousActiveEditor;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("home expansion leaves tilde paths intact when HOME is unavailable", () => {
  const previousHome = process.env.HOME;
  delete process.env.HOME;

  try {
    assert.equal(api.expandHome(" ~/English Training Materials "), "~/English Training Materials");
    assert.equal(api.expandHome(" ~ "), "~");
  } finally {
    if (previousHome !== undefined) {
      process.env.HOME = previousHome;
    }
  }
});

test("lists only valid prebuilt package directories defensively", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-dates-"));
  const prebuilt = path.join(root, "prebuilt");
  fs.mkdirSync(path.join(prebuilt, "2026-05-17"), { recursive: true });
  fs.mkdirSync(path.join(prebuilt, "2026-05-19"));
  fs.mkdirSync(path.join(prebuilt, "2026-02-30"));
  fs.mkdirSync(path.join(prebuilt, "2026-13-01"));
  fs.writeFileSync(path.join(prebuilt, "2026-05-18"), "date-shaped file");
  fs.mkdirSync(path.join(prebuilt, "not-a-date"));
  try {
    fs.symlinkSync(path.join(root, "missing-target"), path.join(prebuilt, "2026-05-20"));
  } catch {
    // Symlink creation can be restricted on some filesystems; the date-shaped
    // file above still exercises the important "ignore non-directories" path.
  }

  assert.deepEqual(api.listPrebuiltPackageDates(root), ["2026-05-17", "2026-05-19"]);
  assert.deepEqual(api.listPrebuiltPackageDates(path.join(root, "missing-root")), []);
  assert.equal(api.isPackageDate("2026-05-22"), true);
  assert.equal(api.isPackageDate("2026-02-30"), false);
  assert.equal(api.isPackageDate("2026-13-01"), false);
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

test("manifest relative asset paths cannot escape the package folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-asset-escape-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-17");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "manifest.json"), JSON.stringify({
    files: {
      daily_card: "../outside.png",
      prosody_detail: "cards/prosody.png",
      telegram_task_card: "/tmp/shared-task-card.md",
    },
  }), "utf8");

  const assets = api.packageAssets(root, "2026-05-17");
  assert.equal(assets.daily_card, path.join(packageDir, "daily-card.png"));
  assert.equal(assets.prosody_detail, path.join(packageDir, "cards", "prosody.png"));
  assert.equal(assets.task_card, "/tmp/shared-task-card.md");
});

test("converts local reading-card assets to webview URIs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-webview-assets-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-17");
  fs.mkdirSync(path.join(packageDir, "audio"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "daily-card.png"), "png");
  fs.writeFileSync(path.join(packageDir, "prosody-detail.png"), "png");
  fs.writeFileSync(path.join(packageDir, "audio", "demo.ogg"), "ogg");
  const assets = api.packageAssets(root, "2026-05-17");
  assets.daily_card = ` ${assets.daily_card} `;
  assets.demo_audio = ` ${assets.demo_audio} `;
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
  assert.equal(nextState.next.assets.daily_card, path.join(packageDir, "daily-card.png"));
  assert.equal(nextState.next.assets.demo_audio, path.join(packageDir, "audio", "demo.ogg"));
  assert.equal(nextState.next.assets.daily_card_uri, `webview:${path.join(packageDir, "daily-card.png")}`);
  assert.equal(nextState.next.assets.prosody_detail_uri, `webview:${path.join(packageDir, "prosody-detail.png")}`);
  assert.equal(nextState.next.assets.demo_audio_uri, `webview:${path.join(packageDir, "audio", "demo.ogg")}`);
});

test("webview asset URI failures skip the URI without blocking state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-webview-asset-failure-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-17");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "daily-card.png"), "png");
  const assets = api.packageAssets(root, "2026-05-17");
  const webview = {
    asWebviewUri() {
      throw new Error("disposed asset webview");
    },
  };

  const nextState = api.toWebviewState(webview, { next: { assets } });
  assert.equal(nextState.next.assets.daily_card, path.join(packageDir, "daily-card.png"));
  assert.equal(nextState.next.assets.daily_card_uri, undefined);
});

test("learner profile read failures degrade without blocking state", () => {
  const markdownRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-profile-md-"));
  fs.mkdirSync(path.join(markdownRoot, "profile", "learner-profile.md"), { recursive: true });
  const markdownProfile = api.loadLocalLearnerProfile(markdownRoot);
  assert.equal(markdownProfile.loaded, false);
  assert.equal(markdownProfile.format, "missing");
  assert.match(markdownProfile.summary, /Could not read profile\/learner-profile\.md/);

  const jsonRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-profile-json-"));
  fs.mkdirSync(path.join(jsonRoot, "profile"), { recursive: true });
  fs.writeFileSync(path.join(jsonRoot, "profile", "learner-profile.json"), '{"name":"Ada",}\n', "utf8");
  const jsonProfile = api.loadLocalLearnerProfile(jsonRoot);
  assert.equal(jsonProfile.loaded, false);
  assert.equal(jsonProfile.format, "missing");
  assert.match(jsonProfile.summary, /Could not parse profile\/learner-profile\.json/);

  const jsonDirRoot = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-profile-json-dir-"));
  fs.mkdirSync(path.join(jsonDirRoot, "profile", "learner-profile.json"), { recursive: true });
  const jsonDirProfile = api.loadLocalLearnerProfile(jsonDirRoot);
  assert.equal(jsonDirProfile.loaded, false);
  assert.equal(jsonDirProfile.format, "missing");
  assert.match(jsonDirProfile.summary, /path is not a file/);
});

test("recent session log read failures degrade to an empty history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-session-log-"));
  fs.mkdirSync(path.join(root, "runtime", "vscode-sessions", "session-log.jsonl"), { recursive: true });
  outputLines.length = 0;

  assert.deepEqual(api.readRecentSessionLog(root, 5), []);
  assert.ok(
    outputLines.some((line) => /Could not read recent session log/.test(line)),
    "session-log read failure should be recorded in the output channel",
  );
});

test("recent session log skips non-object and malformed lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-session-log-shape-"));
  const logPath = path.join(root, "runtime", "vscode-sessions", "session-log.jsonl");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, [
    JSON.stringify({ session_id: "older", native_version: "Older turn." }),
    JSON.stringify({ session_id: "middle", native_version: "Middle turn." }),
    "null",
    "[]",
    '"string"',
    JSON.stringify({ session_id: "newer", native_version: "Newer turn." }),
    "{bad json",
    "   ",
    "[1,2]",
    "",
  ].join("\n"), "utf8");

  assert.deepEqual(
    api.readRecentSessionLog(root, 2).map((item) => item.session_id),
    ["newer", "middle"],
  );
  assert.deepEqual(api.readRecentSessionLog(root, 0), []);
});

test("corrupt progress JSON is diagnosed without blocking inventory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-progress-json-"));
  fs.mkdirSync(path.join(root, "prebuilt", "2026-05-22"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  fs.writeFileSync(path.join(root, "progress", "english-speaking-training-progress.json"), '{"records":[,]}\n', "utf8");

  const inventory = api.readLocalInventory(root);
  assert.deepEqual(inventory.dates, ["2026-05-22"]);
  assert.deepEqual(Array.from(inventory.completed), []);
  assert.match(inventory.progressJsonError, /Unexpected token|Expected/);

  const diagnostics = api.buildLocalSourceDiagnostics(
    root,
    { localMaterialsRoot: root },
    inventory,
    "2026-05-22",
    undefined,
    undefined,
    undefined,
    inventory.progressJsonError,
  );
  assert.equal(
    diagnostics.progressJson,
    path.join(root, "progress", "english-speaking-training-progress.json"),
  );
  assert.match(diagnostics.progressJsonError, /Unexpected token|Expected/);
});

test("progress completion only counts existing package dates", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-progress-scope-"));
  fs.mkdirSync(path.join(root, "prebuilt", "2026-05-22"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  fs.writeFileSync(path.join(root, "progress", "english-speaking-training-progress.json"), JSON.stringify({
    records: [
      { date: "2026-05-22", status: "completed" },
      { date: " 2026-05-22 ", status: " Completed " },
      { date: "2026-05-23", status: "completed" },
      { date: "2026-02-30", status: "completed" },
      { date: "", status: "completed" },
      { date: "2026-05-22", status: "pending" },
      null,
      "2026-05-22",
      ["2026-05-22", "completed"],
    ],
  }), "utf8");

  const inventory = api.readLocalInventory(root);
  assert.deepEqual(inventory.dates, ["2026-05-22"]);
  assert.deepEqual(Array.from(inventory.completed), ["2026-05-22"]);
  assert.deepEqual(
    Array.from(api.completedPackageDates({
      records: [
        { date: " 2026-05-22 ", status: " Completed " },
        { date: "2026-05-23", status: "completed" },
        null,
        ["2026-05-22", "completed"],
      ],
    }, inventory.dates)),
    ["2026-05-22"],
  );
});

test("next-package script output must point at an existing prebuilt package", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-next-script-scope-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-22");
  const scriptsDir = path.join(root, "scripts");
  const previousPythonPath = configValues.pythonPath;
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    goal: "Fallback package goal.",
    scenario: "Fallback scenario.",
    clean_tts_text: "Use the real package.",
  }), "utf8");
  fs.writeFileSync(path.join(scriptsDir, "english_training_progress.py"), [
    "console.log(JSON.stringify({",
    "  result: {",
    "    package_date: '2026-05-99',",
    "    goal: 'Bad script result',",
    "  },",
    "}));",
  ].join("\n"), "utf8");
  configValues.pythonPath = process.execPath;
  api.invalidateNextPackageCache();

  try {
    const next = await api.resolveNextPackage(root, "2026-05-22");
    assert.equal(next.package_date, "2026-05-22");
    assert.equal(next.goal, "Fallback package goal.");
    assert.equal(next.clean_tts_text, "Use the real package.");
  } finally {
    configValues.pythonPath = previousPythonPath;
    api.invalidateNextPackageCache();
  }
});

test("next-package script result is completed from local package metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-next-script-merge-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const scriptsDir = path.join(root, "scripts");
  const previousPythonPath = configValues.pythonPath;
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Seminar answer",
    goal: "Local package goal.",
    scenario: "Local scenario.",
    clean_tts_text: "Local text for audio.",
  }), "utf8");
  fs.writeFileSync(path.join(scriptsDir, "english_training_progress.py"), [
    "console.log(JSON.stringify({",
    "  result: {",
    `    package_date: '${packageDate}',`,
    "    goal: '',",
    "    assets: {},",
    "  },",
    "}));",
  ].join("\n"), "utf8");
  configValues.pythonPath = process.execPath;
  api.invalidateNextPackageCache();

  try {
    const next = await api.resolveNextPackage(root, "2026-05-22");
    assert.equal(next.package_date, packageDate);
    assert.equal(next.training_type, "Seminar answer");
    assert.equal(next.goal, "Local package goal.");
    assert.equal(next.scenario, "Local scenario.");
    assert.equal(next.clean_tts_text, "Local text for audio.");
    assert.equal(next.assets.json, path.join(packageDir, "english-training.json"));
    assert.equal(next.assets.daily_card, path.join(packageDir, "daily-card.png"));
  } finally {
    configValues.pythonPath = previousPythonPath;
    api.invalidateNextPackageCache();
  }
});

test("corrupt manifest JSON is diagnosed while package assets fall back", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-manifest-json-"));
  const packageDir = path.join(root, "prebuilt", "2026-05-22");
  fs.mkdirSync(packageDir, { recursive: true });
  const manifestPath = path.join(packageDir, "manifest.json");
  fs.writeFileSync(manifestPath, '{"files":{,}}\n', "utf8");

  const manifestRead = api.readJsonDiagnosed(manifestPath);
  assert.equal(manifestRead.data, undefined);
  assert.match(manifestRead.parseError, /Unexpected token|Expected/);

  const assets = api.packageAssets(root, "2026-05-22");
  assert.equal(assets.manifest, manifestPath);
  assert.equal(assets.daily_card, path.join(packageDir, "daily-card.png"));
  assert.equal(assets.task_card, path.join(packageDir, "telegram-task-card.md"));

  const diagnostics = api.buildLocalSourceDiagnostics(
    root,
    { localMaterialsRoot: root },
    { dates: ["2026-05-22"], completed: new Set() },
    "2026-05-22",
    undefined,
    undefined,
    manifestRead.parseError,
    undefined,
  );
  assert.equal(diagnostics.manifestJson, manifestPath);
  assert.match(diagnostics.manifestJsonError, /Unexpected token|Expected/);
});

test("session log append failures do not fail a completed practice result", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-session-log-append-"));
  fs.mkdirSync(path.join(root, "runtime", "vscode-sessions", "session-log.jsonl"), { recursive: true });
  outputLines.length = 0;

  assert.doesNotThrow(() => api.appendSessionLog(
    {
      root,
      today: "2026-05-22",
      training: { training_type: "demo", scenario: "conference", primary_tags: ["fluency"] },
      drill: { method: "substitution" },
      settings: {
        audioUnderstandingProvider: "openai",
        coachProvider: "openai",
        ttsProvider: "openai",
      },
    },
    path.join(root, "runtime", "vscode-sessions", "input.wav"),
    {
      transcript: "hello",
      nativeVersion: "Hello.",
      mode: "free",
      problems: [],
      quickFix: "",
      followUpQuestion: "",
      shadowingInstruction: "",
      errorTags: [],
      nextDrill: "",
      scores: {},
      sessionDir: path.join(root, "runtime", "vscode-sessions", "20260522T000000Z"),
      packageDate: "2026-05-22",
    },
    { native_version: "Hello." },
  ));
  assert.ok(
    outputLines.some((line) => /Could not append session log/.test(line)),
    "session-log append failure should be recorded in the output channel",
  );
});

test("practice artifact write failures do not block other artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-artifacts-"));
  const sessionDir = path.join(root, "runtime", "vscode-sessions", "20260522T000000Z");
  fs.mkdirSync(path.join(sessionDir, "coach.json"), { recursive: true });
  outputLines.length = 0;

  const result = {
    transcript: "hello",
    nativeVersion: "Hello.",
    mode: "free",
    problems: [],
    quickFix: "Try again.",
    followUpQuestion: "",
    shadowingInstruction: "Repeat once.",
    errorTags: [],
    nextDrill: "One more sentence.",
    scores: {},
    sessionDir,
    packageDate: "2026-05-22",
  };
  assert.doesNotThrow(() => api.writePracticeArtifacts(
    {
      root,
      today: "2026-05-22",
      sourceLabel: root,
      next: { goal: "Practice clearly." },
      training: { goal: "Practice clearly." },
      drill: {},
      settings: {},
      sourceDiagnostics: { currentJson: path.join(root, "prebuilt", "2026-05-22", "english-training.json") },
      learnerProfile: { loaded: false, source: "", summary: "" },
    },
    path.join(sessionDir, "input.wav"),
    result,
    { native_version: "Hello." },
  ));

  assert.ok(fs.existsSync(path.join(sessionDir, "session.json")), "session.json should still be written");
  assert.ok(fs.existsSync(path.join(sessionDir, "session.md")), "session.md should still be written");
  assert.ok(
    outputLines.some((line) => /Could not write coach\.json/.test(line)),
    "coach.json write failure should be recorded in the output channel",
  );
});

test("transcript artifact write failures do not abort the practice turn", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-transcript-artifact-"));
  const sessionDir = path.join(root, "runtime", "vscode-sessions", "20260522T000000Z");
  fs.mkdirSync(path.join(sessionDir, "transcript.txt"), { recursive: true });
  outputLines.length = 0;

  assert.doesNotThrow(() =>
    api.writeTextArtifact(path.join(sessionDir, "transcript.txt"), "transcript.txt", "hello\n"),
  );
  assert.ok(
    outputLines.some((line) => /Could not write transcript\.txt/.test(line)),
    "transcript.txt write failure should be recorded in the output channel",
  );
});

test("rejects malformed webview audio payloads before writing fake audio", () => {
  assert.equal(api.decodeWebviewAudioBase64(Buffer.alloc(1200, 7).toString("base64")).length, 1200);
  assert.equal(
    api.decodeWebviewAudioBase64(`data:audio/webm;base64,${Buffer.alloc(1200, 8).toString("base64")}`).length,
    1200,
  );
  assert.throws(
    () => api.decodeWebviewAudioBase64("not base64 !!!!"),
    /Recorded audio payload was not valid base64/,
  );
  assert.throws(
    () => api.decodeWebviewAudioBase64(""),
    /Recorded audio payload was missing/,
  );
});

test("inline STT audio preparation rejects empty wav payloads before provider calls", async () => {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-inline-audio-"));
  const wavPath = path.join(sessionDir, "audio-understanding-input.wav");
  fs.writeFileSync(wavPath, Buffer.alloc(0));

  await assert.rejects(
    () => api.prepareInlineAudio(wavPath, "audio/wav", sessionDir),
    /Inline audio input is empty after conversion/,
  );

  const audio = Buffer.from([1, 2, 3, 4]);
  fs.writeFileSync(wavPath, audio);
  const prepared = await api.prepareInlineAudio(wavPath, "audio/wav", sessionDir);
  assert.deepEqual(prepared, {
    filePath: wavPath,
    mimeType: "audio/wav",
    base64: audio.toString("base64"),
  });
});

test("rejects bad webview audio before loading workspace state", async () => {
  await assert.rejects(
    () => api.processPracticeAudio({}, {
      type: "practiceAudio",
      mimeType: "audio/webm",
      base64: "not base64 !!!!",
    }),
    /Recorded audio payload was not valid base64/,
  );
  await assert.rejects(
    () => api.processPracticeAudio({}, {
      type: "practiceAudio",
      mimeType: "audio/webm",
      base64: Buffer.alloc(10, 1).toString("base64"),
    }),
    /Recorded audio is empty or too short/,
  );
});

test("shared string-array normalization trims scalar items and drops blanks", () => {
  assert.deepEqual(api.arrayOfStrings([
    " fluency ",
    "   ",
    42,
    true,
    false,
    "",
    null,
    { text: "ignored" },
  ]), ["fluency", "42", "true", "false"]);
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
  // The default route is now qwen (was openai before 0.1.46, gemini before
  // 0.1.38). Any unknown legacy value (azure, deepseek, kimi, openai, etc.)
  // must fall back to the current default rather than crash or silently
  // pick a removed provider. gemini/mimo/qwen stay as-is.
  configValues.audioUnderstandingProvider = "azure";
  assert.equal(api.normalizedSpeechInputProvider(), "qwen");
  configValues.audioUnderstandingProvider = "openai";
  assert.equal(api.normalizedSpeechInputProvider(), "qwen");
  configValues.audioUnderstandingProvider = "mimo";
  assert.equal(api.normalizedSpeechInputProvider(), "mimo");
  configValues.audioUnderstandingProvider = "qwen";
  assert.equal(api.normalizedSpeechInputProvider(), "qwen");
  configValues.audioUnderstandingProvider = "gemini";
  assert.equal(api.normalizedSpeechInputProvider(), "gemini");
});

test("provider route settings tolerate hand-edited casing and whitespace", () => {
  const previous = {
    coachProvider: configValues.coachProvider,
    audioUnderstandingProvider: configValues.audioUnderstandingProvider,
    ttsProvider: configValues.ttsProvider,
  };

  try {
    configValues.coachProvider = " Qwen ";
    configValues.audioUnderstandingProvider = " QWEN ";
    configValues.ttsProvider = " Qwen ";

    assert.equal(api.normalizedCoachProvider(), "qwen");
    assert.equal(api.normalizedSpeechInputProvider(), "qwen");
    assert.equal(api.resolveAudioUnderstandingProvider(), "qwen");
    assert.equal(api.normalizedTtsProvider(), "qwen");
    assert.equal(api.normalizeSpeechOutputProvider(" MiMo "), "mimo");
    assert.equal(api.normalizeProviderForSetting("ttsProvider", " Qwen "), "qwen");
    assert.deepEqual(api.trainingSettings().coachProvider, "qwen");
    assert.deepEqual(api.trainingSettings().audioUnderstandingProvider, "qwen");
    assert.deepEqual(api.trainingSettings().ttsProvider, "qwen");
    assert.deepEqual(api.activeRouteProviders(), ["qwen"]);
  } finally {
    Object.assign(configValues, previous);
  }
});

test("normalizes stale recorder backend settings to the native recorder", () => {
  configValues.recorderBackend = " Auto ";
  assert.equal(api.normalizedRecorderBackend(), "auto");
  assert.equal(api.trainingSettings().recorderBackend, "auto");
  configValues.recorderBackend = " WEBVIEW ";
  assert.equal(api.normalizedRecorderBackend(), "webview");
  configValues.recorderBackend = "maclocal";
  assert.equal(api.normalizedRecorderBackend(), "macLocal");
  configValues.recorderBackend = "banana";
  assert.equal(api.normalizedRecorderBackend(), "macLocal");
  assert.equal(api.trainingSettings().recorderBackend, "macLocal");
  configValues.recorderBackend = "webview";
  assert.equal(api.normalizedRecorderBackend(), "webview");
  configValues.recorderBackend = "auto";
  assert.equal(api.normalizedRecorderBackend(), "auto");
  configValues.recorderBackend = undefined;
});

test("provider base URLs are trimmed before UI state or endpoint composition", () => {
  const previous = {
    qwenCompatibleBaseUrl: configValues.qwenCompatibleBaseUrl,
    mimoAnthropicBaseUrl: configValues.mimoAnthropicBaseUrl,
    mimoAudioBaseUrl: configValues.mimoAudioBaseUrl,
    mimoTtsBaseUrl: configValues.mimoTtsBaseUrl,
  };

  try {
    configValues.qwenCompatibleBaseUrl = " https://dashscope-intl.aliyuncs.com/compatible-mode/v1/ ";
    configValues.mimoAnthropicBaseUrl = " https://anthropic.example.test/anthropic/ ";
    configValues.mimoAudioBaseUrl = " https://openai.example.test/v1/chat/completions/ ";
    configValues.mimoTtsBaseUrl = "   ";

    assert.equal(api.trainingSettings().qwenCompatibleBaseUrl, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
    configValues.qwenCompatibleBaseUrl = " https://unknown.example.test/v1 ";
    assert.equal(api.trainingSettings().qwenCompatibleBaseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
    assert.equal(api.trainingSettings().mimoAnthropicBaseUrl, "https://anthropic.example.test/anthropic/");
    assert.equal(api.trainingSettings().mimoAudioBaseUrl, "https://openai.example.test/v1/chat/completions/");
    assert.equal(api.trainingSettings().mimoTtsBaseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
    assert.equal(api.configString("mimoTtsBaseUrl", "https://fallback.example.test/v1"), "https://fallback.example.test/v1");
    assert.equal(
      api.chatCompletionsUrl(configValues.mimoAudioBaseUrl),
      "https://openai.example.test/v1/chat/completions",
    );
    assert.equal(
      api.chatCompletionsUrl(" https://openai.example.test/v1/ "),
      "https://openai.example.test/v1/chat/completions",
    );
  } finally {
    Object.assign(configValues, previous);
  }
});

test("qwen realtime endpoint and model mapping follow the configured HTTP endpoint region", () => {
  const previousEndpoint = configValues.qwenTtsEndpoint;
  try {
    configValues.qwenTtsEndpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    assert.equal(
      api.normalizedQwenTtsRealtimeEndpoint(),
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    );
    configValues.qwenTtsEndpoint = "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
    assert.equal(
      api.normalizedQwenTtsRealtimeEndpoint(),
      "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime",
    );
    configValues.qwenTtsEndpoint = "https://unknown.example/api/v1/generation";
    assert.equal(
      api.normalizedQwenTtsRealtimeEndpoint(),
      "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
    );
  } finally {
    configValues.qwenTtsEndpoint = previousEndpoint;
  }

  assert.equal(api.qwenTtsRealtimeModel("qwen3-tts-flash"), "qwen3-tts-flash-realtime");
  assert.equal(api.qwenTtsRealtimeModel("qwen3-tts-instruct-flash"), "qwen3-tts-instruct-flash-realtime");
  // Idempotent: feeding an already -realtime model name through must not
  // double the suffix and trip a model-not-found error host-side.
  assert.equal(api.qwenTtsRealtimeModel("qwen3-tts-flash-realtime"), "qwen3-tts-flash-realtime");
});

test("provider model ids and external voice ids are trimmed before UI state or request bodies", () => {
  const previous = {
    geminiCoachModel: configValues.geminiCoachModel,
    geminiTtsModel: configValues.geminiTtsModel,
    geminiAudioUnderstandingModel: configValues.geminiAudioUnderstandingModel,
    qwenCoachModel: configValues.qwenCoachModel,
    qwenAudioUnderstandingModel: configValues.qwenAudioUnderstandingModel,
    mimoCoachModel: configValues.mimoCoachModel,
    mimoAudioUnderstandingModel: configValues.mimoAudioUnderstandingModel,
    mimoTtsModel: configValues.mimoTtsModel,
    qwenTtsEndpoint: configValues.qwenTtsEndpoint,
    qwenTtsModel: configValues.qwenTtsModel,
    qwenTtsVoice: configValues.qwenTtsVoice,
    qwenTtsLanguageType: configValues.qwenTtsLanguageType,
    qwenTtsInstructions: configValues.qwenTtsInstructions,
  };

  try {
    Object.assign(configValues, {
      geminiCoachModel: " gemini-3.1-pro-preview ",
      geminiTtsModel: " gemini-3.1-flash-tts-preview ",
      geminiAudioUnderstandingModel: " gemini-3-flash-preview ",
      qwenCoachModel: " qwen3.5-flash ",
      qwenAudioUnderstandingModel: " qwen3-asr-flash-2026-02-10 ",
      mimoCoachModel: " mimo-v2.5-flash ",
      mimoAudioUnderstandingModel: " mimo-v2-omni ",
      mimoTtsModel: " mimo-v2.5-tts ",
      qwenTtsEndpoint: " https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation ",
      qwenTtsModel: " qwen3-tts-instruct-flash ",
      qwenTtsVoice: " Serena ",
      qwenTtsLanguageType: " German ",
      qwenTtsInstructions: " Speak warmly. ",
    });

    assert.deepEqual(
      {
        geminiCoachModel: api.trainingSettings().geminiCoachModel,
        geminiTtsModel: api.trainingSettings().geminiTtsModel,
        geminiAudioUnderstandingModel: api.trainingSettings().geminiAudioUnderstandingModel,
        qwenCoachModel: api.trainingSettings().qwenCoachModel,
        qwenAudioUnderstandingModel: api.trainingSettings().qwenAudioUnderstandingModel,
        mimoCoachModel: api.trainingSettings().mimoCoachModel,
        mimoAudioUnderstandingModel: api.trainingSettings().mimoAudioUnderstandingModel,
        mimoTtsModel: api.trainingSettings().mimoTtsModel,
        qwenTtsEndpoint: api.trainingSettings().qwenTtsEndpoint,
        qwenTtsModel: api.trainingSettings().qwenTtsModel,
        qwenTtsVoice: api.trainingSettings().qwenTtsVoice,
        qwenTtsLanguageType: api.trainingSettings().qwenTtsLanguageType,
        qwenTtsInstructions: api.trainingSettings().qwenTtsInstructions,
      },
      {
        geminiCoachModel: "gemini-3.1-pro-preview",
        geminiTtsModel: "gemini-3.1-flash-tts-preview",
        geminiAudioUnderstandingModel: "gemini-3-flash-preview",
        qwenCoachModel: "qwen3.5-flash",
        qwenAudioUnderstandingModel: "qwen3-asr-flash-2026-02-10",
        mimoCoachModel: "mimo-v2.5-flash",
        mimoAudioUnderstandingModel: "mimo-v2-omni",
        mimoTtsModel: "mimo-v2.5-tts",
        qwenTtsEndpoint: "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        qwenTtsModel: "qwen3-tts-instruct-flash",
        qwenTtsVoice: "Serena",
        qwenTtsLanguageType: "German",
        qwenTtsInstructions: "Speak warmly.",
      },
    );

    configValues.qwenCoachModel = "   ";
    configValues.qwenAudioUnderstandingModel = "bogus-asr-model";
    configValues.qwenTtsVoice = "   ";
    assert.equal(api.trainingSettings().qwenCoachModel, "qwen-plus");
    assert.equal(api.trainingSettings().qwenAudioUnderstandingModel, "qwen3-asr-flash");
    assert.equal(api.trainingSettings().qwenTtsVoice, "Cherry");
    assert.equal(api.configString("qwenTtsVoice", "fallback-voice"), "fallback-voice");

    configValues.qwenCoachModel = { model: "qwen-plus" };
    configValues.qwenTtsVoice = ["Cherry"];
    assert.equal(api.trainingSettings().qwenCoachModel, "qwen-plus");
    assert.equal(api.trainingSettings().qwenTtsVoice, "Cherry");
  } finally {
    Object.assign(configValues, previous);
  }
});

test("path, instruction, and microphone string settings are trimmed before UI state or command use", () => {
  const previous = {
    pythonPath: configValues.pythonPath,
    nativeRecorderFfmpegPath: configValues.nativeRecorderFfmpegPath,
    localMaterialsRoot: configValues.localMaterialsRoot,
    openaiTtsInstructions: configValues.openaiTtsInstructions,
    preferredMicrophoneName: configValues.preferredMicrophoneName,
    blockedMicrophoneNamePattern: configValues.blockedMicrophoneNamePattern,
  };
  const previousHome = process.env.HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-path-home-"));

  try {
    process.env.HOME = home;
    configValues.pythonPath = "   ";
    configValues.localMaterialsRoot = " /tmp/english-training-materials ";
    configValues.qwenTtsInstructions = " Read warmly but precisely. ";
    configValues.preferredMicrophoneName = " MacBook Pro Microphone ";
    configValues.blockedMicrophoneNamePattern = " iphone|continuity ";

    assert.equal(api.pythonPath(), "python3");
    assert.equal(api.trainingSettings().localMaterialsRoot, "/tmp/english-training-materials");
    assert.equal(api.trainingSettings().qwenTtsInstructions, "Read warmly but precisely.");
    assert.equal(api.trainingSettings().preferredMicrophoneName, "MacBook Pro Microphone");
    assert.equal(api.trainingSettings().blockedMicrophoneNamePattern, "iphone|continuity");

    configValues.pythonPath = " /usr/bin/python3 ";
    configValues.nativeRecorderFfmpegPath = " ~/bin/ffmpeg ";
    configValues.blockedMicrophoneNamePattern = "   ";
    assert.equal(api.pythonPath(), "/usr/bin/python3");
    configValues.pythonPath = " ~/bin/python3 ";
    assert.equal(api.pythonPath(), path.join(home, "bin/python3"));
    assert.equal(api.expandHomePath(" ~/bin/tool "), path.join(home, "bin/tool"));
    assert.equal(api.resolveFfmpegPath(), path.join(home, "bin/ffmpeg"));
    assert.equal(api.trainingSettings().blockedMicrophoneNamePattern, "iphone|ipad|continuity|karios");

    configValues.pythonPath = { path: "/usr/bin/python3" };
    configValues.localMaterialsRoot = 123;
    configValues.qwenTtsInstructions = ["Read warmly"];
    configValues.preferredMicrophoneName = false;
    configValues.blockedMicrophoneNamePattern = { pattern: "iphone" };
    assert.equal(api.pythonPath(), "python3");
    assert.equal(api.trainingSettings().localMaterialsRoot, "");
    assert.equal(api.trainingSettings().qwenTtsInstructions, "");
    assert.equal(api.trainingSettings().preferredMicrophoneName, "");
    assert.equal(api.trainingSettings().blockedMicrophoneNamePattern, "iphone|ipad|continuity|karios");
  } finally {
    Object.assign(configValues, previous);
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
  }
});

test("transcription runtime route mirrors the normalized speech-input setting", () => {
  configValues.audioUnderstandingProvider = "azure";
  assert.equal(api.resolveAudioUnderstandingProvider(), "qwen");
  configValues.audioUnderstandingProvider = "deepseek";
  assert.equal(api.resolveAudioUnderstandingProvider(), "qwen");
  configValues.audioUnderstandingProvider = "openai";
  assert.equal(api.resolveAudioUnderstandingProvider(), "qwen");
  configValues.audioUnderstandingProvider = "mimo";
  assert.equal(api.resolveAudioUnderstandingProvider(), "mimo");
  configValues.audioUnderstandingProvider = "qwen";
  assert.equal(api.resolveAudioUnderstandingProvider(), "qwen");
  configValues.audioUnderstandingProvider = "gemini";
  assert.equal(api.resolveAudioUnderstandingProvider(), "gemini");
});

test("native recorder sample rate ignores dirty config values", () => {
  configValues.recordSampleRate = "44100";
  assert.equal(api.resolveRecordingSampleRate(), 44100);
  configValues.recordSampleRate = 16000;
  assert.equal(api.resolveRecordingSampleRate(), 16000);
  configValues.recordSampleRate = 12345;
  assert.equal(api.resolveRecordingSampleRate(), 48000);
  configValues.recordSampleRate = "not-a-number";
  assert.equal(api.resolveRecordingSampleRate(), 48000);
  configValues.recordSampleRate = undefined;
});

test("normalizes stale coach and speech-output providers to Qwen", () => {
  configValues.coachProvider = "deepseek";
  configValues.ttsProvider = "unknown";
  assert.equal(api.normalizedCoachProvider(), "qwen");
  assert.equal(api.normalizedTtsProvider(), "qwen");
  assert.equal(api.normalizeSpeechOutputProvider("deepseek"), "qwen");
  assert.equal(api.speechOutputExtension("deepseek"), "wav");

  configValues.coachProvider = "openai";
  configValues.ttsProvider = "openai";
  assert.equal(api.normalizedCoachProvider(), "qwen");
  assert.equal(api.normalizedTtsProvider(), "qwen");

  configValues.coachProvider = "mimo";
  configValues.ttsProvider = "qwen";
  assert.equal(api.normalizedCoachProvider(), "mimo");
  assert.equal(api.normalizedTtsProvider(), "qwen");
});

test("active route key readiness follows configured providers instead of hard-coded Gemini", () => {
  configValues.coachProvider = undefined;
  configValues.audioUnderstandingProvider = undefined;
  configValues.ttsProvider = undefined;
  assert.deepEqual(api.activeRouteProviders(), ["qwen"]);
  assert.equal(api.normalizeProviderForSetting("coachProvider", "unknown-provider"), "qwen");
  assert.equal(api.normalizeProviderForSetting("audioUnderstandingProvider", "unknown-provider"), "qwen");
  assert.equal(api.normalizeProviderForSetting("ttsProvider", "unknown-provider"), "qwen");
  assert.equal(api.normalizeProviderForSetting("coachProvider", "qwen"), "qwen");
  assert.equal(api.normalizeProviderForSetting("audioUnderstandingProvider", "qwen"), "qwen");
  assert.equal(api.normalizeProviderForSetting("ttsProvider", "qwen"), "qwen");

  configValues.coachProvider = "gemini";
  configValues.audioUnderstandingProvider = "mimo";
  configValues.ttsProvider = "qwen";
  assert.deepEqual(api.activeRouteProviders(), ["gemini", "mimo", "qwen"]);

  configValues.coachProvider = "qwen";
  configValues.audioUnderstandingProvider = "qwen";
  configValues.ttsProvider = "qwen";
  assert.deepEqual(api.activeRouteProviders(), ["qwen"]);

  configValues.coachProvider = "deepseek";
  configValues.audioUnderstandingProvider = "azure";
  configValues.ttsProvider = "bogus";
  assert.deepEqual(api.activeRouteProviders(), ["qwen"]);

  configValues.coachProvider = "openai";
  configValues.audioUnderstandingProvider = "openai";
  configValues.ttsProvider = "openai";
  assert.deepEqual(api.activeRouteProviders(), ["qwen"]);
});

test("provider-setting migration only updates stale configured values", async () => {
  const updates = [];
  const fakeSettings = {
    inspect(key) {
      assert.equal(key, "coachProvider");
      return {
        workspaceValue: " DeepSeek ",
        globalValue: "qwen",
      };
    },
    update: async (key, value, target) => {
      updates.push({ key, value, target });
    },
  };

  assert.equal(await api.migrateProviderSetting(fakeSettings, "coachProvider", "deepseek", "qwen"), true);
  assert.deepEqual(updates, [
    { key: "coachProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Workspace },
  ]);

  updates.length = 0;
  assert.equal(await api.migrateProviderSetting(fakeSettings, "coachProvider", "kimi", "qwen"), false);
  assert.deepEqual(updates, []);
});

test("gemini model migration repairs dirty old default values", async () => {
  const updates = [];
  const fakeSettings = {
    inspect(key) {
      assert.equal(key, "geminiCoachModel");
      return {
        workspaceValue: " GEMINI-2.5-FLASH ",
        globalValue: "gemini-3-flash-preview",
      };
    },
    update: async (key, value, target) => {
      updates.push({ key, value, target });
    },
  };

  assert.equal(
    await api.migrateGeminiSetting(
      fakeSettings,
      "geminiCoachModel",
      "gemini-2.5-flash",
      "gemini-3-flash-preview",
    ),
    true,
  );
  assert.deepEqual(updates, [
    { key: "geminiCoachModel", value: "gemini-3-flash-preview", target: mockVscode.ConfigurationTarget.Workspace },
  ]);
});

test("blank API key input warns instead of silently canceling", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const stored = [];
  warningMessages.length = 0;
  mockVscode.window.showInputBox = async () => "   ";

  try {
    const saved = await api.configureApiKey({
      secrets: {
        store: async (key, value) => {
          stored.push({ key, value });
        },
      },
    }, "qwen");

    assert.equal(saved, false);
    assert.deepEqual(stored, []);
    assert.deepEqual(warningMessages, ["Qwen API key was empty; nothing was saved."]);
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    warningMessages.length = 0;
  }
});

test("saved API keys are trimmed before readiness checks or provider use", async () => {
  const previousDashScopeKey = process.env.DASHSCOPE_API_KEY;
  const secrets = {
    "englishTraining.geminiKey": "   ",
    "englishTraining.dashscopeApiKey": " dashscope-key ",
    "englishTraining.mimoKey": undefined,
  };
  const context = {
    secrets: {
      get: async (key) => secrets[key],
    },
  };

  try {
    delete process.env.DASHSCOPE_API_KEY;
    assert.deepEqual(await api.apiKeyAvailability(context), {
      gemini: false,
      qwen: true,
      mimo: false,
    });
    assert.equal(await api.getRequiredKey(context, "qwen"), "dashscope-key");
    await assert.rejects(
      () => api.getRequiredKey(context, "gemini"),
      /Missing Gemini API key/,
    );
  } finally {
    if (previousDashScopeKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousDashScopeKey;
    }
  }
});

test("blank stored DashScope keys do not mask a valid environment key", async () => {
  const previousDashScopeKey = process.env.DASHSCOPE_API_KEY;
  const context = {
    secrets: {
      get: async (key) => key === "englishTraining.dashscopeApiKey" ? "   " : undefined,
    },
  };

  try {
    process.env.DASHSCOPE_API_KEY = " env-dashscope-key ";
    assert.equal(await api.getRequiredKey(context, "qwen"), "env-dashscope-key");
    assert.equal((await api.apiKeyAvailability(context)).qwen, true);
  } finally {
    if (previousDashScopeKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousDashScopeKey;
    }
  }
});

test("saving an already stored API key does not rewrite secrets or refresh", async () => {
  const previousInputBox = mockVscode.window.showInputBox;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const stored = [];
  const info = [];
  let refreshes = 0;
  mockVscode.window.showInputBox = async () => " same-key ";
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    const saved = await api.configureApiKey({
      secrets: {
        get: async () => " same-key ",
        store: async (key, value) => {
          stored.push({ key, value });
        },
      },
    }, "qwen");

    assert.equal(saved, true);
    assert.deepEqual(stored, []);
    assert.equal(refreshes, 0);
    assert.deepEqual(info, ["Qwen API key is already saved."]);
  } finally {
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }
});

test("clearing API keys no-ops without a destructive prompt when none are saved", async () => {
  const previousDashScopeKey = process.env.DASHSCOPE_API_KEY;
  const previousWarningMessage = mockVscode.window.showWarningMessage;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const warnings = [];
  const info = [];
  const deleted = [];
  let refreshes = 0;
  mockVscode.window.showWarningMessage = async (message) => {
    warnings.push(message);
    return "Clear";
  };
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    delete process.env.DASHSCOPE_API_KEY;
    await api.clearApiKeys({
      secrets: {
        get: async () => undefined,
        delete: async (key) => {
          deleted.push(key);
        },
      },
    });
  } finally {
    if (previousDashScopeKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousDashScopeKey;
    }
    mockVscode.window.showWarningMessage = previousWarningMessage;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(warnings, []);
  assert.deepEqual(deleted, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["No English Training API keys are saved."]);
});

test("core-route key setup batches refreshes across missing providers", async () => {
  const previousDashScopeKey = process.env.DASHSCOPE_API_KEY;
  const previousProviders = {
    coachProvider: configValues.coachProvider,
    audioUnderstandingProvider: configValues.audioUnderstandingProvider,
    ttsProvider: configValues.ttsProvider,
  };
  const previousInputBox = mockVscode.window.showInputBox;
  const previousInfoMessage = mockVscode.window.showInformationMessage;

  configValues.coachProvider = "gemini";
  configValues.audioUnderstandingProvider = "mimo";
  configValues.ttsProvider = "qwen";

  const inputs = [" gemini-key ", " mimo-key ", " dashscope-key "];
  const stored = [];
  let refreshes = 0;
  mockVscode.window.showInputBox = async () => inputs.shift();
  mockVscode.window.showInformationMessage = async () => undefined;
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    delete process.env.DASHSCOPE_API_KEY;
    await api.configureCoreRouteKeys({
      secrets: {
        get: async () => undefined,
        store: async (key, value) => {
          stored.push({ key, value });
        },
      },
    });
  } finally {
    if (previousDashScopeKey === undefined) {
      delete process.env.DASHSCOPE_API_KEY;
    } else {
      process.env.DASHSCOPE_API_KEY = previousDashScopeKey;
    }
    mockVscode.window.showInputBox = previousInputBox;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    Object.assign(configValues, previousProviders);
    api.clearRefreshHandlers();
  }

  assert.equal(refreshes, 1);
  assert.deepEqual(stored, [
    { key: "englishTraining.geminiKey", value: "gemini-key" },
    { key: "englishTraining.mimoKey", value: "mimo-key" },
    { key: "englishTraining.dashscopeApiKey", value: "dashscope-key" },
  ]);
});

test("setting an already active provider does not rewrite settings or refresh", async () => {
  const previousProvider = configValues.coachProvider;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const info = [];
  let refreshes = 0;
  configValues.coachProvider = "qwen";
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setProviderSetting("coachProvider", "qwen");
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["English Training coach provider is already qwen."]);
});

test("provider command canonicalizes dirty provider strings before saving", async () => {
  const previousProvider = configValues.coachProvider;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const updates = [];
  let refreshes = 0;
  configValues.coachProvider = " Qwen ";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setProviderSetting("coachProvider", " QWEN ");
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "coachProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("provider command refuses providers that are unsupported for a route", async () => {
  const previousProvider = configValues.coachProvider;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  warningMessages.length = 0;
  const updates = [];
  let refreshes = 0;
  configValues.coachProvider = "qwen";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setProviderSetting("coachProvider", "unsupported");
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(warningMessages, ["English Training coach provider cannot use unsupported."]);
  warningMessages.length = 0;
});

test("provider command writes global settings when no workspace is open", async () => {
  const previousProvider = configValues.coachProvider;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const updates = [];
  let refreshes = 0;
  configValues.coachProvider = "gemini";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setProviderSetting("coachProvider", "qwen");
  } finally {
    configValues.coachProvider = previousProvider;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "coachProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("provider command keeps workspace settings when a workspace is open", async () => {
  const previousProvider = configValues.ttsProvider;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const updates = [];
  let refreshes = 0;
  configValues.ttsProvider = "gemini";
  mockVscode.workspace.workspaceFolders = [{ uri: mockVscode.Uri.file("/tmp/english-training-workspace") }];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setProviderSetting("ttsProvider", "qwen");
  } finally {
    configValues.ttsProvider = previousProvider;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "ttsProvider", value: "qwen", target: mockVscode.ConfigurationTarget.Workspace },
  ]);
  assert.equal(refreshes, 1);
});

test("setting an already active TTS speed does not rewrite settings or refresh", async () => {
  const previousSpeed = configValues.ttsSpeed;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const info = [];
  let refreshes = 0;
  configValues.ttsSpeed = 0.9;
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setTtsSpeedConfig(0.9);
  } finally {
    configValues.ttsSpeed = previousSpeed;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["English Training TTS speed is already 0.9."]);
});

test("setting the effective current TTS speed repairs dirty speed config", async () => {
  const previousSpeed = configValues.ttsSpeed;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const updates = [];
  const info = [];
  let refreshes = 0;
  configValues.ttsSpeed = " 0.9 ";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setTtsSpeedConfig(0.9);
  } finally {
    configValues.ttsSpeed = previousSpeed;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "ttsSpeed", value: 0.9, target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
  assert.deepEqual(info, ["English Training TTS speed set to 0.9."]);
});

test("invalid TTS speed inputs warn without rewriting settings or refreshing", async () => {
  const previousSpeed = configValues.ttsSpeed;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  warningMessages.length = 0;
  const updates = [];
  let refreshes = 0;
  configValues.ttsSpeed = 1.2;
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setTtsSpeedConfig("not-a-speed");
    await api.setTtsSpeedConfig(0);
  } finally {
    configValues.ttsSpeed = previousSpeed;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(warningMessages, [
    "English Training TTS speed must be a positive number.",
    "English Training TTS speed must be a positive number.",
  ]);
  warningMessages.length = 0;
});

test("configuring an already active model setting reports no-op without refresh", async () => {
  const previousModel = configValues.geminiTtsModel;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const info = [];
  let refreshes = 0;
  configValues.geminiTtsModel = "gemini-3.1-flash-tts-preview";
  mockVscode.window.showQuickPick = async (items) => items.find((item) => item.label === "gemini-3.1-flash-tts-preview");
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("geminiTtsModel");
  } finally {
    configValues.geminiTtsModel = previousModel;
    mockVscode.window.showQuickPick = previousQuickPick;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["English Training Gemini speech-output model is already gemini-3.1-flash-tts-preview."]);
});

test("model setting pickers mark and repair blank effective default values", async () => {
  const previousModel = configValues.qwenCoachModel;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.qwenCoachModel = "   ";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => {
    assert.equal(items.find((item) => item.label === "qwen-plus")?.description, "current");
    return items.find((item) => item.label === "qwen-plus");
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("qwenCoachModel");
  } finally {
    configValues.qwenCoachModel = previousModel;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "qwenCoachModel", value: "qwen-plus", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("model configuration writes global settings when no workspace is open", async () => {
  const previousModel = configValues.qwenCoachModel;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.qwenCoachModel = "qwen-plus";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => items.find((item) => item.label === "qwen3-max");
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("qwenCoachModel");
  } finally {
    configValues.qwenCoachModel = previousModel;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "qwenCoachModel", value: "qwen3-max", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("configuring a blank custom model setting warns without refresh", async () => {
  const previousModel = configValues.qwenCoachModel;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const previousInputBox = mockVscode.window.showInputBox;
  warningMessages.length = 0;
  let refreshes = 0;
  configValues.qwenCoachModel = "qwen-plus";
  mockVscode.window.showQuickPick = async (items) => items.find((item) => item.custom);
  mockVscode.window.showInputBox = async () => "   ";
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("qwenCoachModel");
  } finally {
    configValues.qwenCoachModel = previousModel;
    mockVscode.window.showQuickPick = previousQuickPick;
    mockVscode.window.showInputBox = previousInputBox;
    api.clearRefreshHandlers();
  }

  assert.equal(refreshes, 0);
  assert.deepEqual(warningMessages, ["English Training Qwen coach model cannot be empty."]);
  warningMessages.length = 0;
});

test("provider voice settings do not offer a custom value from the sidebar", async () => {
  const previousVoice = configValues.geminiTtsVoice;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.geminiTtsVoice = "Kore";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => {
    assert.equal(items.some((item) => item.custom), false);
    assert.ok(items.some((item) => item.label === "Kore"));
    assert.ok(items.some((item) => item.label === "Puck"));
    return items.find((item) => item.label === "Puck");
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("geminiTtsVoice");
  } finally {
    configValues.geminiTtsVoice = previousVoice;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "geminiTtsVoice", value: "Puck", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("closed enum settings do not offer a custom value from the sidebar", async () => {
  const previousBackend = configValues.recorderBackend;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.recorderBackend = "macLocal";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => {
    assert.equal(items.some((item) => item.custom), false);
    assert.deepEqual(items.map((item) => item.label), ["macLocal", "webview", "auto"]);
    return items.find((item) => item.label === "auto");
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("recorderBackend");
  } finally {
    configValues.recorderBackend = previousBackend;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "recorderBackend", value: "auto", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("closed enum setting pickers mark and repair dirty effective current values", async () => {
  const previousBackend = configValues.recorderBackend;
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const updates = [];
  let refreshes = 0;
  configValues.recorderBackend = " Auto ";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showQuickPick = async (items) => {
    assert.equal(items.some((item) => item.custom), false);
    assert.equal(items.find((item) => item.label === "auto")?.description, "current");
    return items.find((item) => item.label === "auto");
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.configureSetting("recorderBackend");
  } finally {
    configValues.recorderBackend = previousBackend;
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showQuickPick = previousQuickPick;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, [
    { key: "recorderBackend", value: "auto", target: mockVscode.ConfigurationTarget.Global },
  ]);
  assert.equal(refreshes, 1);
});

test("setting an already active Qwen voice does not rewrite settings or refresh", async () => {
  const previous = {
    qwenTtsVoice: configValues.qwenTtsVoice,
  };
  const previousWorkspaceFolders = mockVscode.workspace.workspaceFolders;
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const updates = [];
  const info = [];
  let refreshes = 0;
  configValues.qwenTtsVoice = " Cherry ";
  mockVscode.workspace.workspaceFolders = [];
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setQwenTtsVoice("Cherry");
  } finally {
    Object.assign(configValues, previous);
    mockVscode.workspace.workspaceFolders = previousWorkspaceFolders;
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["Qwen-TTS voice is already Cherry."]);
});

test("blank Qwen voices warn without rewriting settings or refreshing", async () => {
  const previous = {
    qwenTtsVoice: configValues.qwenTtsVoice,
  };
  const previousGetConfiguration = mockVscode.workspace.getConfiguration;
  warningMessages.length = 0;
  const updates = [];
  let refreshes = 0;
  configValues.qwenTtsVoice = "Cherry";
  mockVscode.workspace.getConfiguration = (section) => {
    assert.equal(section, "englishTraining");
    return {
      get: (key) => configValues[key],
      inspect: () => ({}),
      update: async (key, value, target) => {
        updates.push({ key, value, target });
        configValues[key] = value;
      },
    };
  };
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });

  try {
    await api.setQwenTtsVoice("   ");
  } finally {
    Object.assign(configValues, previous);
    mockVscode.workspace.getConfiguration = previousGetConfiguration;
    api.clearRefreshHandlers();
  }

  assert.deepEqual(updates, []);
  assert.equal(refreshes, 0);
  assert.deepEqual(warningMessages, ["Qwen-TTS voice cannot be empty."]);
  warningMessages.length = 0;
});

test("provider TTS voices are normalized before UI state or provider calls", () => {
  configValues.geminiTtsVoice = "Zephyr";
  assert.equal(api.normalizedGeminiTtsVoice(), "Zephyr");
  configValues.geminiTtsVoice = "not-a-real-gemini-voice";
  assert.equal(api.normalizedGeminiTtsVoice(), "Kore");
  assert.equal(api.trainingSettings().geminiTtsVoice, "Kore");

  configValues.mimoTtsVoice = "Dean";
  assert.equal(api.normalizedMimoTtsVoice(), "Dean");
  configValues.mimoTtsVoice = "not-a-real-mimo-voice";
  assert.equal(api.normalizedMimoTtsVoice(), "Mia");
  assert.equal(api.trainingSettings().mimoTtsVoice, "Mia");

  configValues.qwenTtsVoice = "Serena";
  configValues.qwenTtsLanguageType = "German";
  assert.equal(api.normalizedQwenTtsVoice(), "Serena");
  assert.equal(api.normalizedQwenTtsLanguageType(), "German");
  configValues.qwenTtsVoice = "not-a-real-qwen-voice";
  configValues.qwenTtsLanguageType = "Klingon";
  assert.equal(api.normalizedQwenTtsVoice(), "Cherry");
  assert.equal(api.normalizedQwenTtsLanguageType(), "English");
  assert.equal(api.trainingSettings().qwenTtsVoice, "Cherry");
  assert.equal(api.trainingSettings().qwenTtsLanguageType, "English");

  configValues.openaiTtsVoice = "";
  configValues.geminiTtsVoice = "";
  configValues.mimoTtsVoice = "";
  configValues.qwenTtsVoice = "";
  configValues.qwenTtsLanguageType = "";
});

test("Qwen-TTS sends DashScope multimodal requests with documented fields", async () => {
  const previous = {
    qwenTtsEndpoint: configValues.qwenTtsEndpoint,
    qwenTtsModel: configValues.qwenTtsModel,
    qwenTtsVoice: configValues.qwenTtsVoice,
    qwenTtsLanguageType: configValues.qwenTtsLanguageType,
    qwenTtsInstructions: configValues.qwenTtsInstructions,
  };
  const originalFetch = global.fetch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-qwen-tts-"));
  const calls = [];
  configValues.qwenTtsEndpoint = " https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation ";
  configValues.qwenTtsModel = " qwen3-tts-instruct-flash ";
  configValues.qwenTtsVoice = " Serena ";
  configValues.qwenTtsLanguageType = " German ";
  configValues.qwenTtsInstructions = " Speak warmly. ";
  global.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return {
      ok: true,
      text: async () => JSON.stringify({
        output: { audio: { data: Buffer.from("qwen-audio").toString("base64") } },
      }),
    };
  };
  const context = {
    secrets: {
      get: async (key) => key === "englishTraining.dashscopeApiKey" ? " dashscope-test " : "",
    },
  };

  try {
    const firstOut = path.join(tmpDir, "first.wav");
    const secondOut = path.join(tmpDir, "second.wav");
    await api.synthesizeWithConfiguredTts(context, "  Hallo.  ", firstOut, "qwen", {
      ttsStyle: "This style should be overridden.",
    });
    configValues.qwenTtsModel = "qwen3-tts-flash";
    configValues.qwenTtsInstructions = "Should not be sent to flash.";
    await api.synthesizeWithConfiguredTts(context, "  Hello.  ", secondOut, "qwen", {
      ttsStyle: "Also not sent.",
    });

    assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation");
    assert.equal(calls[0].headers.Authorization, "Bearer dashscope-test");
    assert.equal(calls[0].body.model, "qwen3-tts-instruct-flash");
    assert.deepEqual(calls[0].body.input, {
      text: "Hallo.",
      voice: "Serena",
      language_type: "German",
      instructions: "Speak warmly.",
    });
    assert.equal(calls[1].body.model, "qwen3-tts-flash");
    assert.deepEqual(calls[1].body.input, {
      text: "Hello.",
      voice: "Serena",
      language_type: "German",
    });
    assert.equal(fs.readFileSync(firstOut, "utf8"), "qwen-audio");
    assert.equal(fs.readFileSync(secondOut, "utf8"), "qwen-audio");
  } finally {
    Object.assign(configValues, previous);
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Qwen-ASR sends DashScope OpenAI-compatible audio requests", async () => {
  const previous = {
    audioUnderstandingProvider: configValues.audioUnderstandingProvider,
    qwenCompatibleBaseUrl: configValues.qwenCompatibleBaseUrl,
    qwenAudioUnderstandingModel: configValues.qwenAudioUnderstandingModel,
  };
  const originalFetch = global.fetch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-qwen-asr-"));
  const audioPath = path.join(tmpDir, "audio-understanding-input.wav");
  const audioBytes = Buffer.from("fake wav bytes");
  fs.writeFileSync(audioPath, audioBytes);
  const calls = [];
  configValues.audioUnderstandingProvider = " qwen ";
  configValues.qwenCompatibleBaseUrl = " https://dashscope-intl.aliyuncs.com/compatible-mode/v1/ ";
  configValues.qwenAudioUnderstandingModel = " qwen3-asr-flash-2026-02-10 ";
  global.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { content: " Transcript text. " } }],
      }),
    };
  };
  const context = {
    secrets: {
      get: async (key) => key === "englishTraining.dashscopeApiKey" ? " dashscope-asr-test " : "",
    },
  };

  try {
    const transcript = await api.transcribeAudio(context, audioPath, "audio/wav", tmpDir);

    assert.equal(transcript, "Transcript text.");
    assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].headers.Authorization, "Bearer dashscope-asr-test");
    assert.equal(calls[0].body.model, "qwen3-asr-flash-2026-02-10");
    assert.equal(calls[0].body.stream, false);
    assert.deepEqual(calls[0].body.asr_options, { language: "en", enable_itn: false });
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.deepEqual(calls[0].body.messages[1], {
      role: "user",
      content: [
        {
          type: "input_audio",
          input_audio: {
            data: `data:audio/wav;base64,${audioBytes.toString("base64")}`,
          },
        },
      ],
    });
  } finally {
    Object.assign(configValues, previous);
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("Qwen coach sends DashScope OpenAI-compatible chat requests", async () => {
  const previous = {
    coachProvider: configValues.coachProvider,
    qwenCompatibleBaseUrl: configValues.qwenCompatibleBaseUrl,
    qwenCoachModel: configValues.qwenCoachModel,
  };
  const originalFetch = global.fetch;
  const calls = [];
  configValues.coachProvider = " qwen ";
  configValues.qwenCompatibleBaseUrl = " https://dashscope-intl.aliyuncs.com/compatible-mode/v1/ ";
  configValues.qwenCoachModel = " qwen3.5-flash ";
  global.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                lines: [
                  { label: "claim", text: "I would frame the claim more narrowly.", reason: "替换 claim 槽位" },
                ],
              }),
            },
          },
        ],
      }),
    };
  };
  const context = {
    secrets: {
      get: async (key) => key === "englishTraining.dashscopeApiKey" ? " dashscope-coach-test " : "",
    },
  };
  const state = {
    next: { package_date: "2026-05-25", goal: "Defend a claim.", scenario: "Seminar reply" },
    training: { goal: "Defend a claim.", scenario: "Seminar reply", frames: [{ text: "I would frame the claim narrowly." }] },
    drill: {},
    learnerProfile: { loaded: false },
  };

  try {
    const lines = await api.coachGenerateDrillLines(context, state, 1, []);

    assert.deepEqual(lines, [
      { label: "claim", text: "I would frame the claim more narrowly.", reason: "替换 claim 槽位", source: "coach" },
    ]);
    assert.equal(calls[0].url, "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions");
    assert.equal(calls[0].headers.Authorization, "Bearer dashscope-coach-test");
    assert.equal(calls[0].body.model, "qwen3.5-flash");
    assert.deepEqual(calls[0].body.response_format, { type: "json_object" });
    assert.equal(calls[0].body.messages[0].role, "system");
    assert.equal(calls[0].body.messages[1].role, "user");
  } finally {
    Object.assign(configValues, previous);
    global.fetch = originalFetch;
  }
});

test("MiMo TTS reads the selected text instead of a generic prompt", async () => {
  const previous = {
    mimoTtsBaseUrl: configValues.mimoTtsBaseUrl,
    mimoTtsModel: configValues.mimoTtsModel,
    mimoTtsVoice: configValues.mimoTtsVoice,
  };
  const originalFetch = global.fetch;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-mimo-tts-"));
  const calls = [];
  configValues.mimoTtsBaseUrl = " https://custom.mimo/v1/ ";
  configValues.mimoTtsModel = " mimo-v2.5-tts ";
  configValues.mimoTtsVoice = " Dean ";
  global.fetch = async (url, init) => {
    calls.push({
      url: String(url),
      headers: init.headers,
      body: JSON.parse(init.body),
    });
    return {
      ok: true,
      text: async () => JSON.stringify({
        choices: [{ message: { audio: { data: Buffer.from("mimo-selected-audio").toString("base64") } } }],
      }),
    };
  };
  const context = {
    secrets: {
      get: async (key) => key === "englishTraining.mimoKey" ? " tp-mimo-test " : "",
    },
  };

  try {
    const firstOut = path.join(tmpDir, "first.wav");
    const secondOut = path.join(tmpDir, "second.wav");
    await api.synthesizeWithConfiguredTts(context, "  Selected drill line.  ", firstOut, "mimo");
    await api.synthesizeWithConfiguredTts(context, "  Slow selected line.  ", secondOut, "mimo", {
      ttsStyle: "Read slowly and clearly.",
    });

    assert.equal(calls[0].url, "https://custom.mimo/v1/chat/completions");
    assert.equal(calls[0].headers["api-key"], "tp-mimo-test");
    assert.equal(calls[0].body.model, "mimo-v2.5-tts");
    assert.equal(calls[0].body.audio.voice, "Dean");
    assert.deepEqual(calls[0].body.messages, [
      { role: "assistant", content: "Selected drill line." },
    ]);
    assert.deepEqual(calls[1].body.messages, [
      { role: "user", content: "Read slowly and clearly." },
      { role: "assistant", content: "Slow selected line." },
    ]);
    assert.equal(fs.readFileSync(firstOut, "utf8"), "mimo-selected-audio");
    assert.equal(fs.readFileSync(secondOut, "utf8"), "mimo-selected-audio");
  } finally {
    Object.assign(configValues, previous);
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
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

test("labels malformed provider JSON responses with context and a body preview", () => {
  assert.deepEqual(api.parseJsonObject('{"ok":true}', "Demo provider"), { ok: true });
  assert.throws(
    () => api.parseJsonObject("<html>bad gateway</html>", "Demo provider"),
    /Demo provider returned invalid JSON:.*<html>bad gateway<\/html>/,
  );
  assert.throws(
    () => api.parseJsonObject("[1,2,3]", "Demo provider"),
    /Demo provider returned an array instead of a JSON object/,
  );
});

test("first-json parser only accepts object-shaped JSON", () => {
  assert.deepEqual(api.parseFirstJson("noise\n{\"ok\":true}\n"), { ok: true });
  assert.deepEqual(api.parseFirstJson("{bad json}\n{\"ok\":true}\n"), { ok: true });
  assert.deepEqual(api.parseFirstJson([
    "starting progress script",
    "{",
    "  \"result\": {",
    "    \"package_date\": \"2026-05-22\"",
    "  }",
    "}",
    "done",
  ].join("\n")), { result: { package_date: "2026-05-22" } });
  assert.equal(api.parseFirstJson("[1,2,3]"), undefined);
  assert.equal(api.parseFirstJson("null"), undefined);
});

test("provider text extractors skip nullish content parts defensively", () => {
  assert.equal(api.extractGeminiText({
    candidates: [
      {
        content: {
          parts: [
            null,
            ["bad"],
            { text: "Gemini line." },
          ],
        },
      },
    ],
  }), "Gemini line.");
  assert.equal(api.extractGeminiText({
    candidates: [
      null,
      { content: null },
      { content: { parts: [] } },
      { content: { parts: [{ text: "Later candidate text." }] } },
    ],
  }), "Later candidate text.");
});

test("speech and TTS provider extractors skip malformed nested entries", async () => {
  assert.equal(api.extractMimoTranscript({
    choices: [
      null,
      { message: null },
      { message: { content: "Transcript text." } },
    ],
  }), "Transcript text.");

  assert.equal(api.extractQwenAsrTranscript({
    choices: [
      null,
      { message: null },
      { message: { content: "```text\nQwen transcript.\n```" } },
    ],
  }), "Qwen transcript.");

  assert.equal(api.extractMimoTtsAudioData({
    choices: [
      null,
      { message: null },
      { message: { audio: { data: Buffer.from("mimo-audio").toString("base64") } } },
    ],
  }).toString("utf8"), "mimo-audio");
  assert.throws(
    () => api.extractMimoTtsAudioData({
      choices: [{ message: { audio: { data: "not base64 !!!!" } } }],
    }),
    /MiMo TTS returned invalid base64 audio data/,
  );
  assert.equal(
    api.decodeBase64AudioData(Buffer.from("base64-audio").toString("base64"), "Demo TTS").toString("utf8"),
    "base64-audio",
  );
  assert.throws(
    () => api.decodeBase64AudioData("not base64 !!!!", "Demo TTS"),
    /Demo TTS returned invalid base64 audio data/,
  );
  assert.equal(api.ensureNonEmptyAudioData(Buffer.from("audio"), "Demo TTS").toString("utf8"), "audio");
  assert.throws(
    () => api.ensureNonEmptyAudioData(Buffer.alloc(0), "Qwen TTS"),
    /Qwen TTS returned empty audio data/,
  );

  assert.equal(
    (await api.extractQwenTtsAudioData({
      output: { audio: { data: Buffer.from("qwen-audio").toString("base64") } },
    })).toString("utf8"),
    "qwen-audio",
  );
  await assert.rejects(
    () => api.extractQwenTtsAudioData({ output: { audio: { data: "not base64 !!!!" } } }),
    /Qwen-TTS returned invalid base64 audio data/,
  );
  await assert.rejects(
    () => api.extractQwenTtsAudioData({ output: { audio: {} } }),
    /Qwen-TTS returned no output\.audio\.data or output\.audio\.url/,
  );

  const geminiAudio = api.extractGeminiInlineAudio({
    candidates: [
      null,
      { content: null },
      {
        content: {
          parts: [
            null,
            ["bad"],
            { inlineData: null },
            {
              inline_data: {
                data: Buffer.from("gemini-audio").toString("base64"),
                mime_type: "audio/wav",
              },
            },
          ],
        },
      },
    ],
  });
  assert.equal(geminiAudio.data.toString("utf8"), "gemini-audio");
  assert.equal(geminiAudio.mimeType, "audio/wav");
  assert.throws(
    () => api.extractGeminiInlineAudio({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: "not base64 !!!!", mimeType: "audio/wav" } }],
          },
        },
      ],
    }),
    /Gemini TTS returned invalid base64 audio data/,
  );
});

test("distinguishes a missing package file from a corrupt one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "est-readjson-"));

  const missing = api.readJsonDiagnosed(path.join(dir, "nope.json"));
  assert.equal(missing.data, undefined);
  assert.equal(missing.parseError, undefined);

  const looseArrayPath = path.join(dir, "loose-array.json");
  fs.writeFileSync(looseArrayPath, '[{"goal":"Speak"}]\n', "utf8");
  assert.equal(api.readJson(looseArrayPath), undefined);

  const looseNullPath = path.join(dir, "loose-null.json");
  fs.writeFileSync(looseNullPath, "null\n", "utf8");
  assert.equal(api.readJson(looseNullPath), undefined);

  const dirPath = path.join(dir, "dir.json");
  fs.mkdirSync(dirPath);
  const unreadable = api.readJsonDiagnosed(dirPath);
  assert.equal(unreadable.data, undefined);
  assert.match(unreadable.parseError, /Could not read JSON/);

  const badPath = path.join(dir, "bad.json");
  fs.writeFileSync(badPath, '{"goal":"Speak",}\n', "utf8");
  const bad = api.readJsonDiagnosed(badPath);
  assert.equal(bad.data, undefined);
  assert.equal(typeof bad.parseError, "string");
  assert.ok(bad.parseError.length > 0);

  const arrayPath = path.join(dir, "array.json");
  fs.writeFileSync(arrayPath, '[{"goal":"Speak"}]\n', "utf8");
  const array = api.readJsonDiagnosed(arrayPath);
  assert.equal(array.data, undefined);
  assert.match(array.parseError, /JSON root must be an object; got array/);

  const nullPath = path.join(dir, "null.json");
  fs.writeFileSync(nullPath, "null\n", "utf8");
  const nullJson = api.readJsonDiagnosed(nullPath);
  assert.equal(nullJson.data, undefined);
  assert.match(nullJson.parseError, /JSON root must be an object; got null/);

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
  assert.deepEqual(api.normalizePracticeTargetPayload({
    reference_text: " Shadow this. ",
    reference_label: " Prompt ",
    follow_up_question: " Why? ",
  }), {
    mode: "shadow",
    referenceText: "Shadow this.",
    referenceLabel: "Prompt",
    followUpQuestion: "Why?",
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

test("followup drill rounds skip malformed entries before webview render", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-drill-round-shape-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "followup-drill.json"), JSON.stringify({
    rounds: [
      null,
      "bad round",
      ["bad array"],
      {
        label: "Valid round",
        examples: [
          null,
          ["bad example"],
          "",
          "   ",
          {},
          "Practice a full sentence.",
          { cue: "claim", text: "State the claim more carefully." },
        ],
      },
    ],
  }), "utf8");

  const result = api.loadDrillPlan(root, packageDate, {
    clean_tts_text: "Fallback sentence.",
  });

  assert.equal(result.parseError, undefined);
  assert.deepEqual(result.drill.rounds.map((round) => round.label), ["Valid round"]);
  assert.deepEqual(result.drill.rounds[0].examples, [
    "Practice a full sentence.",
    { cue: "claim", text: "State the claim more carefully." },
  ]);
});

test("followup drill falls back to training frames when every round is unusable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-drill-round-fallback-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "followup-drill.json"), JSON.stringify({
    rounds: [
      null,
      "bad round",
      { label: "Empty round", examples: [null, "", { cue: "missing text" }] },
    ],
  }), "utf8");

  const result = api.loadDrillPlan(root, packageDate, {
    clean_tts_text: "Fallback base sentence.",
    frames: [
      { text: "   " },
      { text: "Use the fallback frame." },
      " State the claim plainly. ",
    ],
  });

  assert.equal(result.parseError, undefined);
  assert.equal(result.drill.rounds.length, 1);
  assert.equal(result.drill.rounds[0].label, "Substitution: today's frames");
  assert.equal(result.drill.rounds[0].base_frame, "Use the fallback frame.");
  assert.deepEqual(result.drill.rounds[0].examples, [
    { text: "Use the fallback frame." },
    "State the claim plainly.",
  ]);
});

test("followup drill normalizes frame counts and shadowing chunks before render", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-drill-normalize-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "followup-drill.json"), JSON.stringify({
    rounds: [{ label: "Valid round", examples: ["Use the prepared line."] }],
    shadowing_loop: {
      chunks: [
        "  First chunk.  ",
        "",
        { text: "Second\nchunk." },
        { cue: "missing text" },
      ],
      instruction_zh: "   ",
    },
  }), "utf8");

  const result = api.loadDrillPlan(root, packageDate, {
    clean_tts_text: "Fallback one. Fallback two.",
    task: { required_frames: "2" },
  });

  assert.equal(result.drill.required_frames, 2);
  assert.deepEqual(result.drill.shadowing_loop.chunks, ["First chunk.", "Second chunk."]);
  assert.equal(result.drill.shadowing_loop.instruction_zh, "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。");

  fs.writeFileSync(path.join(packageDir, "followup-drill.json"), JSON.stringify({
    rounds: [{ label: "Valid round", examples: ["Use the prepared line."] }],
    shadowing_loop: ["bad shape"],
  }), "utf8");

  const invalid = api.loadDrillPlan(root, packageDate, {
    clean_tts_text: "Fallback one. Fallback two.",
    task: { required_frames: "1.5" },
  });

  assert.equal(invalid.drill.required_frames, undefined);
  assert.deepEqual(invalid.drill.shadowing_loop.chunks, ["Fallback one.", "Fallback two."]);
});

test("diagnoses corrupt followup-drill JSON while keeping fallback drill lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-drill-json-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, "followup-drill.json"), '{"rounds":[,]}\n', "utf8");

  const result = api.loadDrillPlan(root, packageDate, {
    clean_tts_text: "This is the fallback line.",
    frames: [{ text: "This is a frame." }],
  });

  assert.match(result.parseError, /Unexpected token|Expected/);
  assert.equal(result.drill.title, `FSI Drill - ${packageDate}`);
  assert.ok(Array.isArray(result.drill.rounds));
  assert.deepEqual(result.drill.rounds[0].examples, [{ text: "This is a frame." }]);
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
  // After 0.1.46 every supported TTS provider writes a WAV container; unknown
  // or retired providers fall back to the Qwen default.
  assert.equal(api.speechOutputExtension("gemini"), "wav");
  assert.equal(api.speechOutputExtension(" Qwen "), "wav");
  assert.equal(api.speechOutputExtension("mimo"), "wav");
  assert.equal(api.speechOutputExtension("openai"), "wav");
  assert.equal(api.speechOutputExtension(""), "wav");
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

test("microphone picker refuses blocked devices instead of saving an unusable preference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-mic-picker-"));
  const ffmpegPath = path.join(dir, "fake-ffmpeg.js");
  fs.writeFileSync(ffmpegPath, [
    "#!/usr/bin/env node",
    "console.error('[AVFoundation indev @ 0x123] AVFoundation video devices:');",
    "console.error('[AVFoundation indev @ 0x123] [0] FaceTime HD Camera');",
    "console.error('[AVFoundation indev @ 0x123] AVFoundation audio devices:');",
    "console.error('[AVFoundation indev @ 0x123] [0] iPhone Microphone');",
    "console.error('[AVFoundation indev @ 0x123] [1] MacBook Pro Microphone');",
  ].join("\n"), "utf8");
  fs.chmodSync(ffmpegPath, 0o755);

  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousFfmpegPath = configValues.nativeRecorderFfmpegPath;
  const previousPreference = configValues.preferredMicrophoneName;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const pickedItems = [];
  warningMessages.length = 0;
  configValues.nativeRecorderFfmpegPath = ffmpegPath;
  configValues.preferredMicrophoneName = "";
  mockVscode.window.showInformationMessage = async () => undefined;
  mockVscode.window.showQuickPick = async (items) => {
    pickedItems.push(...items);
    return items.find((item) => item.label === "iPhone Microphone");
  };
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  let savedPreferenceAfterPick = "__unset__";

  try {
    await api.selectRecordingMicrophone();
    savedPreferenceAfterPick = configValues.preferredMicrophoneName;
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    configValues.nativeRecorderFfmpegPath = previousFfmpegPath;
    configValues.preferredMicrophoneName = previousPreference;
    mockVscode.window.showQuickPick = previousQuickPick;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.invalidateResolvedAudioDevice();
  }

  assert.equal(pickedItems.find((item) => item.label === "iPhone Microphone")?.blocked, true);
  assert.equal(savedPreferenceAfterPick, "");
  assert.deepEqual(warningMessages, [
    "\"iPhone Microphone\" is excluded by englishTraining.blockedMicrophoneNamePattern; change that setting before selecting this microphone.",
  ]);
  warningMessages.length = 0;
});

test("microphone picker does not rewrite or refresh an already active preference", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-mic-picker-current-"));
  const ffmpegPath = path.join(dir, "fake-ffmpeg.js");
  fs.writeFileSync(ffmpegPath, [
    "#!/usr/bin/env node",
    "console.error('[AVFoundation indev @ 0x123] AVFoundation video devices:');",
    "console.error('[AVFoundation indev @ 0x123] [0] FaceTime HD Camera');",
    "console.error('[AVFoundation indev @ 0x123] AVFoundation audio devices:');",
    "console.error('[AVFoundation indev @ 0x123] [0] MacBook Pro Microphone');",
    "console.error('[AVFoundation indev @ 0x123] [1] External USB Mic');",
  ].join("\n"), "utf8");
  fs.chmodSync(ffmpegPath, 0o755);

  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousFfmpegPath = configValues.nativeRecorderFfmpegPath;
  const previousPreference = configValues.preferredMicrophoneName;
  const previousQuickPick = mockVscode.window.showQuickPick;
  const previousInfoMessage = mockVscode.window.showInformationMessage;
  const info = [];
  let refreshes = 0;
  configValues.nativeRecorderFfmpegPath = ffmpegPath;
  configValues.preferredMicrophoneName = "MacBook Pro Microphone";
  mockVscode.window.showInformationMessage = async (message) => {
    info.push(message);
  };
  mockVscode.window.showQuickPick = async (items) => items.find((item) => item.label === "MacBook Pro Microphone");
  api.clearRefreshHandlers();
  api.registerRefreshHandler(() => {
    refreshes += 1;
  });
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

  try {
    await api.selectRecordingMicrophone();
  } finally {
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    configValues.nativeRecorderFfmpegPath = previousFfmpegPath;
    configValues.preferredMicrophoneName = previousPreference;
    mockVscode.window.showQuickPick = previousQuickPick;
    mockVscode.window.showInformationMessage = previousInfoMessage;
    api.clearRefreshHandlers();
    api.invalidateResolvedAudioDevice();
  }

  assert.equal(refreshes, 0);
  assert.deepEqual(info, ["Recording microphone preference is already \"MacBook Pro Microphone\"."]);
});

test("native recorder reports missing ffmpeg as ffmpeg, not as missing microphone", async () => {
  // listAvfoundationAudioDevices is async now (cp.spawn, not the host-freezing
  // cp.spawnSync) — a bad ffmpeg path must still surface as an ffmpeg error.
  await assert.rejects(
    api.listAvfoundationAudioDevices("/definitely/not/a/real/ffmpeg"),
    /Could not run ffmpeg/,
  );
});

test("native recorder serializes overlapping starts and reclaims the stale first take", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-native-start-lock-"));
  const packageDate = "2026-05-22";
  const packageDir = path.join(root, "prebuilt", packageDate);
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "english-training-fake-ffmpeg-"));
  const fakeFfmpeg = path.join(fakeDir, "fake-ffmpeg.js");
  const spawnLog = path.join(fakeDir, "spawn.log");
  fs.mkdirSync(packageDir, { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "english-training.json"), JSON.stringify({
    training_type: "Native recorder test",
    goal: "Serialize starts.",
  }), "utf8");
  fs.writeFileSync(fakeFfmpeg, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `fs.appendFileSync(${JSON.stringify(spawnLog)}, process.pid + "\\n");`,
    "const output = process.argv[process.argv.length - 1];",
    "fs.mkdirSync(path.dirname(output), { recursive: true });",
    "fs.writeFileSync(output, Buffer.alloc(2048, 1));",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => { if (String(chunk).includes('q')) process.exit(0); });",
    "process.on('SIGTERM', () => process.exit(0));",
    "setInterval(() => undefined, 1000);",
  ].join("\n"), "utf8");
  fs.chmodSync(fakeFfmpeg, 0o755);

  const previousPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  const previousLocalMaterialsRoot = configValues.localMaterialsRoot;
  const previousFfmpegPath = configValues.nativeRecorderFfmpegPath;
  const previousFfmpegDevice = configValues.nativeRecorderFfmpegAudioDevice;
  configValues.localMaterialsRoot = root;
  configValues.nativeRecorderFfmpegPath = fakeFfmpeg;
  configValues.nativeRecorderFfmpegAudioDevice = "0";
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  api.invalidateNextPackageCache();

  let firstSession;
  let secondSession;
  try {
    const context = {
      extensionPath: "/tmp/english-training-extension-test",
      globalStorageUri: mockVscode.Uri.file("/tmp/english-training-extension-test/storage"),
      secrets: { get: async () => undefined },
      subscriptions: [],
    };
    const firstStart = api.startNativeFfmpegRecording(context);
    const secondStart = api.startNativeFfmpegRecording(context);
    firstSession = await firstStart;
    secondSession = await secondStart;

    assert.notEqual(firstSession.process.pid, secondSession.process.pid);
    assert.equal(firstSession.process.killed || firstSession.process.exitCode !== null || firstSession.process.signalCode !== null, true);
    assert.equal(secondSession.process.killed, false);
    const stopped = await api.stopNativeFfmpegRecording();
    assert.equal(stopped.process.pid, secondSession.process.pid);
    assert.equal(fs.readFileSync(spawnLog, "utf8").trim().split(/\n+/).length, 2);
  } finally {
    api.killActiveNativeRecording();
    if (previousPlatform) {
      Object.defineProperty(process, "platform", previousPlatform);
    }
    configValues.localMaterialsRoot = previousLocalMaterialsRoot;
    configValues.nativeRecorderFfmpegPath = previousFfmpegPath;
    configValues.nativeRecorderFfmpegAudioDevice = previousFfmpegDevice;
    api.invalidateNextPackageCache();
    api.invalidateResolvedAudioDevice();
  }
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
