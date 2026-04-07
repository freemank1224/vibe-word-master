import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  adminService,
  PronunciationReplacementStatus,
} from '../services/adminService';
import { WORD_LEARNING_CONFIG } from '../config/wordLearningConfig';
import { HoverTranslationText } from './HoverTranslationText';

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: '60px',
  right: '60px',
  width: '720px',
  maxWidth: 'calc(100vw - 32px)',
  height: '82vh',
  backgroundColor: '#151515',
  color: '#e8e8e8',
  borderRadius: '16px',
  boxShadow: '0 20px 60px rgba(0,0,0,0.55)',
  zIndex: 10000,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  border: '1px solid #2f2f2f',
  fontFamily: 'monospace',
};

const HEADER_STYLE: React.CSSProperties = {
  padding: '16px 20px',
  borderBottom: '1px solid #2d2d2d',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  background: 'linear-gradient(180deg, #232323 0%, #1b1b1b 100%)',
};

const CONTENT_STYLE: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '18px 20px 20px',
};

const CARD_STYLE: React.CSSProperties = {
  background: '#202020',
  border: '1px solid #333',
  borderRadius: '12px',
  padding: '14px',
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: '10px 14px',
  borderRadius: '10px',
  border: '1px solid #444',
  cursor: 'pointer',
  fontWeight: 700,
  color: 'white',
  background: '#2563eb',
};

const LOG_STYLE: React.CSSProperties = {
  marginTop: '16px',
  padding: '12px',
  backgroundColor: '#090909',
  borderRadius: '12px',
  border: '1px solid #232323',
  height: '220px',
  overflowY: 'auto',
  fontSize: '11px',
  whiteSpace: 'pre-wrap',
};

interface PronunciationMaintenancePanelProps {
  onClose: () => void;
}

export const PronunciationMaintenancePanel: React.FC<PronunciationMaintenancePanelProps> = ({ onClose }) => {
  const superAdminEmail = WORD_LEARNING_CONFIG.pronunciation.superAdminEmail;
  const [logs, setLogs] = useState<string[]>([]);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<PronunciationReplacementStatus | null>(null);
  const [isDispatching, setIsDispatching] = useState(false);
  const [isPurgingOrphans, setIsPurgingOrphans] = useState(false);
  const [isPurgingAll, setIsPurgingAll] = useState(false);
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    setLogs((prev) => [...prev.slice(-149), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    if (!currentRunId) return;

    let timer: number | undefined;
    let active = true;

    const poll = async () => {
      try {
        const status = await adminService.getPronunciationReplacementStatus(currentRunId);
        if (!active) return;
        setProgress(status);

        if (status.message) {
          addLog(`Run ${status.runId.slice(0, 8)}: ${status.message}`);
        }

        if (status.status === 'completed' || status.status === 'failed' || status.status === 'cancelled') {
          setIsDispatching(false);
          return;
        }
      } catch (error: any) {
        addLog(`Status polling failed: ${error?.message || error}`);
        setIsDispatching(false);
        return;
      }

      timer = window.setTimeout(poll, 1500);
    };

    void poll();

    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [currentRunId]);

  const statusTone = useMemo(() => {
    switch (progress?.status) {
      case 'running':
        return '#22c55e';
      case 'completed':
        return '#38bdf8';
      case 'failed':
        return '#ef4444';
      case 'cancelled':
        return '#f59e0b';
      default:
        return '#666';
    }
  }, [progress?.status]);

  const startReplacement = async (forceRegenerate = false) => {
    if (isDispatching) return;
    setIsDispatching(true);
    const modeLabel = forceRegenerate ? 'force-regenerate' : 'rebuild-missing';
    addLog(`Starting pronunciation task: ${modeLabel}`);

    try {
      const result = await adminService.replaceAllPronunciations((msg) => addLog(msg), undefined, { forceRegenerate });
      setCurrentRunId(result.runId);
      addLog(`Replacement task accepted. runId=${result.runId}`);
    } catch (error: any) {
      setIsDispatching(false);
      addLog(`Replacement task failed to start: ${error?.message || error}`);
    }
  };

  const stopReplacement = async () => {
    if (!currentRunId) return;
    addLog(`Stopping run ${currentRunId}...`);
    try {
      await adminService.stopPronunciationReplacement(currentRunId);
      addLog('Stop signal sent.');
      setProgress((prev) => prev ? { ...prev, status: 'cancelled', message: 'Stop signal sent by admin' } : prev);
    } catch (error: any) {
      addLog(`Stop failed: ${error?.message || error}`);
    } finally {
      setIsDispatching(false);
    }
  };

  const purgeOrphanedAudio = async () => {
    if (isPurgingOrphans) return;
    setIsPurgingOrphans(true);
    addLog('Scanning orphaned pronunciation assets...');

    try {
      const result = await adminService.purgeOrphanedAudioAssets((msg) => addLog(msg));
      addLog(`Orphan cleanup complete. assets=${result.deletedAssets}, storage=${result.deletedStorageObjects}`);
    } catch (error: any) {
      addLog(`Orphan cleanup failed: ${error?.message || error}`);
    } finally {
      setIsPurgingOrphans(false);
    }
  };

  const purgeAllMinimax = async () => {
    if (isPurgingAll) return;
    const confirmed = confirm('危险操作：将删除全部 Minimax 发音资产。确认继续？');
    if (!confirmed) return;

    setIsPurgingAll(true);
    addLog('Purging all Minimax pronunciation assets...');

    try {
      const result = await adminService.purgeAllMinimaxPronunciations((msg) => addLog(msg));
      addLog(`Full purge complete. assets=${result.deletedAssets}, storage=${result.deletedStorageObjects}`);
    } catch (error: any) {
      addLog(`Full purge failed: ${error?.message || error}`);
    } finally {
      setIsPurgingAll(false);
    }
  };

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <div>
          <div style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '0.08em' }}>
            🔊 <HoverTranslationText text="Pronunciation Maintenance" translation="发音维护面板" />
          </div>
          <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
            <HoverTranslationText text="Hidden admin panel for global audio rebuild and cleanup" translation="用于全局音频重建与清理的隐藏管理员面板" />
          </div>
          <div style={{ fontSize: '11px', color: '#7dd3fc', marginTop: '6px' }}>
            超级管理员：{superAdminEmail} ｜ 热键：Cmd/Ctrl + Shift + Y
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#999', cursor: 'pointer', fontSize: '24px' }}>×</button>
      </div>

      <div style={CONTENT_STYLE}>
        <div style={{ ...CARD_STYLE, marginBottom: '14px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr 1fr', gap: '12px', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '11px', color: '#8b8b8b', marginBottom: '6px' }}>CURRENT STATUS</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '15px', fontWeight: 700 }}>
                <span style={{ width: '10px', height: '10px', borderRadius: '999px', background: statusTone, display: 'inline-block' }}></span>
                {progress?.status || 'idle'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#8b8b8b', marginBottom: '6px' }}>PROGRESS</div>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{progress ? `${progress.done}/${progress.total}` : '0/0'}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#8b8b8b', marginBottom: '6px' }}>GENERATED</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#22c55e' }}>{progress?.generated || 0}</div>
            </div>
            <div>
              <div style={{ fontSize: '11px', color: '#8b8b8b', marginBottom: '6px' }}>FAILED</div>
              <div style={{ fontSize: '18px', fontWeight: 700, color: '#ef4444' }}>{progress?.failed || 0}</div>
            </div>
          </div>
          {progress?.message && (
            <div style={{ marginTop: '12px', fontSize: '12px', color: '#cfcfcf' }}>{progress.message}</div>
          )}
          {currentRunId && (
            <div style={{ marginTop: '10px', fontSize: '11px', color: '#7dd3fc' }}>runId: {currentRunId}</div>
          )}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div style={CARD_STYLE}>
            <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>
              <HoverTranslationText text="Rebuild Controls" translation="重建控制" />
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.7, marginBottom: '12px' }}>
              <HoverTranslationText text="Rebuild missing audio or force-regenerate the whole pronunciation library." translation="补建缺失音频，或强制重建整个发音词库。" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button style={BUTTON_STYLE} onClick={() => startReplacement(false)} disabled={isDispatching || isPurgingAll || isPurgingOrphans}>
                {isDispatching ? '任务派发中...' : '重建缺失音频'}
              </button>
              <button style={{ ...BUTTON_STYLE, background: '#7c3aed' }} onClick={() => startReplacement(true)} disabled={isDispatching || isPurgingAll || isPurgingOrphans}>
                强制重建全库音频
              </button>
              <button style={{ ...BUTTON_STYLE, background: '#f59e0b' }} onClick={stopReplacement} disabled={!currentRunId}>
                停止当前任务
              </button>
            </div>
          </div>

          <div style={CARD_STYLE}>
            <div style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px' }}>
              <HoverTranslationText text="Cleanup Controls" translation="清理控制" />
            </div>
            <div style={{ fontSize: '11px', color: '#9ca3af', lineHeight: 1.7, marginBottom: '12px' }}>
              <HoverTranslationText text="Clean orphaned audio first. Use full purge only for destructive maintenance." translation="优先清理孤儿音频。全量删除仅用于破坏性维护场景。" />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <button style={{ ...BUTTON_STYLE, background: '#0f766e' }} onClick={purgeOrphanedAudio} disabled={isPurgingOrphans || isDispatching || isPurgingAll}>
                {isPurgingOrphans ? '扫描中...' : '扫描并清理孤儿音频'}
              </button>
              <button style={{ ...BUTTON_STYLE, background: '#dc2626' }} onClick={purgeAllMinimax} disabled={isPurgingAll || isDispatching || isPurgingOrphans}>
                {isPurgingAll ? '删除中...' : '删除全部 Minimax 音频'}
              </button>
            </div>
          </div>
        </div>

        <div style={LOG_STYLE}>
          {logs.length === 0 && <div style={{ color: '#6b7280' }}>No maintenance logs yet.</div>}
          {logs.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
};
