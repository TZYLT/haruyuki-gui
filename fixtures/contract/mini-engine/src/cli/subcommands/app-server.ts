/**
 * Startup lines for the mini engine fixture.
 *
 * Two unguarded `console.log` calls (required shapes) and one behind
 * `if (openaiApi)` (optional shape), exactly the contract the real engine pins.
 */

export interface AppServerListeningInfo {
  url: string;
  controlUrl: string;
  openaiApi?: string;
}

export function createAppServer(): { onListening: (info: AppServerListeningInfo) => void } {
  return {
    onListening: (info: AppServerListeningInfo) => {
      console.log(`Listening on ${info.url}`);
      console.log(`WebSocket:  ${info.controlUrl}`);

      if (info.openaiApi) {
        console.log(`OpenAI:  ${info.openaiApi}`);
      }
    },
  };
}
