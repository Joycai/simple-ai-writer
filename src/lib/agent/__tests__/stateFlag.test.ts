// 状态记忆的两个偏好：Beta 开关与「新会话默认打开」，以及新会话的起点。

import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
});

const {
  isSkillStateDefaultOn, newChatStateMemory, setSkillStateDefaultOn, setSkillStateEnabled,
} = await import("../stateFlag");

beforeEach(() => store.clear());

describe("newChatStateMemory", () => {
  it("is off until both switches are on", () => {
    expect(newChatStateMemory()).toBe(false);
    setSkillStateDefaultOn(true);
    expect(newChatStateMemory()).toBe(false);
    setSkillStateEnabled(true);
    expect(newChatStateMemory()).toBe(true);
  });

  it("keeps the sub-option while the Beta is off, and honours it again when it returns", () => {
    setSkillStateEnabled(true);
    setSkillStateDefaultOn(true);
    setSkillStateEnabled(false);
    expect(isSkillStateDefaultOn()).toBe(true);
    expect(newChatStateMemory()).toBe(false);
    setSkillStateEnabled(true);
    expect(newChatStateMemory()).toBe(true);
  });

  it("goes off when the sub-option is unticked", () => {
    setSkillStateEnabled(true);
    setSkillStateDefaultOn(true);
    setSkillStateDefaultOn(false);
    expect(newChatStateMemory()).toBe(false);
  });
});
