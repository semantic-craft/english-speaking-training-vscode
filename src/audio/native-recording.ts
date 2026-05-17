import * as cp from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";

import { appendOutput, config, resolveFfmpegPath, stringValue } from "../core.js";
import type { AvfoundationAudioDevice, NativeRecordingSession, PracticeTarget } from "../types.js";
import { createSessionDir } from "../practice/pipeline.js";
import { loadState } from "../runtime/state.js";

const DEFAULT_BLOCKED_MICROPHONE_PATTERN = "iphone|ipad|continuity|karios";
const LOCAL_MICROPHONE_PATTERN = /\b(imac|macbook|mac mini|mac studio|studio display|built[- ]?in|internal)\b/i;

let nativeRecording: NativeRecordingSession | undefined;

export function killActiveNativeRecording(): void {
  if (nativeRecording && !nativeRecording.process.killed) {
    nativeRecording.process.kill("SIGTERM");
  }
}

export async function startNativeFfmpegRecording(
  context: vscode.ExtensionContext,
  practiceTarget?: PracticeTarget,
): Promise<NativeRecordingSession> {
  if (nativeRecording) {
    // A leftover recorder (a prior turn that errored, or whose webview
    // start-watchdog fired and reset the UI) must never permanently brick
    // "record": pressing record is an unambiguous intent to start a NEW
    // take. retainContextWhenHidden also means hiding the view no longer
    // disposes it, so onDidDispose can't be relied on to reap it. Reclaim
    // the stale ffmpeg — kill it and free the microphone — instead of
    // throwing "already running" into a dead end with the mic still hot.
    appendOutput("Native recorder was still running from a previous take; reclaiming it.");
    const stale = nativeRecording;
    nativeRecording = undefined;
    if (
      !stale.process.killed &&
      stale.process.exitCode === null &&
      stale.process.signalCode === null
    ) {
      stale.process.kill("SIGTERM");
      await waitForExit(stale.process, 1500);
    }
    await delay(200);
  }
  if (process.platform !== "darwin") {
    throw new Error("Native recorder fallback currently supports macOS AVFoundation only.");
  }

  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const filePath = path.join(sessionDir, "native-input.wav");
  const ffmpegPath = resolveFfmpegPath();
  const device = resolveNativeFfmpegAudioDevice(ffmpegPath);
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
    practiceTarget,
    startedAt: Date.now(),
    stderr,
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const text = String(chunk);
    if (text.trim()) {
      appendOutput(text.trim());
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk);
    stderr.push(text);
    if (text.trim()) {
      appendOutput(text.trim());
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
    appendOutput(`Native ffmpeg recorder exited with code=${code ?? "null"} signal=${signal ?? "null"}.`);
  });

  nativeRecording = session;
  appendOutput(`Starting native recorder: ${ffmpegPath} ${args.join(" ")}`);
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

export async function stopNativeFfmpegRecording(): Promise<NativeRecordingSession> {
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
  appendOutput(`Native recording saved: ${session.filePath} (${size} bytes, ${Math.round((Date.now() - session.startedAt) / 1000)}s)`);
  return session;
}

export function resolveNativeFfmpegAudioDevice(ffmpegPath: string): string {
  const configured = (config<string>("nativeRecorderFfmpegAudioDevice") || "auto").trim() || "auto";
  if (configured.toLowerCase() !== "auto") {
    appendOutput(`Using configured native audio device: ${configured}`);
    return configured;
  }

  const devices = listAvfoundationAudioDevices(ffmpegPath);
  const chosen = chooseLocalAvfoundationAudioDevice(devices);
  if (!chosen) {
    const listed = devices.length
      ? devices.map((device) => `[${device.index}] ${device.name}`).join(", ")
      : "none";
    throw new Error(
      `No allowed Mac local microphone was found. AVFoundation audio devices: ${listed}. ` +
      `Set englishTraining.preferredMicrophoneName or englishTraining.nativeRecorderFfmpegAudioDevice explicitly if needed.`,
    );
  }
  appendOutput(`Selected Mac local microphone [${chosen.index}] ${chosen.name}`);
  return chosen.index;
}

export function listAvfoundationAudioDevices(ffmpegPath: string): AvfoundationAudioDevice[] {
  const result = cp.spawnSync(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""], {
    encoding: "utf8",
  });
  if (result.error) {
    throw new Error(`Could not run ffmpeg at "${ffmpegPath}": ${result.error.message}`);
  }
  const text = `${result.stdout || ""}\n${result.stderr || ""}`;
  return parseAvfoundationAudioDevices(text);
}

export function parseAvfoundationAudioDevices(text: string): AvfoundationAudioDevice[] {
  const devices: AvfoundationAudioDevice[] = [];
  let inAudioSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (line.includes("AVFoundation audio devices:")) {
      inAudioSection = true;
      continue;
    }
    if (line.includes("AVFoundation video devices:")) {
      inAudioSection = false;
      continue;
    }
    if (!inAudioSection) {
      continue;
    }
    const match = line.match(/\]\s*\[(\d+)\]\s+(.+)$/);
    if (match) {
      devices.push({ index: match[1], name: match[2].trim() });
    }
  }
  return devices;
}

export function chooseLocalAvfoundationAudioDevice(devices: AvfoundationAudioDevice[]): AvfoundationAudioDevice | undefined {
  const blocked = blockedMicrophoneRegex();
  const allowed = devices.filter((device) => !blocked.test(device.name));
  const preferredName = (config<string>("preferredMicrophoneName") || "").trim().toLowerCase();
  if (preferredName) {
    const preferred = allowed.find((device) => device.name.toLowerCase().includes(preferredName));
    if (preferred) {
      return preferred;
    }
  }
  return allowed.find((device) => LOCAL_MICROPHONE_PATTERN.test(device.name)) ?? allowed[0];
}

export function blockedMicrophoneRegex(): RegExp {
  const pattern = (config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN).trim()
    || DEFAULT_BLOCKED_MICROPHONE_PATTERN;
  try {
    return new RegExp(pattern, "i");
  } catch {
    return new RegExp(DEFAULT_BLOCKED_MICROPHONE_PATTERN, "i");
  }
}

export function nativeRecorderError(session: NativeRecordingSession, summary: string): string {
  const detail = session.stderr.join("").trim();
  const hint = `Check macOS microphone permission for VS Code/ffmpeg, or set englishTraining.preferredMicrophoneName / englishTraining.nativeRecorderFfmpegAudioDevice after running: ffmpeg -f avfoundation -list_devices true -i ""`;
  return `${summary}${detail ? `\n${detail.slice(0, 1200)}` : ""}\n${hint}`;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForExit(child: cp.ChildProcess, timeoutMs: number): Promise<boolean> {
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
