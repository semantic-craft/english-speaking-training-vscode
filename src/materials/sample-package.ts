import type { JsonObject } from "../types.js";

export function sampleTrainingPackage(date: string): JsonObject {
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
    stress_guide:
      "I ˈWORK on ˈLEGAL ˈISSUES around ˈAI and ˈPLATFORMS. ˈRIGHT ˈNOW I'm ˈESPECIALLY ˈFOCUSED on ˈUSER-AUTHORIZED ˈAGENTS. ˈMORE ˈBROADLY, I'm ˈINTERESTED in how ˈLAW should ˈRESPOND when ˈTECHNOLOGY ˈCHANGES who ˈACTS and who ˈCONTROLS.",
    intonation_guide:
      "I work on legal issues around AI and platforms. → | Right now I'm especially focused on user-authorized agents. → | More broadly, I'm interested in how law should respond when technology changes who acts and who controls. ↘",
    word_level_prosody: {
      groups: [
        {
          id: 1,
          text: "I work on legal issues around AI and platforms.",
          function: "statement",
          nucleus: "platforms.",
          contour: "→",
          pause_after: "short",
        },
        {
          id: 2,
          text: "Right now I'm especially focused on user-authorized agents.",
          function: "statement",
          nucleus: "agents.",
          contour: "→",
          pause_after: "short",
        },
        {
          id: 3,
          text: "More broadly, I'm interested in how law should respond when technology changes who acts and who controls.",
          function: "statement",
          nucleus: "controls.",
          contour: "↘",
          pause_after: "final",
        },
      ],
      words: [
        { text: "work", stress: "support", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "legal", stress: "support", syllables: "LE·gal", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "AI", stress: "support", pitch_role: "support beat", arrow: "", group: 1 },
        { text: "platforms.", stress: "nucleus", syllables: "PLAT·forms.", pitch_role: "level continuation", arrow: "→", group: 1 },
        { text: "focused", stress: "support", syllables: "FO·cused", pitch_role: "support beat", arrow: "", group: 2 },
        { text: "agents.", stress: "nucleus", syllables: "A·gents.", pitch_role: "level continuation", arrow: "→", group: 2 },
        { text: "law", stress: "support", pitch_role: "support beat", arrow: "", group: 3 },
        { text: "respond", stress: "support", syllables: "re·SPOND", pitch_role: "support beat", arrow: "", group: 3 },
        { text: "controls.", stress: "nucleus", syllables: "con·TROLS.", pitch_role: "falling target", arrow: "↘", group: 3 },
      ],
    },
    notes: [
      "This is a starter sample. Edit scenario, goal, frames, and clean_tts_text for your own lesson.",
      "Add stress_guide, intonation_guide, or word_level_prosody for richer prosody coaching.",
      "Use the Example audio button in the sidebar to generate reference TTS from the example only.",
    ],
  };
}

export function sampleFollowupDrillPackage(date: string): JsonObject {
  return {
    schema_version: 1,
    date,
    title: `Post-practice Speaking Drill - ${date}`,
    method: "FSI-style substitution + shadowing",
    source_principles: [
      "Stable base sentence plus fast slot replacement.",
      "Full-sentence output for each cue; do not answer with fragments.",
      "Shadow the audio with 0.5-1 second delay, then say selected lines from memory.",
    ],
    routine_zh: [
      "先看例句，不分析语法。",
      "听一遍，只抓节奏和停顿。",
      "点击 Practice 后完整跟读目标句。",
      "最后任选两句，不看文本直接说出来。",
    ],
    rounds: [
      {
        id: "A",
        label: "Substitution: role and project",
        base_frame: "I work on legal issues around AI and platforms.",
        slot: "topic / project",
        examples: [
          { cue: "topic", text: "I work on legal issues around AI and platforms." },
          { cue: "current project", text: "Right now I'm especially focused on user-authorized agents." },
          { cue: "broader question", text: "More broadly, I'm interested in how law should respond when technology changes who acts and who controls." },
        ],
      },
      {
        id: "B",
        label: "Substitution: claim and example",
        base_frame: "My claim is that authorization should matter when platforms decide whether to block an agent.",
        slot: "claim / example",
        examples: [
          { cue: "claim", text: "My claim is that authorization should matter when platforms decide whether to block an agent." },
          { cue: "example", text: "A concrete example is when a useful agent gets blocked because the platform treats it like abuse." },
          { cue: "repair", text: "Let me put the point more narrowly." },
        ],
      },
    ],
    shadowing_loop: {
      chunks: [
        "I work on legal issues around AI and platforms.",
        "Right now I'm especially focused on user-authorized agents.",
        "My claim is that authorization should matter when platforms decide whether to block an agent.",
      ],
      instruction_zh: "每个 chunk 跟读两遍；卡住的 chunk 单独循环三遍。",
    },
  };
}
