import { bookMyShowTool } from "./bookmyshow.ts";
import { districtTool } from "./district.ts";
import { lumaTool } from "./luma.ts";
import type { EventTool } from "./types.ts";

export const eventTools: EventTool[] = [lumaTool, districtTool, bookMyShowTool];

export type { EventTool, ToolContext, ToolName, ToolResult } from "./types.ts";
