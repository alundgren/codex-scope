import type { History } from "./history.ts";
import type { ScopeAPI } from "./types.ts";
declare global {
  var scopeHistory: History;
  interface Window {
    scope: ScopeAPI;
  }
}
export {};
