import { makeRng } from './rng.js';

// 年輪カード v0 — WorkSummary のみから描画する(生ログは参照しない)。
// OGP サイズ (1200x630)。左に年輪、右に作品情報と統計。
// ビジュアルマッピング(仮):
//   輪1つ = 1セッション(内側が最初)。輪の厚み = 実作動時間の比。
//   色相 = セッションの支配的ツール(Tier Bはニュートラルな木色)。
//   明度 = 作業密度(濃い作業ほど濃い輪)。輪郭の揺らぎは有機的な見た目のため。
// カバレッジ表現(coverage_model_v01):
//   芯(未観測領域)は全カードに常在し、大きさはベースライン規模の全体比で連続的にスケールする。
//   初回観測がほぼ作成直後なら芯は小さく(木の髄)、途中参加なら大きい。「作成から観測」の二値表現はしない。
//   未観測期間 = 輪の間の暗い帯(破線縁)。どちらも減点ではなく事実の描写として描く。

const W = 1200;
const H = 630;
const CX = 315;
const CY = 315;
const R0 = 40;
const R_MAX = 258;

const INK = '#f2e9dc';
const MUTED = '#b7a58f';
const FAINT = '#8a7a66';
const ACCENT = '#d9a05f';
const BG = '#241c15';
const RING_EDGE = '#191209';

const TOOL_HUE = {
  pencil: [27, 22],
  pen: [22, 40],
  brush: [32, 58],
  eraser: [26, 24],
  other: [26, 24],
};

function dominantTool(dist) {
  if (!dist) return null;
  return Object.entries(dist).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function blobPath(r, w) {
  const pts = [];
  const N = 120;
  for (let i = 0; i < N; i++) {
    const th = (2 * Math.PI * i) / N;
    const rr = r + w.a1 * Math.sin(w.k1 * th + w.p1) + w.a2 * Math.sin(w.k2 * th + w.p2);
    pts.push(`${(CX + rr * Math.cos(th)).toFixed(1)} ${(CY + rr * Math.sin(th)).toFixed(1)}`);
  }
  return 'M' + pts.join('L') + 'Z';
}

function fmtDuration(ms) {
  const h = Math.floor(ms / 3600e3);
  const m = Math.round((ms % 3600e3) / 60e3);
  return h > 0 ? `${h}時間${String(m).padStart(2, '0')}分` : `${m}分`;
}

function fmtGapDuration(ms) {
  if (ms == null) return '不明';
  if (ms >= 86400e3) return `${Math.round((ms / 86400e3) * 10) / 10}日`;
  return fmtDuration(ms);
}

// セッションが1つも成立しなかった記録は date_range が null になる(対象アプリを検知できなかった、
// 保存先が監視外だった等)。描画で落とさず「なし」と正直に出す。
function fmtRange(range) {
  if (!range) return 'なし';
  const [a, b] = range;
  const f = (s) => s.slice(5, 10).replace('-', '.');
  return f(a) === f(b) ? f(a) : `${f(a)} – ${f(b)}`;
}

const TOOL_LABELS = { 'clip-studio-paint': 'CLIP STUDIO PAINT', 'logic-pro': 'Logic Pro', 'garageband': 'GarageBand' };
const escXml = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

export function renderCard(meta, summary) {
  const sessions = summary.sessions;
  const n = sessions.length;
  const rng = makeRng(7 + n);
  const cov = summary.coverage ?? { baseline: null, baseline_share: null, gaps: [] };

  // 未観測の芯: 大きさは初回観測時点のタイムラプス規模比(baseline_share)で連続スケール。
  // 比率が取れない記録(タイムラプスなし等)は最小の芯にフォールバックする
  const R_CORE_MAX = 150;
  const rCore = cov.baseline_share != null ? R0 + Math.sqrt(Math.min(cov.baseline_share, 1)) * (R_CORE_MAX - R0) : R0;
  const gaps = (cov.gaps ?? []).filter((g) => g.after_session > 0 && g.after_session < n);
  // 帯の厚み: 輪郭の揺らぎ(最大±5弱)が前後の輪と逆位相になっても帯が消えない値にする
  const GAP_T = 12;

  // 厚み配分: 最小6px保証+実作動時間比(ギャップ帯のぶんを差し引く)
  const weights = sessions.map((s) => Math.max(s.active_ms, 1));
  const sumW = weights.reduce((a, b) => a + b, 0);
  const avail = R_MAX - rCore - GAP_T * gaps.length;
  const minT = 6;
  const thick = weights.map((w) => minT + (avail - minT * n) * (w / sumW));

  // 密度→明度 (濃い作業ほど濃い輪)
  const density = sessions.map((s) => {
    const activeMin = Math.max(s.active_ms / 60e3, 1);
    return (s.stroke_count || s.input_total / 40 || s.event_count) / activeMin;
  });
  const dMin = Math.min(...density);
  const dMax = Math.max(...density);
  const norm = (d) => (dMax > dMin ? (d - dMin) / (dMax - dMin) : 0.5);

  // セッション輪とギャップ帯を内側から並べる(ギャップは該当セッションの直前に挟む)
  const items = [];
  sessions.forEach((s, i) => {
    if (gaps.some((g) => g.after_session === i)) items.push({ kind: 'gap' });
    items.push({ kind: 'session', i });
  });

  // 境界半径と揺らぎパラメータ
  let r = rCore;
  const rings = items.map((it) => {
    const wobble = {
      a1: Math.min(1.2 + r * 0.014, 4.5), k1: 3 + Math.floor(rng.f() * 4), p1: rng.f() * 6.28,
      a2: 0.5 + r * 0.007, k2: 7 + Math.floor(rng.f() * 7), p2: rng.f() * 6.28,
    };
    if (it.kind === 'gap') {
      r += GAP_T;
      return { kind: 'gap', outer: r, wobble };
    }
    r += thick[it.i];
    const s = sessions[it.i];
    const [hue, sat] = summary.tier === 'B' ? [30, 30] : (TOOL_HUE[dominantTool(s.tool_distribution)] ?? [30, 32]);
    const light = 76 - Math.round(16 * norm(density[it.i]));
    return { kind: 'session', outer: r, color: `hsl(${hue} ${sat}% ${light}%)`, wobble };
  });

  const ringSvg = [];
  for (let i = rings.length - 1; i >= 0; i--) {
    const ring = rings[i];
    ringSvg.push(
      ring.kind === 'gap'
        ? `<path d="${blobPath(ring.outer, ring.wobble)}" fill="#170f08" stroke="${FAINT}" stroke-opacity="0.4" stroke-width="1" stroke-dasharray="3 6"/>`
        : `<path d="${blobPath(ring.outer, ring.wobble)}" fill="${ring.color}" stroke="${RING_EDGE}" stroke-opacity="0.5" stroke-width="1.1"/>`,
    );
  }
  const coreW = { a1: 1.6, k1: 4, p1: 1.1, a2: 0.7, k2: 9, p2: 3.9 };
  if (cov.baseline) {
    // 未観測の芯: 初回観測(ベースライン)以前の過程は観測されていない=存在証明のみの領域
    ringSvg.push(`<path d="${blobPath(rCore, coreW)}" fill="#1b140c" stroke="${FAINT}" stroke-opacity="0.55" stroke-width="1" stroke-dasharray="4 5"/>`);
    if (rCore >= 78) {
      ringSvg.push(`<text x="${CX}" y="${CY - 2}" text-anchor="middle" font-size="13" fill="${FAINT}">記録開始前</text>`);
      ringSvg.push(`<text x="${CX}" y="${CY + 17}" text-anchor="middle" font-size="10.5" fill="#6f6152">未観測・存在証明のみ</text>`);
    }
  } else {
    // ベースライン情報のない旧形式の記録
    ringSvg.push(`<path d="${blobPath(rCore, coreW)}" fill="#4a3a2b" stroke="${RING_EDGE}" stroke-opacity="0.5" stroke-width="1.1"/>`);
  }

  const isB = summary.tier === 'B';
  const year = (summary.date_range?.[0] ?? meta.started_at ?? '').slice(0, 4) || '—';
  const stats = [
    // 「制作時間」ではなく「観測」を明示する — 証明の主張は観測した区間のみ(coverage_model_v01)
    ['観測された制作時間', fmtDuration(summary.total_active_ms)],
    ['セッション', `${summary.session_count}回`],
    [`期間 (${year})`, fmtRange(summary.date_range)],
    isB ? ['入力アクティビティ', summary.input_total.toLocaleString('ja-JP')] : ['ストローク', summary.stroke_total.toLocaleString('ja-JP')],
    ['外部アンカー', `${summary.anchor_count}回`],
    ['休憩', summary.total_paused_ms > 0 ? fmtDuration(summary.total_paused_ms) : 'なし'],
  ];
  const statSvg = stats.map(([label, value], i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 690 + col * 250;
    const y = 258 + row * 72;
    return `<text x="${x}" y="${y}" font-size="14" fill="${MUTED}">${label}</text>
<text x="${x}" y="${y + 34}" font-size="27" font-weight="600" fill="${INK}">${value}</text>`;
  }).join('\n');

  // カバレッジ注記: 観測がどこから始まったかを事実として書く。「作成から全過程」のような断定はしない
  const noteLines = [];
  if (cov.baseline) {
    const bl = cov.baseline;
    const blDay = (bl.wall ?? '').slice(5, 10).replace('-', '.');
    const frames = bl.timelapse_frame_count != null ? `タイムラプス${bl.timelapse_frame_count.toLocaleString('ja-JP')}フレーム` : null;
    if (bl.reason === 'watch_start') {
      noteLines.push('記録範囲: 途中から観測(開始時点の状態を存在証明として固定済み)');
      if (frames) noteLines.push(`ベースライン: ${frames}を記録開始時点に固定`);
    } else {
      noteLines.push(`記録範囲: ${blDay}の初回保存から観測${frames ? `(その時点の状態: ${frames})` : '(開始時点の状態を存在証明として固定済み)'}`);
    }
  }
  for (const g of gaps) {
    noteLines.push(`未観測期間: ${fmtGapDuration(g.unobserved_ms)}${g.file_changed_while_unobserved ? '(この間のファイル変更を検知・再固定済み)' : ''}`);
  }
  if (isB) noteLines.push('記録レベル: セッション+保存スナップショット(Tier B)');
  const noteSvg = noteLines
    .map((line, i) => `<text x="690" y="${520 - (noteLines.length - 1 - i) * 19}" font-size="12" fill="${FAINT}">${line}</text>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="'Hiragino Sans','Noto Sans JP',sans-serif">
<rect width="${W}" height="${H}" fill="${BG}"/>
<g>
${ringSvg.join('\n')}
</g>
<text x="60" y="606" font-size="12" fill="${FAINT}">${meta.disclaimer ?? 'サンプル(シミュレーションによるダミーデータ)'}</text>
<text x="690" y="86" font-size="21" letter-spacing="7" fill="${ACCENT}">NENRIN</text>
<text x="820" y="86" font-size="13" fill="${FAINT}">${summary.tool ? escXml(TOOL_LABELS[summary.tool] ?? summary.tool) + ' · ' : ''}制作過程の記録</text>
<text x="690" y="148" font-size="36" font-weight="700" fill="${INK}">${meta.title.length > 18 ? meta.title.slice(0, 17) + '…' : meta.title}</text>
<text x="690" y="184" font-size="17" fill="${MUTED}">${meta.handle}</text>
<line x1="690" y1="212" x2="1140" y2="212" stroke="#3d3126" stroke-width="1"/>
${statSvg}
${noteSvg}
<text x="690" y="547" font-size="13" fill="${MUTED}">検証ページ</text>
<text x="690" y="576" font-size="21" fill="${ACCENT}">nenrin.example/w/${summary.work_id.slice(0, 8)}</text>
<text x="690" y="604" font-size="12" fill="${FAINT}">証明対象は観測された過程のみ・記録は改ざん検知チェーンと外部アンカーで保護</text>
</svg>
`;
}
