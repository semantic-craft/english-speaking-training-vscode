import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import {
  arrayOfStrings,
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
import { apiKeyAvailability } from "../commands/provider-routes.js";
import { loadLocalLearnerProfile } from "./learner-profile.js";
import {
  dateRangeLabel,
  execFile,
  findTrainingRoot,
  isHttpUrl,
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
  const drill = packageDate ? buildDrillPlan(root, packageDate, training) : {};
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
    settings,
  };
}

export function buildLocalSourceDiagnostics(
  root: string,
  settings: TrainingState["settings"],
  inventory: { dates: string[]; completed: Set<string> },
  packageDate: string,
  packageJsonError?: string,
): SourceDiagnostics {
  return {
    mode: "local",
    root,
    configuredRoot: settings.localMaterialsRoot,
    packageDir: packageDate ? path.join(root, "prebuilt", packageDate) : "",
    currentJson: packageDate ? path.join(root, "prebuilt", packageDate, "english-training.json") : "",
    currentPackageDate: packageDate,
    lessonCount: inventory.dates.length,
    completedCount: inventory.completed.size,
    dateRange: dateRangeLabel(inventory.dates),
    ...(packageJsonError ? { packageJsonError } : {}),
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

export async function resolveNextPackage(root: string, today: string): Promise<JsonObject> {
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
  return path.join(packageDir, candidate);
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

export function buildDrillPlan(root: string, packageDate: string, training: JsonObject): JsonObject {
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

export function toWebviewState(webview: vscode.Webview, state: TrainingState): JsonObject {
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
