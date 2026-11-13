'use client';

import { useRef, useState } from 'react';
import type { AdminState } from '@/lib/admin';
import { bundleClass, bundleIndex } from '@/lib/bundle';
import { rowLabelCols, rowLabels, type Floor } from '@/lib/layout';

type Seat = AdminState['seats'][number];
export interface SeatLook { bg?: string; ink?: string; kind: 'free' | 'held' | 'pending' | 'sold' | 'blocked'; title: string; dim?: boolean; sel?: boolean }

interface Props {
  seats: Seat[];
  vipInstalled: boolean;
  look: (s: Seat) => SeatLook;
  /** 框選（預設）：按住拖出一個框，放開時回傳框裡的座位；塗刷：回傳拖曳經過的座位。點一下＝那一席 */
  onPaint?: (seatIds: string[]) => void;
  caption?: string;
  floor?: Floor;
}

export default function AdminMap({ seats, vipInstalled, look, onPaint, caption, floor = '2M' }: Props) {
  const [cell, setCell] = useState(22);
  const { linkRight } = bundleIndex(seats);
  const painting = useRef<Set<string> | null>(null);
  const [preview, setPreview] = useState<Set<string>>(new Set());
  // 編輯模式：平常只能看，按「開始設定」才能點選改動，避免手機捲動時誤點
  const [editing, setEditing] = useState(false);
  const canPaint = !!onPaint && editing;
  const [mode, setMode] = useState<'box' | 'brush'>('box');
  const hall = useRef<HTMLDivElement>(null);
  const box = useRef<{ x0: number; y0: number; x1: number; y1: number; id: number } | null>(null);
  const [rect, setRect] = useState<{ l: number; t: number; w: number; h: number } | null>(null);
  /** 框裡的座位（座位方塊和框有重疊就算） */
  const inBox = (b: { x0: number; y0: number; x1: number; y1: number }) => {
    const h = hall.current; if (!h) return [] as string[];
    const o = h.getBoundingClientRect();
    const L = Math.min(b.x0, b.x1) + o.left, R = Math.max(b.x0, b.x1) + o.left, T = Math.min(b.y0, b.y1) + o.top, B = Math.max(b.y0, b.y1) + o.top;
    const ids: string[] = [];
    h.querySelectorAll<HTMLElement>('button.seat[data-id]').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.right > L && r.left < R && r.bottom > T && r.top < B) ids.push(el.dataset.id!);
    });
    return ids;
  };
  const at = (e: React.PointerEvent) => { const o = hall.current!.getBoundingClientRect(); return { x: e.clientX - o.left, y: e.clientY - o.top }; };
  const boxDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canPaint || mode !== 'box' || e.button > 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = at(e);
    box.current = { x0: p.x, y0: p.y, x1: p.x + 1, y1: p.y + 1, id: e.pointerId };
    setRect({ l: p.x, t: p.y, w: 1, h: 1 });
    setPreview(new Set(inBox(box.current)));
  };
  const boxMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = box.current; if (!b || b.id !== e.pointerId) return;
    const p = at(e); b.x1 = p.x; b.y1 = p.y;
    setRect({ l: Math.min(b.x0, b.x1), t: Math.min(b.y0, b.y1), w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) });
    setPreview(new Set(inBox(b)));
  };
  const boxUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const b = box.current; if (!b || b.id !== e.pointerId) return;
    box.current = null; setRect(null);
    const ids = inBox(b);
    setPreview(new Set());
    if (ids.length && onPaint) onPaint(ids);
  };

  const rows = rowLabels(floor, vipInstalled);

  const finish = () => {
    const set = painting.current;
    painting.current = null;
    if (set && set.size && onPaint) onPaint([...set]);
    setPreview(new Set());
  };
  const add = (id: string) => {
    if (!painting.current) return;
    painting.current.add(id);
    setPreview(new Set(painting.current));
  };

  return (
    <div className="card">
      <div className="mapbar">
        <span className="small muted">{caption}</span>
        {onPaint && (editing
          ? <button className="btn pri small" onClick={() => setEditing(false)}>完成設定（鎖定）</button>
          : <button className="btn small" onClick={() => setEditing(true)}>開始設定（點座位改動）</button>)}
        {onPaint && editing && (
          <span className="row small" style={{ gap: 4 }}>
            <button className={`btn small${mode === 'box' ? ' pri' : ''}`} onClick={() => setMode('box')}>▭ 框選</button>
            <button className={`btn small${mode === 'brush' ? ' pri' : ''}`} onClick={() => setMode('brush')}>🖌 塗刷</button>
          </span>
        )}
        <span className="row zoom small muted">
          縮放
          <button className="btn" aria-label="縮小" onClick={() => setCell((c) => Math.max(14, c - 2))}>−</button>
          <button className="btn" aria-label="放大" onClick={() => setCell((c) => Math.min(34, c + 2))}>＋</button>
        </span>
      </div>
      {onPaint && editing && <div className="note warn small" style={{ margin: '6px 0' }}>設定中：{mode === 'box' ? '按住拖出一個框，放開時框裡的座位一次改好（點一下＝單一席）。手機框選時座位圖不能滑動，請先按「−」縮小，或切到「塗刷」。' : '點按或按住拖曳，經過的座位會改動。'}改完請按「完成設定」。</div>}
      <div className="mapscroll" style={{ touchAction: canPaint && mode === 'box' ? 'none' : undefined }}
        onPointerDown={boxDown} onPointerMove={boxMove} onPointerUp={(e) => { boxUp(e); finish(); }} onPointerCancel={boxUp} onPointerLeave={finish}>
        <div className="stage">舞台</div>
        <div ref={hall} className={`hall${floor === '3F' ? ' f3' : ''}`}
          style={{ ['--cell' as string]: `${cell}px`, position: 'relative', touchAction: canPaint && mode === 'box' ? 'none' : undefined }}>
          {rect && <div style={{ position: 'absolute', left: rect.l, top: rect.t, width: rect.w, height: rect.h, border: '2px dashed var(--red)', background: 'rgba(216,31,45,.08)', zIndex: 3, pointerEvents: 'none' }} />}
          {rows.flatMap((r) => rowLabelCols(floor).map((c) => (
            <div key={`${r.y}-${c}`} className="rl" style={{ gridColumn: c, gridRow: r.y }}>{r.label}</div>
          )))}
          {seats.filter((s) => s.installed).map((s) => {
            const L = look(s);
            const hot = preview.has(s.id) || !!L.sel;
            return (
              <button
                key={s.id}
                type="button"
                className={`seat${s.type === 'wheelchair' ? ' wheel' : ''}${hot ? ' sel' : ''}${bundleClass(s, linkRight)}`}
                data-k={L.kind}
                style={{ gridColumn: s.x, gridRow: s.y, ['--z' as string]: L.bg, color: L.ink, opacity: L.dim ? 0.45 : undefined, cursor: canPaint ? 'pointer' : 'default' }}
                title={L.title}
                aria-label={L.title}
                data-id={s.id}
                onPointerDown={(e) => { if (!canPaint || mode !== 'brush') return; e.preventDefault(); painting.current = new Set([s.id]); setPreview(new Set([s.id])); }}
                onPointerEnter={() => add(s.id)}
              >
                {s.no}
              </button>
            );
          })}
        </div>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        游標停在座位上可看座位編號（排-席次-區）。{onPaint ? (editing ? '框選或塗刷可一次設定多個座位，已有訂單的座位不會被改。' : '目前鎖定中，只能看；要改請按上方「開始設定」。') : ''}
      </p>
    </div>
  );
}
