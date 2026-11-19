import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { getDb } from '@/db/client';
import { SESSION_COOKIE, sessionUser } from '@/lib/auth';
import { checkSheets, type Sheet, type SheetSeat } from '@/lib/checkSheet';
import PrintButton from '@/components/admin/PrintButton';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: '驗票打勾圖' };

const tw = (iso: string) => new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const rowName = (r: number | null) => (r === 0 ? 'VIP' : r === null ? '輪椅' : String(r));

/** 依 x 把座位切成幾塊（中間空很多欄＝不同區，例如三樓極左、極右） */
function panels(s: Sheet) {
  const xs = [...new Set(s.seats.map((x) => x.x))].sort((a, b) => a - b);
  const cuts: number[][] = [];
  for (const x of xs) {
    const last = cuts[cuts.length - 1];
    if (last && x - last[last.length - 1] <= 4) last.push(x); else cuts.push([x]);
  }
  return cuts.map((c) => s.seats.filter((x) => x.x >= c[0] && x.x <= c[c.length - 1]));
}

/** 名字字級：框太窄就縮小（最小 4.5pt），還放不下才省略 */
const fit = (name: string, mm: number, max = 8.5) => Math.max(4.5, Math.min(max, mm / (Math.max(1, [...name].length) * 0.36)));

const BLOCK_ORDER = ['L1', 'C0', 'R1'];
const BLOCK_NAME: Record<string, string> = { L1: '左區', C0: '中區', R1: '右區' };
/** 1–3 排：依區塊切（左、中、右由上而下） */
const byBlock = (s: Sheet) => BLOCK_ORDER.map((b) => s.seats.filter((x) => x.block === b)).filter((p) => p.length);
const colsOf = (p: SheetSeat[]) => Math.max(...p.map((x) => x.x)) - Math.min(...p.map((x) => x.x)) + 1;
const rowsOf = (p: SheetSeat[]) => new Set(p.map((x) => x.y)).size;

/** 同一列、相鄰、同一位買方（群）的座位＝一組框 */
function runs(list: SheetSeat[]) {
  const out: { key: string; name: string; from: number; to: number }[] = [];
  for (const s of [...list].sort((a, b) => a.x - b.x)) {
    if (!s.key) continue;
    const last = out[out.length - 1];
    if (last && last.key === s.key && s.x === last.to + 1) last.to = s.x;
    else out.push({ key: s.key, name: s.name, from: s.x, to: s.x });
  }
  return out;
}

function Panel({ seats, cw, ch, lab, caption }: { seats: SheetSeat[]; cw: number; ch: number; lab: number; caption?: string }) {
  const minX = Math.min(...seats.map((s) => s.x));
  const maxX = Math.max(...seats.map((s) => s.x));
  const ys = [...new Set(seats.map((s) => s.y))].sort((a, b) => a - b);
  const cols = maxX - minX + 1;
  const col = (x: number) => x - minX + 2;
  const cell = Math.min(cw, ch);
  const big = lab > 4.5; // 直印：字放大
  const font = big ? Math.max(7, Math.min(14, ch * 1.0)) : Math.max(6, Math.min(11, cell * 0.62));
  const nameMax = big ? 11 : 8.5;
  return (
    <div className="cs-pwrap">
    {caption && <div className="cs-cap">{caption}</div>}
    <div className="cs-panel" style={{ gridTemplateColumns: `8mm repeat(${cols}, ${cw}mm) 8mm`, gridTemplateRows: ys.map(() => `${lab}mm ${ch}mm`).join(' ') }}>
      {ys.map((y, i) => {
        const row = seats.filter((s) => s.y === y);
        const r = row.find((s) => s.rowNo !== null)?.rowNo ?? row[0].rowNo;
        const gr = i * 2 + 1;
        return [
          <div key={`l${y}`} className="cs-row" style={{ gridColumn: 1, gridRow: `${gr + 1}`, fontSize: big ? '11pt' : undefined }}>{rowName(r)}</div>,
          <div key={`r${y}`} className="cs-row" style={{ gridColumn: cols + 2, gridRow: `${gr + 1}`, fontSize: big ? '11pt' : undefined }}>{rowName(r)}</div>,
          ...runs(row).map((g) => (
            <div key={`f${y}-${g.from}`} className="cs-frame" style={{ gridColumn: `${col(g.from)} / ${col(g.to) + 1}`, gridRow: `${gr} / ${gr + 2}` }}>
              <div className="cs-name" style={{ height: `${lab}mm`, fontSize: `${fit(g.name, (g.to - g.from + 1) * cw - 1.5, nameMax)}pt` }}>{g.name}</div>
            </div>
          )),
          ...row.map((s) => (
            <div key={s.id} className={`cs-seat cs-${s.kind}${s.entered ? ' cs-in' : ''}`} style={{ gridColumn: col(s.x), gridRow: gr + 1, fontSize: `${font}pt` }}>
              <span className="cs-no">{s.seatNo}</span>
              <span className="cs-box">{s.kind === 'qr' ? (s.entered ? '✓' : '☐') : s.kind === 'paper' ? '紙' : ''}</span>
            </div>
          )),
        ];
      })}
    </div>
    </div>
  );
}

function SheetView({ s, ev, now }: { s: Sheet; ev: { name: string }; now: string }) {
  const ps = s.stack ? byBlock(s) : panels(s);
  let cw: number, ch: number, lab: number;
  if (s.orient === 'land') {
    // A4 橫印（4–12 排各區）：維持 11-20a 的算法
    const totalCols = ps.reduce((n, p) => n + colsOf(p) + 2, 0);
    const rows = Math.max(...ps.map(rowsOf));
    const W = 277 - (ps.length - 1) * 10 - 16;
    const H = 180 - 22;
    lab = 4.2;
    cw = ch = Math.max(6, Math.min(18, W / totalCols, H / rows - lab));
  } else {
    // A4 直印：寬 194mm、可用高約 236mm（扣標題、舞台）；格子可以比高更寬
    lab = 5.5;
    const H = 236;
    if (s.stack) {
      const maxCols = Math.max(...ps.map(colsOf));
      const rows = ps.reduce((n, p) => n + rowsOf(p), 0);
      cw = Math.min(26, (194 - 17) / maxCols);
      ch = Math.min(18, (H - ps.length * 6 - (ps.length - 1) * 4) / rows - lab);
    } else {
      const sumCols = ps.reduce((n, p) => n + colsOf(p), 0);
      const rows = Math.max(...ps.map(rowsOf));
      cw = Math.min(26, (194 - ps.length * 17 - (ps.length - 1) * 8) / sumCols);
      ch = Math.min(18, H / rows - lab);
    }
    cw = Math.max(6, cw); ch = Math.max(6, ch);
  }
  return (
    <section className={`cs-sheet cs-${s.orient}`}>
      <div className="cs-head">
        <h1>{s.title}</h1>
        <div>{ev.name}・列印 {tw(now)}・本系統 QR {s.qr} 席・列印時已入場 {s.entered} 席</div>
        <div className="cs-legend">☐ 未入場（入場後打勾）　✓ 列印時已入場　紙＝持紙本票　灰色＝非本系統票（年代票、未售）　框＝同一位買方（三樓為同一群）</div>
      </div>
      <div className="cs-stage">舞台方向 ↑</div>
      <div className={`cs-panels${s.stack ? ' cs-stack' : ''}`}>{ps.map((p, i) => <Panel key={i} seats={p} cw={cw} ch={ch} lab={lab} caption={s.stack ? BLOCK_NAME[p[0].block] : undefined} />)}</div>
    </section>
  );
}

/** 驗票打勾圖：一區一張（1–3 排、三樓銀區直印，其餘橫印） */
export default async function CheckSheetPage({ searchParams }: { searchParams: { s?: string } }) {
  const db = await getDb();
  const user = await sessionUser(db, cookies().get(SESSION_COOKIE)?.value);
  if (!user) return <main className="wrap"><div className="card">請先登入後台。<a href="/admin">前往登入</a></div></main>;
  if (user.role === 'finance') return <main className="wrap"><div className="card">會計帳號只能處理電子發票與對帳。</div></main>;
  const { event, sheets } = await checkSheets(db);
  const now = new Date().toISOString();
  const show = searchParams.s ? sheets.filter((s) => s.key === searchParams.s) : sheets;
  return (
    <main className="cs-wrap">
      {/* 全部列印時每張用自己的方向（Chrome／Edge 支援）；單張列印時整份用那張的方向 */}
      <style>{`@media print { @page { size: A4 ${show.length === 1 && show[0].orient === 'port' ? 'portrait' : 'landscape'}; margin: 8mm; } @page land { size: A4 landscape; margin: 8mm; } @page port { size: A4 portrait; margin: 8mm; } .cs-land { page: land; } .cs-port { page: port; } }`}</style>
      <div className="no-print row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
        <span>列印：</span>
        {searchParams.s ? <a href="?">全部 {sheets.length} 張</a> : <b>全部 {sheets.length} 張</b>}
        {sheets.map((s) => (searchParams.s === s.key ? <b key={s.key}>{s.title}</b> : <a key={s.key} href={`?s=${s.key}`}>{s.title}</a>))}
        <PrintButton />
      </div>
      <p className="no-print small muted">A4（1–3 排、三樓銀區直印，其餘橫印）。建議用 Chrome 或 Edge 列印；方向不對時改成單張列印。含買方姓名，活動後收回銷毀，請勿拍照外傳。</p>
      {show.map((s) => <SheetView key={s.key} s={s} ev={event} now={now} />)}
    </main>
  );
}
