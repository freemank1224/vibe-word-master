import { useState } from 'react';
import type { SurfRunReview as SurfRunReviewData, SurfReviewWordStatus } from './runReview';
import type { SurfWord } from './types';
import './surf-run-review.css';

interface SurfRunReviewProps {
  review: SurfRunReviewData;
  isZh: boolean;
  onReplay?: (word: SurfWord) => void;
}

const STATUS_LABELS: Record<SurfReviewWordStatus, readonly [string, string]> = {
  'first-try-correct': ['首次答对', 'First try'],
  corrected: ['已纠正', 'Corrected'],
  incorrect: ['待复习', 'Needs review'],
  unanswered: ['未作答', 'Unanswered'],
  'not-reached': ['未遇到', 'Not reached'],
};

function SpeakerIcon() {
  return <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m11 5-6 4H2v6h3l6 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>;
}

/** Review is read-only: listening and filtering never record another learning attempt. */
export function SurfRunReview({ review, isZh, onReplay }: SurfRunReviewProps) {
  const [filter, setFilter] = useState<'all' | 'mistakes'>('all');
  const t = (zh: string, en: string) => isZh ? zh : en;
  const rows = filter === 'mistakes' ? review.rows.filter(row => row.mistakeCount > 0) : review.rows;
  const accuracy = review.firstAnswerAccuracy === null ? '—' : `${Math.round(review.firstAnswerAccuracy)}%`;

  return <section className="ms-word-review" aria-labelledby="ms-word-review-title" data-testid="surf-word-review">
    <div className="ms-review-metrics">
      <div className="ms-review-accuracy">
        <span>{t('首次听写正确率', 'FIRST-TRY ACCURACY')}</span>
        <strong data-testid="surf-review-accuracy">{accuracy}</strong>
        <small>{t(`首次答对 ${review.firstTryCorrectCount} / 已作答 ${review.attemptedCount}`, `${review.firstTryCorrectCount} first correct / ${review.attemptedCount} attempted`)}</small>
      </div>
      <div className="ms-review-tally"><strong>{review.attemptedCount}<i> / {review.totalCount}</i></strong><span>{t('已作答单词', 'WORDS ATTEMPTED')}</span></div>
      <div className="ms-review-tally is-mistakes"><strong>{review.wrongWordCount}</strong><span>{t('答错过的单词', 'WORDS WITH MISTAKES')}</span></div>
    </div>
    <p className="ms-review-accuracy-note">{t('按每个词的首次提交统计；未作答与未遇到的词不计入正确率。', 'Based on each word’s first submission. Unanswered and unreached words are excluded.')}</p>
    <div className="ms-review-toolbar">
      <h3 id="ms-word-review-title">{t('单词复盘', 'WORD REVIEW')}</h3>
      <div className="ms-review-filters" role="group" aria-label={t('筛选复盘单词', 'Filter reviewed words')}>
        <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')} data-testid="surf-review-all">{t('全部', 'All')} <b>{review.totalCount}</b></button>
        <button type="button" aria-pressed={filter === 'mistakes'} onClick={() => setFilter('mistakes')} data-testid="surf-review-mistakes">{t('错词', 'Mistakes')} <b>{review.wrongWordCount}</b></button>
      </div>
    </div>
    <div className="ms-review-scroll" tabIndex={0} role="region" aria-label={filter === 'mistakes' ? t('错词清单，包含已纠正的单词', 'Mistake list, including corrected words') : t('本局全部单词', 'All words in this ride')}>
      {rows.length ? <ol className="ms-review-word-list">
        {rows.map(row => <li className={`ms-review-word is-${row.status}`} key={row.key} data-review-status={row.status} data-review-word={row.word.answer}>
          <span className="ms-review-word-number" aria-label={t(`第 ${row.index + 1} 词`, `Word ${row.index + 1}`)}>{String(row.index + 1).padStart(2, '0')}</span>
          <div className="ms-review-word-content">
            <div className="ms-review-word-heading"><strong lang="en">{row.word.answer}</strong><span className={`ms-review-word-status is-${row.status}`}>{STATUS_LABELS[row.status][isZh ? 0 : 1]}</span></div>
            <p className="ms-review-meaning" lang="zh-CN">{row.word.meaningZh}</p>
            {row.wrongAnswers.length > 0 && <div className="ms-review-wrong-answers"><span>{t(`错误拼写 ${row.mistakeCount} 次`, `${row.mistakeCount} incorrect ${row.mistakeCount === 1 ? 'submission' : 'submissions'}`)}</span><div>{row.wrongAnswers.map((answer, index) => <code lang="en" key={`${index}:${answer}`}>{answer}</code>)}</div></div>}
          </div>
          {onReplay && <button className="ms-review-replay" type="button" onClick={() => onReplay(row.word)} aria-label={t(`重听 ${row.word.answer}`, `Listen to ${row.word.answer}`)} title={t('重听单词', 'Listen to word')}><SpeakerIcon/></button>}
        </li>)}
      </ol> : <div className="ms-review-empty"><span aria-hidden="true">✓</span><strong>{t('没有错词', 'No mistakes to review')}</strong><p>{review.attemptedCount === 0 ? t('本局还没有提交答案。全部单词仍可在「全部」中查看。', 'No answers were submitted. You can still see the full deck under All.') : t('本局已作答的单词全部一次答对。', 'Every word you attempted was correct on the first try.')}</p><button type="button" onClick={() => setFilter('all')}>{t('查看全部单词', 'View all words')}</button></div>}
    </div>
    <p className="ms-review-footer-note">{filter === 'mistakes' ? t('已纠正的错词也会保留，方便再次巩固。', 'Corrected words stay in this list so you can practise them again.') : t(`已完成 ${review.completedCount} · 已纠正 ${review.correctedCount} · 未作答 ${review.unansweredCount} · 未遇到 ${review.notReachedCount}`, `${review.completedCount} completed · ${review.correctedCount} corrected · ${review.unansweredCount} unanswered · ${review.notReachedCount} not reached`)}</p>
  </section>;
}
