/**
 * Local Whisper engine catalog (app 2.5.0): every downloadable asset with its
 * pinned URL, size and SHA-256, and the packs Settings offers. Pure: no
 * Electron import, so the esbuild + vm suites load it as is.
 *
 * Runtimes are the official whisper.cpp b5454 Windows builds (GitHub
 * releases). Models come from Hugging Face pinned to a revision, never
 * `main`. Sizes and hashes were measured on the downloaded files.
 */
import { join } from 'path'
import type { DictationDevice } from '@shared/types'
import { PACK_IDS, type WhisperPackId } from '@shared/dictation'

export { PACK_IDS, type WhisperPackId }

export const WHISPER_CPP_RELEASE = 'b5454'
const GH = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_CPP_RELEASE}`
const HF_W = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1'
const HF_VAD = 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b'

export type AssetId = 'runtime-cpu' | 'runtime-cuda' | 'model-small' | 'model-turbo' | 'vad'

export interface WhisperAsset {
  id: AssetId
  kind: 'zip' | 'file'
  url: string
  bytes: number
  sha256: string
  /** Relative to whisperDir: the extracted folder (zip) or the file (model). */
  target: string
  /** Zip members to extract (tar --strip-components 1), relative to the zip root. */
  members?: readonly string[]
}

/** The minimal CPU set (13 files): server, whisper, ggml and the 9 CPU variants. */
const CPU_MEMBERS: readonly string[] = [
  'whisper-server.exe',
  'whisper.dll',
  'ggml.dll',
  'ggml-base.dll',
  ...['alderlake', 'cannonlake', 'cascadelake', 'haswell', 'icelake', 'sandybridge', 'skylakex', 'sse42', 'x64'].map((v) => `ggml-cpu-${v}.dll`),
].map((f) => `Release/${f}`)

/** CPU set + the CUDA backend and the NVIDIA runtime DLLs it imports (no nvrtc, SDL2 or llama). */
const CUDA_MEMBERS: readonly string[] = [
  ...CPU_MEMBERS,
  'Release/ggml-cuda.dll',
  'Release/cudart64_12.dll',
  'Release/cublas64_12.dll',
  'Release/cublasLt64_12.dll',
]

export const ASSETS: Readonly<Record<AssetId, WhisperAsset>> = {
  'runtime-cpu': {
    id: 'runtime-cpu',
    kind: 'zip',
    url: `${GH}/whisper-bin-x64.zip`,
    bytes: 8928640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
    target: 'runtime/cpu-b5454',
    members: CPU_MEMBERS,
  },
  'runtime-cuda': {
    id: 'runtime-cuda',
    kind: 'zip',
    url: `${GH}/whisper-bin-win-cuda-12.4.0-x64.zip`,
    bytes: 684913404,
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
    target: 'runtime/cuda124-b5454',
    members: CUDA_MEMBERS,
  },
  'model-small': {
    id: 'model-small',
    kind: 'file',
    url: `${HF_W}/ggml-small-q5_1.bin`,
    bytes: 190085487,
    sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
    target: 'models/ggml-small-q5_1.bin',
  },
  'model-turbo': {
    id: 'model-turbo',
    kind: 'file',
    url: `${HF_W}/ggml-large-v3-turbo-q8_0.bin`,
    bytes: 874188075,
    sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1',
    target: 'models/ggml-large-v3-turbo-q8_0.bin',
  },
  vad: {
    id: 'vad',
    kind: 'file',
    url: `${HF_VAD}/ggml-silero-v5.1.2.bin`,
    bytes: 885098,
    sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
    target: 'models/ggml-silero-v5.1.2.bin',
  },
}

/** The GPU pack includes the CPU pack, so the GPU always has a CPU fallback. */
export const PACKS: Readonly<Record<WhisperPackId, readonly AssetId[]>> = {
  cpu: ['runtime-cpu', 'model-small', 'vad'],
  gpu: ['runtime-cpu', 'model-small', 'vad', 'runtime-cuda', 'model-turbo'],
}
// Download totals: cpu 199,899,225 B; gpu 1,759,000,704 B.

/**
 * Extracted size of a zip asset (the members only), used by the free-space
 * check and the disk size Settings shows. The CUDA runtime is about 1.16 GB.
 */
export const EXTRACT_BYTES: Partial<Record<AssetId, number>> = { 'runtime-cpu': 12_000_000, 'runtime-cuda': 1_160_000_000 }

/** Sum of the downloads of a set of assets. */
export function assetsDownloadBytes(ids: readonly AssetId[]): number {
  return ids.reduce((n, id) => n + ASSETS[id].bytes, 0)
}

/** Bytes a set of assets takes on disk once installed (zips are deleted after extraction). */
export function assetsDiskBytes(ids: readonly AssetId[]): number {
  return ids.reduce((n, id) => n + (ASSETS[id].kind === 'zip' ? (EXTRACT_BYTES[id] ?? ASSETS[id].bytes) : ASSETS[id].bytes), 0)
}

export const ALLOWED_DOWNLOAD_HOSTS = ['github.com', 'huggingface.co'] as const

/** Every download hop (redirects included) must land on one of these hosts. */
export function isAllowedDownloadHost(h: string): boolean {
  if (typeof h !== 'string' || !h) return false
  const host = h.toLowerCase()
  if ((ALLOWED_DOWNLOAD_HOSTS as readonly string[]).includes(host)) return true
  return host.endsWith('.githubusercontent.com') || host.endsWith('.huggingface.co') || host.endsWith('.hf.co')
}

export function packInstalled(pack: WhisperPackId, installed: ReadonlySet<AssetId>): boolean {
  return PACKS[pack].every((id) => installed.has(id))
}

export interface EnginePlan {
  device: 'gpu' | 'cpu'
  runtime: AssetId
  model: AssetId
}

const CPU_PLAN: EnginePlan = { device: 'cpu', runtime: 'runtime-cpu', model: 'model-small' }
const GPU_PLAN: EnginePlan = { device: 'gpu', runtime: 'runtime-cuda', model: 'model-turbo' }

export type ResolvedEngine = { ok: true; primary: EnginePlan; fallback: EnginePlan | null } | { ok: false; error: 'model_missing' }

/**
 * Which engine a session runs on.
 *  - 'auto': the GPU pack when there is an NVIDIA GPU, it is installed and the
 *    GPU has not failed this run; else the CPU pack; else model_missing.
 *  - 'gpu': the GPU pack, else model_missing. Once the GPU failed this run
 *    (`gpuBroken`) it runs on the CPU pack instead, and the service reports
 *    that with `fallback: 'gpu_failed'`.
 *  - 'cpu': the CPU pack, else model_missing.
 * Every GPU plan carries the CPU plan as its fallback when the CPU pack is installed.
 */
export function resolveEngine(
  s: { device: DictationDevice },
  installed: ReadonlySet<AssetId>,
  nvidia: boolean,
  gpuBroken: boolean,
): ResolvedEngine {
  const cpu = packInstalled('cpu', installed)
  const gpu = packInstalled('gpu', installed)
  const gpuPlan = (): ResolvedEngine => ({ ok: true, primary: { ...GPU_PLAN }, fallback: cpu ? { ...CPU_PLAN } : null })
  const cpuPlan = (): ResolvedEngine => (cpu ? { ok: true, primary: { ...CPU_PLAN }, fallback: null } : { ok: false, error: 'model_missing' })
  switch (s.device) {
    case 'gpu':
      if (!gpu) return { ok: false, error: 'model_missing' }
      return gpuBroken && cpu ? cpuPlan() : gpuPlan()
    case 'cpu':
      return cpuPlan()
    default:
      if (nvidia && !gpuBroken && gpu) return gpuPlan()
      return cpuPlan()
  }
}

/** `<dataDir>/whisper`: downloads, runtimes, models, installed.json, the CUDA cache. */
export function whisperDir(dataDir: string): string {
  return join(dataDir, 'whisper')
}
