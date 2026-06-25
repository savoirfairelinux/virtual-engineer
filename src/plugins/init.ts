/**
 * Built-in plugin registration.
 *
 * Must be called once — before `PluginManager.loadFromDatabase()` — to make
 * all built-in integration types discoverable by the plugin manager.
 */
import { registerPlugin } from "./registry.js";
import { buildBuiltinDescriptors } from "./descriptors/index.js";

/** Register all built-in provider descriptors with the plugin registry. */
export function registerBuiltinPlugins(options?: { adminAuthSecret?: string }): void {
  for (const descriptor of buildBuiltinDescriptors(options)) {
    registerPlugin(descriptor);
  }
}
