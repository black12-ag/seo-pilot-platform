import { describe, expect, it } from "vitest";
import { getAgentSetupPrompt, getAgentUpdatePrompt } from "./agentSetupPrompt";

describe("agent prompts", () => {
  it("targets the current instance and explains secure manual authentication", () => {
    const prompt = getAgentSetupPrompt("https://seo.example.com");
    expect(prompt).toContain("https://seo.example.com/mcp");
    expect(prompt).toContain("https://seo.example.com/settings");
    expect(prompt).toContain("https://seo.example.com/help/agent");
    expect(prompt).toContain("Authorization: Bearer");
    expect(prompt).not.toContain("openseo.so");
    expect(prompt).toContain("Do not claim success before verification");
  });

  it("updates public skills without replacing the instance endpoint", () => {
    const prompt = getAgentUpdatePrompt("https://seo.example.com");
    expect(prompt).toContain("https://seo.example.com/help/agent");
    expect(prompt).toContain("black12-ag/seo-pilot-platform");
    expect(prompt).toContain("Preserve my MCP endpoint");
    expect(prompt).not.toContain("openseo.so");
  });
});
