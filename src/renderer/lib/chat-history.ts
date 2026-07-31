import type { ChatSummary } from "../../shared/types";

export type ChatQuestionMode = "continue" | "new-chat";

export function filterChats(chats: ChatSummary[], query: string): ChatSummary[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return chats;
  return chats.filter((chat) => chat.title.toLocaleLowerCase().includes(normalized));
}

export function chatIdForQuestion(mode: ChatQuestionMode, currentChatId: number | null): number | null {
  return mode === "new-chat" ? null : currentChatId;
}
