const SCRIPTS: Array<[RegExp, string]> = [
  [/[\u0900-\u097F]/, "hi-IN"],
  [/[\u0980-\u09FF]/, "bn-IN"],
  [/[\u0A00-\u0A7F]/, "pa-IN"],
  [/[\u0A80-\u0AFF]/, "gu-IN"],
  [/[\u0B00-\u0B7F]/, "od-IN"],
  [/[\u0B80-\u0BFF]/, "ta-IN"],
  [/[\u0C00-\u0C7F]/, "te-IN"],
  [/[\u0C80-\u0CFF]/, "kn-IN"],
  [/[\u0D00-\u0D7F]/, "ml-IN"],
];

export function spokenLanguage(text: string): string {
  for (const [script, code] of SCRIPTS) {
    if (script.test(text)) return code;
  }
  return "en-IN";
}
