import { describe, expect, it } from "vitest";
import type { ChatSummary } from "../src/shared/types";
import { chatIdForQuestion, filterChats } from "../src/renderer/lib/chat-history";

const chats: ChatSummary[] = [
  { id: 1, title: "Bears fishing at the river bend", createdAt: "2026-07-20T10:00:00.000Z" },
  { id: 2, title: "Beach house conversation", createdAt: "2026-07-19T10:00:00.000Z" },
  { id: 3, title: "Morning market establishing shots", createdAt: "2026-07-18T10:00:00.000Z" },
];

describe("chat history controls", () => {
  it("filters chat titles without changing their order", () => {
    expect(filterChats(chats, "  HOUSE ")).toEqual([chats[1]]);
    expect(filterChats(chats, "ing")).toEqual([chats[0], chats[2]]);
    expect(filterChats(chats, "missing")).toEqual([]);
  });

  it("returns the full list for an empty search", () => {
    expect(filterChats(chats, "   ")).toBe(chats);
  });

  it("starts a fresh chat only in new-chat mode", () => {
    expect(chatIdForQuestion("continue", 42)).toBe(42);
    expect(chatIdForQuestion("continue", null)).toBeNull();
    expect(chatIdForQuestion("new-chat", 42)).toBeNull();
  });
});
