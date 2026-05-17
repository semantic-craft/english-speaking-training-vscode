import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { appendOutput, config, readJson, stringValue } from "../core.js";
import type { CommandResult, JsonObject } from "../types.js";
import { pythonPath } from "./settings.js";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

export async function findTrainingRoot(): Promise<string> {
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

export function looksLikeTrainingRoot(root: string): boolean {
  return isDirectory(path.join(root, "prebuilt"));
}

export function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

export function expandHome(value: string): string {
  if (value === "~") {
    return process.env.HOME || value;
  }
  if (value.startsWith("~/")) {
    return path.join(process.env.HOME || "", value.slice(2));
  }
  return value;
}

export function todayInConfiguredTimezone(): string {
  const timezone = (config<string>("timezone") || DEFAULT_TIMEZONE).trim() || DEFAULT_TIMEZONE;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  } catch {
    appendOutput(`Invalid englishTraining.timezone "${timezone}", falling back to ${DEFAULT_TIMEZONE}.`);
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: DEFAULT_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
  }
  const pick = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

export function execFile(root: string, args: string[], timeoutMs = 120_000): Promise<CommandResult> {
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

export function readLocalInventory(root: string): { dates: string[]; completed: Set<string> } {
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

export function dateRangeLabel(dates: string[]): string {
  if (!dates.length) {
    return "";
  }
  if (dates.length === 1) {
    return dates[0];
  }
  return `${dates[0]} to ${dates[dates.length - 1]}`;
}

export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}
