import type { Inspection, Navigation, Reply } from "../src/types.ts";
declare global {
  var measureSequence: number;
  var syntheticSequence: number;
  var navigationSequence: number;
  var mainDelay: number;
  var measureMainDelay: number;
  var measureRendererDelay: number;
  var transportMainDelay: number;
  var transportRendererDelay: number;
  var regressionDelay: number;
  var regressionMutations: number;
  var delayTimer: ReturnType<typeof setInterval>;
  var measureMainTimer: ReturnType<typeof setInterval>;
  var measureRendererTimer: ReturnType<typeof setInterval>;
  var transportMainTimer: ReturnType<typeof setInterval>;
  var transportRendererTimer: ReturnType<typeof setInterval>;
  var regressionTimer: ReturnType<typeof setInterval>;
  var regressionObserver: MutationObserver;
  var delayedInspection: Promise<Reply<Inspection>>;
  var clearResult: unknown;
  var oldConnection: string;
  var clipboardCalls: number;
  var releaseClipboard: () => void;
  var lateTargetReady: boolean;
  var releaseLateTarget: () => void;
  interface Window {
    compromised?: boolean;
  }
}
export {};
