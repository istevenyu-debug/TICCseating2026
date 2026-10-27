'use client';

import { useRef, useState } from 'react';
import type { AdminState } from '@/lib/admin';
import { bundleClass, bundleIndex } from '@/lib/bundle';

type Seat = AdminState['seats'][number];
export interface SeatLook { bg?: string; ink?: string; kind: 'free' | 'held' | 'pending' | 'sold' | 'blocked'; title: string; dim?: boolean }

interface Props {
  seats: Seat[];
  vipInstalled: boolean;
  look: (s: Seat) => SeatLook;
  /** 點按或拖曳塗刷：放開滑鼠時一次回傳所有經過的座位 */
  onPaint?: (seatIds: string[]) => void;
  caption?: string;
}

const ROW_LABEL_COLS = [8, 45];

export default function AdminMap({ seats, vipInstalled, look, onPaint, caption }: Props) {
  const [cell, setCell] = useState(22);
  const { linkRight } = bundleIndex(seats);
  const painting = useRef<Set<string> | null>(null);
  const [preview, setPreview] = useState<Set<string>>(new Set());

  const rows: { y: number; label: string }[] = [];
  if (vipInstalled) rows.push({ y: 1, label: 'VIP' });
  for (let r = 1; r <= 12; r++) rows.push({ y: r + 1, label: String(r) });

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
        <span className="row zoom small muted">
          縮放
          <button className="btn" aria-label="縮小" onClick={() => setCell((c) => Math.max(14, c - 2))}>−</button>
          <button className="btn" aria-label="放大" onClick={() => setCell((c) => Math.min(34, c + 2))}>＋</button>
        </span>
      </div>
      <div className="mapscroll" onPointerUp={finish} onPointerLeave={finish}>
        <div className="stage">舞台</div>
        <div className="hall" style={{ ['--cell' as string]: `${cell}px` }}>
          {rows.flatMap((r) => ROW_LABEL_COLS.map((c) => (
            <div key={`${r.y}-${c}`} className="rl" style={{ gridColumn: c, gridRow: r.y }}>{r.label}</div>
          )))}
          {seats.filter((s) => s.installed).map((s) => {
            const L = look(s);
            const hot = preview.has(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className={`seat${s.type === 'wheelchair' ? ' wheel' : ''}${hot ? ' sel' : ''}${bundleClass(s, linkRight)}`}
                data-k={L.kind}
                style={{ gridColumn: s.x, gridRow: s.y, ['--z' as string]: L.bg, color: L.ink, opacity: L.dim ? 0.45 : undefined, cursor: onPaint ? 'pointer' : 'default' }}
                title={L.title}
                aria-label={L.title}
                onPointerDown={(e) => { if (!onPaint) return; e.preventDefault(); painting.current = new Set([s.id]); setPreview(new Set([s.id])); }}
                onPointerEnter={() => add(s.id)}
              >
                {s.no}
              </button>
            );
          })}
        </div>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        游標停在座位上可看座位編號（排-席次-區）。{onPaint ? '點按或按住拖曳可一次設定多個座位，已有訂單的座位不會被改。' : ''}
      </p>
    </div>
  );
}
