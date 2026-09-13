// WorkSummary derivation — record_schema_v01 §8.
// 生ログから決定論的に計算する。アイドル判定閾値は derivation_v: 1 の一部。
const IDLE_MS = 5 * 60e3;

export function deriveSummary(meta, events) {
  const sessions = [];
  const baselines = [];
  let lastKnownSha = null;
  let cur = null;
  let lastTs = null;
  let pausedFrom = null;
  let anchorCount = 0;
  let exportInfo = null;
  let exportFrames = null;
  // 制作ツールと、その統計の推移(daw_adapter_v01 §5): 最初と最後の保存の tool_stats
  let tool = null;
  let toolStatsFirst = null;
  let toolStatsLast = null;
  let exportArtifact = null;

  for (const e of events) {
    const tw = Date.parse(e.ts_wall);
    switch (e.type) {
      case 'core.baseline':
        baselines.push({
          wall: e.ts_wall,
          reason: e.payload.reason,
          sha256: e.payload.sha256,
          timelapse_frame_count: e.payload.timelapse_frame_count ?? null,
          prev_known_sha256: lastKnownSha,
          after_session_index: sessions.length,
          prev_session_end_wall: sessions.length ? sessions[sessions.length - 1].end_wall : null,
        });
        lastKnownSha = e.payload.sha256;
        break;
      case 'core.session_start':
        cur = {
          start_wall: e.ts_wall, end_wall: null, active_ms: 0, paused_ms: 0,
          event_count: 0, stroke_count: 0, input_total: 0, snapshot_count: 0, tools: {},
        };
        if (tool === null && typeof e.payload?.tool === 'string') tool = e.payload.tool;
        lastTs = tw;
        break;
      case 'core.session_end':
        if (cur) {
          // 前面から外れてからの猶予(セッション分断を防ぐデバウンス)は制作時間ではない。
          // 記録側が last_active_wall を積んでいればそちらを終端に使う(時間を盛らない = 製品原則5)。
          // 旧記録にはこのフィールドが無いので ts_wall にフォールバックし、出力は従来と一致する。
          cur.end_wall = e.payload?.last_active_wall ?? e.ts_wall;
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
      case 'core.export':
        exportInfo = { sha256: e.payload.sha256, format: e.payload.format };
        exportFrames = e.payload.timelapse_frame_count ?? null;
        if (typeof e.payload.tool === 'string') tool = e.payload.tool;
        if (e.payload.artifact && typeof e.payload.artifact.sha256 === 'string') {
          const a = e.payload.artifact;
          exportArtifact = { sha256: a.sha256, bytes: Number(a.bytes ?? 0), format: String(a.format ?? ''), name: String(a.name ?? '') };
        }
        break;
      case 'core.anchor_ack':
        anchorCount += 1;
      // fallthrough: アンカーもセッション内の活動として時間集計に含める
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
            cur.tools[e.payload.tool_class] = (cur.tools[e.payload.tool_class] || 0) + 1;
          }
          if (e.type === 'sim.activity') cur.input_total += e.payload.input_count;
          if (e.type === 'core.snapshot') cur.snapshot_count += 1;
        }
        if ((e.type === 'core.snapshot' || e.type === 'core.baseline') && e.payload?.tool_stats && typeof e.payload.tool_stats === 'object') {
          if (!toolStatsFirst) toolStatsFirst = e.payload.tool_stats;
          toolStatsLast = e.payload.tool_stats;
        }
        if (e.type === 'core.snapshot') lastKnownSha = e.payload.sha256;
    }
  }

  const sessionOut = sessions.map((s) => {
    const total = Object.values(s.tools).reduce((a, b) => a + b, 0);
    const dist = {};
    for (const [k, v] of Object.entries(s.tools)) dist[k] = Math.round((v / total) * 1000) / 1000;
    return {
      start_wall: s.start_wall,
      end_wall: s.end_wall,
      active_ms: s.active_ms,
      paused_ms: s.paused_ms,
      event_count: s.event_count,
      stroke_count: s.stroke_count,
      input_total: s.input_total,
      snapshot_count: s.snapshot_count,
      tool_distribution: total > 0 ? dist : null,
    };
  });

  const day = (w) => new Date(Date.parse(w) + 9 * 3600e3).toISOString().slice(0, 10); // JST表示

  // カバレッジ(coverage_model_v01): 観測がどこから始まり、どこに未観測期間があるか。
  // 証明書は「観測した区間」だけを主張する — 総制作時間の主張はしない(製品原則1)。
  // 「作成から観測した」という二値ラベルは導出しない(判定不能)。初回観測時点の状態が証拠のすべて。
  const initialBaseline = baselines.find((b) => b.reason !== 'rediscovery') ?? null;
  const coverage = {
    baseline: initialBaseline && {
      wall: initialBaseline.wall,
      reason: initialBaseline.reason,
      sha256: initialBaseline.sha256,
      timelapse_frame_count: initialBaseline.timelapse_frame_count,
    },
    // 年輪カードの芯の大きさに使う可視化比率(初回観測時点のタイムラプス規模 ÷ 完成時)。証明の主張ではない
    baseline_share:
      initialBaseline?.timelapse_frame_count != null && exportFrames
        ? Math.min(1, Math.round((initialBaseline.timelapse_frame_count / exportFrames) * 1000) / 1000)
        : null,
    gaps: baselines
      .filter((b) => b.reason === 'rediscovery')
      .map((b) => ({
        after_session: b.after_session_index,
        from_wall: b.prev_session_end_wall,
        to_wall: b.wall,
        unobserved_ms: b.prev_session_end_wall ? Date.parse(b.wall) - Date.parse(b.prev_session_end_wall) : null,
        file_changed_while_unobserved: b.prev_known_sha256 !== null && b.sha256 !== b.prev_known_sha256,
      })),
  };

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
    date_range: sessionOut.length ? [day(sessionOut[0].start_wall), day(sessionOut[sessionOut.length - 1].end_wall)] : null,
    coverage,
    export: exportInfo,
    sessions: sessionOut,
    ...(tool ? { tool } : {}),
    ...(toolStatsFirst ? { tool_stats_first: toolStatsFirst } : {}),
    ...(toolStatsLast ? { tool_stats_last: toolStatsLast } : {}),
    ...(exportArtifact ? { export_artifact: exportArtifact } : {}),
  };
}
