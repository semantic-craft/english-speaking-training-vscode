import type * as cp from "node:child_process";

export type JsonObject = Record<string, unknown>;
export type ProviderName =
  | "gemini"
  | "qwen"
  | "mimo";
export type ActiveMaterialsSource = "local";
export type KeyAvailability = Record<ProviderName, boolean>;

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface ProgressCell {
  date: string;
  status: "completed" | "current" | "pending" | "missed";
}

export interface ProgressSnapshot {
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

export interface SourceDiagnostics {
  mode: ActiveMaterialsSource;
  root: string;
  configuredRoot: string;
  packageDir: string;
  currentJson: string;
  followupDrillJson: string;
  manifestJson: string;
  progressJson: string;
  currentPackageDate: string;
  lessonCount: number;
  completedCount: number;
  dateRange: string;
  /** Set when the current package's english-training.json exists but failed
   * to parse — surfaced to the user so a JSON typo is not a silent empty UI. */
  packageJsonError?: string;
  /** Set when followup-drill.json exists but failed to parse. This does not
   * block recording, but it explains why the drill workbench fell back. */
  drillJsonError?: string;
  /** Set when manifest.json exists but failed to parse. Asset paths stay
   * conservative, but the user should know why package media fell back. */
  manifestJsonError?: string;
  /** Set when the local progress file exists but failed to parse. The sidebar
   * stays usable, but progress/current-package inference may be conservative. */
  progressJsonError?: string;
}

export interface LearnerProfile {
  loaded: boolean;
  source: string;
  format: "markdown" | "json" | "missing";
  summary: string;
  content: string;
}

export interface TrainingState {
  root: string;
  source: ActiveMaterialsSource;
  sourceLabel: string;
  today: string;
  next: JsonObject;
  training: JsonObject;
  drill: JsonObject;
  progress?: ProgressSnapshot;
  sourceDiagnostics: SourceDiagnostics;
  learnerProfile: LearnerProfile;
  recentSessions: JsonObject[];
  generatedAt: string;
  keys: KeyAvailability;
  qwenCoachKey: boolean;
  settings: {
    localMaterialsRoot: string;
    coachProvider: string;
    audioUnderstandingProvider: string;
    ttsProvider: string;
    geminiCoachModel: string;
    geminiTtsModel: string;
    geminiTtsVoice: string;
    geminiAudioUnderstandingModel: string;
    qwenCoachBaseUrl: string;
    qwenCompatibleBaseUrl: string;
    qwenCoachModel: string;
    qwenAudioUnderstandingModel: string;
    mimoAnthropicBaseUrl: string;
    mimoCoachModel: string;
    mimoAudioBaseUrl: string;
    mimoAudioUnderstandingModel: string;
    mimoTtsBaseUrl: string;
    mimoTtsModel: string;
    mimoTtsVoice: string;
    qwenTtsEndpoint: string;
    qwenTtsModel: string;
    qwenTtsVoice: string;
    qwenTtsLanguageType: string;
    qwenTtsInstructions: string;
    ttsSpeed: number;
    recorderBackend: string;
    preferredMicrophoneName: string;
    blockedMicrophoneNamePattern: string;
  };
}

export interface CoachPriorTurn {
  nativeVersion: string;
  followUpQuestion: string;
  userTranscript: string;
}

export interface PracticeTarget {
  mode: "shadow";
  referenceText: string;
  referenceLabel?: string;
  followUpQuestion?: string;
}

export interface PracticeResult {
  transcript: string;
  nativeVersion: string;
  mode?: "free" | "shadow";
  referenceText?: string;
  referenceLabel?: string;
  problems: string[];
  quickFix: string;
  followUpQuestion: string;
  shadowingInstruction: string;
  errorTags: string[];
  nextDrill: string;
  drillExamples?: DrillExample[];
  scores: JsonObject;
  audioFile?: string;
  followUpAudioFile?: string;
  /** Optional short English direction the coach emitted for the TTS voice
   *  this turn (e.g. "Speak like a patient seminar professor"). Forwarded to
   *  the active TTS provider's style/instructions field; surfaced to the
   *  webview for transparency. */
  ttsStyle?: string;
  sessionDir: string;
  packageDate: string;
}

export interface DrillExample {
  label: string;
  text: string;
  reason?: string;
  source?: string;
}

export interface WebviewAudioMessage {
  type: "practiceAudio";
  base64: string;
  mimeType: string;
  requestId?: number;
  priorTurn?: CoachPriorTurn;
  practiceTarget?: PracticeTarget;
}

export interface NativeRecordingSession {
  process: cp.ChildProcessWithoutNullStreams;
  filePath: string;
  sessionDir: string;
  packageDate: string;
  priorTurn?: CoachPriorTurn;
  practiceTarget?: PracticeTarget;
  startedAt: number;
  stderr: string[];
}

export interface AvfoundationAudioDevice {
  index: string;
  name: string;
}

export type PracticeStage = "transcribe" | "coach" | "tts" | "save";
export type StageStatus = "active" | "done";
export type StageReporter = (stage: PracticeStage, status: StageStatus) => void;
