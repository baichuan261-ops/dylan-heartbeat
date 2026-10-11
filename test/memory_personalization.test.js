"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { personalizeMemoriesSection } = require("../memory_personalization");

test("personalizes narration only inside the Memories section", () => {
  const prompt = [
    "You are an AI companion.",
    "## Memories",
    "用户喜欢吃桃子。AI记住了。",
  ].join("\n");

  assert.equal(
    personalizeMemoriesSection(prompt),
    ["You are an AI companion.", "## Memories", "川川喜欢吃桃子。我记住了。"].join("\n")
  );
});

test("leaves prompts without a Memories section unchanged", () => {
  const prompt = "AI should help the 用户.";
  assert.equal(personalizeMemoriesSection(prompt), prompt);
});
