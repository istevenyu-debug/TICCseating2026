'use client';

import { useEffect, useState } from 'react';

type BoardState = Awaited<ReturnType<typeof import('@/lib/checkinBoard').boardAdminState>>;
type Act = (body: Record<string, unknown>, ok?: string) => Promise<unknown>;
interface Props {
  b: BoardState; eventName: string; act: Act; busy: boolean; sure: string | null; confirm2: (key: string, fn: () => void) => void;
  setMsg: (m: { kind: 'ok' | 'err' | 'warn'; text: string } | null) => void;
}

/** 九、驗票：驗票即時看板的連結與框設定（系統管理員） */
export default function BoardAdmin({ b, eventName, act, busy, sure, confirm2, setMsg }: Props) {
  const [edit, setEdit] = useState(false);
  const [boxes, setBoxes] = useState(b.boxes.map((x) => ({ name: x.name, hidden: x.hidden })));
  const [assign, setAssign] = useState<Record<string, string>>(() => Object.fromEntries(b.sources.map((s) => [s.key, s.box])));
  const [newBox, setNewBox] = useState('');
  useEffect(() => { if (!edit) { setBoxes(b.boxes.map((x) => ({ name: x.name, hidden: x.hidden }))); setAssign(Object.fromEntries(b.sources.map((s) => [s.key, s.box]))); } }, [b, edit]);

  const url = typeof window !== 'undefined' && b.link.token ? `${location.origin}/checkin/${b.link.token}` : '';
  const copy = (withText: boolean) => navigator.clipboard?.writeText(withText
    ? `【${eventName}】驗票即時看板（只有人數，沒有個資；每 5 秒自動更新）：\n${url}\n請勿外流。`
    : url).then(() => setMsg({ kind: 'ok', text: '已複製看板連結' }), () => undefined);

  const rename = (i: number, name: string) => {
    const old = boxes[i].name;
    setBoxes(boxes.map((x, j) => (j === i ? { ...x, name } : x)));
    setAssign(Object.fromEntries(Object.entries(assign).map(([k, v]) => [k, v === old ? name : v])));
  };
  const move = (i: number, d: number) => {
    const j = i + d; if (j < 0 || j >= boxes.length) return;
    const n = [...boxes]; [n[i], n[j]] = [n[j], n[i]]; setBoxes(n);
  };
  const save = async () => {
    if (await act({ action: 'board.boxes', boxes, assign }, '已儲存看板的框設定')) setEdit(false);
  };
  const totalOf = (name: string) => b.sources.filter((s) => assign[s.key] === name).reduce((a, s) => a + s.total, 0);

  return (
    <div className="card">
      <h2>驗票即時看板 <span className="small muted">獨立連結，傳給需要看人數的人；只有數字、沒有姓名</span></h2>
      {!b.link.token ? (
        <button className="btn pri small" disabled={busy} onClick={() => act({ action: 'board.link', renew: true }, '已建立看板連結')}>建立看板連結</button>
      ) : (
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <span className={`pill ${b.link.active ? 'p-paid' : 'p-cancelled'}`}>{b.link.active ? '使用中' : '已停用'}</span>
          <button className="btn small pri" disabled={!b.link.active} onClick={() => copy(true)}>複製連結＋說明</button>
          <button className="btn small" disabled={!b.link.active} onClick={() => copy(false)}>只複製連結</button>
          <a className={`btn small${b.link.active ? '' : ' disabled'}`} href={b.link.active ? `/checkin/${b.link.token}` : undefined} target="_blank" rel="noreferrer">開啟</a>
          <button className="btn small" disabled={busy} onClick={() => act({ action: 'board.link', active: !b.link.active }, b.link.active ? '已停用看板連結' : '已啟用看板連結')}>{b.link.active ? '停用' : '啟用'}</button>
          <button className="btn small" disabled={busy} onClick={() => confirm2('board-renew', () => act({ action: 'board.link', renew: true }, '已換新看板連結，舊連結立即失效，請把新連結傳給要看的人'))}>
            {sure === 'board-renew' ? '確定換新？舊連結會失效' : '換新連結'}</button>
        </div>
      )}

      <div className="tbl" style={{ marginTop: 10, maxWidth: 420 }}><table>
        <thead><tr><th>框</th><th style={{ textAlign: 'right' }}>已驗</th><th style={{ textAlign: 'right' }}>應驗</th></tr></thead>
        <tbody>{b.boxes.filter((x) => !x.hidden && (x.total || x.done)).map((x) => (
          <tr key={x.name}><td>{x.name}</td><td className="mono" style={{ textAlign: 'right' }}>{x.done}</td><td className="mono" style={{ textAlign: 'right' }}>{x.total}</td></tr>
        ))}</tbody>
      </table></div>

      {!edit ? (
        <button className="btn small" style={{ marginTop: 8 }} onClick={() => setEdit(true)}>設定框（改名、排序、隱藏、哪些票算哪一框）</button>
      ) : (
        <div className="note" style={{ marginTop: 8 }}>
          <b>框</b>
          {boxes.map((x, i) => (
            <div key={i} className="row" style={{ gap: 4, marginTop: 4 }}>
              <input value={x.name} maxLength={20} style={{ flex: 1, minWidth: 0 }} onChange={(e) => rename(i, e.target.value)} />
              <span className="small muted" style={{ width: 44, textAlign: 'right' }}>{totalOf(x.name)}</span>
              <button className="btn small" onClick={() => move(i, -1)} aria-label="上移">↑</button>
              <button className="btn small" onClick={() => move(i, 1)} aria-label="下移">↓</button>
              <label className="check small"><input type="checkbox" checked={!!x.hidden} onChange={(e) => setBoxes(boxes.map((y, j) => (j === i ? { ...y, hidden: e.target.checked } : y)))} />隱藏</label>
            </div>
          ))}
          <form className="row" style={{ gap: 4, marginTop: 6 }} onSubmit={(e) => { e.preventDefault(); const n = newBox.trim(); if (n && !boxes.some((x) => x.name === n)) { setBoxes([...boxes, { name: n, hidden: false }]); setNewBox(''); } }}>
            <input value={newBox} maxLength={20} placeholder="新增框，例：貴賓" style={{ flex: 1 }} onChange={(e) => setNewBox(e.target.value)} />
            <button className="btn small" disabled={!newBox.trim()}>新增</button>
          </form>
          <b style={{ display: 'block', marginTop: 10 }}>哪些票算哪一框</b>
          {b.sources.map((s) => (
            <div key={s.key} className="row" style={{ gap: 6, marginTop: 4, justifyContent: 'space-between' }}>
              <span className="small">{s.label} <span className="muted">（{s.total} 張）</span></span>
              <select value={assign[s.key] ?? ''} style={{ width: 'auto' }} onChange={(e) => setAssign({ ...assign, [s.key]: e.target.value })}>
                {boxes.map((x) => <option key={x.name} value={x.name}>{x.name}</option>)}
              </select>
            </div>
          ))}
          <div className="row" style={{ marginTop: 10 }}>
            <button className="btn pri small" disabled={busy} onClick={save}>儲存</button>
            <button className="btn small" onClick={() => setEdit(false)}>取消</button>
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>VIP 排的座位一律算「VIP 排」；招待依類別（招待／公益…）。沒有票的框，看板上不顯示（年代、3F 贈票除外）。</p>
        </div>
      )}
      <p className="small muted" style={{ margin: '8px 0 0' }}>
        年代的應驗＝「十二」上傳的年代售出明細，依樓層算已售張數（要含全部樓層、全部票點，活動前請上傳最新的）。
        年代票的樓層看驗票手機上方選的「年代票樓層」。只有系統管理員能看到這裡。
      </p>
    </div>
  );
}
