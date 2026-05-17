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

// Discrete, user-meaningful steps of the "press record → can speak" gap, so
// the webview can show live progress instead of one frozen line. Emitted in
// order; "reclaim" only fires when a stale recorder is actually being reaped.
export type NativeStartPhase = "reclaim" | "mic" | "arming";

export async function startNativeFfmpegRecording(
  context: vscode.ExtensionContext,
  practiceTarget?: PracticeTarget,
  onPhase?: (phase: NativeStartPhase) => void,
): Promise<NativeRecordingSession> {
  if (nativeRecording) {
    onPhase?.("reclaim");
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
      // SIGKILL, not SIGTERM: this is an abandoned take being discarded, so
      // there is nothing to finalize — we only need the old ffmpeg gone fast
      // enough that it releases the AVFoundation device before the new one
      // opens it. SIGKILL cannot be trapped/slowed by ffmpeg's shutdown, so
      // the mic frees near-instantly; the short settle lets the kernel drop
      // the device handle. This took up to ~1.7s on the hot path before.
      stale.process.kill("SIGKILL");
      await waitForExit(stale.process, 600);
    }
    await delay(80);
  }
  if (process.platform !== "darwin") {
    throw new Error("Native recorder fallback currently supports macOS AVFoundation only.");
  }

  onPhase?.("mic");
  const state = await loadState(context);
  const packageDate = stringValue(state.next.package_date) || state.today;
  const sessionDir = createSessionDir(state.root, packageDate);
  const filePath = path.join(sessionDir, "native-input.wav");
  const ffmpegPath = resolveFfmpegPath();
  const device = await resolveNativeFfmpegAudioDevice(ffmpegPath);
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
  onPhase?.("arming");
  appendOutput(`Starting native recorder: ${ffmpegPath} ${args.join(" ")}`);

  // Adaptive readiness instead of a flat `await delay(900)`. The old fixed
  // sleep cost every single take ~0.9s of dead time regardless of how fast
  // ffmpeg actually came up, and the user feels that on every press. Poll
  // instead: the moment the WAV file has real PCM past its header ffmpeg is
  // demonstrably capturing (fast path, typically ~150–300ms); a bad device
  // or denied mic permission makes ffmpeg exit well within the fast-fail
  // floor, which we still surface exactly as before. Some ffmpeg builds
  // buffer the WAV and don't flush until stop, so a healthy process that
  // has survived past the fast-fail floor also counts as ready.
  try {
    await waitForRecorderReady(session, () => spawnError);
  } catch (error) {
    if (nativeRecording === session) {
      nativeRecording = undefined;
    }
    // A failed start may mean the cached device is stale/wrong (mic
    // unplugged, permission revoked). Drop the cache so the next press
    // re-enumerates instead of re-pinning a dead device.
    invalidateResolvedAudioDevice();
    throw error;
  }

  return session;
}

const RECORDER_READY_SIZE_BYTES = 1024;
const RECORDER_READY_FLOOR_MS = 450;
const RECORDER_READY_POLL_MS = 60;
const RECORDER_READY_MAX_MS = 1500;

/**
 * Resolve as soon as the recorder is demonstrably live; throw the same
 * "failed/exited before it could start" errors the old fixed-delay gate
 * threw, just sooner and without the unconditional 900ms tax.
 */
async function waitForRecorderReady(
  session: NativeRecordingSession,
  spawnError: () => Error | undefined,
): Promise<void> {
  const child = session.process;
  const start = Date.now();
  for (;;) {
    const failure = spawnError();
    if (failure) {
      throw new Error(`Native recorder failed to start: ${failure.message}`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(nativeRecorderError(session, "Native recorder exited before it could start."));
    }
    let size = 0;
    try {
      size = fs.statSync(session.filePath).size;
    } catch {
      size = 0;
    }
    const elapsed = Date.now() - start;
    // size > threshold  → ffmpeg is writing real PCM, unambiguously capturing.
    // size > 0 past the floor → ffmpeg opened the device and wrote the WAV
    //   header (a device that fails to open never creates the file), and the
    //   process has outlived the fast-fail window — ready even on builds that
    //   buffer PCM and don't grow the file until stop.
    // A slow-failing ffmpeg (no device) keeps size at 0, so the floor branch
    // won't fire; we keep polling and the exit check above catches it exactly
    // as the old flat delay(900) gate did — no false "ready".
    if (size > RECORDER_READY_SIZE_BYTES || (elapsed >= RECORDER_READY_FLOOR_MS && size > 0)) {
      appendOutput(`Native recorder ready in ${elapsed}ms (${size} bytes written).`);
      return;
    }
    if (elapsed >= RECORDER_READY_MAX_MS) {
      // Process never errored, never exited, never flushed, and somehow
      // outlived the floor check — accept it rather than fail a recorder
      // that is, by every available signal, alive.
      appendOutput(`Native recorder accepted at ${elapsed}ms cap (no flush yet, process alive).`);
      return;
    }
    await delay(RECORDER_READY_POLL_MS);
  }
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

// Resolving the AVFoundation device used to run ffmpeg's slow
// `-list_devices` enumeration on EVERY record press. The mic almost never
// changes between takes, and on machines with an iPhone/Continuity device
// in range that enumeration is multi-second — paid on every single press.
// Memoize the resolved device, keyed by the inputs that could change it
// (ffmpeg path + the three relevant settings), so enumeration runs at most
// once per session per configuration. Any recorder failure invalidates the
// cache so a genuinely changed/bad mic re-resolves and can never be pinned.
interface ResolvedAudioDevice {
  key: string;
  device: string;
}
let resolvedAudioDevice: ResolvedAudioDevice | undefined;

export function invalidateResolvedAudioDevice(): void {
  resolvedAudioDevice = undefined;
}

function audioDeviceCacheKey(ffmpegPath: string): string {
  const configured = (config<string>("nativeRecorderFfmpegAudioDevice") || "auto").trim() || "auto";
  const preferred = (config<string>("preferredMicrophoneName") || "").trim();
  const blocked = (config<string>("blockedMicrophoneNamePattern") || DEFAULT_BLOCKED_MICROPHONE_PATTERN).trim();
  return [ffmpegPath, configured, preferred, blocked].join(" ");
}

export async function resolveNativeFfmpegAudioDevice(ffmpegPath: string): Promise<string> {
  const key = audioDeviceCacheKey(ffmpegPath);
  if (resolvedAudioDevice && resolvedAudioDevice.key === key) {
    return resolvedAudioDevice.device;
  }
  const configured = (config<string>("nativeRecorderFfmpegAudioDevice") || "auto").trim() || "auto";
  if (configured.toLowerCase() !== "auto") {
    appendOutput(`Using configured native audio device: ${configured}`);
    resolvedAudioDevice = { key, device: configured };
    return configured;
  }

  const devices = await listAvfoundationAudioDevices(ffmpegPath);
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
  resolvedAudioDevice = { key, device: chosen.index };
  return chosen.index;
}

const FFMPEG_LIST_DEVICES_TIMEOUT_MS = 6000;

// Async, not cp.spawnSync. spawnSync froze the entire single-threaded
// extension host for the full duration of AVFoundation enumeration, so no
// progress could be painted and the UI was dead during the slowest part of
// "press record". cp.spawn keeps the host responsive; a hard timeout means
// a hung probe (e.g. ffmpeg blocked on a flaky device) can't wedge a take.
export function listAvfoundationAudioDevices(ffmpegPath: string): Promise<AvfoundationAudioDevice[]> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const child = cp.spawn(ffmpegPath, ["-f", "avfoundation", "-list_devices", "true", "-i", ""]);
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        reject(new Error(`Could not run ffmpeg at "${ffmpegPath}": device enumeration timed out after ${Math.round(FFMPEG_LIST_DEVICES_TIMEOUT_MS / 1000)}s`));
      });
    }, FFMPEG_LIST_DEVICES_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      finish(() => reject(new Error(`Could not run ffmpeg at "${ffmpegPath}": ${error.message}`)));
    });
    child.on("close", () => {
      finish(() => resolve(parseAvfoundationAudioDevices(`${stdout}\n${stderr}`)));
    });
  });
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
