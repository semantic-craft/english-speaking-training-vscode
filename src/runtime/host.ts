/**
 * Decouples "trigger a UI refresh" from the concrete tree/webview providers so
 * domain modules can request a refresh without importing the provider classes
 * (which would create import cycles back through the state layer).
 *
 * extension.ts registers the real handlers in activate().
 */

type RefreshHandler = () => void | Promise<void>;

const refreshHandlers: RefreshHandler[] = [];

export function registerRefreshHandler(handler: RefreshHandler): void {
  refreshHandlers.push(handler);
}

export function clearRefreshHandlers(): void {
  refreshHandlers.length = 0;
}

export async function refreshAll(): Promise<void> {
  for (const handler of refreshHandlers) {
    await handler();
  }
}

/**
 * Bridges "open the configure-setting flow" without importing extension.ts
 * (configureSetting must stay in extension.ts for a raw-text manifest test).
 */
type ConfigureSettingHandler = (setting: string) => void | Promise<void>;

let configureSettingHandler: ConfigureSettingHandler | undefined;

export function registerConfigureSetting(handler: ConfigureSettingHandler): void {
  configureSettingHandler = handler;
}

export async function runConfigureSetting(setting: string): Promise<void> {
  if (configureSettingHandler) {
    await configureSettingHandler(setting);
  }
}

/**
 * Bridges providerSetupHint(), which must stay in extension.ts for a
 * raw-text manifest test, to the provider-routes module that needs it.
 */
type ProviderSetupHintHandler = (provider: string) => string;

let providerSetupHintHandler: ProviderSetupHintHandler | undefined;

export function registerProviderSetupHint(handler: ProviderSetupHintHandler): void {
  providerSetupHintHandler = handler;
}

export function runProviderSetupHint(provider: string): string {
  return providerSetupHintHandler ? providerSetupHintHandler(provider) : "";
}
