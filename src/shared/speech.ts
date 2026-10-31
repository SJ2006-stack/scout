export function firstSentence(text: string): string | null {
  const match = text.match(/^[\s\S]*?[.!?।](?=\s|$)/);
  const sentence = match?.[0]?.trim() ?? "";
  return sentence.length > 0 ? sentence : null;
}

export function speechCue(started: boolean, text: string): string | null {
  if (started) return null;
  return firstSentence(text);
}
