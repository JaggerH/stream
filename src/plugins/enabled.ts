import type { PluginDescriptor } from './types.ts'

/**
 * Is a plugin enabled? Opt-out model:
 *  - a `required` plugin (rsshub/builtin) is ALWAYS on — the user override is ignored;
 *  - otherwise the settings map wins, and an ABSENT entry means enabled (new/unknown plugins
 *    default on, existing installs keep everything). Only an explicit `false` disables.
 * Pure + keyed by descriptor id so it's trivially testable and has one home.
 */
export function pluginEnabled(
  descriptor: Pick<PluginDescriptor, 'id' | 'required'>,
  enabledMap: Record<string, boolean> | undefined
): boolean {
  if (descriptor.required) return true
  return enabledMap?.[descriptor.id] ?? true
}
