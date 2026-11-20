import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 库入口的导出清单钉成快照（design D7）：`src/engine/index.ts` 就是 `@streamapp/engine` 的全部公开面，
 * 多导出一个名字 = 多一个外部调用方会依赖、以后改不动的东西。改这张表要显式改这里。
 *
 * 按源码文本数，不按运行期 `Object.keys(import(...))`：类型导出在运行期不存在，而它们恰恰是公开面的大头。
 */
function exportedNames(src: string): string[] {
  const names = new Set<string>()
  for (const m of src.matchAll(/^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1])
  }
  for (const m of src.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) names.add(name)
    }
  }
  if (/^export\s+\*/m.test(src)) names.add('*')
  return [...names].sort()
}

describe('@streamapp/engine 公开面', () => {
  it('导出清单与快照一致（不许 `export *`）', () => {
    const src = readFileSync(join(import.meta.dirname, 'index.ts'), 'utf8')
    expect(exportedNames(src)).toEqual(
      [
        'ANDROID_OP_NAMES',
        'ANDROID_STEP_KINDS',
        'AndroidActOutcome',
        'AndroidApp',
        'AndroidCaps',
        'AndroidDriver',
        'AndroidDriverOptions',
        'AndroidElement',
        'AndroidExpect',
        'AndroidFindResult',
        'AndroidForeground',
        'AndroidLocator',
        'AndroidOps',
        'AndroidPerception',
        'AndroidProbe',
        'AndroidQuery',
        'AndroidRecipe',
        'AndroidRunOptions',
        'AndroidRunOutcome',
        'AndroidScreen',
        'AndroidScrollOptions',
        'AndroidScrollReceipt',
        'AndroidStateSpec',
        'AndroidStep',
        'AndroidTransport',
        'AndroidUnsupportedCapabilityError',
        'AndroidUnsupportedOpError',
        'AndroidWindow',
        'AppInUseSemantics',
        'CallerFetchGuardOptions',
        'CapAvailability',
        'CdpBinding',
        'CdpBindingOptions',
        'CheckOutput',
        'CheckResult',
        'CreateStreamOptions',
        'CredentialVerdict',
        'DEVICE_WIRE_OPS',
        'DeviceCapability',
        'DeviceCaps',
        'DeviceChange',
        'DeviceGateway',
        'DeviceGatewayOptions',
        'DeviceOpSemantics',
        'DeviceSnapshot',
        'DeviceWindowIdentity',
        'DeviceWireAction',
        'Feature',
        'FeatureTest',
        'ForwardScope',
        'HostOpSemantics',
        'IdentifyResult',
        'Observation',
        'ObservationLedger',
        'Perception',
        'StaleRefSemantics',
        'StateDef',
        'StateGraph',
        'StateVerdict',
        'Stream',
        'StreamCapabilities',
        'StreamDevices',
        'StreamHostHooks',
        'StreamRuntime',
        'StreamSecrets',
        'StreamTools',
        'ToolAnnotations',
        'ToolCallContext',
        'ToolDescriptor',
        'ToolProgress',
        'ToolResult',
        'WIDGET_DATA_DEFAULT_DIR',
        'WIDGET_DATA_MODE',
        'WIDGET_DATA_MODES',
        'WIDGET_DATA_PATH',
        'WIDGET_DATA_TOKEN',
        'WIDGET_DATA_URL',
        'WIDGET_SCHEMA',
        'WIDGET_STORAGE_DOCUMENT_PATH',
        'WIDGET_STORAGE_MAX_DEPTH',
        'WIDGET_STORAGE_MAX_PATH',
        'WIDGET_STORAGE_MAX_SEGMENT',
        'WIDGET_STORAGE_MIN_DOCUMENT_BYTES',
        'WIDGET_STORAGE_MIN_OBJECT_BYTES',
        'WIDGET_STORAGE_OBJECTS_PATH',
        'WIDGET_STORAGE_PATH_PREFIX',
        'WIDGET_STORAGE_RESERVED_NAMES',
        'WidgetsStore',
        'androidProbeFromDriver',
        'androidTransport',
        'callerFetchGuardConfigured',
        'checkDiscriminative',
        'checkWidget',
        'classifyWithPerception',
        'createRuntime',
        'createStream',
        'createWidgetsStore',
        'deviceForwardApp',
        'deviceForwardUpgrade',
        'deviceGateway',
        'featureKey',
        'forwardSecretOf',
        'identifyWith',
        'makeAndroidDriver',
        'maskCredential',
        'matchesAndroidQuery',
        'mintForwardCredential',
        'mountDeviceForward',
        'mountWidgetListPage',
        'parseWidgetManifest',
        'runAndroidRecipe',
        'startCdpBinding',
        'type WidgetManifest',
        'validateAndroidRecipe',
        'verifyForwardCredential',
        'windowIdentity',
        'wireActionOf',
        'wireArgsFor',
        'wireNamesFor',
        'wireOpName',
      ].sort(),
    )
  })
})
