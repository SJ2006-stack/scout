export type BlinkitHandoff = {
  platform: "Blinkit";
  query: string;
  url: string;
  message: string;
};

const SEARCH_PAGE = "https://blinkit.com/s/";
const MAX_QUERY = 200;

export function blinkitHandoff(query: string): BlinkitHandoff | null {
  const text = query.trim().replace(/\s+/g, " ");
  if (text.length === 0 || text.length > MAX_QUERY) return null;
  const url = new URL(SEARCH_PAGE);
  url.searchParams.set("q", text);
  return {
    platform: "Blinkit",
    query: text,
    url: url.toString(),
    message: "Opens Blinkit search in your browser. Scout does not fetch a price.",
  };
}
