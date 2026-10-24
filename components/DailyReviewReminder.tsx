import React, { useEffect, useRef, useState } from 'react';
import { useLanguage } from '../contexts/LanguageContext';
import './DailyReviewReminder.css';

export function ReviewBadge({ count, onClick, anchorRef, disabled = false }: {
  count: number; onClick: () => void; disabled?: boolean; anchorRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const { isZh } = useLanguage();
  if (count <= 0) return null;
  const label = disabled ? (isZh ? `${count} 个单词待复习，完成当前操作后返回首页查看` : `${count} words due. Finish this activity and return to the dashboard to review.`) : isZh ? `${count} 个单词待复习，查看今日复习` : `${count} words due for review. Open today's review`;
  return <button ref={anchorRef} type="button" className="review-badge" disabled={disabled} onClick={onClick} aria-label={label} title={label} data-testid="review-badge">
    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2" strokeLinecap="round" strokeLinejoin="round"/></svg>
    <span>{count}</span>
  </button>;
}

export function DailyReviewReminder({ count, anchorRef, onClose, onStart }: {
  count: number; anchorRef: React.RefObject<HTMLButtonElement | null>; onClose: () => void; onStart: () => void;
}) {
  const { isZh } = useLanguage();
  const dialogRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLDivElement>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const flightRef = useRef<HTMLSpanElement>(null);
  const dismissRef = useRef<() => void>(() => {});
  const [flight, setFlight] = useState<{ x: number; y: number; dx: number; dy: number } | null>(null);
  const closing = useRef(false);
  const closeCallback = useRef(onClose);
  closeCallback.current = onClose;

  const dismiss = () => {
    if (closing.current) return;
    closing.current = true;
    const from = countRef.current?.getBoundingClientRect();
    const to = anchorRef.current?.getBoundingClientRect();
    if (!from || !to || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    const x = from.left + from.width / 2 - 30;
    const y = from.top + from.height / 2 - 18;
    setFlight({ x, y, dx: to.left + to.width / 2 - 30 - x, dy: to.top + to.height / 2 - 18 - y });
  };
  dismissRef.current = dismiss;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    startRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); dismissRef.current(); }
      if (event.key === 'Tab') {
        const buttons = [...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const first = buttons[0], last = buttons[buttons.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => {
    if (!flight || !flightRef.current) return;
    const animation = flightRef.current.animate([
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${flight.dx}px, ${flight.dy}px) scale(.82)`, opacity: .9 },
    ], { duration: 480, easing: 'cubic-bezier(.3,.1,.2,1)', fill: 'forwards' });
    animation.onfinish = () => closeCallback.current();
    return () => { animation.onfinish = null; animation.cancel(); };
  }, [flight]);

  return <>
    <div className={`review-reminder-backdrop ${flight ? 'is-leaving' : ''}`} onClick={() => dismiss()}>
      <div ref={dialogRef} className="review-reminder" role="dialog" aria-modal="true" aria-labelledby="review-reminder-title" aria-describedby="review-reminder-description" data-testid="daily-review-reminder" onClick={event => event.stopPropagation()}>
        <div className="review-reminder-kicker">{isZh ? '今日复习' : 'YOUR DAILY REVIEW'}</div>
        <button type="button" className="review-reminder-close" onClick={dismiss} aria-label={isZh ? '稍后复习' : 'Review later'}>×</button>
        <div ref={countRef} className="review-reminder-count">{count}<span>{isZh ? '个待复习单词' : 'WORDS READY'}</span></div>
        <h2 id="review-reminder-title">{isZh ? '趁记忆还热，再练一轮。' : 'Keep those words with you.'}</h2>
        <p id="review-reminder-description">{isZh ? '优先巩固到期和容易遗忘的单词。先完成一小组，让下一次回忆更轻松。' : 'Revisit the words due now and those most likely to fade. A short round makes the next recall easier.'}</p>
        <button ref={startRef} type="button" className="review-reminder-start" disabled={!!flight} onClick={onStart}>{isZh ? `开始复习 ${Math.min(12, count)} 个词` : `Review ${Math.min(12, count)} words`}<span aria-hidden="true">↗</span></button>
        <button type="button" className="review-reminder-later" disabled={!!flight} onClick={dismiss}>{isZh ? '稍后再练 · 提醒收进右上角' : 'Later · keep it in the top bar'}</button>
      </div>
    </div>
    {flight && <span ref={flightRef} aria-hidden="true" className="review-reminder-flight" style={{ left: flight.x, top: flight.y }}>{count}</span>}
  </>;
}
