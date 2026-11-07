/**
 * Hands-free voice (app 2.11.0): the local voice pack, installed at runtime
 * under `<dataDir>/voice` by the shared pack installer (WhisperInstaller with
 * this catalog). Pure: no Electron import. Nothing is bundled.
 *
 * - runtime: the sherpa-onnx 2.0.1 N-API addon for Windows x64 as npm
 *   publishes it (`sherpa-onnx-win-x64`, Apache-2.0): the `.node` file and the
 *   DLLs it loads from its own folder.
 * - model: Supertonic 3 int8 as sherpa-onnx republishes it (code MIT, model
 *   OpenRAIL-M), Spanish and English among its 31 languages, 10 voices.
 * Sizes and SHA-256 were measured on the downloaded files (2026-11-07).
 */
import { join } from 'path'
import type { AssetId, WhisperAsset, WhisperPackId } from '../dictation/whisper/catalog'

export const VOICE_PACK_ID = 'supertonic'
export type VoiceAssetId = 'voice-runtime' | 'voice-model'

export const SHERPA_VERSION = '2.0.1'
export const SUPERTONIC_MODEL = 'sherpa-onnx-supertonic-3-tts-int8-2026-05-11'

export interface VoiceAsset {
  id: VoiceAssetId
  kind: 'zip'
  url: string
  bytes: number
  sha256: string
  target: string
  members: readonly string[]
}

export const RUNTIME_FILES = ['sherpa-onnx.node', 'sherpa-onnx-c-api.dll', 'sherpa-onnx-cxx-api.dll', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll'] as const
export const MODEL_FILES = ['duration_predictor.int8.onnx', 'text_encoder.int8.onnx', 'vector_estimator.int8.onnx', 'vocoder.int8.onnx', 'tts.json', 'unicode_indexer.bin', 'voice.bin', 'LICENSE'] as const

export const VOICE_ASSETS: Readonly<Record<VoiceAssetId, VoiceAsset>> = {
  'voice-runtime': {
    id: 'voice-runtime',
    kind: 'zip',
    url: `https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${SHERPA_VERSION}.tgz`,
    bytes: 8779375,
    sha256: '217cec234c6026dbfd2b9c06523507180796fe4227c7cc9d11cfe218260a2519',
    target: `runtime/sherpa-${SHERPA_VERSION}`,
    members: RUNTIME_FILES.map((f) => `package/${f}`),
  },
  'voice-model': {
    id: 'voice-model',
    kind: 'zip',
    url: `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${SUPERTONIC_MODEL}.tar.bz2`,
    bytes: 128774318,
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
    target: `models/${SUPERTONIC_MODEL}`,
    members: MODEL_FILES.map((f) => `${SUPERTONIC_MODEL}/${f}`),
  },
}

/** Bytes on disk once extracted (the runtime members and the model files). */
export const VOICE_EXTRACT_BYTES: Readonly<Record<VoiceAssetId, number>> = { 'voice-runtime': 23_160_000, 'voice-model': 145_300_000 }

export const ALLOWED_VOICE_HOSTS = ['github.com', 'registry.npmjs.org'] as const

/** Every download hop (redirects included) lands on GitHub (its release CDN) or the npm registry. */
export function isAllowedVoiceHost(h: string): boolean {
  if (typeof h !== 'string' || !h) return false
  const host = h.toLowerCase()
  return (ALLOWED_VOICE_HOSTS as readonly string[]).includes(host) || host.endsWith('.githubusercontent.com')
}

/** The shared installer's catalog for the one voice pack. */
export function voiceInstallerCatalog(): {
  assets: Readonly<Record<AssetId, WhisperAsset>>
  packs: Readonly<Record<WhisperPackId, readonly AssetId[]>>
  packIds: readonly WhisperPackId[]
  extractBytes: Partial<Record<AssetId, number>>
  allowHost: (host: string) => boolean
} {
  // The installer is typed over Whisper's ids; the voice ids are just other strings.
  return {
    assets: VOICE_ASSETS as unknown as Readonly<Record<AssetId, WhisperAsset>>,
    packs: { [VOICE_PACK_ID]: ['voice-runtime', 'voice-model'] } as unknown as Readonly<Record<WhisperPackId, readonly AssetId[]>>,
    packIds: [VOICE_PACK_ID] as unknown as readonly WhisperPackId[],
    extractBytes: VOICE_EXTRACT_BYTES as unknown as Partial<Record<AssetId, number>>,
    allowHost: isAllowedVoiceHost,
  }
}

/** `<dataDir>/voice`: the pack, the phrase cache, the ElevenLabs key and credits. */
export function voiceDir(dataDir: string): string {
  return join(dataDir, 'voice')
}

/** Where the installed pack's files are, under voiceDir(). */
export function packPaths(dir: string): { addon: string; model: string } {
  return {
    addon: join(dir, VOICE_ASSETS['voice-runtime'].target, 'sherpa-onnx.node'),
    model: join(dir, VOICE_ASSETS['voice-model'].target),
  }
}
