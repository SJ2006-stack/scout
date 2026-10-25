export const LIVE_SOURCE_UNAVAILABLE =
  "No live grocery source is available. A plain request to the candidate search was rejected (HTTP 401, missing encrypted request id). Scout did not invent prices.";

export const LIVE_SOURCE_CHECK = {
  name: "quickcompare",
  method: "GET",
  url: "https://api.quickcompare.in/qc?type=groupsearch&query=milk&pincode=110054",
  status: 401,
  elapsedMs: 2787,
  passed: false,
  message: "Security validation failed: missing encrypted request id",
} as const;
