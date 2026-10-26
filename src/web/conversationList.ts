export function deleteConversation<T extends { id: string }>(conversations: readonly T[], id: string): T[] {
  return conversations.filter((conversation) => conversation.id !== id);
}
