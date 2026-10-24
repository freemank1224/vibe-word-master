import React, { useId } from 'react';
import './surf-launch-options.css';

export interface SurfLaunchProgress {
  loaded: number;
  total: number;
  status: 'loading' | 'ready' | 'error';
}

export interface SurfLaunchOptionsProps {
  isZh: boolean;
  /** 10–50 selects a fixed word count; 51 selects Endless Mode. */
  value: number;
  onChange: (value: number) => void;
  availableCount: number;
  /** An existing pre-selector ride retains its original deck, even above50. */
  savedWordCount?: number;
  disabled?: boolean;
  progress?: SurfLaunchProgress | null;
  onRetry?: () => void;
  onCancel?: () => void;
}

const LENGTH_TICKS = [10, 20, 30, 40, 50, 51] as const;

export function SurfLaunchOptions({
  isZh,
  value,
  onChange,
  availableCount,
  savedWordCount,
  disabled = false,
  progress = null,
  onRetry,
  onCancel,
}: SurfLaunchOptionsProps) {
  const id = useId();
  const t = (zh: string, en: string) => isZh ? zh : en;
  const selected = Math.min(51, Math.max(10, Math.round(value)));
  const available = Math.max(0, Math.floor(availableCount));
  const saved = savedWordCount !== undefined;
  const endless = !saved && selected === 51;
  const count = saved ? savedWordCount : endless ? available : Math.min(selected, available);
  const initialCount = endless ? Math.min(20, count) : count;
  const modeName = endless ? t('无尽模式', 'Endless Mode') : t(`${selected} 个词`, `${selected} words`);
  const note = saved
    ? t(`保留原航程的 ${count} 词；继续前加载剩余录音，不重复扣费。`, `Keep all ${count} saved words. Prepare the remaining recordings before resuming; no extra fee.`)
    : available === 0
    ? t('等待可用词库。', 'Waiting for available words.')
    : endless
      ? t(
        `先加载 ${initialCount} 词录音，再后台加载；遍历全部 ${count} 词一次。`,
        `Load ${initialCount} recordings first, then stream ahead. Cover all ${count} words once.`,
      )
      : count < selected
        ? t(
          `当前可用 ${count} 词；全部录音准备好后开始。`,
          `${count} words available. Start after all ${count} recordings are ready.`,
        )
        : t(
          `开场前加载全部 ${count} 词录音，游玩时直接播放。`,
          `Load all ${count} recordings before the ride for instant playback.`,
        );
  const total = progress ? Math.max(0, Math.floor(progress.total)) : 0;
  const loaded = progress ? Math.min(total, Math.max(0, Math.floor(progress.loaded))) : 0;
  const completion = total > 0 ? loaded / total * 100 : 0;
  const progressLabel = progress?.status === 'error'
    ? t('部分录音加载失败，请重试', 'Some recordings failed. Please retry.')
    : progress?.status === 'ready'
      ? t('录音已就绪', 'Recordings ready')
      : t('正在准备录音', 'Preparing recordings');

  return <section className={`ms-launch-options${endless ? ' is-endless' : ''}`} aria-labelledby={`${id}-label`}>
    <div className="ms-launch-heading">
      <label id={`${id}-label`} htmlFor={saved ? undefined : `${id}-range`}>{saved ? t('已保存航程', 'Saved ride') : t('本局词数', 'Ride length')}</label>
      <output htmlFor={`${id}-range`} className="ms-launch-value">
        <strong>{saved ? count : endless ? '∞' : selected}</strong>
        <span>{endless ? t('无尽模式', 'Endless Mode') : t('个单词', 'words')}</span>
      </output>
    </div>
    {!saved && <><input
      id={`${id}-range`}
      className="ms-launch-slider"
      type="range"
      min={10}
      max={51}
      step={1}
      value={selected}
      disabled={disabled || progress?.status === 'loading'}
      onChange={event => onChange(Number(event.currentTarget.value))}
      aria-valuetext={modeName}
      aria-describedby={`${id}-note`}
      style={{ '--launch-fill': `${(selected - 10) / 41 * 100}%` } as React.CSSProperties}
      data-testid="surf-word-count"
    />
    <div className="ms-launch-ticks" aria-hidden="true">
      {LENGTH_TICKS.map(tick => <span
        key={tick}
        className={tick === 51 ? 'is-endless-tick' : tick === 50 ? 'is-last-count' : undefined}
        style={{ left: `${(tick - 10) / 41 * 100}%` }}
      >{tick === 51 ? '∞' : tick}</span>)}
    </div></>}
    <p id={`${id}-note`} className="ms-launch-note">{note}</p>
    {progress && <div
      className={`ms-launch-preload is-${progress.status}`}
      data-testid="surf-audio-preload"
      data-status={progress.status}
    >
      <div className="ms-launch-preload-heading" role="status" aria-live="polite">
        <span>{progressLabel}</span>
        <strong>{loaded} / {total}</strong>
      </div>
      <div
        className="ms-launch-progress"
        role="progressbar"
        aria-label={t('录音预加载', 'Recording preload')}
        aria-valuemin={0}
        aria-valuemax={Math.max(1, total)}
        aria-valuenow={loaded}
      ><span style={{ width: `${completion}%` }} /></div>
      {progress.status !== 'ready' && (onRetry || onCancel) && <div className="ms-launch-loading-actions">
        {progress.status === 'error' && onRetry && <button type="button" onClick={onRetry}>{t('重试加载', 'Retry loading')}</button>}
        {onCancel && <button type="button" className="ms-launch-cancel" onClick={onCancel}>{t('取消', 'Cancel')}</button>}
      </div>}
    </div>}
  </section>;
}
