import * as vscode from "vscode";

import { errorMessage, stringValue } from "../core.js";
import { loadState } from "../runtime/state.js";

export class StatusItem extends vscode.TreeItem {
  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    description?: string,
    command?: vscode.Command,
    tooltip?: string,
  ) {
    super(label, collapsibleState);
    this.description = description;
    this.command = command;
    this.tooltip = tooltip || [label, description].filter(Boolean).join(": ");
  }
}

export class StatusProvider implements vscode.TreeDataProvider<StatusItem> {
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
      const diagnostics = state.sourceDiagnostics;
      const profile = state.learnerProfile;
      return [
        new StatusItem(`${stringValue(next.completion_label) || "Current"} ${stringValue(next.package_date)}`, vscode.TreeItemCollapsibleState.None, stringValue(next.training_type)),
        new StatusItem("Source", vscode.TreeItemCollapsibleState.None, "local", { command: "englishTraining.configureLocalMaterials", title: "Configure Local Materials Folder" }),
        new StatusItem("Materials Root", vscode.TreeItemCollapsibleState.None, compactStatusValue(diagnostics.root), undefined, diagnostics.root),
        new StatusItem("Lessons", vscode.TreeItemCollapsibleState.None, `${diagnostics.lessonCount} total${diagnostics.dateRange ? ` · ${diagnostics.dateRange}` : ""}`),
        new StatusItem("Current JSON", vscode.TreeItemCollapsibleState.None, compactStatusValue(diagnostics.currentJson), { command: "englishTraining.revealPackage", title: "Reveal Current Package" }, diagnostics.currentJson),
        new StatusItem("Profile", vscode.TreeItemCollapsibleState.None, profile.loaded ? "loaded" : "missing", undefined, `${profile.loaded ? "Loaded" : "Missing"}: ${profile.source}`),
        new StatusItem("Coach", vscode.TreeItemCollapsibleState.None, state.settings.coachProvider),
        new StatusItem("Speech In", vscode.TreeItemCollapsibleState.None, state.settings.audioUnderstandingProvider),
        new StatusItem("Speech Out", vscode.TreeItemCollapsibleState.None, state.settings.ttsProvider),
        new StatusItem("MiniMax Key", vscode.TreeItemCollapsibleState.None, state.keys.minimax ? "saved" : "missing", { command: "englishTraining.configureMiniMaxKey", title: "Configure MiniMax" }),
        new StatusItem("MiMo Key", vscode.TreeItemCollapsibleState.None, state.keys.mimo ? "saved" : "missing", { command: "englishTraining.configureMimoKey", title: "Configure MiMo" }),
        new StatusItem("OpenAI Key", vscode.TreeItemCollapsibleState.None, state.keys.openai ? "saved" : "missing", { command: "englishTraining.configureOpenAIKey", title: "Configure OpenAI" }),
        new StatusItem("Gemini Key", vscode.TreeItemCollapsibleState.None, state.keys.gemini ? "saved" : "missing", { command: "englishTraining.configureGeminiKey", title: "Configure Gemini" }),
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

export function compactStatusValue(value: string, maxLength = 48): string {
  if (!value) return "";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, 22)}...${value.slice(-23)}`;
}
