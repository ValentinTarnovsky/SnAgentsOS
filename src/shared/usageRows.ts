/**
 * Row filtering shared by the desktop sidebar and the phone. A provider that
 * answered (at least one `ok` row) but has a `nodata` window simply does not
 * have that window on its plan (a weekly-only Codex plan, a Claude plan without
 * a Sonnet bucket), so the row is dropped instead of printing "No data".
 * When nothing for the provider is `ok` yet, `nodata` rows stay: that is
 * "unknown", not "absent".
 */
interface RowLike {
  provider: string
  status: string
}

export function visibleUsageRows<T extends RowLike>(rows: readonly T[]): T[] {
  const answered = new Set<string>()
  for (const r of rows) if (r.status === 'ok') answered.add(r.provider)
  return rows.filter((r) => !(r.status === 'nodata' && answered.has(r.provider)))
}

/** Quota window labels are chosen by kind, never by row id or by position. */
export function isQuotaKind(kind: string): kind is '5h' | '7d' {
  return kind === '5h' || kind === '7d'
}
