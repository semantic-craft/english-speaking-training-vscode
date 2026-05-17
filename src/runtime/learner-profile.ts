import * as fs from "node:fs";
import * as path from "node:path";

import { readJson, stringValue } from "../core.js";
import type { JsonObject, LearnerProfile } from "../types.js";

export function loadLocalLearnerProfile(root: string): LearnerProfile {
  const markdownPath = path.join(root, "profile", "learner-profile.md");
  if (fs.existsSync(markdownPath)) {
    return learnerProfileFromMarkdown(markdownPath, fs.readFileSync(markdownPath, "utf8"));
  }

  const jsonPath = path.join(root, "profile", "learner-profile.json");
  if (fs.existsSync(jsonPath)) {
    const profile = readJson(jsonPath);
    if (profile) {
      return learnerProfileFromJson(jsonPath, profile);
    }
  }

  return missingLearnerProfile(path.join(root, "profile", "learner-profile.md"));
}

export function learnerProfileFromMarkdown(source: string, content: string): LearnerProfile {
  const summary = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, 4)
    .join(" ");
  return {
    loaded: true,
    source,
    format: "markdown",
    summary: shortenText(summary || "Markdown learner profile loaded.", 260),
    content: shortenText(content.trim(), 5000),
  };
}

export function learnerProfileFromJson(source: string, profile: JsonObject): LearnerProfile {
  const summaryParts = [
    profileFieldText(profile, ["name", "role", "identity"]),
    profileFieldText(profile, ["research_focus", "researchFocus", "focus"]),
    profileFieldText(profile, ["speaking_goals", "speakingGoals", "goals"]),
    profileFieldText(profile, ["coaching_preferences", "coachingPreferences", "preferences"]),
  ].filter(Boolean);
  return {
    loaded: true,
    source,
    format: "json",
    summary: shortenText(summaryParts.join(" "), 260) || "JSON learner profile loaded.",
    content: shortenText(JSON.stringify(profile, null, 2), 5000),
  };
}

export function profileFieldText(profile: JsonObject, keys: string[]): string {
  for (const key of keys) {
    const value = profile[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const items = value.map((item) => stringValue(item)).filter(Boolean);
      if (items.length) {
        return items.join("; ");
      }
    }
  }
  return "";
}

export function missingLearnerProfile(source: string): LearnerProfile {
  return {
    loaded: false,
    source,
    format: "missing",
    summary: "Add profile/learner-profile.md or profile/learner-profile.json to personalize coaching.",
    content: "",
  };
}

export function shortenText(value: string, maxLength: number): string {
  const text = value.replace(/\s+$/g, "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
