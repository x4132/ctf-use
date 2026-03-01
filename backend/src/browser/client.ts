import { BrowserUse } from "browser-use-sdk";

let _client: BrowserUse | null = null;

export function getBrowserClient(): BrowserUse {
  if (!_client) {
    _client = new BrowserUse({ maxRetries: 2 });
  }
  return _client;
}
