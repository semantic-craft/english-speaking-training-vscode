import { Blob } from "node:buffer";
import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

type JsonObject = Record<string, unknown>;
type ProviderName = "openai" | "gemini" | "minimax" | "mimo" | "kimi" | "deepseek";
type MaterialsSource = "auto" | "local" | "github";
type ActiveMaterialsSource = "local" | "github";
type KeyAvailability = Record<ProviderName, boolean> & { github: boolean };

interface RemoteFetchOptions {
  accept?: string;
  githubToken?: string;
}

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface ProgressCell {
  date: string;
  status: "completed" | "current" | "pending" | "missed";
}

interface ProgressSnapshot {
  total: number;
  completedCount: number;
  currentIndex: number;
  streak: number;
  weekIndex: number;
  dayInWeek: number;
  weekTotalDays: number;
  weekCompletedDays: number;
  cells: ProgressCell[];
}

interface TrainingState {
  root: string;
  source: ActiveMaterialsSource;
  sourceLabel: string;
  materialsBaseUrl?: string;
  today: string;
  next: JsonObject;
  training: JsonObject;
  drill: JsonObject;
  progress?: ProgressSnapshot;
  recentSessions: JsonObject[];
  generatedAt: string;
  keys: KeyAvailability;
  settings: {
    materialsSource: MaterialsSource;
    localMaterialsRoot: string;
    githubMaterialsBaseUrl: string;
    coachProvider: string;
    audioUnderstandingProvider: string;
    ttsProvider: string;
    openaiTranscriptionModel: string;
    openaiCoachModel: string;
    geminiCoachModel: string;
    geminiTtsModel: string;
    geminiTtsVoice: string;
    geminiAudioUnderstandingModel: string;
    minimaxChatBaseUrl: string;
    minimaxCoachModel: string;
    mimoChatBaseUrl: string;
    mimoCoachModel: string;
    mimoAudioUnderstandingModel: string;
    mimoTtsModel: string;
    mimoTtsVoice: string;
    kimiChatBaseUrl: string;
    kimiCoachModel: string;
    deepseekChatBaseUrl: string;
    deepseekCoachModel: string;
    minimaxTtsModel: string;
    minimaxTtsVoiceId: string;
    ttsSpeed: number;
  };
}

interface PracticeResult {
  transcript: string;
  nativeVersion: string;
  problems: string[];
  quickFix: string;
  followUpQuestion: string;
  shadowingInstruction: string;
  errorTags: string[];
  nextDrill: string;
  scores: JsonObject;
  audioFile?: string;
  sessionDir: string;
  packageDate: string;
}

interface WebviewAudioMessage {
  type: "practiceAudio";
  base64: string;
  mimeType: string;
}

interface NativeRecordingSession {
  process: cp.ChildProcessWithoutNullStreams;
  filePath: string;
  sessionDir: string;
  packageDate: string;
  startedAt: number;
  stderr: string[];
}

type PracticeStage = "transcribe" | "coach" | "tts" | "save";
type StageStatus = "active" | "done";
type StageReporter = (stage: PracticeStage, status: StageStatus) => void;

let output: vscode.OutputChannel;
let statusProvider: StatusProvider;
let practiceProvider: PracticeViewProvider;
let nativeRecording: NativeRecordingSession | undefined;

const secretKeys: Record<ProviderName, string> = {
  openai: "englishTraining.openaiKey",
  gemini: "englishTraining.geminiKey",
  minimax: "englishTraining.minimaxKey",
  mimo: "englishTraining.mimoKey",
  kimi: "englishTraining.kimiKey",
  deepseek: "englishTraining.deepSeekKey",
};
const githubTokenSecretKey = "englishTraining.githubToken";

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("English Training");
  statusProvider = new StatusProvider(context);
  practiceProvider = new PracticeViewProvider(context);

  context.subscriptions.push(output);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("englishTraining.status", statusProvider));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("englishTraining.practice", practiceProvider));

  const register = (command: string, callback: (...args: unknown[]) => unknown) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, callback));
  };

  register("englishTraining.openPractice", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.englishTraining");
    await vscode.commands.executeCommand("englishTraining.practice.focus");
  });
  register("englishTraining.refresh", async () => {
    await refreshAll();
  });
  register("englishTraining.configureGitHubMaterials", async () => {
    await configureGitHubMaterialsSource(context);
  });
  register("englishTraining.configureGitHubToken", async () => {
    await configureGitHubToken(context);
  });
  register("englishTraining.clearGitHubToken", async () => {
    await clearGitHubToken(context);
  });
  register("englishTraining.configureOpenAIKey", async () => {
    await configureApiKey(context, "openai");
  });
  register("englishTraining.configureGeminiKey", async () => {
    await configureApiKey(context, "gemini");
  });
  register("englishTraining.configureMiniMaxKey", async () => {
    await configureApiKey(context, "minimax");
  });
  register("englishTraining.configureMiMoKey", async () => {
    await configureApiKey(context, "mimo");
  });
  register("englishTraining.configureKimiKey", async () => {
    await configureApiKey(context, "kimi");
  });
  register("englishTraining.configureDeepSeekKey", async () => {
    await configureApiKey(context, "deepseek");
  });
  register("englishTraining.clearApiKeys", async () => {
    await clearApiKeys(context);
  });
  register("englishTraining.useOpenAICoach", async () => {
    await setProviderSetting("coachProvider", "openai");
  });
  register("englishTraining.useGeminiCoach", async () => {
    await setProviderSetting("coachProvider", "gemini");
  });
  register("englishTraining.useMiniMaxCoach", async () => {
    await setProviderSetting("coachProvider", "minimax");
  });
  register("englishTraining.useMiMoCoach", async () => {
    await setProviderSetting("coachProvider", "mimo");
  });
  register("englishTraining.useKimiCoach", async () => {
    await setProviderSetting("coachProvider", "kimi");
  });
  register("englishTraining.useDeepSeekCoach", async () => {
    await setProviderSetting("coachProvider", "deepseek");
  });
  register("englishTraining.useOpenAIAudioUnderstanding", async () => {
    await setProviderSetting("audioUnderstandingProvider", "openai");
  });
  register("englishTraining.useGeminiAudioUnderstanding", async () => {
    await setProviderSetting("audioUnderstandingProvider", "gemini");
  });
  register("englishTraining.useMiMoAudioUnderstanding", async () => {
    await setProviderSetting("audioUnderstandingProvider", "mimo");
  });
  register("englishTraining.useMiniMaxTts", async () => {
    await setProviderSetting("ttsProvider", "minimax");
  });
  register("englishTraining.useOpenAITts", async () => {
    await setProviderSetting("ttsProvider", "openai");
  });
  register("englishTraining.useGeminiTts", async () => {
    await setProviderSetting("ttsProvider", "gemini");
  });
  register("englishTraining.useMiMoTts", async () => {
    await setProviderSetting("ttsProvider", "mimo");
  });
  register("englishTraining.completeLocal", async () => {
    await completeLocalPackage(context);
  });
  register("englishTraining.openTaskCard", async () => {
    await openCurrentTaskCard(context);
  });
  register("englishTraining.revealPackage", async () => {
    await revealCurrentPackage(context);
  });
  register("englishTraining.openSessionFolder", async () => {
    await openSessionFolder(context);
  });
  register("englishTraining.createSamplePackage", async () => {
    await createSamplePackage(context);
  });
  register("englishTraining.openMaterialsGuide", async () => {
    await openMaterialsGuide();
  });

  void refreshAll();
}

export function deactivate(): void {
  if (nativeRecording && !nativeRecording.process.killed) {
    nativeRecording.process.kill("SIGTERM");
  }
}

function config<T>(key: string): T {
  return vscode.workspace.getConfiguration("englishTraining").get<T>(key) as T;
}

function pythonPath(): string {
  return config<string>("pythonPath") || "python3";
}

function trainingSettings(): TrainingState["settings"] {
  return {
    materialsSource: (config<string>("materialsSource") as MaterialsSource | undefined) || "auto",
    localMaterialsRoot: config<string>("localMaterialsRoot") || "",
    githubMaterialsBaseUrl: config<string>("githubMaterialsBaseUrl") || "",
    coachProvider: config<string>("coachProvider") || "mimo",
    audioUnderstandingProvider: config<string>("audioUnderstandingProvider") || "openai",
    ttsProvider: config<string>("ttsProvider") || "minimax",
    openaiTranscriptionModel: config<string>("openaiTranscriptionModel") || "gpt-4o-transcribe",
    openaiCoachModel: config<string>("openaiCoachModel") || "gpt-4o-mini",
    geminiCoachModel: config<string>("geminiCoachModel") || "gemini-2.5-flash",
    geminiTtsModel: config<string>("geminiTtsModel") || "gemini-2.5-flash-preview-tts",
    geminiTtsVoice: config<string>("geminiTtsVoice") || "Kore",
    geminiAudioUnderstandingModel: config<string>("geminiAudioUnderstandingModel") || "gemini-2.5-flash",
    minimaxChatBaseUrl: config<string>("minimaxChatBaseUrl") || "https://api.minimax.io/v1",
    minimaxCoachModel: config<string>("minimaxCoachModel") || "MiniMax-M2.7-highspeed",
    mimoChatBaseUrl: config<string>("mimoChatBaseUrl") || "https://token-plan-cn.xiaomimimo.com/v1",
    mimoCoachModel: config<string>("mimoCoachModel") || "mimo-v2.5",
    mimoAudioUnderstandingModel: config<string>("mimoAudioUnderstandingModel") || "mimo-v2.5",
    mimoTtsModel: config<string>("mimoTtsModel") || "mimo-v2.5-tts",
    mimoTtsVoice: config<string>("mimoTtsVoice") || "mimo_default",
    kimiChatBaseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
    kimiCoachModel: config<string>("kimiCoachModel") || "kimi-for-coding",
    deepseekChatBaseUrl: config<string>("deepseekChatBaseUrl") || "https://api.deepseek.com",
    deepseekCoachModel: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
    minimaxTtsModel: config<string>("minimaxTtsModel") || "speech-2.8-hd",
    minimaxTtsVoiceId: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
    ttsSpeed: Number(config<number>("ttsSpeed") ?? 0.9),
  };
}

async function refreshAll(): Promise<void> {
  statusProvider.refresh();
  await practiceProvider.postState();
}

async function findTrainingRoot(): Promise<string> {
  const candidates: string[] = [];
  const configuredRoot = expandHome(config<string>("localMaterialsRoot") || "").trim();
  if (configuredRoot) {
    candidates.push(configuredRoot);
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.push(folder.uri.fsPath);
    candidates.push(path.dirname(folder.uri.fsPath));
  }
  const activeFile = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activeFile) {
    candidates.push(path.dirname(activeFile));
  }

  for (const start of candidates) {
    let current = path.resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (looksLikeTrainingRoot(current)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }

  throw new Error("Could not find an EnglishSpeakingTraining root with a prebuilt/ folder.");
}

function looksLikeTrainingRoot(root: string): boolean {
  return fs.existsSync(path.join(root, "prebuilt")) && (
    fs.existsSync(path.join(root, "progress")) ||
    fs.existsSync(path.join(root, "scripts", "english_training_progress.py")) ||
    fs.existsSync(path.join(root, "two-month-english-speaking-training-project.md"))
  );
}

function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "", value.slice(2));
  }
  return value;
}

function todayInConfiguredTimezone(): string {
  const timezone = config<string>("timezone") || "Asia/Shanghai";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

function readJson(filePath: string): JsonObject | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as JsonObject;
  } catch {
    return undefined;
  }
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function execFile(root: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = cp.execFile(
      pythonPath(),
      args,
      {
        cwd: root,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 12,
      },
      (error, stdout, stderr) => {
        const exitError = error as NodeJS.ErrnoException | null;
        resolve({
          code: typeof exitError?.code === "number" ? exitError.code : error ? 1 : 0,
          stdout,
          stderr,
        });
      },
    );
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
  });
}

function parseFirstJson(stdout: string): JsonObject | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      return JSON.parse(trimmed) as JsonObject;
    } catch {
      continue;
    }
  }
  try {
    return JSON.parse(stdout) as JsonObject;
  } catch {
    return undefined;
  }
}

async function loadState(context: vscode.ExtensionContext): Promise<TrainingState> {
  const settings = trainingSettings();
  const today = todayInConfiguredTimezone();

  if (settings.materialsSource !== "github") {
    try {
      return await loadLocalState(context, today, settings);
    } catch (error) {
      if (settings.materialsSource === "local" || !settings.githubMaterialsBaseUrl.trim()) {
        throw error;
      }
      output.appendLine(`Local training root unavailable; falling back to GitHub materials: ${errorMessage(error)}`);
    }
  }

  return loadGitHubState(context, today, settings);
}

async function loadLocalState(
  context: vscode.ExtensionContext,
  today: string,
  settings: TrainingState["settings"],
): Promise<TrainingState> {
  const root = await findTrainingRoot();
  const next = await resolveNextPackage(root, today);
  const packageDate = stringValue(next.package_date);
  const training = packageDate ? readJson(path.join(root, "prebuilt", packageDate, "english-training.json")) ?? {} : {};
  const drill = packageDate ? buildDrillPlan(root, packageDate, training) : {};
  const inventory = readLocalInventory(root);
  const progress = buildProgressSnapshot(inventory.dates, inventory.completed, today, packageDate);

  return {
    root,
    source: "local",
    sourceLabel: root,
    today,
    next,
    training,
    drill,
    progress,
    recentSessions: readRecentSessionLog(root, 5),
    generatedAt: new Date().toISOString(),
    keys: await apiKeyAvailability(context),
    settings,
  };
}

function readLocalInventory(root: string): { dates: string[]; completed: Set<string> } {
  const prebuiltRoot = path.join(root, "prebuilt");
  const dates = fs.existsSync(prebuiltRoot)
    ? fs.readdirSync(prebuiltRoot)
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(prebuiltRoot, name)).isDirectory())
        .sort()
    : [];
  const progressJson = readJson(path.join(root, "progress", "english-speaking-training-progress.json")) ?? {};
  const completed = new Set<string>();
  for (const record of Array.isArray(progressJson.records) ? progressJson.records : []) {
    const item = record as JsonObject;
    if (stringValue(item.status) === "completed") {
      completed.add(stringValue(item.date));
    }
  }
  return { dates, completed };
}

function buildProgressSnapshot(
  dates: string[],
  completed: Set<string>,
  today: string,
  currentPackageDate: string,
): ProgressSnapshot {
  const total = dates.length;
  const completedCount = dates.filter((d) => completed.has(d)).length;
  const indexOfCurrent = currentPackageDate ? dates.indexOf(currentPackageDate) : -1;
  const currentIndex = indexOfCurrent >= 0 ? indexOfCurrent + 1 : 0;

  let lastTodayIdx = -1;
  for (let i = 0; i < dates.length; i += 1) {
    if (dates[i] <= today) {
      lastTodayIdx = i;
    } else {
      break;
    }
  }
  let streak = 0;
  for (let i = lastTodayIdx; i >= 0; i -= 1) {
    if (completed.has(dates[i])) {
      streak += 1;
    } else {
      break;
    }
  }

  const weekIndex = currentIndex ? Math.ceil(currentIndex / 7) : 0;
  const dayInWeek = currentIndex ? ((currentIndex - 1) % 7) + 1 : 0;
  const weekStart = currentIndex ? (weekIndex - 1) * 7 : 0;
  const weekDates = dates.slice(weekStart, weekStart + 7);
  const weekTotalDays = weekDates.length;
  const weekCompletedDays = weekDates.filter((d) => completed.has(d)).length;

  const cells: ProgressCell[] = dates.map((date) => {
    if (completed.has(date)) {
      return { date, status: "completed" };
    }
    if (date === currentPackageDate) {
      return { date, status: "current" };
    }
    if (date < today) {
      return { date, status: "missed" };
    }
    return { date, status: "pending" };
  });

  return {
    total,
    completedCount,
    currentIndex,
    streak,
    weekIndex,
    dayInWeek,
    weekTotalDays,
    weekCompletedDays,
    cells,
  };
}

async function resolveNextPackage(root: string, today: string): Promise<JsonObject> {
  const script = path.join(root, "scripts", "english_training_progress.py");
  if (fs.existsSync(script)) {
    const result = await execFile(root, ["scripts/english_training_progress.py", "next", "--as-of", today], 60_000);
    const parsed = parseFirstJson(result.stdout);
    const next = ((parsed?.result as JsonObject | undefined) ?? {}) as JsonObject;
    if (stringValue(next.package_date)) {
      return next;
    }
  }

  const prebuiltRoot = path.join(root, "prebuilt");
  const dates = fs
    .readdirSync(prebuiltRoot)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name) && fs.statSync(path.join(prebuiltRoot, name)).isDirectory())
    .sort();
  const progress = readJson(path.join(root, "progress", "english-speaking-training-progress.json")) ?? {};
  const completed = new Set<string>();
  for (const record of Array.isArray(progress.records) ? progress.records : []) {
    const item = record as JsonObject;
    if (stringValue(item.status) === "completed") {
      completed.add(stringValue(item.date));
    }
  }
  const packageDate = dates.find((date) => !completed.has(date)) ?? dates[dates.length - 1] ?? "";
  const training = packageDate ? readJson(path.join(prebuiltRoot, packageDate, "english-training.json")) ?? {} : {};
  return {
    send_date: today,
    package_date: packageDate,
    completion_label: packageDate ? `Package ${dates.indexOf(packageDate) + 1}` : "",
    package_day_index: packageDate ? dates.indexOf(packageDate) + 1 : undefined,
    training_type: stringValue(training.training_type),
    goal: stringValue(training.goal),
    scenario: stringValue(training.scenario),
    clean_tts_text: stringValue(training.clean_tts_text) || stringValue(training.audio_text),
    assets: packageDate ? packageAssets(root, packageDate) : {},
  };
}

function packageAssets(root: string, packageDate: string): JsonObject {
  const dir = path.join(root, "prebuilt", packageDate);
  return {
    package_dir: dir,
    task_card: path.join(dir, "telegram-task-card.md"),
    daily_card: path.join(dir, "daily-card.png"),
    prosody_detail: path.join(dir, "prosody-detail.png"),
    audio: path.join(dir, "audio", "demo.ogg"),
    json: path.join(dir, "english-training.json"),
    followup_drill_json: path.join(dir, "followup-drill.json"),
    followup_drill_md: path.join(dir, "followup-drill.md"),
    manifest: path.join(dir, "manifest.json"),
  };
}

function buildDrillPlan(root: string, packageDate: string, training: JsonObject): JsonObject {
  const followupPath = path.join(root, "prebuilt", packageDate, "followup-drill.json");
  const followup = readJson(followupPath) ?? {};
  const task = (training.task as JsonObject | undefined) ?? {};
  const primaryTags = arrayOfStrings(training.primary_tags);
  const fallbackFrames = Array.isArray(training.frames)
    ? [
        {
          id: "A",
          label: "Substitution: today's frames",
          base_frame: stringValue((training.frames[0] as JsonObject | undefined)?.text) || stringValue(training.clean_tts_text),
          slot: "frame",
          examples: training.frames,
        },
      ]
    : [];

  return {
    title: stringValue(followup.title) || `FSI Drill - ${packageDate}`,
    method: stringValue(followup.method) || "FSI-style substitution + shadowing",
    routine_zh: arrayOfStrings(followup.routine_zh).length
      ? arrayOfStrings(followup.routine_zh)
      : [
          "先听一遍，不分析语法。",
          "用完整句快速替换 cue。",
          "延迟 0.5-1 秒跟读，复制节奏和停顿。",
          "最后不看文本说两句。",
        ],
    rounds: Array.isArray(followup.rounds) ? followup.rounds : fallbackFrames,
    shadowing_loop: (followup.shadowing_loop as JsonObject | undefined) ?? {
      chunks: splitPracticeText(stringValue(training.clean_tts_text) || stringValue(training.audio_text)).slice(0, 4),
      instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
    },
    source_principles: arrayOfStrings(followup.source_principles),
    repair_drills: arrayOfStrings(training.repair_drills),
    primary_tags: primaryTags,
    required_frames: Number(task.required_frames ?? 0) || undefined,
    training_type: stringValue(training.training_type),
  };
}

async function loadGitHubState(
  context: vscode.ExtensionContext,
  today: string,
  settings: TrainingState["settings"],
): Promise<TrainingState> {
  const baseUrl = normalizeGitHubMaterialsBaseUrl(settings.githubMaterialsBaseUrl);
  if (!baseUrl) {
    throw new Error("Configure englishTraining.githubMaterialsBaseUrl to read practice materials from GitHub.");
  }

  const root = localStateRoot(context);
  fs.mkdirSync(root, { recursive: true });
  const githubToken = await getGitHubToken(context);
  const dates = await resolveRemoteDates(baseUrl, githubToken);
  const completed = readCompletedDates(root);
  const remote = await resolveRemotePackageFromInventory(baseUrl, today, dates, completed, githubToken);
  const packageDate = stringValue(remote.package_date);
  const training = packageDate ? await fetchRemoteJson(remoteUrl(baseUrl, "prebuilt", packageDate, "english-training.json"), { githubToken }) : {};
  const drill = packageDate ? await buildRemoteDrillPlan(baseUrl, packageDate, training, githubToken) : {};
  const assets = packageDate ? await remotePackageAssets(root, baseUrl, packageDate, githubToken) : {};
  const next = {
    ...remote,
    training_type: stringValue(training.training_type),
    goal: stringValue(training.goal),
    scenario: stringValue(training.scenario),
    clean_tts_text: stringValue(training.clean_tts_text) || stringValue(training.audio_text),
    assets,
  };
  const progress = dates.length ? buildProgressSnapshot(dates, completed, today, packageDate) : undefined;

  return {
    root,
    source: "github",
    sourceLabel: baseUrl,
    materialsBaseUrl: baseUrl,
    today,
    next,
    training,
    drill,
    progress,
    recentSessions: readRecentSessionLog(root, 5),
    generatedAt: new Date().toISOString(),
    keys: await apiKeyAvailability(context),
    settings,
  };
}

async function resolveRemotePackageFromInventory(
  baseUrl: string,
  today: string,
  dates: string[],
  completed: Set<string>,
  githubToken?: string,
): Promise<JsonObject> {
  if (dates.length) {
    const packageDate = dates.find((date) => !completed.has(date)) ?? dates[dates.length - 1] ?? "";
    return {
      send_date: today,
      package_date: packageDate,
      completion_label: packageDate ? `Package ${dates.indexOf(packageDate) + 1}` : "",
      package_day_index: packageDate ? dates.indexOf(packageDate) + 1 : undefined,
    };
  }
  const packageDate = await findRemoteDateFallback(baseUrl, today, githubToken);
  return {
    send_date: today,
    package_date: packageDate,
    completion_label: packageDate ? "Remote package" : "",
  };
}

function localStateRoot(context: vscode.ExtensionContext): string {
  return path.join(context.globalStorageUri.fsPath, "english-training");
}

async function resolveRemoteDates(baseUrl: string, githubToken?: string): Promise<string[]> {
  const indexDates = await resolveRemoteDatesFromIndex(baseUrl, githubToken);
  if (indexDates.length) {
    return indexDates;
  }
  const githubDates = await resolveRemoteDatesFromGitHubApi(baseUrl, githubToken);
  return githubDates;
}

async function resolveRemoteDatesFromIndex(baseUrl: string, githubToken?: string): Promise<string[]> {
  for (const indexName of ["prebuilt/index.json", "prebuilt/manifest.json"]) {
    const value = await fetchRemoteJsonOptional(remoteUrl(baseUrl, indexName), { githubToken });
    if (!value) {
      continue;
    }
    const dates = normalizeRemoteDateList(value);
    if (dates.length) {
      return dates;
    }
  }
  return [];
}

function normalizeRemoteDateList(value: unknown): string[] {
  const source: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray((value as JsonObject | undefined)?.dates)
      ? ((value as JsonObject).dates as unknown[])
      : Array.isArray((value as JsonObject | undefined)?.packages)
        ? ((value as JsonObject).packages as unknown[])
        : [];
  return source
    .map((item) => {
      if (typeof item === "string") return item;
      const object = item as JsonObject | undefined;
      return stringValue(object?.date) || stringValue(object?.package_date) || stringValue(object?.packageDate);
    })
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
}

async function resolveRemoteDatesFromGitHubApi(baseUrl: string, githubToken?: string): Promise<string[]> {
  const parsed = parseGitHubMaterialsBaseUrl(baseUrl);
  if (!parsed) {
    return [];
  }
  const contentsPath = ["repos", parsed.owner, parsed.repo, "contents", ...parsed.pathPrefix, "prebuilt"]
    .map(encodeURIComponent)
    .join("/");
  const url = `https://api.github.com/${contentsPath}?ref=${encodeURIComponent(parsed.ref)}`;
  const value = await fetchRemoteJsonOptional(url, { accept: "application/vnd.github+json", githubToken });
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => (item as JsonObject | undefined)?.name)
    .map(stringValue)
    .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
    .sort();
}

async function findRemoteDateFallback(baseUrl: string, today: string, githubToken?: string): Promise<string> {
  for (const offset of [0, ...Array.from({ length: 90 }, (_, index) => -(index + 1)), ...Array.from({ length: 14 }, (_, index) => index + 1)]) {
    const date = addDays(today, offset);
    const training = await fetchRemoteJsonOptional(remoteUrl(baseUrl, "prebuilt", date, "english-training.json"), { githubToken });
    if (training) {
      return date;
    }
  }
  throw new Error("Could not find a remote package. Add prebuilt/index.json or use a GitHub URL whose prebuilt/ directory can be listed.");
}

async function buildRemoteDrillPlan(baseUrl: string, packageDate: string, training: JsonObject, githubToken?: string): Promise<JsonObject> {
  const followupValue = await fetchRemoteJsonOptional(remoteUrl(baseUrl, "prebuilt", packageDate, "followup-drill.json"), { githubToken });
  const followup = followupValue && !Array.isArray(followupValue) ? followupValue : {};
  const task = (training.task as JsonObject | undefined) ?? {};
  const primaryTags = arrayOfStrings(training.primary_tags);
  const fallbackFrames = Array.isArray(training.frames)
    ? [
        {
          id: "A",
          label: "Substitution: today's frames",
          base_frame: stringValue((training.frames[0] as JsonObject | undefined)?.text) || stringValue(training.clean_tts_text),
          slot: "frame",
          examples: training.frames,
        },
      ]
    : [];

  return {
    title: stringValue(followup.title) || `FSI Drill - ${packageDate}`,
    method: stringValue(followup.method) || "FSI-style substitution + shadowing",
    routine_zh: arrayOfStrings(followup.routine_zh).length
      ? arrayOfStrings(followup.routine_zh)
      : [
          "先听一遍，不分析语法。",
          "用完整句快速替换 cue。",
          "延迟 0.5-1 秒跟读，复制节奏和停顿。",
          "最后不看文本说两句。",
        ],
    rounds: Array.isArray(followup.rounds) ? followup.rounds : fallbackFrames,
    shadowing_loop: (followup.shadowing_loop as JsonObject | undefined) ?? {
      chunks: splitPracticeText(stringValue(training.clean_tts_text) || stringValue(training.audio_text)).slice(0, 4),
      instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
    },
    source_principles: arrayOfStrings(followup.source_principles),
    repair_drills: arrayOfStrings(training.repair_drills),
    primary_tags: primaryTags,
    required_frames: Number(task.required_frames ?? 0) || undefined,
    training_type: stringValue(training.training_type),
  };
}

async function remotePackageAssets(root: string, baseUrl: string, packageDate: string, githubToken?: string): Promise<JsonObject> {
  const assets: JsonObject = {
    package_dir: remoteUrl(baseUrl, "prebuilt", packageDate),
    task_card: remoteUrl(baseUrl, "prebuilt", packageDate, "telegram-task-card.md"),
    daily_card: remoteUrl(baseUrl, "prebuilt", packageDate, "daily-card.png"),
    prosody_detail: remoteUrl(baseUrl, "prebuilt", packageDate, "prosody-detail.png"),
    audio: remoteUrl(baseUrl, "prebuilt", packageDate, "audio", "demo.ogg"),
    json: remoteUrl(baseUrl, "prebuilt", packageDate, "english-training.json"),
    followup_drill_json: remoteUrl(baseUrl, "prebuilt", packageDate, "followup-drill.json"),
    followup_drill_md: remoteUrl(baseUrl, "prebuilt", packageDate, "followup-drill.md"),
    manifest: remoteUrl(baseUrl, "prebuilt", packageDate, "manifest.json"),
  };
  const cachedAudio = await cacheRemoteAsset(root, packageDate, "audio/demo.ogg", stringValue(assets.audio), {
    accept: "audio/ogg, audio/*, */*",
    githubToken,
  });
  if (cachedAudio) {
    assets.audio = cachedAudio;
  }
  return assets;
}

function normalizeGitHubMaterialsBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    if (url.hostname === "github.com") {
      const parts = url.pathname.split("/").filter(Boolean);
      const [owner, repoWithSuffix] = parts;
      const repo = (repoWithSuffix || "").replace(/\.git$/, "");
      if (!owner || !repo) {
        return trimmed;
      }
      if (parts[2] === "tree" && parts[3]) {
        const ref = parts[3];
        const rest = parts.slice(4).map(encodeURIComponent).join("/");
        return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}${rest ? `/${rest}` : ""}`;
      }
      return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/main`;
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

function parseGitHubMaterialsBaseUrl(baseUrl: string): { owner: string; repo: string; ref: string; pathPrefix: string[] } | undefined {
  try {
    const url = new URL(baseUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "raw.githubusercontent.com" && parts.length >= 3) {
      return {
        owner: parts[0],
        repo: parts[1],
        ref: parts[2],
        pathPrefix: parts.slice(3),
      };
    }
    if (url.hostname === "github.com" && parts.length >= 2) {
      const [owner, repoWithSuffix] = parts;
      const repo = repoWithSuffix.replace(/\.git$/, "");
      if (parts[2] === "tree" && parts[3]) {
        return {
          owner,
          repo,
          ref: parts[3],
          pathPrefix: parts.slice(4),
        };
      }
      return {
        owner,
        repo,
        ref: "main",
        pathPrefix: [],
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function remoteUrl(baseUrl: string, ...parts: string[]): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = parts
    .flatMap((part) => part.split("/"))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${base}/${suffix}`;
}

async function cacheRemoteAsset(root: string, packageDate: string, relativePath: string, url: string, options: RemoteFetchOptions): Promise<string> {
  if (!url) {
    return "";
  }
  const filePath = path.join(root, "remote-materials", packageDate, ...relativePath.split("/").filter(Boolean));
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 0) {
      return filePath;
    }
    const buffer = await fetchRemoteBuffer(url, options);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (error) {
    output.appendLine(`Remote asset cache failed: ${errorMessage(error)}`);
    return "";
  }
}

async function fetchRemoteJson(url: string, options: RemoteFetchOptions = {}): Promise<JsonObject> {
  const value = await fetchRemoteJsonOptional(url, options);
  if (!value || Array.isArray(value)) {
    throw new Error(`Could not read remote JSON: ${url}`);
  }
  return value;
}

async function fetchRemoteJsonOptional(url: string, options: RemoteFetchOptions = {}): Promise<JsonObject | JsonObject[] | undefined> {
  const response = await fetch(url, {
    headers: remoteFetchHeaders(url, {
      ...options,
      accept: options.accept || "application/json",
    }),
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    output.appendLine(`Remote request failed (${response.status}) ${url}`);
    return undefined;
  }
  try {
    return JSON.parse(await response.text()) as JsonObject | JsonObject[];
  } catch {
    return undefined;
  }
}

async function fetchRemoteText(url: string, options: RemoteFetchOptions = {}): Promise<string> {
  const response = await fetch(url, {
    headers: remoteFetchHeaders(url, {
      ...options,
      accept: options.accept || "text/plain, text/markdown, */*",
    }),
  });
  if (!response.ok) {
    throw new Error(`Could not read remote text (${response.status}): ${url}`);
  }
  return response.text();
}

async function fetchRemoteBuffer(url: string, options: RemoteFetchOptions = {}): Promise<Buffer> {
  const response = await fetch(url, {
    headers: remoteFetchHeaders(url, options),
  });
  if (!response.ok) {
    throw new Error(`Could not read remote asset (${response.status}): ${url}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function remoteFetchHeaders(url: string, options: RemoteFetchOptions = {}): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: options.accept || "*/*",
    "User-Agent": "english-speaking-training-vscode",
  };
  if (options.githubToken && shouldSendGitHubToken(url)) {
    headers.Authorization = `Bearer ${options.githubToken}`;
    if (new URL(url).hostname.toLowerCase() === "api.github.com") {
      headers["X-GitHub-Api-Version"] = "2022-11-28";
    }
  }
  return headers;
}

function shouldSendGitHubToken(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "api.github.com" || host === "raw.githubusercontent.com" || host.endsWith(".githubusercontent.com");
  } catch {
    return false;
  }
}

function addDays(dateText: string, offset: number): string {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function readCompletedDates(root: string): Set<string> {
  const progress = readJson(remoteProgressPath(root)) ?? {};
  const completed = new Set<string>();
  for (const record of Array.isArray(progress.records) ? progress.records : []) {
    const item = record as JsonObject;
    if (stringValue(item.status) === "completed") {
      completed.add(stringValue(item.date));
    }
  }
  return completed;
}

function remoteProgressPath(root: string): string {
  return path.join(root, "runtime", "vscode-sessions", "remote-progress.json");
}

async function apiKeyAvailability(context: vscode.ExtensionContext): Promise<KeyAvailability> {
  return {
    openai: Boolean(await context.secrets.get(secretKeys.openai)),
    gemini: Boolean(await context.secrets.get(secretKeys.gemini)),
    minimax: Boolean(await context.secrets.get(secretKeys.minimax)),
    mimo: Boolean(await context.secrets.get(secretKeys.mimo)),
    kimi: Boolean(await context.secrets.get(secretKeys.kimi)),
    deepseek: Boolean(await context.secrets.get(secretKeys.deepseek)),
    github: Boolean(await getGitHubToken(context)),
  };
}

async function getGitHubToken(context: vscode.ExtensionContext): Promise<string | undefined> {
  const value = await context.secrets.get(githubTokenSecretKey);
  return value?.trim() || undefined;
}

async function configureApiKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<void> {
  const label = providerLabel(provider);
  const value = await vscode.window.showInputBox({
    title: `Configure ${label} API Key`,
    prompt: `Paste the ${label} API key. It will be stored in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  await context.secrets.store(secretKeys[provider], value.trim());
  vscode.window.showInformationMessage(`${label} API key saved.`);
  await refreshAll();
}

async function pickAndConfigureProviderKey(context: vscode.ExtensionContext): Promise<void> {
  const providers: ProviderName[] = ["mimo", "openai", "gemini", "minimax", "kimi", "deepseek"];
  const availability = await apiKeyAvailability(context);
  const items: (vscode.QuickPickItem & { provider: ProviderName })[] = providers.map((provider) => ({
    provider,
    label: providerLabel(provider),
    description: availability[provider] ? "saved" : "not set",
    detail: providerSetupHint(provider),
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: "Set up an AI provider key",
    placeHolder: "Pick a provider to configure (you only need one to start)",
    ignoreFocusOut: true,
  });
  if (!picked) {
    return;
  }
  await configureApiKey(context, picked.provider);
}

function providerSetupHint(provider: ProviderName): string {
  switch (provider) {
    case "mimo": return "MiMo Audio · default coach + STT + TTS";
    case "openai": return "OpenAI · whisper STT, GPT coach, TTS";
    case "gemini": return "Gemini · audio understanding + TTS";
    case "minimax": return "MiniMax · default TTS voice";
    case "kimi": return "Kimi (Moonshot) · alternate coach";
    case "deepseek": return "DeepSeek · alternate coach";
  }
}

async function clearApiKeys(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage("Clear all English Training API keys from VS Code SecretStorage?", { modal: true }, "Clear");
  if (choice !== "Clear") {
    return;
  }
  await Promise.all(Object.values(secretKeys).map((key) => context.secrets.delete(key)));
  vscode.window.showInformationMessage("English Training API keys cleared.");
  await refreshAll();
}

async function configureGitHubMaterialsSource(context: vscode.ExtensionContext): Promise<void> {
  const current = config<string>("githubMaterialsBaseUrl") || "";
  const value = await vscode.window.showInputBox({
    title: "Configure GitHub Materials Source",
    prompt: "Paste a GitHub repo/tree URL or raw.githubusercontent.com base URL that contains prebuilt/.",
    value: current,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  const baseUrl = normalizeGitHubMaterialsBaseUrl(value);
  const configTarget = vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("englishTraining").update("githubMaterialsBaseUrl", baseUrl, configTarget);
  await vscode.workspace.getConfiguration("englishTraining").update("materialsSource", "github", configTarget);
  const choice = await vscode.window.showInformationMessage(
    "English Training GitHub materials source saved. Private repositories need a GitHub token in SecretStorage.",
    "Configure Token",
  );
  if (choice === "Configure Token") {
    await configureGitHubToken(context);
    return;
  }
  await refreshAll();
}

async function configureGitHubToken(context: vscode.ExtensionContext): Promise<void> {
  const value = await vscode.window.showInputBox({
    title: "Configure GitHub Materials Token",
    prompt: "Paste a GitHub token with read access to the private materials repository. It will be stored in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!value) {
    return;
  }
  await context.secrets.store(githubTokenSecretKey, value.trim());
  vscode.window.showInformationMessage("GitHub materials token saved.");
  await refreshAll();
}

async function clearGitHubToken(context: vscode.ExtensionContext): Promise<void> {
  const choice = await vscode.window.showWarningMessage("Clear the English Training GitHub token from VS Code SecretStorage?", { modal: true }, "Clear");
  if (choice !== "Clear") {
    return;
  }
  await context.secrets.delete(githubTokenSecretKey);
  vscode.window.showInformationMessage("GitHub materials token cleared.");
  await refreshAll();
}

async function setProviderSetting(setting: "coachProvider" | "audioUnderstandingProvider" | "ttsProvider", value: string): Promise<void> {
  await vscode.workspace.getConfiguration("englishTraining").update(setting, value, vscode.ConfigurationTarget.Workspace);
  vscode.window.showInformationMessage(`English Training ${providerSettingLabel(setting)} provider set to ${value}.`);
  await refreshAll();
}

function providerSettingLabel(setting: "coachProvider" | "audioUnderstandingProvider" | "ttsProvider"): string {
  if (setting === "coachProvider") return "coach";
  if (setting === "audioUnderstandingProvider") return "speech input";
  return "speech output";
}

async function getRequiredKey(context: vscode.ExtensionContext, provider: ProviderName): Promise<string> {
  const key = await context.secrets.get(secretKeys[provider]);
  if (!key) {
    throw new Error(`Missing ${providerLabel(provider)} API key. Run the configure command first.`);
  }
  return key;
}

function providerLabel(provider: ProviderName): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "gemini") return "Gemini";
  if (provider === "minimax") return "MiniMax";
  if (provider === "mimo") return "MiMo";
  if (provider === "kimi") return "Kimi";
  return "DeepSeek";
}

function isProviderName(value: unknown): value is ProviderName {
  return value === "openai" || value === "gemini" || value === "minimax" || value === "mimo" || value === "kimi" || value === "deepseek";
}

function isCoachProvider(value: unknown): value is ProviderName {
  return value === "mimo" || value === "minimax" || value === "gemini" || value === "kimi" || value === "deepseek" || value === "openai";
}

function isAudioUnderstandingProvider(value: unknown): value is ProviderName {
  return value === "openai" || value === "gemini" || value === "mimo";
}

function isTtsProvider(value: unknown): value is ProviderName {
  return value === "minimax" || value === "gemini" || value === "openai" || value === "mimo";
}

class PracticeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(this.context.extensionPath),
        this.context.globalStorageUri,
        ...((vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri)),
      ],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((message: unknown) => {
      void this.handleMessage(message);
    });
    void this.postState();
  }

  async postState(): Promise<void> {
    if (!this.view) {
      return;
    }
    try {
      const state = await loadState(this.context);
      this.view.webview.postMessage({ type: "state", state: toWebviewState(this.view.webview, state) });
    } catch (error) {
      this.view.webview.postMessage({ type: "error", message: errorMessage(error) });
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!this.view || typeof message !== "object" || !message) {
      return;
    }
    const payload = message as JsonObject;
    try {
      if (payload.type === "ready" || payload.type === "refresh") {
        await this.postState();
        return;
      }
      if (payload.type === "configureKey") {
        const provider = payload.provider;
        if (isProviderName(provider)) {
          await configureApiKey(this.context, provider);
        }
        return;
      }
      if (payload.type === "setProvider") {
        if (payload.setting === "coachProvider" && isCoachProvider(payload.value)) {
          await setProviderSetting("coachProvider", payload.value);
        }
        if (payload.setting === "audioUnderstandingProvider" && isAudioUnderstandingProvider(payload.value)) {
          await setProviderSetting("audioUnderstandingProvider", payload.value);
        }
        if (payload.setting === "ttsProvider" && isTtsProvider(payload.value)) {
          await setProviderSetting("ttsProvider", payload.value);
        }
        return;
      }
      if (payload.type === "completeLocal") {
        await completeLocalPackage(this.context);
        return;
      }
      if (payload.type === "command") {
        if (payload.command === "configureMaterials") {
          await configureGitHubMaterialsSource(this.context);
        }
        if (payload.command === "configureGitHubToken") {
          await configureGitHubToken(this.context);
        }
        if (payload.command === "openTask") {
          await openCurrentTaskCard(this.context);
        }
        if (payload.command === "openSessionFolder") {
          await openSessionFolder(this.context);
        }
        if (payload.command === "setupProviderKey") {
          await pickAndConfigureProviderKey(this.context);
        }
        if (payload.command === "createSamplePackage") {
          await createSamplePackage(this.context);
        }
        if (payload.command === "openMaterialsGuide") {
          await openMaterialsGuide();
        }
        return;
      }
      if (payload.type === "startNativeRecording") {
        await this.startNativeRecording();
        return;
      }
      if (payload.type === "stopNativeRecording") {
        await this.stopNativeRecording();
        return;
      }
      if (payload.type === "practiceAudio") {
        await this.runPractice(payload as unknown as WebviewAudioMessage);
      }
    } catch (error) {
      this.view.webview.postMessage({ type: "error", message: errorMessage(error) });
    }
  }

  private stageReporter(): StageReporter {
    return (stage, status) => {
      this.view?.webview.postMessage({ type: "stage", stage, status, show: true });
    };
  }

  private async runPractice(message: WebviewAudioMessage): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "stage", stage: "transcribe", status: "active", show: true });
    const result = await processPracticeAudio(this.context, message, this.stageReporter());
    const audioUri = result.audioFile ? this.view.webview.asWebviewUri(vscode.Uri.file(result.audioFile)).toString() : "";
    this.view.webview.postMessage({
      type: "practiceResult",
      result: {
        ...result,
        audioUri,
      },
    });
    await refreshAll();
  }

  private async startNativeRecording(): Promise<void> {
    if (!this.view) {
      return;
    }
    const session = await startNativeFfmpegRecording(this.context);
    this.view.webview.postMessage({
      type: "nativeRecordingStarted",
      sessionDir: session.sessionDir,
    });
  }

  private async stopNativeRecording(): Promise<void> {
    if (!this.view) {
      return;
    }
    this.view.webview.postMessage({ type: "stage", stage: "transcribe", status: "active", show: true });
    const session = await stopNativeFfmpegRecording();
    const result = await processPracticeFile(
      this.context,
      session.filePath,
      "audio/wav",
      session.sessionDir,
      session.packageDate,
      this.stageReporter(),
    );
    const audioUri = result.audioFile ? this.view.webview.asWebviewUri(vscode.Uri.file(result.audioFile)).toString() : "";
    this.view.webview.postMessage({
      type: "practiceResult",
      result: {
        ...result,
        audioUri,
        localAudioUri: this.view.webview.asWebviewUri(vscode.Uri.file(session.filePath)).toString(),
      },
    });
    await refreshAll();
  }

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} https: data:; media-src ${webview.cspSource} https: blob: data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --soft: color-mix(in srgb, var(--vscode-editor-background) 88%, var(--vscode-editor-foreground) 12%);
      --accent: var(--vscode-button-background);
    }
    body {
      margin: 0;
      padding: 12px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    h2, h3 { margin: 0; font-weight: 650; }
    h2 { font-size: 17px; line-height: 1.3; }
    h3 { font-size: 13px; margin-bottom: 8px; }
    p { line-height: 1.45; margin: 8px 0; }
    button {
      min-height: 30px;
      border: 0;
      border-radius: 5px;
      padding: 0 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
    }
    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }
    button:disabled { opacity: .55; cursor: default; }
    button.active {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    button.ghost {
      background: transparent;
      color: var(--muted);
      min-height: 22px;
      padding: 0 6px;
      font-size: 13px;
    }
    button.ghost:hover { color: var(--vscode-editor-foreground); }
    .stack { display: grid; gap: 12px; }
    .panel {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 11px;
      background: var(--vscode-editor-background);
    }
    .record-panel {
      position: sticky;
      top: 0;
      z-index: 4;
      padding: 12px 11px;
      background: var(--vscode-sideBar-background);
      box-shadow: 0 1px 0 var(--border);
    }
    .record-row {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: nowrap;
    }
    .record-cta {
      width: 52px;
      height: 52px;
      min-height: 52px;
      border-radius: 50%;
      padding: 0;
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-errorForeground, #e51400);
      color: #fff;
      box-shadow: 0 1px 3px rgba(0,0,0,.25);
      transition: background-color .12s ease, box-shadow .12s ease;
    }
    .record-cta:hover { filter: brightness(1.08); }
    .record-cta:focus-visible {
      outline: 2px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    .record-cta-icon {
      width: 16px;
      height: 16px;
      border-radius: 50%;
      background: #fff;
      transition: width .12s ease, height .12s ease, border-radius .12s ease;
    }
    .record-cta.recording {
      animation: cta-pulse 1.6s ease-in-out infinite;
    }
    .record-cta.recording .record-cta-icon {
      width: 14px;
      height: 14px;
      border-radius: 3px;
    }
    .record-cta.busy {
      opacity: .6;
      cursor: progress;
      animation: none;
    }
    @keyframes cta-pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vscode-errorForeground, #e51400) 55%, transparent); }
      50% { box-shadow: 0 0 0 9px color-mix(in srgb, var(--vscode-errorForeground, #e51400) 0%, transparent); }
    }
    .record-meta {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .record-status {
      font-weight: 600;
      font-size: 13px;
      line-height: 1.25;
      overflow-wrap: anywhere;
    }
    .record-status.busy { color: var(--vscode-charts-blue, var(--accent)); }
    .record-status.error { color: var(--vscode-errorForeground); }
    .record-meter {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    #timer { min-width: 34px; }
    #vu {
      flex: 0 1 100px;
      height: 14px;
      background: var(--soft);
      border-radius: 3px;
    }
    .stages {
      list-style: none;
      padding: 0;
      margin: 12px 0 0 0;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 4px;
    }
    .stages li {
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 10.5px;
      color: var(--muted);
      letter-spacing: .02em;
    }
    .stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--border);
      flex-shrink: 0;
    }
    .stages li.active { color: var(--vscode-editor-foreground); }
    .stages li.active .stage-dot {
      background: var(--accent);
      animation: stage-blink 1s ease-in-out infinite;
    }
    .stages li.done { color: var(--vscode-editor-foreground); }
    .stages li.done .stage-dot {
      background: var(--vscode-testing-iconPassed, var(--accent));
    }
    .stage-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    @keyframes stage-blink {
      0%, 100% { opacity: 1; }
      50% { opacity: .35; }
    }
    .progress-panel { padding: 10px 11px; }
    .progress-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      margin-bottom: 8px;
      font-size: 11px;
    }
    .progress-meta .progress-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--soft);
      color: var(--muted);
      letter-spacing: .02em;
    }
    .progress-meta .progress-chip.primary {
      border-color: color-mix(in srgb, var(--accent) 60%, transparent);
      color: var(--vscode-editor-foreground);
      background: color-mix(in srgb, var(--accent) 14%, transparent);
    }
    .progress-meta .progress-chip.streak {
      color: var(--vscode-editor-foreground);
    }
    .heatmap {
      display: grid;
      grid-template-columns: repeat(30, 1fr);
      gap: 2px;
    }
    .heatmap-cell {
      aspect-ratio: 1 / 1;
      border-radius: 2px;
      background: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent);
      border: 1px solid transparent;
    }
    .heatmap-cell.completed {
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 70%, transparent);
    }
    .heatmap-cell.missed {
      background: color-mix(in srgb, var(--vscode-errorForeground, #e51400) 38%, transparent);
    }
    .heatmap-cell.current {
      background: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent);
      position: relative;
      z-index: 1;
    }
    .heatmap-legend {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      font-size: 10px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .heatmap-legend span { display: inline-flex; align-items: center; gap: 4px; }
    .heatmap-legend i {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 2px;
    }
    .heatmap-legend .lg-completed { background: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 70%, transparent); }
    .heatmap-legend .lg-current { background: var(--accent); }
    .heatmap-legend .lg-missed { background: color-mix(in srgb, var(--vscode-errorForeground, #e51400) 38%, transparent); }
    .heatmap-legend .lg-pending { background: color-mix(in srgb, var(--vscode-editor-foreground) 8%, transparent); }
    @media (max-width: 320px) {
      .heatmap { grid-template-columns: repeat(20, 1fr); }
    }
    .onboarding-panel {
      border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
      background: color-mix(in srgb, var(--accent) 6%, var(--vscode-editor-background));
    }
    .onboarding-title {
      margin: 0 0 4px;
      font-size: 13px;
      font-weight: 600;
    }
    .onboarding-sub {
      margin: 0 0 10px;
      font-size: 11px;
      color: var(--muted);
      line-height: 1.4;
    }
    .onboarding-steps {
      display: grid;
      gap: 8px;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .onboarding-step {
      display: grid;
      grid-template-columns: 18px 1fr auto;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      font-size: 11px;
    }
    .onboarding-step.done {
      opacity: .65;
    }
    .onboarding-step .step-mark {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1.5px solid var(--border);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      color: var(--muted);
    }
    .onboarding-step.done .step-mark {
      background: var(--vscode-testing-iconPassed, var(--accent));
      border-color: transparent;
      color: #fff;
    }
    .onboarding-step.active .step-mark {
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 700;
    }
    .onboarding-step .step-body strong {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-editor-foreground);
    }
    .onboarding-step .step-body span {
      color: var(--muted);
    }
    .onboarding-step button {
      min-height: 28px;
      padding: 4px 10px;
      font-size: 11px;
    }
    @media (max-width: 320px) {
      .onboarding-step {
        grid-template-columns: 18px 1fr;
      }
      .onboarding-step button {
        grid-column: 1 / -1;
        justify-self: stretch;
      }
    }
    .loop-stepper {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 10px;
      font-size: 11px;
      color: var(--muted);
      flex-wrap: wrap;
    }
    .loop-step {
      padding: 2px 8px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--soft);
      letter-spacing: .02em;
    }
    .loop-step.active {
      border-color: var(--accent);
      color: var(--vscode-button-foreground);
      background: var(--accent);
    }
    .loop-step.done {
      color: var(--vscode-editor-foreground);
      border-color: color-mix(in srgb, var(--vscode-testing-iconPassed, var(--accent)) 70%, transparent);
    }
    .loop-divider { color: var(--border); }
    .diff-card {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 0;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
      margin: 8px 0 12px;
    }
    .diff-side {
      padding: 9px 10px;
    }
    .diff-side + .diff-side {
      border-left: 1px solid var(--border);
    }
    .diff-you { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-errorForeground, #e51400) 8%); }
    .diff-native { background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-testing-iconPassed, #16a34a) 8%); }
    .diff-label {
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .diff-text {
      margin: 0;
      line-height: 1.55;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .diff-removed {
      color: var(--vscode-errorForeground, #e51400);
      text-decoration: line-through;
      text-decoration-thickness: 1px;
      opacity: .85;
    }
    .diff-added {
      color: var(--vscode-testing-iconPassed, #16a34a);
      font-weight: 600;
      background: color-mix(in srgb, var(--vscode-testing-iconPassed, #16a34a) 12%, transparent);
      padding: 0 2px;
      border-radius: 2px;
    }
    @media (max-width: 320px) {
      .diff-card { grid-template-columns: 1fr; }
      .diff-side + .diff-side { border-left: 0; border-top: 1px solid var(--border); }
    }
    .ab-audio {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-bottom: 12px;
    }
    .ab-side { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .ab-side audio { width: 100%; margin: 0; }
    .ab-label { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; }
    @media (max-width: 320px) {
      .ab-audio { grid-template-columns: 1fr; }
    }
    .quick-fix-card {
      border-left: 3px solid var(--accent);
      background: var(--soft);
      padding: 8px 10px;
      border-radius: 0 4px 4px 0;
      margin-bottom: 12px;
    }
    .quick-fix-card p { margin: 4px 0 0; line-height: 1.5; }
    .follow-up-card {
      border: 1px solid color-mix(in srgb, var(--vscode-charts-blue, var(--accent)) 60%, var(--border));
      background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-charts-blue, var(--accent)) 8%);
      border-radius: 6px;
      padding: 10px 12px;
      margin: 12px 0;
    }
    .follow-up-label {
      font-size: 10px;
      letter-spacing: .08em;
      text-transform: uppercase;
      color: var(--vscode-charts-blue, var(--accent));
      font-weight: 700;
    }
    .follow-up-text {
      margin: 4px 0 0;
      font-size: 14px;
      font-weight: 600;
      line-height: 1.45;
    }
    .loop-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      margin-top: 4px;
    }
    .loop-actions button { min-height: 32px; }
    .result-details {
      margin: 10px 0;
      border-top: 1px dashed var(--border);
      padding-top: 8px;
    }
    .result-details summary {
      cursor: pointer;
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .04em;
      text-transform: uppercase;
      margin-bottom: 6px;
      list-style: none;
    }
    .result-details summary::before { content: "▸ "; }
    .result-details[open] summary::before { content: "▾ "; }
    .muted { color: var(--muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
    .chip {
      display: inline-flex;
      align-items: center;
      min-height: 22px;
      padding: 0 8px;
      border: 1px solid var(--border);
      border-radius: 5px;
      background: var(--soft);
      font-size: 11px;
    }
    .row { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
    .field { margin-top: 10px; }
    .label {
      display: block;
      color: var(--muted);
      font-size: 11px;
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    .text {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .recording {
      outline: 2px solid var(--vscode-errorForeground);
      outline-offset: 2px;
    }
    audio { width: 100%; margin-top: 8px; }
    ol, ul { padding-left: 18px; }
    li { margin: 5px 0; line-height: 1.4; }
    code { overflow-wrap: anywhere; }
  </style>
</head>
<body>
  <div class="stack">
    <section class="panel record-panel">
      <div class="record-row">
        <button id="record" class="record-cta" aria-label="Start recording" title="Start recording">
          <span class="record-cta-icon"></span>
        </button>
        <div class="record-meta">
          <div class="record-status" id="status">Ready to record</div>
          <div class="record-meter">
            <span id="timer">00:00</span>
            <canvas id="vu" width="100" height="14"></canvas>
            <button class="ghost" id="refresh" title="Refresh state" aria-label="Refresh state">↻</button>
          </div>
        </div>
      </div>
      <ol class="stages" id="stages" hidden>
        <li data-stage="transcribe"><span class="stage-dot"></span><span class="stage-name">Transcribe</span></li>
        <li data-stage="coach"><span class="stage-dot"></span><span class="stage-name">Coach</span></li>
        <li data-stage="tts"><span class="stage-dot"></span><span class="stage-name">Speak</span></li>
        <li data-stage="save"><span class="stage-dot"></span><span class="stage-name">Save</span></li>
      </ol>
      <audio id="localAudio" controls hidden></audio>
    </section>
    <section class="panel onboarding-panel" id="onboarding" hidden></section>
    <section class="panel progress-panel" id="progress" hidden></section>
    <section class="panel" id="task"></section>
    <section class="panel" id="drill"></section>
    <section class="panel" id="result" hidden></section>
    <section class="panel" id="sessionLog"></section>
    <section class="panel">
      <h3>Source</h3>
      <div id="source" class="chips"></div>
      <div class="row">
        <button class="secondary" id="configureMaterials">GitHub</button>
        <button class="secondary" id="configureGitHubToken">GitHub Token</button>
      </div>
    </section>
    <section class="panel">
      <h3>Providers</h3>
      <div class="field">
        <span class="label">Coach</span>
        <div class="row">
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="mimo">MiMo</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="minimax">MiniMax</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="gemini">Gemini</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="kimi">Kimi</button>
          <button class="secondary" data-provider-setting="coachProvider" data-provider-value="deepseek">DeepSeek</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Speech in</span>
        <div class="row">
          <button class="secondary" data-provider-setting="audioUnderstandingProvider" data-provider-value="openai">OpenAI</button>
          <button class="secondary" data-provider-setting="audioUnderstandingProvider" data-provider-value="gemini">Gemini</button>
          <button class="secondary" data-provider-setting="audioUnderstandingProvider" data-provider-value="mimo">MiMo</button>
        </div>
      </div>
      <div class="field">
        <span class="label">Speech out</span>
        <div class="row">
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="openai">OpenAI</button>
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="gemini">Gemini</button>
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="mimo">MiMo</button>
          <button class="secondary" data-provider-setting="ttsProvider" data-provider-value="minimax">MiniMax</button>
        </div>
      </div>
    </section>
    <section class="panel">
      <h3>Keys</h3>
      <div id="keys" class="chips"></div>
      <div class="row">
        <button class="secondary" data-key="openai">OpenAI</button>
        <button class="secondary" data-key="gemini">Gemini</button>
        <button class="secondary" data-key="minimax">MiniMax</button>
        <button class="secondary" data-key="mimo">MiMo</button>
        <button class="secondary" data-key="kimi">Kimi</button>
        <button class="secondary" data-key="deepseek">DeepSeek</button>
      </div>
    </section>
    <section class="panel">
      <h3>Local</h3>
      <div class="row">
        <button class="secondary" id="completeLocal">Complete</button>
        <button class="secondary" id="openTask">Task Card</button>
        <button class="secondary" id="openFolder">Sessions</button>
      </div>
    </section>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let mediaRecorder = null;
    let stream = null;
    let chunks = [];
    let recorderMode = null;
    let state = null;
    let audioCtx = null;
    let analyser = null;
    let analyserSource = null;
    let vuBuffer = null;
    let vuRaf = null;
    let timerHandle = null;
    let recordingStartedAt = 0;
    const STAGES = ["transcribe", "coach", "tts", "save"];
    const $ = (id) => document.getElementById(id);
    const esc = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

    function isRecording() {
      return recorderMode === "native" || (mediaRecorder && mediaRecorder.state === "recording");
    }

    function startVuMeter(mediaStream) {
      try {
        if (!audioCtx) {
          const Ctx = window.AudioContext || window.webkitAudioContext;
          if (!Ctx) return;
          audioCtx = new Ctx();
        }
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 128;
        analyser.smoothingTimeConstant = 0.78;
        analyserSource = audioCtx.createMediaStreamSource(mediaStream);
        analyserSource.connect(analyser);
        vuBuffer = new Uint8Array(analyser.frequencyBinCount);
        drawVu();
      } catch (error) {
        // Silent: VU is best-effort.
      }
    }

    function drawVu() {
      const canvas = $("vu");
      if (!canvas || !analyser || !vuBuffer) return;
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      analyser.getByteFrequencyData(vuBuffer);
      ctx.clearRect(0, 0, w, h);
      const bars = 18;
      const gap = 1;
      const barWidth = Math.max(1, (w - gap * (bars - 1)) / bars);
      for (let i = 0; i < bars; i += 1) {
        const idx = Math.min(vuBuffer.length - 1, Math.floor((i / bars) * vuBuffer.length));
        const value = vuBuffer[idx] / 255;
        const barHeight = Math.max(1.5, value * h);
        const alpha = 0.3 + value * 0.6;
        ctx.fillStyle = "rgba(229, 20, 0, " + alpha.toFixed(2) + ")";
        ctx.fillRect(i * (barWidth + gap), h - barHeight, barWidth, barHeight);
      }
      vuRaf = requestAnimationFrame(drawVu);
    }

    function stopVuMeter() {
      if (vuRaf) cancelAnimationFrame(vuRaf);
      vuRaf = null;
      if (analyserSource) {
        try { analyserSource.disconnect(); } catch (_) {}
      }
      if (analyser) {
        try { analyser.disconnect(); } catch (_) {}
      }
      analyserSource = null;
      analyser = null;
      vuBuffer = null;
      const canvas = $("vu");
      if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
    }

    function startTimer() {
      recordingStartedAt = Date.now();
      $("timer").textContent = "00:00";
      timerHandle = setInterval(() => {
        const sec = Math.floor((Date.now() - recordingStartedAt) / 1000);
        const m = String(Math.floor(sec / 60)).padStart(2, "0");
        const s = String(sec % 60).padStart(2, "0");
        $("timer").textContent = m + ":" + s;
      }, 250);
    }

    function stopTimer() {
      if (timerHandle) clearInterval(timerHandle);
      timerHandle = null;
    }

    function resetStages() {
      document.querySelectorAll(".stages li").forEach((li) => li.classList.remove("active", "done"));
    }

    function showStages(visible) {
      $("stages").hidden = !visible;
      if (visible) resetStages();
    }

    function setStage(stage, status) {
      const el = document.querySelector('.stages li[data-stage="' + stage + '"]');
      if (!el) return;
      if (status === "active") {
        el.classList.remove("done");
        el.classList.add("active");
      } else if (status === "done") {
        el.classList.remove("active");
        el.classList.add("done");
      }
    }

    function markAllStagesDone() {
      STAGES.forEach((stage) => setStage(stage, "done"));
    }

    function renderState(nextState) {
      state = nextState;
      const next = state.next || {};
      const training = state.training || {};
      const drill = state.drill || {};
      const settings = state.settings || {};
      const assets = next.assets || {};
      renderOnboarding(state);
      renderProgress(state.progress);
      const weekTag = state.progress && state.progress.weekIndex
        ? "Week " + state.progress.weekIndex + " · Day " + state.progress.dayInWeek + "/" + (state.progress.weekTotalDays || 7)
        : "";
      $("task").innerHTML = \`
        <h2>\${esc(next.completion_label || "Current Package")} \${next.package_date ? "· " + esc(next.package_date) : ""}</h2>
        \${weekTag ? '<p class="muted" style="margin: 0 0 8px;">' + esc(weekTag) + '</p>' : ''}
        <div class="chips">
          <span class="chip">\${esc(state.source || "local")} source</span>
          <span class="chip">\${esc(settings.coachProvider || "mimo")} coach</span>
          <span class="chip">\${esc(settings.audioUnderstandingProvider || "openai")} speech in</span>
          <span class="chip">\${esc(settings.ttsProvider || "minimax")} speech out</span>
          <span class="chip">\${esc(next.training_type || "practice")}</span>
        </div>
        <p>\${esc(training.goal || next.goal || "")}</p>
        <p class="muted">\${esc(training.scenario || next.scenario || "")}</p>
        <div class="field"><span class="label">Frames</span>\${frames(training.frames)}</div>
        <div class="field"><span class="label">Audio text</span><p class="text">\${esc(training.clean_tts_text || training.audio_text || next.clean_tts_text || "")}</p></div>
        \${assets.audio_uri ? '<div class="field"><span class="label">Today audio</span><audio controls src="' + esc(assets.audio_uri) + '"></audio></div>' : ''}
      \`;
      $("drill").innerHTML = \`
        <h3>Drill</h3>
        <div class="chips">
          <span class="chip">\${esc(drill.method || "FSI-style drill")}</span>
          \${(drill.primary_tags || []).map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("")}
          \${drill.required_frames ? '<span class="chip">use ' + esc(drill.required_frames) + ' frames</span>' : ''}
        </div>
        <div class="field"><span class="label">Routine</span>\${simpleList(drill.routine_zh)}</div>
        <div class="field"><span class="label">Rounds</span>\${drillRounds(drill.rounds)}</div>
        <div class="field"><span class="label">Shadowing</span>\${shadowing(drill.shadowing_loop)}</div>
        <div class="field"><span class="label">Repair focus</span>\${simpleList(drill.repair_drills)}</div>
      \`;
      $("sessionLog").innerHTML = \`
        <h3>Session Log</h3>
        \${recentSessions(state.recentSessions || [])}
      \`;
      $("source").innerHTML = \`
        <span class="chip">\${esc(state.source || "local")}</span>
        \${state.sourceLabel ? '<span class="chip">' + esc(shortSourceLabel(state.sourceLabel)) + '</span>' : ''}
        <span class="chip">github token: \${state.keys && state.keys.github ? "saved" : "missing"}</span>
      \`;
      $("keys").innerHTML = ["openai", "gemini", "minimax", "mimo", "kimi", "deepseek"].map((name) => {
        const ok = state.keys && state.keys[name];
        return \`<span class="chip">\${name}: \${ok ? "saved" : "missing"}</span>\`;
      }).join("");
      document.querySelectorAll("[data-provider-setting]").forEach((button) => {
        const setting = button.dataset.providerSetting;
        const value = button.dataset.providerValue;
        const active = settings && settings[setting] === value;
        button.classList.toggle("active", Boolean(active));
      });
    }

    function renderOnboarding(currentState) {
      const panel = $("onboarding");
      if (!panel) return;
      const keys = (currentState && currentState.keys) || {};
      const providerNames = ["openai", "gemini", "minimax", "mimo", "kimi", "deepseek"];
      const hasAnyProviderKey = providerNames.some((name) => keys[name]);
      const source = currentState && currentState.source;
      const sourceLabel = currentState && currentState.sourceLabel;
      const sourceConfigured = Boolean(sourceLabel) || source === "local";
      const githubReady = source === "github" ? Boolean(keys.github) : true;
      const progress = currentState && currentState.progress;
      const hasLessons = Boolean(progress && progress.total && progress.total > 0);
      const allDone = hasAnyProviderKey && sourceConfigured && githubReady && hasLessons;
      if (allDone) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      const sourceStep = sourceConfigured
        ? { state: "done", title: "Source connected", hint: source === "github" ? "GitHub materials linked" : "Local prebuilt folder", action: "" }
        : { state: "active", title: "Pick where lessons live", hint: "Local folder or GitHub repo", action: '<button class="primary" data-onboard="source">Connect</button>' };
      const githubTokenStep = source === "github"
        ? (keys.github
            ? { state: "done", title: "GitHub token saved", hint: "Private repo access ready", action: "" }
            : { state: "active", title: "Add GitHub token", hint: "Needed for private repos", action: '<button class="secondary" data-onboard="github-token">Add token</button>' })
        : null;
      const lessonStep = hasLessons
        ? { state: "done", title: "Lesson library ready", hint: progress.total + " lesson" + (progress.total === 1 ? "" : "s") + " in prebuilt/", action: "" }
        : (source === "github"
            ? { state: "active", title: "Add lessons to your repo", hint: "Push prebuilt/<date>/english-training.json", action: '<button class="secondary" data-onboard="materials-guide">View guide</button>' }
            : { state: "active", title: "Create your first lesson", hint: "Writes a starter prebuilt/<today>/english-training.json", action: '<button class="primary" data-onboard="create-sample">Create sample</button>' });
      const keyStep = hasAnyProviderKey
        ? { state: "done", title: "AI provider ready", hint: "At least one provider key saved", action: "" }
        : { state: "active", title: "Add your first AI key", hint: "MiMo, OpenAI, Gemini, MiniMax, Kimi, or DeepSeek", action: '<button class="primary" data-onboard="provider-key">Set up</button>' };
      const steps = [sourceStep, githubTokenStep, lessonStep, keyStep].filter(Boolean);
      const renderedSteps = steps.map((step, idx) => {
        const mark = step.state === "done" ? "✓" : String(idx + 1);
        return \`
          <li class="onboarding-step \${step.state}">
            <span class="step-mark">\${mark}</span>
            <span class="step-body"><strong>\${esc(step.title)}</strong><span>\${esc(step.hint)}</span></span>
            \${step.action || '<span></span>'}
          </li>
        \`;
      }).join("");
      panel.hidden = false;
      panel.innerHTML = \`
        <p class="onboarding-title">Quick setup</p>
        <p class="onboarding-sub">Two minutes to your first practice loop.</p>
        <ol class="onboarding-steps">\${renderedSteps}</ol>
      \`;
    }

    function renderProgress(progress) {
      const panel = $("progress");
      if (!panel) return;
      if (!progress || !Array.isArray(progress.cells) || progress.cells.length === 0) {
        panel.hidden = true;
        panel.innerHTML = "";
        return;
      }
      panel.hidden = false;
      const total = progress.total || progress.cells.length;
      const dayLabel = progress.currentIndex
        ? "Day " + progress.currentIndex + " / " + total
        : (progress.completedCount || 0) + " / " + total + " completed";
      const weekLabel = progress.weekIndex
        ? "Week " + progress.weekIndex + " · " + (progress.weekCompletedDays || 0) + "/" + (progress.weekTotalDays || 7)
        : "";
      const streakLabel = progress.streak && progress.streak > 0
        ? "🔥 " + progress.streak + "-day streak"
        : "";
      const cells = progress.cells.map((cell) => {
        const status = cell && cell.status ? cell.status : "pending";
        const date = cell && cell.date ? cell.date : "";
        return '<div class="heatmap-cell ' + esc(status) + '" title="' + esc(date) + ' · ' + esc(status) + '"></div>';
      }).join("");
      panel.innerHTML = \`
        <div class="progress-meta">
          <span class="progress-chip primary">\${esc(dayLabel)}</span>
          \${weekLabel ? '<span class="progress-chip">' + esc(weekLabel) + '</span>' : ''}
          \${streakLabel ? '<span class="progress-chip streak">' + esc(streakLabel) + '</span>' : ''}
        </div>
        <div class="heatmap" role="img" aria-label="\${esc(dayLabel)}">\${cells}</div>
        <div class="heatmap-legend" aria-hidden="true">
          <span><i class="lg-completed"></i>done</span>
          <span><i class="lg-current"></i>today</span>
          <span><i class="lg-missed"></i>missed</span>
          <span><i class="lg-pending"></i>upcoming</span>
        </div>
      \`;
    }

    function frames(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No frames.</p>';
      return '<ol>' + value.map((item) => '<li>' + esc((item && item.text) || item) + '</li>').join("") + '</ol>';
    }

    function simpleList(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No items.</p>';
      return '<ul>' + value.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>';
    }

    function drillRounds(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No drill rounds.</p>';
      return value.map((round) => {
        const examples = Array.isArray(round.examples) ? round.examples : [];
        return \`
          <div class="field">
            <strong>\${esc(round.label || round.id || "Round")}</strong>
            \${round.base_frame ? '<p class="text">' + esc(round.base_frame) + '</p>' : ''}
            \${examples.length ? '<ol>' + examples.map((item) => '<li><span class="muted">' + esc(item.cue || item.label || "") + '</span> ' + esc(item.text || item) + '</li>').join("") + '</ol>' : ''}
          </div>
        \`;
      }).join("");
    }

    function shadowing(value) {
      const chunks = value && Array.isArray(value.chunks) ? value.chunks : [];
      if (!chunks.length) return '<p class="muted">No shadowing chunks.</p>';
      return '<p class="muted">' + esc(value.instruction_zh || "Shadow each chunk twice.") + '</p><ol>' + chunks.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ol>';
    }

    function recentSessions(value) {
      if (!Array.isArray(value) || value.length === 0) return '<p class="muted">No VS Code sessions yet.</p>';
      return value.map((item) => \`
        <div class="field">
          <strong>\${esc(item.package_date || item.packageDate || "session")}</strong>
          <span class="muted"> · \${esc(item.created_at || item.createdAt || "")}</span>
          \${Array.isArray(item.error_tags) && item.error_tags.length ? '<div class="chips">' + item.error_tags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>' : ''}
          <p class="text">\${esc(item.native_version || item.nativeVersion || item.progress_note || "")}</p>
        </div>
      \`).join("");
    }

    function shortSourceLabel(value) {
      const text = String(value || "");
      return text.length > 46 ? text.slice(0, 21) + "..." + text.slice(-20) : text;
    }

    function setStatus(text, tone) {
      const el = $("status");
      el.textContent = text;
      el.classList.remove("busy", "error");
      if (tone === "busy") el.classList.add("busy");
      if (tone === "error") el.classList.add("error");
    }

    function setRecording(active) {
      const btn = $("record");
      btn.classList.toggle("recording", active);
      btn.setAttribute("aria-label", active ? "Stop recording" : "Start recording");
      btn.setAttribute("title", active ? "Stop recording" : "Start recording");
    }

    function setBusy(active, label) {
      const btn = $("record");
      btn.classList.toggle("busy", active);
      btn.disabled = active;
      if (label) setStatus(label, active ? "busy" : undefined);
    }

    async function startRecording() {
      if (!navigator.mediaDevices || !window.MediaRecorder) {
        startNativeRecording("Webview recorder unavailable.");
        return;
      }
      chunks = [];
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type));
        mediaRecorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
        mediaRecorder.ondataavailable = (event) => {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        };
        mediaRecorder.onstop = async () => {
          const mimeType = mediaRecorder.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: mimeType });
          $("localAudio").src = URL.createObjectURL(blob);
          $("localAudio").hidden = false;
          stopVuMeter();
          stopTimer();
          setRecording(false);
          setBusy(true, "Sending to coach…");
          showStages(true);
          const base64 = await blobToBase64(blob);
          vscode.postMessage({ type: "practiceAudio", mimeType, base64 });
          if (stream) stream.getTracks().forEach((track) => track.stop());
        };
        recorderMode = "webview";
        mediaRecorder.start();
        setRecording(true);
        setStatus("Listening… speak now.");
        startVuMeter(stream);
        startTimer();
      } catch (error) {
        startNativeRecording((error && error.message) || String(error));
      }
    }

    function stopRecording() {
      if (recorderMode === "native") {
        vscode.postMessage({ type: "stopNativeRecording" });
        setRecording(false);
        stopTimer();
        setBusy(true, "Stopping native recorder…");
        recorderMode = null;
        return;
      }
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
      }
    }

    function toggleRecording() {
      if (isRecording()) {
        stopRecording();
      } else {
        setLoopStep("speak");
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    }

    function startNativeRecording(reason) {
      recorderMode = "native";
      setRecording(true);
      setStatus((reason ? reason + " " : "") + "Using native ffmpeg recorder…");
      startTimer();
      vscode.postMessage({ type: "startNativeRecording" });
    }

    function blobToBase64(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      });
    }

    function normalizeWord(word) {
      return String(word || "").toLowerCase().replace(/[^a-z0-9']/gi, "");
    }

    function wordDiff(left, right) {
      const a = (String(left || "").match(/\\S+/g)) || [];
      const b = (String(right || "").match(/\\S+/g)) || [];
      const m = a.length;
      const n = b.length;
      const dp = [];
      for (let i = 0; i <= m; i += 1) {
        dp.push(new Array(n + 1).fill(0));
      }
      for (let i = 0; i < m; i += 1) {
        for (let j = 0; j < n; j += 1) {
          if (normalizeWord(a[i]) && normalizeWord(a[i]) === normalizeWord(b[j])) {
            dp[i + 1][j + 1] = dp[i][j] + 1;
          } else {
            dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
          }
        }
      }
      const leftMarks = new Array(m).fill("removed");
      const rightMarks = new Array(n).fill("added");
      let i = m;
      let j = n;
      while (i > 0 && j > 0) {
        if (normalizeWord(a[i - 1]) && normalizeWord(a[i - 1]) === normalizeWord(b[j - 1])) {
          leftMarks[i - 1] = "common";
          rightMarks[j - 1] = "common";
          i -= 1;
          j -= 1;
        } else if (dp[i - 1][j] >= dp[i][j - 1]) {
          i -= 1;
        } else {
          j -= 1;
        }
      }
      return {
        left: a.map((word, k) => ({ word, mark: leftMarks[k] })),
        right: b.map((word, k) => ({ word, mark: rightMarks[k] })),
      };
    }

    function renderDiffSide(items) {
      if (!items.length) return '<span class="muted">—</span>';
      return items.map(({ word, mark }) => {
        const safe = esc(word);
        if (mark === "removed") return '<span class="diff-removed">' + safe + '</span>';
        if (mark === "added") return '<span class="diff-added">' + safe + '</span>';
        return safe;
      }).join(" ");
    }

    let loopStep = "speak";

    function setLoopStep(step) {
      loopStep = step;
      document.querySelectorAll(".loop-step").forEach((el) => {
        const stepName = el.dataset.step;
        el.classList.remove("active", "done");
        if (stepName === step) {
          el.classList.add("active");
        } else if ((step === "imitate" && stepName === "speak") ||
                   (step === "reply" && (stepName === "speak" || stepName === "imitate"))) {
          el.classList.add("done");
        }
      });
    }

    function renderResult(result) {
      const diff = wordDiff(result.transcript, result.nativeVersion);
      const userAudioSrc = (result && result.localAudioUri) || ($("localAudio").src || "");
      const nativeAudioSrc = (result && result.audioUri) || "";
      const tagsHtml = Array.isArray(result.errorTags) && result.errorTags.length
        ? '<div class="chips">' + result.errorTags.map((tag) => '<span class="chip">' + esc(tag) + '</span>').join("") + '</div>'
        : '<p class="muted">No tags.</p>';
      const problemsHtml = Array.isArray(result.problems) && result.problems.length
        ? '<ul>' + result.problems.map((item) => '<li>' + esc(item) + '</li>').join("") + '</ul>'
        : '<p class="muted">No specific problems.</p>';

      $("result").hidden = false;
      $("result").innerHTML = \`
        <h3>Coaching</h3>
        <div class="loop-stepper">
          <span class="loop-step done" data-step="speak">① Speak</span>
          <span class="loop-divider">→</span>
          <span class="loop-step\${loopStep === "imitate" ? " active" : ""}" data-step="imitate">② Imitate</span>
          <span class="loop-divider">→</span>
          <span class="loop-step\${loopStep === "reply" ? " active" : ""}" data-step="reply">③ Reply</span>
        </div>
        <div class="diff-card">
          <div class="diff-side diff-you">
            <div class="diff-label">You said</div>
            <p class="diff-text">\${renderDiffSide(diff.left)}</p>
          </div>
          <div class="diff-side diff-native">
            <div class="diff-label">Native says</div>
            <p class="diff-text">\${renderDiffSide(diff.right)}</p>
          </div>
        </div>
        <div class="ab-audio">
          <div class="ab-side">
            <span class="ab-label muted">Your audio</span>
            \${userAudioSrc ? '<audio controls src="' + esc(userAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
          <div class="ab-side">
            <span class="ab-label muted">Native audio</span>
            \${nativeAudioSrc ? '<audio controls src="' + esc(nativeAudioSrc) + '"></audio>' : '<span class="muted">—</span>'}
          </div>
        </div>
        \${result.quickFix ? '<div class="quick-fix-card"><span class="label">Quick fix</span><p>' + esc(result.quickFix) + '</p></div>' : ''}
        \${result.followUpQuestion ? '<div class="follow-up-card"><span class="follow-up-label">Follow-up</span><p class="follow-up-text">' + esc(result.followUpQuestion) + '</p></div>' : ''}
        <div class="loop-actions">
          <button data-loop-action="imitate">Imitate this</button>
          \${result.followUpQuestion ? '<button class="secondary" data-loop-action="reply">Answer follow-up</button>' : ''}
        </div>
        <details class="result-details">
          <summary>More details</summary>
          <div class="field"><span class="label">Problems</span>\${problemsHtml}</div>
          <div class="field"><span class="label">Tags</span>\${tagsHtml}</div>
          \${result.shadowingInstruction ? '<div class="field"><span class="label">Repeat</span><p class="text">' + esc(result.shadowingInstruction) + '</p></div>' : ''}
          \${result.nextDrill ? '<div class="field"><span class="label">Next drill</span><p class="text">' + esc(result.nextDrill) + '</p></div>' : ''}
          <div class="field"><span class="label">Session folder</span><code>\${esc(result.sessionDir)}</code></div>
        </details>
      \`;
    }

    $("record").addEventListener("click", toggleRecording);
    $("refresh").addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    document.addEventListener("click", (event) => {
      const trigger = event.target.closest && event.target.closest("[data-loop-action]");
      if (!trigger) return;
      const action = trigger.dataset.loopAction;
      if (action !== "imitate" && action !== "reply") return;
      setLoopStep(action);
      const cta = $("record");
      if (cta && typeof cta.scrollIntoView === "function") {
        cta.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      if (!isRecording()) {
        startRecording().catch((error) => setStatus(error.message || String(error), "error"));
      }
    });
    document.addEventListener("click", (event) => {
      const trigger = event.target.closest && event.target.closest("[data-onboard]");
      if (!trigger) return;
      const action = trigger.dataset.onboard;
      if (action === "source") {
        vscode.postMessage({ type: "command", command: "configureMaterials" });
      } else if (action === "github-token") {
        vscode.postMessage({ type: "command", command: "configureGitHubToken" });
      } else if (action === "provider-key") {
        vscode.postMessage({ type: "command", command: "setupProviderKey" });
      } else if (action === "create-sample") {
        vscode.postMessage({ type: "command", command: "createSamplePackage" });
      } else if (action === "materials-guide") {
        vscode.postMessage({ type: "command", command: "openMaterialsGuide" });
      }
    });
    $("completeLocal").addEventListener("click", () => vscode.postMessage({ type: "completeLocal" }));
    $("configureMaterials").addEventListener("click", () => vscode.postMessage({ type: "command", command: "configureMaterials" }));
    $("configureGitHubToken").addEventListener("click", () => vscode.postMessage({ type: "command", command: "configureGitHubToken" }));
    $("openTask").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openTask" }));
    $("openFolder").addEventListener("click", () => vscode.postMessage({ type: "command", command: "openSessionFolder" }));
    document.querySelectorAll("[data-key]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({ type: "configureKey", provider: button.dataset.key }));
    });
    document.querySelectorAll("[data-provider-setting]").forEach((button) => {
      button.addEventListener("click", () => vscode.postMessage({
        type: "setProvider",
        setting: button.dataset.providerSetting,
        value: button.dataset.providerValue,
      }));
    });

    window.addEventListener("message", (event) => {
      const message = event.data || {};
      if (message.type === "state") renderState(message.state);
      if (message.type === "busy") setStatus(message.message || "Working…", "busy");
      if (message.type === "nativeRecordingStarted") {
        setStatus("Listening… speak now.");
      }
      if (message.type === "stage") {
        if (message.show) showStages(true);
        if (message.stage) setStage(message.stage, message.status || "active");
      }
      if (message.type === "practiceResult") {
        markAllStagesDone();
        setBusy(false);
        setStatus("Ready ✓");
        recorderMode = null;
        if (message.result && message.result.localAudioUri) {
          $("localAudio").src = message.result.localAudioUri;
          $("localAudio").hidden = false;
        }
        renderResult(message.result);
        setTimeout(() => showStages(false), 1500);
      }
      if (message.type === "error") {
        if (recorderMode === "native") {
          recorderMode = null;
          setRecording(false);
        }
        stopVuMeter();
        stopTimer();
        setBusy(false);
        showStages(false);
        setStatus(message.message || "Error.", "error");
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function toWebviewState(webview: vscode.Webview, state: TrainingState): JsonObject {
  const next = { ...state.next };
  const assets = { ...((next.assets as JsonObject | undefined) ?? {}) };
  for (const [key, value] of Object.entries(assets)) {
    const filePath = stringValue(value);
    if (isHttpUrl(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      assets[`${key}_uri`] = filePath;
    } else if (filePath && fs.existsSync(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      assets[`${key}_uri`] = webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
    }
  }
  next.assets = assets;
  return {
    ...state,
    next,
  };
}

async function processPracticeAudio(
  context: vscode.ExtensionContext,
  message: WebviewAudioMessage,
  progress?: StageReporter,
): Promise<PracticeResult> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const inputExt = extensionFromMime(message.mimeType);
  const inputPath = path.join(sessionDir, `input.${inputExt}`);
  const audioBuffer = Buffer.from(message.base64, "base64");
  fs.writeFileSync(inputPath, audioBuffer);
  return processPracticeFile(context, inputPath, message.mimeType, sessionDir, packageDate, progress);
}

async function startNativeFfmpegRecording(context: vscode.ExtensionContext): Promise<NativeRecordingSession> {
  if (nativeRecording) {
    throw new Error("Native recorder is already running.");
  }
  if (process.platform !== "darwin") {
    throw new Error("Native recorder fallback currently supports macOS AVFoundation only.");
  }

  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const filePath = path.join(sessionDir, "native-input.wav");
  const ffmpegPath = resolveFfmpegPath();
  const device = (config<string>("nativeRecorderFfmpegAudioDevice") || "0").trim() || "0";
  const args = [
    "-y",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "avfoundation",
    "-i",
    `:${device}`,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-sample_fmt",
    "s16",
    filePath,
  ];

  const stderr: string[] = [];
  let spawnError: Error | undefined;
  const child = cp.spawn(ffmpegPath, args, { stdio: ["pipe", "pipe", "pipe"] }) as cp.ChildProcessWithoutNullStreams;
  const session: NativeRecordingSession = {
    process: child,
    filePath,
    sessionDir,
    packageDate,
    startedAt: Date.now(),
    stderr,
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (text.trim()) {
      output.appendLine(text.trim());
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr.push(text);
    if (text.trim()) {
      output.appendLine(text.trim());
    }
  });
  child.on("error", (error) => {
    spawnError = error;
    stderr.push(error.message);
    if (nativeRecording === session) {
      nativeRecording = undefined;
    }
  });
  child.on("exit", (code, signal) => {
    if (nativeRecording === session) {
      nativeRecording = undefined;
    }
    output.appendLine(`Native ffmpeg recorder exited with code=${code ?? "null"} signal=${signal ?? "null"}.`);
  });

  nativeRecording = session;
  output.appendLine(`Starting native recorder: ${ffmpegPath} ${args.join(" ")}`);
  await delay(900);
  if (spawnError) {
    nativeRecording = undefined;
    throw new Error(`Native recorder failed to start: ${spawnError.message}`);
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    nativeRecording = undefined;
    throw new Error(nativeRecorderError(session, "Native recorder exited before it could start."));
  }

  return session;
}

async function stopNativeFfmpegRecording(): Promise<NativeRecordingSession> {
  const session = nativeRecording;
  if (!session) {
    throw new Error("Native recorder is not running.");
  }
  nativeRecording = undefined;

  const child = session.process;
  if (child.exitCode === null && child.signalCode === null) {
    try {
      if (!child.stdin.destroyed && child.stdin.writable) {
        child.stdin.write("q\n");
      }
    } catch {
      // Fall through to signal-based shutdown.
    }
  }

  let exited = await waitForExit(child, 2500);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGINT");
    exited = await waitForExit(child, 1500);
  }
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await waitForExit(child, 1000);
  }

  await delay(150);
  let size = 0;
  try {
    size = fs.statSync(session.filePath).size;
  } catch {
    size = 0;
  }
  if (size < 1000) {
    throw new Error(nativeRecorderError(session, "Native recorder did not produce a usable audio file."));
  }
  output.appendLine(`Native recording saved: ${session.filePath} (${size} bytes, ${Math.round((Date.now() - session.startedAt) / 1000)}s)`);
  return session;
}

function resolveFfmpegPath(): string {
  const configured = (config<string>("nativeRecorderFfmpegPath") || "ffmpeg").trim() || "ffmpeg";
  if (configured.includes("/") || configured.includes("\\")) {
    return configured;
  }
  for (const candidate of ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg"]) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return configured;
}

function nativeRecorderError(session: NativeRecordingSession, summary: string): string {
  const detail = session.stderr.join("").trim();
  const hint = `Check macOS microphone permission for VS Code/ffmpeg, or set englishTraining.nativeRecorderFfmpegAudioDevice after running: ffmpeg -f avfoundation -list_devices true -i ""`;
  return `${summary}${detail ? `\n${detail.slice(0, 1200)}` : ""}\n${hint}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child: cp.ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
      child.off("error", onExit);
    };
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    child.once("exit", onExit);
    child.once("error", onExit);
  });
}

async function processPracticeFile(
  context: vscode.ExtensionContext,
  inputPath: string,
  mimeType: string,
  sessionDir: string,
  packageDate: string,
  progress?: StageReporter,
): Promise<PracticeResult> {
  const state = await loadState(context);

  progress?.("transcribe", "active");
  const transcript = await transcribeAudio(context, inputPath, mimeType, sessionDir);
  fs.writeFileSync(path.join(sessionDir, "transcript.txt"), `${transcript}\n`, "utf8");
  progress?.("transcribe", "done");

  progress?.("coach", "active");
  const coaching = await coachTranscript(context, state, transcript);
  const nativeVersion = stringValue(coaching.native_version) || stringValue(coaching.nativeVersion) || transcript;
  const problems = arrayOfStrings(coaching.problems).slice(0, 3);
  const quickFix = stringValue(coaching.quick_fix) || stringValue(coaching.quickFix);
  const followUpQuestion = stringValue(coaching.follow_up_question) || stringValue(coaching.followUpQuestion);
  const shadowingInstruction = stringValue(coaching.shadowing_instruction) || stringValue(coaching.shadowingInstruction) || `Repeat once: ${nativeVersion}`;
  const errorTags = normalizeErrorTags(coaching.error_tags ?? coaching.errorTags);
  const nextDrill = stringValue(coaching.next_drill) || stringValue(coaching.nextDrill) || nextDrillFromState(state, errorTags);
  const scores = ((coaching.scores as JsonObject | undefined) ?? {}) as JsonObject;
  progress?.("coach", "done");

  progress?.("tts", "active");
  const ttsProvider = config<string>("ttsProvider") || "minimax";
  const outputAudio = path.join(sessionDir, speechOutputFileName(ttsProvider));
  let audioFile: string | undefined;
  if (nativeVersion.trim()) {
    if (ttsProvider === "gemini") {
      audioFile = await synthesizeGemini(context, nativeVersion, outputAudio);
    } else if (ttsProvider === "mimo") {
      audioFile = await synthesizeMiMo(context, nativeVersion, outputAudio);
    } else if (ttsProvider === "openai") {
      audioFile = await synthesizeOpenAI(context, nativeVersion, outputAudio);
    } else {
      audioFile = await synthesizeMiniMax(context, nativeVersion, outputAudio);
    }
  }
  progress?.("tts", "done");

  progress?.("save", "active");
  const result: PracticeResult = {
    transcript,
    nativeVersion,
    problems,
    quickFix,
    followUpQuestion,
    shadowingInstruction,
    errorTags,
    nextDrill,
    scores,
    audioFile,
    sessionDir,
    packageDate,
  };
  writeJson(path.join(sessionDir, "coach.json"), coaching);
  writeJson(path.join(sessionDir, "session.json"), {
    createdAt: new Date().toISOString(),
    packageDate,
    input: inputPath,
    result,
    settings: state.settings,
    drill: state.drill,
  });
  writeSessionMarkdown(path.join(sessionDir, "session.md"), state, result);
  appendSessionLog(state, inputPath, result, coaching);
  progress?.("save", "done");
  return result;
}

function appendSessionLog(state: TrainingState, inputPath: string, result: PracticeResult, coaching: JsonObject): void {
  const entry = {
    schema_version: "vscode-session-log-v1",
    session_id: path.basename(result.sessionDir),
    created_at: new Date().toISOString(),
    date: state.today,
    package_date: result.packageDate,
    engine_type: "voice-5min",
    training_type: stringValue(state.training.training_type),
    scene: inferScene(state.training),
    primary_tags: arrayOfStrings(state.training.primary_tags),
    drill_types_used: drillTypesUsed(state),
    providers: {
      speech_in: state.settings.audioUnderstandingProvider,
      coach: state.settings.coachProvider,
      speech_out: state.settings.ttsProvider,
    },
    input_audio: inputPath,
    transcript: result.transcript,
    native_version: result.nativeVersion,
    problems: result.problems,
    error_tags: result.errorTags,
    scores: result.scores,
    quick_fix: result.quickFix,
    follow_up_question: result.followUpQuestion,
    shadowing_instruction: result.shadowingInstruction,
    next_drill: result.nextDrill,
    audio_file: result.audioFile,
    session_dir: result.sessionDir,
    raw_coaching: coaching,
  };
  const logPath = sessionLogPath(state.root);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  writeJson(path.join(state.root, "runtime", "vscode-sessions", "session-log-latest.json"), entry);
}

function readRecentSessionLog(root: string, limit: number): JsonObject[] {
  const logPath = sessionLogPath(root);
  if (!fs.existsSync(logPath)) {
    return [];
  }
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/).filter(Boolean);
  const recent: JsonObject[] = [];
  for (const line of lines.slice(-limit).reverse()) {
    try {
      recent.push(JSON.parse(line) as JsonObject);
    } catch {
      continue;
    }
  }
  return recent;
}

function sessionLogPath(root: string): string {
  return path.join(root, "runtime", "vscode-sessions", "session-log.jsonl");
}

function inferScene(training: JsonObject): string {
  const scenario = `${stringValue(training.scenario)} ${stringValue(training.goal)}`.toLowerCase();
  if (scenario.includes("conference") || scenario.includes("workshop") || scenario.includes("seminar") || scenario.includes("q&a")) {
    return "S1";
  }
  if (scenario.includes("coffee") || scenario.includes("professor") || scenario.includes("network")) {
    return "S2";
  }
  return "S3";
}

function drillTypesUsed(state: TrainingState): string[] {
  const method = stringValue(state.drill.method).toLowerCase();
  const used = new Set<string>();
  if (method.includes("substitution")) used.add("Substitution");
  if (method.includes("shadow")) used.add("Shadowing");
  const type = stringValue(state.training.training_type);
  if (type) used.add(type);
  if (used.size === 0) used.add("Voice-mode Free Chat");
  return Array.from(used);
}

function normalizeErrorTags(value: unknown): string[] {
  const allowed = new Set(["[TA]", "[ART]", "[COUNT]", "[REF]", "[ORG]", "[LINK]", "[PRAG]", "[PROS]"]);
  return arrayOfStrings(value)
    .map((tag) => tag.trim().toUpperCase())
    .filter((tag) => allowed.has(tag))
    .slice(0, 3);
}

function nextDrillFromState(state: TrainingState, errorTags: string[]): string {
  const frames = Array.isArray(state.training.frames)
    ? state.training.frames.map((item) => stringValue((item as JsonObject).text)).filter(Boolean)
    : [];
  const frame = frames[0] || splitPracticeText(stringValue(state.training.clean_tts_text) || stringValue(state.training.audio_text))[0] || "";
  const tagText = errorTags.length ? ` targeting ${errorTags.join(", ")}` : "";
  return frame
    ? `Do one FSI substitution loop${tagText}: repeat "${frame}", then replace one key phrase and say the full sentence again.`
    : `Do one FSI substitution loop${tagText}: keep the sentence frame stable and replace one slot quickly.`;
}

function splitPracticeText(text: string): string[] {
  return text
    .replace(/<#\d+(?:\.\d+)?#>/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

async function prepareInlineAudio(audioPath: string, mimeType: string, sessionDir: string): Promise<{ filePath: string; mimeType: string; base64: string }> {
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

function convertAudioToWav(inputPath: string, outPath: string): Promise<void> {
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

function speechOutputFileName(provider: string): string {
  return provider === "gemini" || provider === "mimo" ? "native-version.wav" : "native-version.mp3";
}

function createSessionDir(root: string, packageDate: string): string {
  const dir = path.join(root, "runtime", "vscode-sessions", packageDate, stamp());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("mp4")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
  return "webm";
}

async function transcribeAudio(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const provider = config<string>("audioUnderstandingProvider") || "openai";
  if (provider === "gemini") {
    return transcribeWithGemini(context, audioPath, mimeType, sessionDir);
  }
  if (provider === "mimo") {
    return transcribeWithMiMo(context, audioPath, mimeType, sessionDir);
  }
  return transcribeWithOpenAI(context, audioPath, mimeType);
}

async function transcribeWithOpenAI(context: vscode.ExtensionContext, audioPath: string, mimeType: string): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiTranscriptionModel") || "gpt-4o-transcribe";
  const file = new Blob([fs.readFileSync(audioPath)], { type: mimeType || "audio/webm" });
  const form = new FormData();
  form.append("file", file, path.basename(audioPath));
  form.append("model", model);
  form.append("language", "en");
  form.append("response_format", "json");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`OpenAI transcription failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const text = stringValue(parsed.text);
  if (!text.trim()) {
    throw new Error("OpenAI transcription returned empty text.");
  }
  return text.trim();
}

async function transcribeWithGemini(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiAudioUnderstandingModel") || "gemini-2.5-flash";
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            {
              inlineData: {
                mimeType: audio.mimeType,
                data: audio.base64,
              },
            },
            {
              text: "Transcribe this spoken English audio. Return only the transcript text, without commentary.",
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini audio understanding failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const text = extractGeminiText(JSON.parse(body) as JsonObject).trim();
  if (!text) {
    throw new Error("Gemini audio understanding returned empty text.");
  }
  return text;
}

async function transcribeWithMiMo(
  context: vscode.ExtensionContext,
  audioPath: string,
  mimeType: string,
  sessionDir: string,
): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const audio = await prepareInlineAudio(audioPath, mimeType, sessionDir);
  const response = await fetch(chatCompletionsUrl(config<string>("mimoChatBaseUrl") || "https://token-plan-cn.xiaomimimo.com/v1"), {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("mimoAudioUnderstandingModel") || "mimo-v2.5",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: `data:${audio.mimeType};base64,${audio.base64}`,
              },
            },
            {
              type: "text",
              text: "Transcribe this spoken English audio. Return only the transcript text, without commentary.",
            },
          ],
        },
      ],
      stream: false,
      temperature: 0,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo audio understanding failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const text = extractOpenAIText(JSON.parse(body) as JsonObject).trim();
  if (!text) {
    throw new Error("MiMo audio understanding returned empty text.");
  }
  return text;
}

async function coachTranscript(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const provider = config<string>("coachProvider") || "mimo";
  if (provider === "gemini") {
    return coachWithGemini(context, state, transcript);
  }
  if (provider === "minimax") {
    return coachWithMiniMax(context, state, transcript);
  }
  if (provider === "kimi") {
    return coachWithKimi(context, state, transcript);
  }
  if (provider === "deepseek") {
    return coachWithDeepSeek(context, state, transcript);
  }
  if (provider === "openai") {
    return coachWithOpenAI(context, state, transcript);
  }
  return coachWithMiMo(context, state, transcript);
}

function coachingSystemPrompt(): string {
  return [
    "You are an English speaking coach for a Chinese legal academic.",
    "Return strict JSON only.",
    "Focus on natural spoken academic English, not generic encouragement.",
    "Give one native speaker version, 1-2 concrete problems, one quick fix, one shadowing instruction, and one specific follow-up question.",
    "Explanations may be in Chinese, but native_version and follow_up_question must be natural English.",
  ].join(" ");
}

function coachingUserPrompt(state: TrainingState, transcript: string): string {
  const training = state.training;
  const frames = Array.isArray(training.frames)
    ? training.frames.map((item) => (typeof item === "object" && item ? stringValue((item as JsonObject).text) : stringValue(item))).filter(Boolean)
    : [];
  return JSON.stringify({
    task: {
      package_date: stringValue(state.next.package_date),
      goal: stringValue(training.goal) || stringValue(state.next.goal),
      scenario: stringValue(training.scenario) || stringValue(state.next.scenario),
      frames,
    },
    user_transcript: transcript,
    output_shape: {
      native_version: "one natural spoken English version of what the user meant",
      problems: ["1-2 concrete issues in Chinese, with tiny English examples if useful"],
      error_tags: ["0-3 of [TA], [ART], [COUNT], [REF], [ORG], [LINK], [PRAG], [PROS]"],
      scores: {
        fluency: "integer 1-5",
        accuracy: "integer 1-5",
        naturalness: "integer 1-5",
      },
      quick_fix: "one practical fix in Chinese",
      shadowing_instruction: "short instruction asking user to repeat the native version once",
      follow_up_question: "one specific English follow-up question",
      next_drill: "one short FSI-style drill instruction for the next repetition",
    },
  }, null, 2);
}

async function coachWithOpenAI(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "openai");
  const model = config<string>("openaiCoachModel") || "gpt-4o-mini";
  const input = [
    { role: "system", content: coachingSystemPrompt() },
    { role: "user", content: coachingUserPrompt(state, transcript) },
  ];

  const responsesBody = {
    model,
    input,
    text: { format: { type: "json_object" } },
  };
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(responsesBody),
  });
  const body = await response.text();
  if (response.ok) {
    return parseLooseJson(extractOpenAIText(JSON.parse(body) as JsonObject));
  }

  output.appendLine(`OpenAI Responses API failed, falling back to chat completions: ${body.slice(0, 600)}`);
  const fallback = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: input,
      response_format: { type: "json_object" },
    }),
  });
  const fallbackBody = await fallback.text();
  if (!fallback.ok) {
    throw new Error(`OpenAI coaching failed (${fallback.status}): ${fallbackBody.slice(0, 1200)}`);
  }
  return parseLooseJson(extractOpenAIText(JSON.parse(fallbackBody) as JsonObject));
}

async function coachWithMiniMax(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "minimax");
  return coachWithOpenAICompatibleChat(state, transcript, {
    provider: "MiniMax",
    baseUrl: config<string>("minimaxChatBaseUrl") || "https://api.minimax.io/v1",
    model: config<string>("minimaxCoachModel") || "MiniMax-M2.7-highspeed",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

async function coachWithMiMo(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "mimo");
  return coachWithOpenAICompatibleChat(state, transcript, {
    provider: "MiMo",
    baseUrl: config<string>("mimoChatBaseUrl") || "https://token-plan-cn.xiaomimimo.com/v1",
    model: config<string>("mimoCoachModel") || "mimo-v2.5",
    headers: {
      "api-key": apiKey,
    },
  });
}

async function coachWithKimi(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "kimi");
  return coachWithOpenAICompatibleChat(state, transcript, {
    provider: "Kimi",
    baseUrl: config<string>("kimiChatBaseUrl") || "https://api.kimi.com/coding/v1",
    model: config<string>("kimiCoachModel") || "kimi-for-coding",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });
}

async function coachWithDeepSeek(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "deepseek");
  return coachWithOpenAICompatibleChat(state, transcript, {
    provider: "DeepSeek",
    baseUrl: config<string>("deepseekChatBaseUrl") || "https://api.deepseek.com",
    model: config<string>("deepseekCoachModel") || "deepseek-v4-pro",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    responseFormat: { type: "json_object" },
  });
}

async function coachWithOpenAICompatibleChat(
  state: TrainingState,
  transcript: string,
  options: { provider: string; baseUrl: string; model: string; headers: Record<string, string>; responseFormat?: JsonObject },
): Promise<JsonObject> {
  const requestBody: JsonObject = {
    model: options.model,
    messages: [
      { role: "system", content: coachingSystemPrompt() },
      { role: "user", content: coachingUserPrompt(state, transcript) },
    ],
    stream: false,
  };
  if (options.provider !== "Kimi") {
    requestBody.temperature = 0.2;
  }
  if (options.responseFormat) {
    requestBody.response_format = options.responseFormat;
  }
  const response = await fetch(chatCompletionsUrl(options.baseUrl), {
    method: "POST",
    headers: {
      ...options.headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${options.provider} coaching failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  return parseLooseJson(extractOpenAIText(JSON.parse(body) as JsonObject));
}

async function coachWithGemini(context: vscode.ExtensionContext, state: TrainingState, transcript: string): Promise<JsonObject> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiCoachModel") || "gemini-2.5-flash";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: {
        parts: [{ text: coachingSystemPrompt() }],
      },
      contents: [
        {
          role: "user",
          parts: [{ text: coachingUserPrompt(state, transcript) }],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini coaching failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const text = extractGeminiText(parsed);
  return parseLooseJson(text);
}

function chatCompletionsUrl(baseUrl: string): string {
  const clean = baseUrl.trim().replace(/\/+$/, "");
  return clean.endsWith("/chat/completions") ? clean : `${clean}/chat/completions`;
}

async function synthesizeOpenAI(context: vscode.ExtensionContext, text: string, outPath: string): Promise<string> {
  const apiKey = await getRequiredKey(context, "openai");
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("openaiTtsModel") || "gpt-4o-mini-tts",
      voice: config<string>("openaiTtsVoice") || "marin",
      input: text,
      response_format: "mp3",
      speed: Number(config<number>("ttsSpeed") ?? 0.9),
    }),
  });
  const body = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new Error(`OpenAI TTS failed (${response.status}): ${body.toString("utf8").slice(0, 1200)}`);
  }
  fs.writeFileSync(outPath, body);
  return outPath;
}

async function synthesizeMiMo(context: vscode.ExtensionContext, text: string, outPath: string): Promise<string> {
  const apiKey = await getRequiredKey(context, "mimo");
  const response = await fetch(chatCompletionsUrl(config<string>("mimoChatBaseUrl") || "https://token-plan-cn.xiaomimimo.com/v1"), {
    method: "POST",
    headers: {
      "api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("mimoTtsModel") || "mimo-v2.5-tts",
      messages: [
        {
          role: "assistant",
          content: text,
        },
      ],
      audio: {
        format: "wav",
        voice: config<string>("mimoTtsVoice") || "mimo_default",
      },
      stream: false,
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiMo TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const audio = extractOpenAICompatibleAudio(JSON.parse(body) as JsonObject);
  fs.writeFileSync(outPath, audio);
  return outPath;
}

async function synthesizeGemini(context: vscode.ExtensionContext, text: string, outPath: string): Promise<string> {
  const apiKey = await getRequiredKey(context, "gemini");
  const model = config<string>("geminiTtsModel") || "gemini-2.5-flash-preview-tts";
  const voiceName = config<string>("geminiTtsVoice") || "Kore";
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [{ text }],
        },
      ],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName,
            },
          },
        },
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Gemini TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const audio = extractGeminiInlineAudio(JSON.parse(body) as JsonObject);
  if (audio.mimeType.includes("wav")) {
    fs.writeFileSync(outPath, audio.data);
  } else {
    writePcm16Wav(outPath, audio.data, 24000, 1);
  }
  return outPath;
}

async function synthesizeMiniMax(context: vscode.ExtensionContext, text: string, outPath: string): Promise<string> {
  const apiKey = await getRequiredKey(context, "minimax");
  const response = await fetch(config<string>("minimaxTtsBaseUrl") || "https://api.minimax.io/v1/t2a_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config<string>("minimaxTtsModel") || "speech-2.8-hd",
      text,
      stream: false,
      output_format: "hex",
      language_boost: "auto",
      voice_setting: {
        voice_id: config<string>("minimaxTtsVoiceId") || "English_expressive_narrator",
        speed: Number(config<number>("ttsSpeed") ?? 0.9),
        vol: 1,
        pitch: 0,
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: "mp3",
        channel: 1,
      },
    }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`MiniMax TTS failed (${response.status}): ${body.slice(0, 1200)}`);
  }
  const parsed = JSON.parse(body) as JsonObject;
  const baseResp = (parsed.base_resp as JsonObject | undefined) ?? {};
  if (Number(baseResp.status_code ?? 0) !== 0) {
    throw new Error(`MiniMax TTS API error ${stringValue(baseResp.status_code)}: ${stringValue(baseResp.status_msg)}`);
  }
  const audioHex = stringValue((parsed.data as JsonObject | undefined)?.audio);
  if (!audioHex) {
    throw new Error("MiniMax TTS returned empty audio data.");
  }
  fs.writeFileSync(outPath, Buffer.from(audioHex, "hex"));
  return outPath;
}

function extractGeminiInlineAudio(parsed: JsonObject): { data: Buffer; mimeType: string } {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) {
    throw new Error("Gemini TTS returned no candidates.");
  }
  for (const candidate of candidates) {
    const content = (candidate as JsonObject).content as JsonObject | undefined;
    const parts = content?.parts;
    if (!Array.isArray(parts)) {
      continue;
    }
    for (const part of parts) {
      const partObj = part as JsonObject;
      const inlineData = (partObj.inlineData as JsonObject | undefined) ?? (partObj.inline_data as JsonObject | undefined);
      const data = stringValue(inlineData?.data);
      if (data) {
        return {
          data: Buffer.from(data, "base64"),
          mimeType: stringValue(inlineData?.mimeType) || stringValue(inlineData?.mime_type) || "audio/L16;rate=24000",
        };
      }
    }
  }
  throw new Error("Gemini TTS returned no inline audio data.");
}

function extractOpenAICompatibleAudio(parsed: JsonObject): Buffer {
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as JsonObject | undefined;
    const message = first?.message as JsonObject | undefined;
    const audio = message?.audio as JsonObject | undefined;
    const data = stringValue(audio?.data);
    if (data) {
      return Buffer.from(data, "base64");
    }
  }
  throw new Error("Audio response did not include base64 audio data.");
}

function writePcm16Wav(filePath: string, pcm: Buffer, sampleRate: number, channels: number): void {
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const byteRate = sampleRate * channels * bytesPerSample;
  const blockAlign = channels * bytesPerSample;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function extractOpenAIText(parsed: JsonObject): string {
  const direct = stringValue(parsed.output_text);
  if (direct) return direct;
  const choices = parsed.choices;
  if (Array.isArray(choices)) {
    const first = choices[0] as JsonObject | undefined;
    const message = first?.message as JsonObject | undefined;
    const content = message?.content;
    const textContent = typeof content === "string" ? content : "";
    if (textContent) return textContent;
    if (Array.isArray(content)) {
      const parts = content.map((part) => stringValue((part as JsonObject).text)).filter(Boolean);
      if (parts.length) return parts.join("\n");
    }
  }
  const output = parsed.output;
  if (Array.isArray(output)) {
    const parts: string[] = [];
    for (const item of output) {
      const content = (item as JsonObject).content;
      if (Array.isArray(content)) {
        for (const part of content) {
          const partObj = part as JsonObject;
          const text = stringValue(partObj.text) || stringValue(partObj.output_text);
          if (text) parts.push(text);
        }
      }
    }
    if (parts.length) return parts.join("\n");
  }
  return JSON.stringify(parsed);
}

function extractGeminiText(parsed: JsonObject): string {
  const candidates = parsed.candidates;
  if (!Array.isArray(candidates)) return JSON.stringify(parsed);
  const first = candidates[0] as JsonObject | undefined;
  const content = first?.content as JsonObject | undefined;
  const parts = content?.parts;
  if (!Array.isArray(parts)) return JSON.stringify(parsed);
  return parts.map((part) => stringValue((part as JsonObject).text)).filter(Boolean).join("\n");
}

function parseLooseJson(text: string): JsonObject {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as JsonObject;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(cleaned.slice(start, end + 1)) as JsonObject;
    }
    throw new Error(`Could not parse coaching JSON: ${cleaned.slice(0, 600)}`);
  }
}

function writeSessionMarkdown(filePath: string, state: TrainingState, result: PracticeResult): void {
  const lines = [
    `# VS Code Practice Session`,
    ``,
    `- Date: ${state.today}`,
    `- Package: ${result.packageDate}`,
    `- Session: ${result.sessionDir}`,
    ``,
    `## Task`,
    ``,
    stringValue(state.training.goal) || stringValue(state.next.goal),
    ``,
    `## Transcript`,
    ``,
    result.transcript,
    ``,
    `## Native Version`,
    ``,
    result.nativeVersion,
    ``,
    `## Problems`,
    ``,
    ...result.problems.map((item) => `- ${item}`),
    ``,
    `## Tags`,
    ``,
    ...(result.errorTags.length ? result.errorTags.map((item) => `- ${item}`) : ["- none"]),
    ``,
    `## Quick Fix`,
    ``,
    result.quickFix,
    ``,
    `## Next Drill`,
    ``,
    result.nextDrill,
    ``,
    `## Follow-up`,
    ``,
    result.followUpQuestion,
    ``,
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function completeLocalPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date);
  if (!packageDate) {
    throw new Error("No current package to complete.");
  }
  if (state.source === "github") {
    completeRemotePackage(state, packageDate);
    vscode.window.showInformationMessage(`Completed ${packageDate} in local VS Code progress.`);
    await refreshAll();
    return;
  }
  const script = path.join(state.root, "scripts", "english_training_progress.py");
  if (!fs.existsSync(script)) {
    throw new Error("Local completion requires scripts/english_training_progress.py in this workspace.");
  }
  const result = await execFile(state.root, [
    "scripts/english_training_progress.py",
    "complete",
    "--date",
    packageDate,
    "--due-date",
    state.today,
    "--no-todoist",
    "--note",
    "Completed in VS Code local practice.",
  ], 90_000);
  output.show(true);
  output.appendLine(`\n$ ${pythonPath()} scripts/english_training_progress.py complete --date ${packageDate} --due-date ${state.today} --no-todoist`);
  output.appendLine(result.stdout.trim());
  if (result.stderr.trim()) output.appendLine(result.stderr.trim());
  if (result.code !== 0) {
    throw new Error(`Local completion failed: ${result.stderr || result.stdout}`);
  }
  vscode.window.showInformationMessage(`Completed ${packageDate} locally.`);
  await refreshAll();
}

function completeRemotePackage(state: TrainingState, packageDate: string): void {
  const progressPath = remoteProgressPath(state.root);
  const progress = readJson(progressPath) ?? {};
  const records = Array.isArray(progress.records) ? progress.records.filter((record) => stringValue((record as JsonObject).date) !== packageDate) : [];
  records.push({
    date: packageDate,
    due_date: state.today,
    status: "completed",
    completed_at: new Date().toISOString(),
    source: state.source,
    source_label: state.sourceLabel,
  });
  writeJson(progressPath, {
    schema_version: "vscode-remote-progress-v1",
    updated_at: new Date().toISOString(),
    records,
  });
}

async function openCurrentTaskCard(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const taskCard = stringValue(assets.task_card);
  if (!taskCard) {
    throw new Error("No task card path is available.");
  }
  if (isHttpUrl(taskCard)) {
    const text = await fetchRemoteText(taskCard, { githubToken: await getGitHubToken(context) });
    const doc = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: text,
    });
    await vscode.window.showTextDocument(doc);
    return;
  }
  await vscode.window.showTextDocument(vscode.Uri.file(taskCard));
}

async function revealCurrentPackage(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const assets = (state.next.assets as JsonObject | undefined) ?? {};
  const packageDir = stringValue(assets.package_dir);
  if (!packageDir) {
    throw new Error("No package directory is available.");
  }
  if (isHttpUrl(packageDir)) {
    await vscode.env.openExternal(vscode.Uri.parse(packageDir));
    return;
  }
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(packageDir));
}

async function openSessionFolder(context: vscode.ExtensionContext): Promise<void> {
  const state = await loadState(context);
  const dir = path.join(state.root, "runtime", "vscode-sessions");
  fs.mkdirSync(dir, { recursive: true });
  await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(dir));
}

async function createSamplePackage(context: vscode.ExtensionContext): Promise<void> {
  const source = (config<string>("materialsSource") || "auto").toLowerCase();
  if (source === "github") {
    const choice = await vscode.window.showInformationMessage(
      "GitHub mode is read-only. Add your prebuilt/<date>/english-training.json to the linked repo, then refresh.",
      "Open Materials Guide",
      "Switch to Local",
    );
    if (choice === "Open Materials Guide") {
      await openMaterialsGuide();
    } else if (choice === "Switch to Local") {
      await vscode.workspace.getConfiguration().update("englishTraining.materialsSource", "local", vscode.ConfigurationTarget.Global);
      await refreshAll();
    }
    return;
  }
  const root = await resolveOrBootstrapLocalRoot();
  if (!root) {
    return;
  }
  const today = todayInConfiguredTimezone();
  const dateInput = await vscode.window.showInputBox({
    title: "Create Sample Package",
    prompt: "Lesson date (YYYY-MM-DD). Defaults to today.",
    value: today,
    ignoreFocusOut: true,
    validateInput: (value) => /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? null : "Use YYYY-MM-DD format.",
  });
  if (!dateInput) {
    return;
  }
  const targetDate = dateInput.trim();
  const packageDir = path.join(root, "prebuilt", targetDate);
  const targetFile = path.join(packageDir, "english-training.json");
  if (fs.existsSync(targetFile)) {
    const overwrite = await vscode.window.showWarningMessage(
      `${targetDate}/english-training.json already exists. Overwrite?`,
      { modal: true },
      "Overwrite",
    );
    if (overwrite !== "Overwrite") {
      return;
    }
  }
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(targetFile, sampleTrainingPackage(targetDate));
  vscode.window.showInformationMessage(`Sample lesson written to prebuilt/${targetDate}/english-training.json. Edit it and refresh the sidebar.`);
  await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
  await refreshAll();
}

async function resolveOrBootstrapLocalRoot(): Promise<string | undefined> {
  try {
    return await findTrainingRoot();
  } catch {
    // fall through to bootstrap flow
  }
  const choice = await vscode.window.showInformationMessage(
    "No local materials folder found. Pick a folder to host your lessons — the extension will create prebuilt/ and progress/ inside it.",
    { modal: true },
    "Pick Folder",
    "Open Guide",
  );
  if (choice === "Open Guide") {
    await openMaterialsGuide();
    return undefined;
  }
  if (choice !== "Pick Folder") {
    return undefined;
  }
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Use this folder for English Training materials",
  });
  if (!picked || picked.length === 0) {
    return undefined;
  }
  const root = picked[0].fsPath;
  fs.mkdirSync(path.join(root, "prebuilt"), { recursive: true });
  fs.mkdirSync(path.join(root, "progress"), { recursive: true });
  await vscode.workspace.getConfiguration().update("englishTraining.localMaterialsRoot", root, vscode.ConfigurationTarget.Global);
  await vscode.workspace.getConfiguration().update("englishTraining.materialsSource", "local", vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`English Training materials root set to ${root}.`);
  return root;
}

async function openMaterialsGuide(): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: MATERIALS_GUIDE_MD,
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}

function sampleTrainingPackage(date: string): JsonObject {
  return {
    date,
    training_type: "input",
    primary_tags: ["OPEN", "LINK"],
    scenario: "You're at a conference coffee break. Someone asks: \"So what kind of work do you do?\"",
    goal: "Give a natural 30-second introduction to your role and one thing you're working on right now.",
    chinese_setup: "用 30-45 秒自然介绍你做什么、最近在忙什么。像茶歇里答复别人问题，不要像念简历。",
    frames: [
      { label: "Frame 1", text: "I work on [topic] at [team or context].", function: "spoken frame" },
      { label: "Frame 2", text: "Right now I'm especially focused on [current project].", function: "spoken frame" },
      { label: "Frame 3", text: "More broadly, I'm interested in [bigger question].", function: "spoken frame" },
    ],
    demo_line:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    audio_text:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    clean_tts_text:
      "I work on legal issues around AI and platforms. Right now I'm especially focused on user-authorized agents. More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
    notes: [
      "This is a starter sample. Edit scenario, goal, frames, and clean_tts_text for your own lesson.",
      "Add stress_guide, intonation_guide, or word_level_prosody for richer prosody coaching.",
      "Drop a today.mp3 next to this file (optional) to use your own native-version reference audio.",
    ],
  };
}

const MATERIALS_GUIDE_MD = [
  "# English Training: Bring Your Own Materials",
  "",
  "The extension reads daily lesson packages from a `prebuilt/` directory.",
  "Each lesson lives in its own `YYYY-MM-DD` folder.",
  "",
  "## Minimum directory layout",
  "",
  "```",
  "your-training-root/",
  "├── prebuilt/",
  "│   ├── 2026-05-10/",
  "│   │   ├── english-training.json   # required",
  "│   │   └── today.mp3               # optional native-version audio",
  "│   ├── 2026-05-11/",
  "│   │   └── english-training.json",
  "│   └── ...",
  "└── progress/                        # auto-created by the extension",
  "```",
  "",
  "Point the extension at this root either way:",
  "",
  "- **Local**: open the parent folder as your VS Code workspace, OR set",
  "  `englishTraining.localMaterialsRoot` to its absolute path so the sidebar",
  "  works from any workspace.",
  "- **GitHub**: run `English Training: Configure GitHub Materials Source` and",
  "  paste a repo/tree URL or `raw.githubusercontent.com` base URL whose contents",
  "  match the layout above. Add a fine-grained PAT via `Configure GitHub Token`",
  "  for private repos.",
  "",
  "## Required fields in `english-training.json`",
  "",
  "| Field | Type | Purpose |",
  "|-------|------|---------|",
  "| `date` | string `YYYY-MM-DD` | Must match the folder name. |",
  "| `scenario` | string | One-line context: who you're talking to, what they asked. |",
  "| `goal` | string | What a successful answer sounds like. |",
  "| `chinese_setup` | string | Chinese instruction shown to the learner. |",
  "| `frames` | array of `{label, text}` | Reusable spoken patterns. |",
  "| `clean_tts_text` | string | The native-version sentence used for TTS. |",
  "",
  "Useful optional fields: `training_type`, `primary_tags`, `demo_line`,",
  "`audio_text`, `stress_guide`, `intonation_guide`, `word_level_prosody`.",
  "",
  "## Quick start",
  "",
  "1. Pick a source (Local or GitHub) in the sidebar.",
  "2. Run `English Training: Create Sample Package` to write a starter file at",
  "   `prebuilt/<today>/english-training.json`.",
  "3. Edit that file: change `scenario`, `goal`, `frames`, `clean_tts_text`.",
  "4. Click `Refresh` in the sidebar — your lesson appears as the current task.",
  "5. Press the red record button and start practicing.",
  "",
  "## Multiple lessons / a curriculum",
  "",
  "Add one folder per day. The extension auto-walks `prebuilt/` for every",
  "`YYYY-MM-DD` directory and shows the 120-day heatmap from the dates it finds.",
  "There is no required curriculum length — 7 lessons or 365 lessons both work.",
  "",
  "## Native-version audio (optional)",
  "",
  "If `prebuilt/<date>/today.mp3` exists, the sidebar's *Today audio* player uses",
  "it directly. Otherwise the extension synthesizes audio from `clean_tts_text`",
  "using your configured TTS provider.",
  "",
  "## Where session output goes",
  "",
  "- Local mode: `<root>/runtime/vscode-sessions/<date>/<timestamp>/`.",
  "- GitHub mode: VS Code global storage (the extension shows the path on first run).",
  "",
].join("\n");

class StatusItem extends vscode.TreeItem {
  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, description?: string, command?: vscode.Command) {
    super(label, collapsibleState);
    this.description = description;
    this.command = command;
  }
}

class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
  private readonly changed = new vscode.EventEmitter<StatusItem | undefined | null | void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(element: StatusItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<StatusItem[]> {
    try {
      const state = await loadState(this.context);
      const next = state.next;
      return [
        new StatusItem(`${stringValue(next.completion_label) || "Current"} ${stringValue(next.package_date)}`, vscode.TreeItemCollapsibleState.None, stringValue(next.training_type)),
        new StatusItem("Source", vscode.TreeItemCollapsibleState.None, state.source, { command: "englishTraining.configureGitHubMaterials", title: "Configure GitHub Materials" }),
        new StatusItem("GitHub Token", vscode.TreeItemCollapsibleState.None, state.keys.github ? "saved" : "missing", { command: "englishTraining.configureGitHubToken", title: "Configure GitHub Token" }),
        new StatusItem("Coach", vscode.TreeItemCollapsibleState.None, state.settings.coachProvider),
        new StatusItem("Speech In", vscode.TreeItemCollapsibleState.None, state.settings.audioUnderstandingProvider),
        new StatusItem("Speech Out", vscode.TreeItemCollapsibleState.None, state.settings.ttsProvider),
        new StatusItem("OpenAI Key", vscode.TreeItemCollapsibleState.None, state.keys.openai ? "saved" : "missing", { command: "englishTraining.configureOpenAIKey", title: "Configure OpenAI" }),
        new StatusItem("Gemini Key", vscode.TreeItemCollapsibleState.None, state.keys.gemini ? "saved" : "missing", { command: "englishTraining.configureGeminiKey", title: "Configure Gemini" }),
        new StatusItem("MiniMax Key", vscode.TreeItemCollapsibleState.None, state.keys.minimax ? "saved" : "missing", { command: "englishTraining.configureMiniMaxKey", title: "Configure MiniMax" }),
        new StatusItem("MiMo Key", vscode.TreeItemCollapsibleState.None, state.keys.mimo ? "saved" : "missing", { command: "englishTraining.configureMiMoKey", title: "Configure MiMo" }),
        new StatusItem("Kimi Key", vscode.TreeItemCollapsibleState.None, state.keys.kimi ? "saved" : "missing", { command: "englishTraining.configureKimiKey", title: "Configure Kimi" }),
        new StatusItem("DeepSeek Key", vscode.TreeItemCollapsibleState.None, state.keys.deepseek ? "saved" : "missing", { command: "englishTraining.configureDeepSeekKey", title: "Configure DeepSeek" }),
        new StatusItem("Open Task Card", vscode.TreeItemCollapsibleState.None, "markdown", { command: "englishTraining.openTaskCard", title: "Open Task Card" }),
      ];
    } catch (error) {
      return [
        new StatusItem("English Training unavailable", vscode.TreeItemCollapsibleState.None, errorMessage(error)),
      ];
    }
  }
}

function randomNonce(): string {
  return Array.from({ length: 16 }, () => Math.floor(Math.random() * 36).toString(36)).join("");
}

function stringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => stringValue(item)).filter(Boolean);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
