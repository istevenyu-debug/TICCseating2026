'use client';

import { useState } from 'react';
import { bundleClass, bundleIndex } from '@/lib/bundle';
import type { BookingState } from '@/lib/booking';
import { inkFor } from '@/lib/color';

type Seat = BookingState['seats'][number];

interface Props {
  seats: Seat[];
  zones: BookingState['zones'];
  vipInstalled: boolean;
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** 點到不能選的座位：說明原因（不屬於這個購票方式／不開放／已被訂） */
  onBlocked?: (id: string, why: 'off' | 'blocked' | 'taken') => void;
  locked: boolean; // 暫存中：不可再改選
  /** 目前購票方式可選的票種；其他座位變淡、不能選 */
  allowed?: Set<number>;
  /** 送出後：只框出這些座位，其他全部淡化 */
  focus?: Set<string> | null;
}

const ROW_LABEL_COLS = [8, 45];

export default function SeatMap({ seats, zones, vipInstalled, selected, onToggle, onBlocked, locked, allowed, focus }: Props) {
  const [cell, setCell] = useState(22);
  const zone = Object.fromEntries(zones.map((z) => [z.id, z]));
  const fmt = (n: number) => `NT$${n.toLocaleString('en-US')}`;
  const { linkRight, groups } = bundleIndex(seats);

  const rows: { y: number; label: string }[] = [];
  if (vipInstalled) rows.push({ y: 1, label: 'VIP' });
  for (let r = 1; r <= 12; r++) rows.push({ y: r + 1, label: String(r) });

  return (
    <div className="card">
      <div className="mapbar">
        <div className="legend">
          {zones.filter((z) => seats.some((s) => s.zoneId === z.id)).map((z) => (
            <span key={z.id}><i style={{ background: z.color }} />{z.name} {fmt(z.price)}</span>
          ))}
          <span><i style={{ outline: '2px solid var(--red)', outlineOffset: -2 }} />已勾選</span>
          <span><i style={{ background: 'repeating-linear-gradient(-45deg,var(--sold) 0 2px,transparent 2px 5px)' }} />他人暫存中</span>
          <span><i style={{ background: 'var(--pending)' }} />待確認</span>
          <span><i style={{ background: 'var(--sold)' }} />已售出</span>
          <span><i style={{ borderStyle: 'dashed' }} />不開放</span>
          {groups.size > 0 && <span><i className="pairi" />連座：按一下選整組</span>}
        </div>
        <span className="row zoom small muted">
          縮放
          <button className="btn" aria-label="縮小" onClick={() => setCell((c) => Math.max(14, c - 2))}>−</button>
          <button className="btn" aria-label="放大" onClick={() => setCell((c) => Math.min(34, c + 2))}>＋</button>
        </span>
      </div>
      <div className="mapscroll">
        <div className="stage">舞台</div>
        <div className="hall" style={{ ['--cell' as string]: `${cell}px` }}>
          {rows.flatMap((r) => ROW_LABEL_COLS.map((c) => (
            <div key={`${r.y}-${c}`} className="rl" style={{ gridColumn: c, gridRow: r.y }}>{r.label}</div>
          )))}
          {seats.map((s) => {
            const z = zone[s.zoneId];
            const isFocus = !!focus && focus.has(s.id);
            const isSel = selected.has(s.id) || isFocus;
            const off = focus ? !isFocus : !!allowed && s.status === 'free' && !allowed.has(s.zoneId) && !isSel; // 不屬於目前購票方式的座位
            const clickable = !locked && !off && (s.status === 'free' || isSel);
            const title = `${s.label}・${s.code}${z ? `・${z.name} ${fmt(z.price)}` : '・未開放'}${s.bundle ? `・連座 ${groups.get(s.bundle)?.length ?? 0} 位一組` : ''}`;
            return (
              <button
                key={s.id}
                type="button"
                className={`seat${off ? ' off' : ''}${isSel && (s.status !== 'mine' || isFocus) ? ' sel' : ''}${s.type === 'wheelchair' ? ' wheel' : ''}${bundleClass(s, linkRight)}`}
                data-k={s.status}
                style={{ gridColumn: s.x, gridRow: s.y, ['--z' as string]: z?.color, color: z && (s.status === 'free' || isSel) ? inkFor(z.color) : undefined }}
                title={title}
                aria-label={title}
                aria-pressed={isSel}
                aria-disabled={!clickable}
                onClick={() => (clickable ? onToggle(s.id) : !locked && onBlocked?.(s.id, off ? 'off' : s.status === 'blocked' ? 'blocked' : 'taken'))}
              >
                {s.no}
              </button>
            );
          })}
        </div>
      </div>
      <p className="small muted" style={{ margin: '10px 0 0' }}>
        單號在左、雙號在右，由中央往兩側編號。右上角圓點為輪椅席。按一下座位出現紅框表示勾選，再按一下取消；連座（下緣有粗線、彼此相連）按一下會同時選整組。游標停在座位上可看座位編號（排-席次-區）。
      </p>
    </div>
  );
}
