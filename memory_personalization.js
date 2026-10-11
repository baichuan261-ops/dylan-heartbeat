"use strict";

const MEMORIES_HEADING = "## Memories";

function personalizeMemoriesSection(content) {
  if (typeof content !== "string") return content;

  const headingIndex = content.indexOf(MEMORIES_HEADING);
  if (headingIndex < 0) return content;

  const beforeMemories = content.slice(0, headingIndex);
  const memories = content
    .slice(headingIndex)
    .replaceAll("用户", "川川")
    .replace(/\bAI\b/g, "我");

  return beforeMemories + memories;
}

module.exports = { personalizeMemoriesSection };
