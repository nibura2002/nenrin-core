// WorkSummary導出 — loop-poc/summary.js のTS移植(derivation_v: 1)。
// 表示日付は日本時間(JST)基準(初期ターゲットは日本語圏。i18n時にタイムゾーンをアカウント設定へ)。
import type { ChainEvent } from './verify';

const IDLE_MS = 5 * 60e3;
const JST = 9 * 3600e3;
const jstDay = (iso: string) => new Date(Date.parse(iso) + JST).toISOString().slice(0, 10);

export type SessionSummary = {
  start_wall: string; end_wall: string | null; active_ms: number; paused_ms: number;
  event_count: number; stroke_count: number; input_total: number; snapshot_count: number;
  tool_distribution: Record<string, number> | null;
};

export type WorkSummary = {
  derivation_v: number; work_id: string; title: string; tier: string;
  total_active_ms: number; total_paused_ms: number; session_count: number;
  stroke_total: number; input_total: number; snapshot_total: number; anchor_count: number;
  date_range: [string, string] | null;
  export: { sha256: string; format: string } | null;
  sessions: SessionSummary[];
  // 制作ツール(アダプタ id)と、最初と最後の保存の統計(件数・数値のみ)、書き出し音源(daw_adapter_v01 §5)
  tool?: string;
  tool_stats_first?: Record<string, unknown>;
  tool_stats_last?: Record<string, unknown>;
  export_artifact?: { sha256: string; bytes: number; format: string; name: string };
  // L1(存在証明)で作品ファイルから読み取る描写情報(任意)。deriveSummary は設定しない。
  timelapse_frames?: number; timelapse_keyframes?: number;
  layer_count?: number | null;
  canvas_width?: number | null; canvas_height?: number | null; canvas_dpi?: number | null;
};

export function deriveSummary(meta: { work_id: string; title: string; tier: string }, events: ChainEvent[]): WorkSummary {
  const sessions: any[] = [];
  let cur: any = null;
  let lastTs: number | null = null;
  let pausedFrom: number | null = null;
  let anchorCount = 0;
  let exportInfo: WorkSummary['export'] = null;
  let tool: string | null = null;
  let toolStatsFirst: Record<string, unknown> | null = null;
  let toolStatsLast: Record<string, unknown> | null = null;
  let exportArtifact: WorkSummary['export_artifact'] | null = null;

  for (const e of events) {
    const tw = Date.parse(e.ts_wall);
    switch (e.type) {
      case 'core.session_start':
        cur = { start_wall: e.ts_wall, end_wall: null, active_ms: 0, paused_ms: 0, event_count: 0, stroke_count: 0, input_total: 0, snapshot_count: 0, tools: {} as Record<string, number> };
        if (tool === null && typeof (e.payload as any)?.tool === 'string') tool = String((e.payload as any).tool);
        lastTs = tw;
        break;
      case 'core.session_end':
        if (cur) {
          // 前面から外れてからの猶予(セッション分断を防ぐデバウンス)は制作時間ではない。
          // 記録側が last_active_wall を積んでいればそちらを終端に使う(時間を盛らない = 製品原則5)。
          // 旧記録にはこのフィールドが無いので ts_wall にフォールバックし、出力は従来と一致する。
          cur.end_wall = (e.payload as { last_active_wall?: string } | undefined)?.last_active_wall ?? e.ts_wall;
          sessions.push(cur);
          cur = null;
        }
        break;
      case 'core.pause':
        pausedFrom = tw;
        break;
      case 'core.resume':
        if (cur && pausedFrom !== null) cur.paused_ms += tw - pausedFrom;
        pausedFrom = null;
        lastTs = tw;
        break;
      case 'core.export': {
        exportInfo = { sha256: String(e.payload.sha256), format: String(e.payload.format) };
        const p = e.payload as any;
        if (typeof p.tool === 'string') tool = p.tool;
        if (p.artifact && typeof p.artifact.sha256 === 'string') {
          exportArtifact = { sha256: String(p.artifact.sha256), bytes: Number(p.artifact.bytes ?? 0), format: String(p.artifact.format ?? ''), name: String(p.artifact.name ?? '') };
        }
        break;
      }
      case 'core.anchor_ack':
        anchorCount += 1;
      // fallthrough
      default:
        if (cur && pausedFrom === null && lastTs !== null) {
          const gap = tw - lastTs;
          if (gap > 0 && gap < IDLE_MS) cur.active_ms += gap;
          lastTs = tw;
        }
        if (cur) {
          cur.event_count += 1;
          if (e.type === 'sim.stroke') {
            cur.stroke_count += 1;
            const t = String(e.payload.tool_class);
            cur.tools[t] = (cur.tools[t] || 0) + 1;
          }
          if (e.type === 'sim.activity') cur.input_total += Number(e.payload.input_count ?? 0);
          if (e.type === 'core.snapshot') cur.snapshot_count += 1;
        }
        if ((e.type === 'core.snapshot' || e.type === 'core.baseline') && (e.payload as any)?.tool_stats && typeof (e.payload as any).tool_stats === 'object') {
          const ts = (e.payload as any).tool_stats as Record<string, unknown>;
          if (!toolStatsFirst) toolStatsFirst = ts;
          toolStatsLast = ts;
        }
    }
  }

  const sessionOut: SessionSummary[] = sessions.map((s) => {
    const total = (Object.values(s.tools) as number[]).reduce((a, b) => a + b, 0);
    const dist: Record<string, number> = {};
    for (const [k, v] of Object.entries(s.tools as Record<string, number>)) dist[k] = Math.round((v / total) * 1000) / 1000;
    const { tools, ...rest } = s;
    return { ...rest, tool_distribution: total > 0 ? dist : null };
  });

  return {
    derivation_v: 1,
    work_id: meta.work_id,
    title: meta.title,
    tier: meta.tier,
    total_active_ms: sessionOut.reduce((a, s) => a + s.active_ms, 0),
    total_paused_ms: sessionOut.reduce((a, s) => a + s.paused_ms, 0),
    session_count: sessionOut.length,
    stroke_total: sessionOut.reduce((a, s) => a + s.stroke_count, 0),
    input_total: sessionOut.reduce((a, s) => a + s.input_total, 0),
    snapshot_total: sessionOut.reduce((a, s) => a + s.snapshot_count, 0),
    anchor_count: anchorCount,
    date_range: sessionOut.length ? [jstDay(sessionOut[0].start_wall), jstDay(sessionOut[sessionOut.length - 1].end_wall!)] : null,
    export: exportInfo,
    sessions: sessionOut,
    ...(tool ? { tool } : {}),
    ...(toolStatsFirst ? { tool_stats_first: toolStatsFirst } : {}),
    ...(toolStatsLast ? { tool_stats_last: toolStatsLast } : {}),
    ...(exportArtifact ? { export_artifact: exportArtifact } : {}),
  };
}
