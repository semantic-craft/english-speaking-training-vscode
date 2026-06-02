import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  appendOutput,
  arrayOfStrings,
  errorMessage,
  parseFirstJson,
  readJson,
  readJsonDiagnosed,
  stringValue,
} from "../core.js";
import type {
  JsonObject,
  ProgressCell,
  ProgressSnapshot,
  SourceDiagnostics,
  TrainingState,
} from "../types.js";
import { createSessionDir, readRecentSessionLog, splitPracticeText } from "../practice/pipeline.js";
import { apiKeyAvailability, qwenCoachKeyAvailable } from "../commands/provider-routes.js";
import { loadLocalLearnerProfile } from "./learner-profile.js";
import {
  dateRangeLabel,
  execFile,
  findTrainingRoot,
  isHttpUrl,
  isFile,
  listPrebuiltPackageDates,
  completedPackageDates,
  readLocalInventory,
  todayInConfiguredTimezone,
} from "./training-root.js";
import { trainingSettings } from "./settings.js";

export async function loadState(context: vscode.ExtensionContext): Promise<TrainingState> {
  const settings = trainingSettings();
  const today = todayInConfiguredTimezone();
  return loadLocalState(context, today, settings);
}

export async function loadLocalState(
  context: vscode.ExtensionContext,
  today: string,
  settings: TrainingState["settings"],
): Promise<TrainingState> {
  const root = await findTrainingRoot();
  const next = await resolveNextPackage(root, today);
  const packageDate = stringValue(next.package_date);
  const trainingRead = packageDate
    ? readJsonDiagnosed(path.join(root, "prebuilt", packageDate, "english-training.json"))
    : { data: undefined as JsonObject | undefined };
  const training = trainingRead.data ?? {};
  const drillRead = packageDate
    ? loadDrillPlan(root, packageDate, training)
    : { drill: {} as JsonObject, parseError: undefined as string | undefined };
  const drill = drillRead.drill;
  const manifestRead = packageDate
    ? readJsonDiagnosed(path.join(root, "prebuilt", packageDate, "manifest.json"))
    : { data: undefined as JsonObject | undefined };
  const trainingForState = packageDate
    ? { ...training, tts_example_text: todayExampleText(training, next) }
    : training;
  const inventory = readLocalInventory(root);
  const progress = buildProgressSnapshot(inventory.dates, inventory.completed, today, packageDate);
  const sourceDiagnostics = buildLocalSourceDiagnostics(
    root,
    settings,
    inventory,
    packageDate,
    trainingRead.parseError,
    drillRead.parseError,
    manifestRead.parseError,
    inventory.progressJsonError,
  );

  return {
    root,
    source: "local",
    sourceLabel: root,
    today,
    next,
    training: trainingForState,
    drill,
    progress,
    sourceDiagnostics,
    learnerProfile: loadLocalLearnerProfile(root),
    recentSessions: readRecentSessionLog(root, 5),
    generatedAt: new Date().toISOString(),
    keys: await apiKeyAvailability(context),
    qwenCoachKey: await qwenCoachKeyAvailable(context),
    settings,
  };
}

export function buildLocalSourceDiagnostics(
  root: string,
  settings: TrainingState["settings"],
  inventory: { dates: string[]; completed: Set<string> },
  packageDate: string,
  packageJsonError?: string,
  drillJsonError?: string,
  manifestJsonError?: string,
  progressJsonError?: string,
): SourceDiagnostics {
  return {
    mode: "local",
    root,
    configuredRoot: settings.localMaterialsRoot,
    packageDir: packageDate ? path.join(root, "prebuilt", packageDate) : "",
    currentJson: packageDate ? path.join(root, "prebuilt", packageDate, "english-training.json") : "",
    followupDrillJson: packageDate ? path.join(root, "prebuilt", packageDate, "followup-drill.json") : "",
    manifestJson: packageDate ? path.join(root, "prebuilt", packageDate, "manifest.json") : "",
    progressJson: path.join(root, "progress", "english-speaking-training-progress.json"),
    currentPackageDate: packageDate,
    lessonCount: inventory.dates.length,
    completedCount: inventory.completed.size,
    dateRange: dateRangeLabel(inventory.dates),
    ...(packageJsonError ? { packageJsonError } : {}),
    ...(drillJsonError ? { drillJsonError } : {}),
    ...(manifestJsonError ? { manifestJsonError } : {}),
    ...(progressJsonError ? { progressJsonError } : {}),
  };
}

export function buildProgressSnapshot(
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

// computeNextPackage spawns `english_training_progress.py` (a Python
// cold-start, 60s-timeout subprocess) — or, without that script, a
// readdir + JSON scan — and it ran on EVERY loadState(). loadState fires
// ~4x per practice turn (record press → native-recording loadState; stop
// press → practice-view loadState; then refreshAll → status-tree
// getChildren loadState + webview postState loadState), so the same
// Python interpreter was launched four times per turn for a result that
// only moves when a package is completed or added. That was a large,
// invisible slice of "按下录音后等特别久". Memoize per (root, today): date
// rollover and a changed materials root fall out of the key for free.
// Invalidated explicitly on the only in-session events that change which
// package is "next" — completing one, adding one, or a user refresh.
interface NextPackageCache {
  key: string;
  value: JsonObject;
}
let nextPackageCache: NextPackageCache | undefined;

export function invalidateNextPackageCache(): void {
  nextPackageCache = undefined;
}

export async function resolveNextPackage(root: string, today: string): Promise<JsonObject> {
  const key = JSON.stringify([root, today]);
  if (nextPackageCache && nextPackageCache.key === key) {
    // Hand back a shallow copy so a caller mutating state.next can never
    // corrupt the shared cache entry.
    return { ...nextPackageCache.value };
  }
  const value = await computeNextPackage(root, today);
  nextPackageCache = { key, value };
  return { ...value };
}

async function computeNextPackage(root: string, today: string): Promise<JsonObject> {
  const script = path.join(root, "scripts", "english_training_progress.py");
  const prebuiltRoot = path.join(root, "prebuilt");
  const dates = listPrebuiltPackageDates(root);
  if (isFile(script)) {
    const result = await execFile(root, ["scripts/english_training_progress.py", "next", "--as-of", today], 60_000);
    const parsed = parseFirstJson(result.stdout);
    const resultValue = parsed?.result;
    const next = resultValue && typeof resultValue === "object" && !Array.isArray(resultValue)
      ? resultValue as JsonObject
      : {};
    const packageDate = stringValue(next.package_date);
    if (packageDate && dates.includes(packageDate)) {
      return mergeScriptNextWithLocalPackage(
        nextPackageFromLocalPackage(root, prebuiltRoot, dates, today, packageDate),
        next,
        packageDate,
      );
    }
  }

  const progress = readJsonDiagnosed(path.join(root, "progress", "english-speaking-training-progress.json")).data ?? {};
  const completed = completedPackageDates(progress, dates);
  const packageDate = dates.find((date) => !completed.has(date)) ?? dates[dates.length - 1] ?? "";
  return nextPackageFromLocalPackage(root, prebuiltRoot, dates, today, packageDate);
}

function nextPackageFromLocalPackage(
  root: string,
  prebuiltRoot: string,
  dates: string[],
  today: string,
  packageDate: string,
): JsonObject {
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

function mergeScriptNextWithLocalPackage(local: JsonObject, scripted: JsonObject, packageDate: string): JsonObject {
  const merged: JsonObject = {
    ...local,
    ...scripted,
    package_date: packageDate,
  };
  for (const key of ["send_date", "completion_label", "training_type", "goal", "scenario", "clean_tts_text"]) {
    if (!stringValue(merged[key])) {
      merged[key] = local[key];
    }
  }
  if (merged.package_day_index === undefined || merged.package_day_index === null || merged.package_day_index === "") {
    merged.package_day_index = local.package_day_index;
  }
  const localAssets = local.assets && typeof local.assets === "object" && !Array.isArray(local.assets)
    ? local.assets as JsonObject
    : {};
  const scriptedAssets = scripted.assets && typeof scripted.assets === "object" && !Array.isArray(scripted.assets)
    ? scripted.assets as JsonObject
    : {};
  merged.assets = { ...localAssets, ...scriptedAssets };
  return merged;
}

export function packageAssets(root: string, packageDate: string): JsonObject {
  const dir = path.join(root, "prebuilt", packageDate);
  const manifest = readJson(path.join(dir, "manifest.json")) ?? {};
  const files = (manifest.files && typeof manifest.files === "object" ? manifest.files : {}) as JsonObject;
  return {
    package_dir: dir,
    task_card: resolvePackageAsset(dir, files, ["telegram_task_card", "task_card"], "telegram-task-card.md"),
    daily_card: resolvePackageAsset(dir, files, ["daily_card"], "daily-card.png"),
    prosody_detail: resolvePackageAsset(dir, files, ["prosody_detail"], "prosody-detail.png"),
    demo_audio: resolvePackageAsset(dir, files, ["audio_demo", "demo_audio", "audio"], path.join("audio", "demo.ogg")),
    json: resolvePackageAsset(dir, files, ["json"], "english-training.json"),
    followup_drill_json: resolvePackageAsset(dir, files, ["followup_drill_json"], "followup-drill.json"),
    followup_drill_md: resolvePackageAsset(dir, files, ["followup_drill_md"], "followup-drill.md"),
    audio_queue: resolvePackageAsset(dir, files, ["audio_queue"], "audio-queue.json"),
    validation_report: resolvePackageAsset(dir, files, ["validation_report"], "validation-report.json"),
    manifest: path.join(dir, "manifest.json"),
  };
}

export function resolvePackageAsset(
  packageDir: string,
  manifestFiles: JsonObject,
  keys: string[],
  fallbackRelativePath: string,
): string {
  const fromManifest = keys
    .map((key) => stringValue(manifestFiles[key]).trim())
    .find(Boolean);
  const candidate = fromManifest || fallbackRelativePath;
  if (!candidate) {
    return "";
  }
  if (isHttpUrl(candidate) || path.isAbsolute(candidate)) {
    return candidate;
  }
  const resolved = path.resolve(packageDir, candidate);
  const packageRoot = path.resolve(packageDir);
  if (resolved === packageRoot || resolved.startsWith(`${packageRoot}${path.sep}`)) {
    return resolved;
  }
  return path.join(packageDir, fallbackRelativePath);
}

export function todayExampleText(training: JsonObject, next: JsonObject = {}): string {
  const direct = [
    stringValue(training.tts_example_text),
    stringValue(training.clean_tts_text),
    stringValue(training.audio_text),
    stringValue(training.demo_line),
    stringValue(next.clean_tts_text),
    stringValue(next.audio_text),
    stringValue(next.demo_line),
  ]
    .map((text) => text.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (direct) {
    return direct;
  }
  return spokenFrameTexts(training.frames).join(" ").trim();
}

export function spokenFrameTexts(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === "object" && item) {
        return stringValue((item as JsonObject).text);
      }
      return stringValue(item);
    })
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

export function loadDrillPlan(
  root: string,
  packageDate: string,
  training: JsonObject,
): { drill: JsonObject; parseError?: string } {
  const followupPath = path.join(root, "prebuilt", packageDate, "followup-drill.json");
  const followupRead = readJsonDiagnosed(followupPath);
  return {
    drill: buildDrillPlanFromFollowup(packageDate, training, followupRead.data ?? {}),
    parseError: followupRead.parseError,
  };
}

export function buildDrillPlan(root: string, packageDate: string, training: JsonObject): JsonObject {
  return loadDrillPlan(root, packageDate, training).drill;
}

function buildDrillPlanFromFollowup(
  packageDate: string,
  training: JsonObject,
  followup: JsonObject,
): JsonObject {
  const task = (training.task as JsonObject | undefined) ?? {};
  const primaryTags = arrayOfStrings(training.primary_tags);
  const routine = arrayOfStrings(followup.routine_zh);
  const fallbackFrameExamples = cleanDrillExamples(training.frames);
  const fallbackFrameText =
    spokenFrameTexts(training.frames)[0] ||
    stringValue(training.clean_tts_text).replace(/\s+/g, " ").trim();
  const fallbackFrames = Array.isArray(training.frames)
    ? [
        {
          id: "A",
          label: "Substitution: today's frames",
          base_frame: fallbackFrameText,
          slot: "frame",
          examples: fallbackFrameExamples,
        },
      ]
    : [];
  const followupRounds = Array.isArray(followup.rounds)
    ? followup.rounds
        .map(cleanDrillRound)
        .filter((round): round is JsonObject => Boolean(round))
    : undefined;
  const rounds = followupRounds && followupRounds.length ? followupRounds : fallbackFrames;

  return {
    title: stringValue(followup.title) || `FSI Drill - ${packageDate}`,
    method: stringValue(followup.method) || "FSI-style substitution + shadowing",
    routine_zh: routine.length
      ? routine
      : [
          "先听一遍，不分析语法。",
          "用完整句快速替换 cue。",
          "延迟 0.5-1 秒跟读，复制节奏和停顿。",
          "最后不看文本说两句。",
        ],
    rounds,
    shadowing_loop: cleanShadowingLoop(followup.shadowing_loop, training),
    source_principles: arrayOfStrings(followup.source_principles),
    repair_drills: arrayOfStrings(training.repair_drills),
    primary_tags: primaryTags,
    required_frames: positiveInteger(task.required_frames),
    training_type: stringValue(training.training_type),
  };
}

function cleanShadowingLoop(value: unknown, training: JsonObject): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as JsonObject;
    const chunks = cleanShadowingChunks(obj.chunks);
    if (chunks.length) {
      return {
        ...obj,
        chunks,
        instruction_zh: stringValue(obj.instruction_zh).trim()
          || "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
      };
    }
  }
  return {
    chunks: splitPracticeText(stringValue(training.clean_tts_text) || stringValue(training.audio_text)).slice(0, 4),
    instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
  };
}

function cleanShadowingChunks(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        return stringValue((item as JsonObject).text);
      }
      return stringValue(item);
    })
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function positiveInteger(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : undefined;
  return typeof parsed === "number" && Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function cleanDrillRound(round: unknown): JsonObject | undefined {
  if (!round || typeof round !== "object" || Array.isArray(round)) {
    return undefined;
  }
  const obj = round as JsonObject;
  const examples = cleanDrillExamples(obj.examples);
  const baseFrame = stringValue(obj.base_frame);
  if (!examples.length && !baseFrame.trim()) {
    return undefined;
  }
  return {
    ...obj,
    examples,
  };
}

function cleanDrillExamples(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item): unknown | undefined => {
      if (typeof item === "string") {
        const text = item.replace(/\s+/g, " ").trim();
        return text ? text : undefined;
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        return undefined;
      }
      const obj = item as JsonObject;
      const text = stringValue(obj.text).replace(/\s+/g, " ").trim();
      return text ? { ...obj, text } : undefined;
    })
    .filter((item): item is string | JsonObject => item !== undefined);
}

export function toWebviewState(webview: vscode.Webview, state: TrainingState): JsonObject {
  const next = { ...state.next };
  const assets = { ...((next.assets as JsonObject | undefined) ?? {}) };
  for (const [key, value] of Object.entries(assets)) {
    const filePath = stringValue(value).trim();
    if (filePath) {
      assets[key] = filePath;
    }
    if (isHttpUrl(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      assets[`${key}_uri`] = filePath;
    } else if (filePath && fs.existsSync(filePath) && /\.(png|jpe?g|gif|webp|ogg|mp3|wav|flac)$/i.test(filePath)) {
      const uri = webviewAssetUri(webview, filePath, key);
      if (uri) {
        assets[`${key}_uri`] = uri;
      }
    }
  }
  next.assets = assets;
  return {
    ...state,
    next,
  };
}

function webviewAssetUri(webview: vscode.Webview, filePath: string, key: string): string | undefined {
  try {
    return webview.asWebviewUri(vscode.Uri.file(filePath)).toString();
  } catch (error) {
    appendOutput(`Webview asset URI unavailable for ${key}: ${errorMessage(error)}`);
    return undefined;
  }
}
