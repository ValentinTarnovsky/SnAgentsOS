/**
 * The language of a file for the code editor (v2.2, E9), by name and
 * extension. Each grammar is a dynamic import, so only the ones a user opens
 * are loaded (their own chunks, no workers: the CSP stays as it is).
 */
import type { Extension } from '@codemirror/state'
import { StreamLanguage, type StreamParser } from '@codemirror/language'

type Loader = () => Promise<Extension>

const legacy = (load: () => Promise<StreamParser<unknown>>): Loader => () => load().then((p) => StreamLanguage.define(p))

const js: Loader = () => import('@codemirror/lang-javascript').then((m) => m.javascript())
const jsx: Loader = () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true }))
const ts: Loader = () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true }))
const tsx: Loader = () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true }))
const json: Loader = () => import('@codemirror/lang-json').then((m) => m.json())
const md: Loader = () => import('@codemirror/lang-markdown').then((m) => m.markdown())
const css: Loader = () => import('@codemirror/lang-css').then((m) => m.css())
const html: Loader = () => import('@codemirror/lang-html').then((m) => m.html())
const python: Loader = () => import('@codemirror/lang-python').then((m) => m.python())
const java: Loader = () => import('@codemirror/lang-java').then((m) => m.java())
const yaml: Loader = () => import('@codemirror/lang-yaml').then((m) => m.yaml())
const xml: Loader = () => import('@codemirror/lang-xml').then((m) => m.xml())
const sql: Loader = () => import('@codemirror/lang-sql').then((m) => m.sql())
const rust: Loader = () => import('@codemirror/lang-rust').then((m) => m.rust())
const cpp: Loader = () => import('@codemirror/lang-cpp').then((m) => m.cpp())
const shell = legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell as StreamParser<unknown>))
const powershell = legacy(() => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell as StreamParser<unknown>))
const properties = legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties as StreamParser<unknown>))
const toml = legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml as StreamParser<unknown>))
const dockerfile = legacy(() => import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile as StreamParser<unknown>))
const go = legacy(() => import('@codemirror/legacy-modes/mode/go').then((m) => m.go as StreamParser<unknown>))
const lua = legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua as StreamParser<unknown>))
const ruby = legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby as StreamParser<unknown>))
const csharp = legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp as StreamParser<unknown>))
const kotlin = legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin as StreamParser<unknown>))
const groovy = legacy(() => import('@codemirror/legacy-modes/mode/groovy').then((m) => m.groovy as StreamParser<unknown>))
const diff = legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff as StreamParser<unknown>))

interface Lang {
  label: string
  load: Loader
}

const BY_EXT: Record<string, Lang> = {
  js: { label: 'JavaScript', load: js },
  mjs: { label: 'JavaScript', load: js },
  cjs: { label: 'JavaScript', load: js },
  jsx: { label: 'JavaScript JSX', load: jsx },
  ts: { label: 'TypeScript', load: ts },
  mts: { label: 'TypeScript', load: ts },
  cts: { label: 'TypeScript', load: ts },
  tsx: { label: 'TypeScript JSX', load: tsx },
  json: { label: 'JSON', load: json },
  jsonc: { label: 'JSON', load: json },
  md: { label: 'Markdown', load: md },
  markdown: { label: 'Markdown', load: md },
  css: { label: 'CSS', load: css },
  scss: { label: 'CSS', load: css },
  less: { label: 'CSS', load: css },
  html: { label: 'HTML', load: html },
  htm: { label: 'HTML', load: html },
  vue: { label: 'HTML', load: html },
  py: { label: 'Python', load: python },
  java: { label: 'Java', load: java },
  yml: { label: 'YAML', load: yaml },
  yaml: { label: 'YAML', load: yaml },
  xml: { label: 'XML', load: xml },
  svg: { label: 'XML', load: xml },
  pom: { label: 'XML', load: xml },
  sql: { label: 'SQL', load: sql },
  rs: { label: 'Rust', load: rust },
  c: { label: 'C', load: cpp },
  h: { label: 'C', load: cpp },
  cpp: { label: 'C++', load: cpp },
  cc: { label: 'C++', load: cpp },
  hpp: { label: 'C++', load: cpp },
  sh: { label: 'Shell', load: shell },
  bash: { label: 'Shell', load: shell },
  zsh: { label: 'Shell', load: shell },
  ps1: { label: 'PowerShell', load: powershell },
  psm1: { label: 'PowerShell', load: powershell },
  properties: { label: 'Properties', load: properties },
  ini: { label: 'INI', load: properties },
  cfg: { label: 'INI', load: properties },
  env: { label: 'Env', load: properties },
  toml: { label: 'TOML', load: toml },
  go: { label: 'Go', load: go },
  lua: { label: 'Lua', load: lua },
  rb: { label: 'Ruby', load: ruby },
  cs: { label: 'C#', load: csharp },
  kt: { label: 'Kotlin', load: kotlin },
  kts: { label: 'Kotlin', load: kotlin },
  gradle: { label: 'Groovy', load: groovy },
  groovy: { label: 'Groovy', load: groovy },
  diff: { label: 'Diff', load: diff },
  patch: { label: 'Diff', load: diff },
}

const BY_NAME: Record<string, Lang> = {
  dockerfile: { label: 'Dockerfile', load: dockerfile },
  '.env': { label: 'Env', load: properties },
  '.gitignore': { label: 'Properties', load: properties },
  '.bashrc': { label: 'Shell', load: shell },
  makefile: { label: 'Shell', load: shell },
}

function langOf(name: string): Lang | null {
  const lower = name.toLowerCase()
  const byName = BY_NAME[lower] ?? (lower.startsWith('.env.') ? BY_NAME['.env'] : undefined)
  if (byName) return byName
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? (BY_EXT[lower.slice(dot + 1)] ?? null) : null
}

/** "TypeScript", "Markdown"... or "Plain text". */
export function languageLabel(name: string, plain: string): string {
  return langOf(name)?.label ?? plain
}

/** The grammar of a file, or null for plain text. Never rejects. */
export async function loadLanguage(name: string): Promise<Extension | null> {
  const lang = langOf(name)
  if (!lang) return null
  try {
    return await lang.load()
  } catch {
    return null
  }
}

export function isMarkdownName(name: string): boolean {
  return /\.(md|markdown)$/i.test(name)
}
