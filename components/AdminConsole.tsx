import React, { useState, useEffect, useRef } from 'react';
import { adminService, AdminStats } from '../services/adminService';
import { AISettings, AEServiceProvider, AITask } from '../services/ai/settings';
import { generateImagesForMissingWords, cancelGeneration } from '../services/imageGenerationTask';
import { getCurrentUserId } from '../services/dataService';
import { HoverTranslationText } from './HoverTranslationText';
import { SceneGameSettings } from '../services/sceneGameSettings';
import { probeSceneDirector, SceneDirectorProbeResult, cleanupOrphanSceneAssets, migrateScenePngsToWebp } from '../services/sceneGame';

const PANEL_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: '50px',
  right: '50px',
  width: '650px',
  height: '80vh',
  backgroundColor: '#1a1a1a',
  color: '#e0e0e0',
  borderRadius: '12px',
  boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
  zIndex: 9999,
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'monospace',
  overflow: 'hidden',
  border: '1px solid #333'
};

const HEADER_STYLE: React.CSSProperties = {
  padding: '16px',
  borderBottom: '1px solid #333',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  backgroundColor: '#252525'
};

const CONTENT_STYLE: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '16px',
};

const LOG_STYLE: React.CSSProperties = {
  marginTop: '16px',
  padding: '10px',
  backgroundColor: '#000',
  borderRadius: '4px',
  height: '200px',
  overflowY: 'scroll',
  fontSize: '11px',
  whiteSpace: 'pre-wrap'
};

const BUTTON_STYLE: React.CSSProperties = {
  padding: '8px 16px',
  borderRadius: '4px',
  border: 'none',
  cursor: 'pointer',
  marginRight: '8px',
  fontWeight: 'bold',
  backgroundColor: '#4a90e2',
  color: 'white'
};

const INPUT_STYLE: React.CSSProperties = {
  width: '100%',
  padding: '8px',
  marginBottom: '10px',
  backgroundColor: '#333',
  border: '1px solid #555',
  color: 'white',
  borderRadius: '4px'
};

const TAB_BUTTON_STYLE = (active: boolean): React.CSSProperties => ({
  ...BUTTON_STYLE,
  background: active ? '#333' : 'transparent',
  margin: 0,
  borderRadius: 0,
  borderBottom: active ? '2px solid #4a90e2' : 'none',
  flex: 1,
});

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
};

export const AdminConsole: React.FC<{ onClose: () => void, onDataChange?: () => void }> = ({ onClose, onDataChange }) => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'text' | 'scene'>('dashboard');
  const [logs, setLogs] = useState<string[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  
  const logEndRef = useRef<HTMLDivElement>(null);

  const addLog = (msg: string) => {
    setLogs(prev => [...prev.slice(-100), `[${new Date().toLocaleTimeString()}] ${msg}`]);
  };

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  useEffect(() => {
    loadStats();
  }, []);

  const loadStats = async () => {
    const s = await adminService.getStats();
    setStats(s);
  };

  const handleSync = async () => {
    if (isSyncing || isRunning) return;
    try {
      setIsSyncing(true);
      addLog("Starting Dictionary Sync...");
      await adminService.seedAllDictionaries((msg) => addLog(msg));
      loadStats();
      onDataChange?.();
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    } finally {
      setIsSyncing(false);
    }
  };

  const handleClear = async () => {
    if (!confirm("DANGER: This will delete ALL images for the current user. Are you sure?")) return;
    try {
      addLog("Starting Cleanup...");
      await adminService.clearAllImages((msg) => addLog(msg));
      loadStats();
      onDataChange?.();
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
    }
  };

  const toggleGeneration = async () => {
    if (isRunning) {
      cancelGeneration();
      setIsRunning(false);
      addLog("Stopping generation...");
    } else {
      const userId = await getCurrentUserId();
      if (!userId) {
          addLog("Error: Not authenticated. Cannot start generation.");
          return;
      }

      setIsRunning(true);
      addLog("Starting Background Generation Loop...");
      
      generateImagesForMissingWords(
          userId,
          (msg) => addLog(msg),
          (wordId, path) => {
              // Refresh stats occasionally
              if (Math.random() > 0.2) loadStats();
          }
      ).then(() => {
          setIsRunning(false);
          addLog("Background generation finished.");
          loadStats();
      });
    }
  };

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <h3>🛠️ <HoverTranslationText text="Vibe Admin Console" translation="Vibe 管理控制台" /></h3>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: '#888', cursor: 'pointer', fontSize: '20px' }}>×</button>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid #333' }}>
        <button style={TAB_BUTTON_STYLE(activeTab === 'dashboard')} onClick={() => setActiveTab('dashboard')}>概览</button>
        <button style={TAB_BUTTON_STYLE(activeTab === 'text')} onClick={() => setActiveTab('text')}>普通文本</button>
        <button style={TAB_BUTTON_STYLE(activeTab === 'scene')} onClick={() => setActiveTab('scene')}>场景游戏</button>
      </div>

      <div style={CONTENT_STYLE}>
        {activeTab === 'dashboard' && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '20px' }}>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}><HoverTranslationText text="Active Unique Words" translation="活跃去重总词库" /></div>
                <div style={{ fontSize: '24px' }}>{stats?.totalWords || 0}</div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}><HoverTranslationText text="Image Coverage" translation="图像覆盖率（基于活跃去重词库）" /></div>
                <div style={{ fontSize: '24px' }}>{stats?.imageCoverageRate.toFixed(1)}% <span style={{fontSize: '12px'}}>({stats?.wordsWithImages || 0} imgs)</span></div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}><HoverTranslationText text="Audio Coverage" translation="语音覆盖率（基于活跃去重词库）" /></div>
                <div style={{ fontSize: '24px' }}>{stats?.pronunciationCoverageRate.toFixed(1)}% <span style={{fontSize: '12px'}}>({stats?.wordsWithPronunciations || 0} audios)</span></div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}><HoverTranslationText text="Registered Users" translation="注册总人数" /></div>
                <div style={{ fontSize: '24px' }}>{stats?.totalUsers || 0}</div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}><HoverTranslationText text="Image Storage" translation="图片存储占用（vocab-images 存储桶实际占用）" /></div>
                <div style={{ fontSize: '24px' }}>{formatBytes(stats?.imageStorageBytes || 0)}</div>
                <div style={{ fontSize: '12px', color: '#9a9a9a', marginTop: '4px' }}>
                  {stats?.imageObjectCount || 0} files · avg {formatBytes(stats?.averageImageBytes || 0)}
                </div>
              </div>
            </div>

            <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', fontSize: '12px', color: '#bdbdbd', lineHeight: 1.6 }}>
              <HoverTranslationText
                text="Dashboard metrics are calculated from the active deduplicated global word set. Words no longer referenced by any user are removed from the shared pronunciation and meaning libraries."
                translation="以上统计均以活跃去重总词库为基准。只要某个单词不再被任何用户引用，它就会从共享语音库和中文释义库中自动移除。"
              />
            </div>

            <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', fontSize: '12px', color: '#bdbdbd', lineHeight: 1.6 }}>
              <HoverTranslationText
                text="Image Storage reflects the actual usage of the vocab-images bucket. This metric is not deduplicated by active words, so it can reveal leftover or orphaned files."
                translation="图片存储占用统计的是 vocab-images 存储桶的实际文件体积，不按活跃词库去重，因此能反映残留文件或孤儿文件带来的真实占用。"
              />
            </div>

            <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: isRunning ? '#22c55e' : '#555' }}></div>
              <div style={{ fontSize: '12px', color: '#cfcfcf' }}>
                {isRunning
                  ? <HoverTranslationText text="Image generation loop is running" translation="图像生成循环运行中" />
                  : <HoverTranslationText text="Image generation loop is idle" translation="图像生成循环空闲" />}
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <button 
                style={{
                    padding: '8px 16px', 
                    borderRadius: '4px', 
                    border: 'none', 
                    cursor: (isSyncing && !isRunning) ? 'not-allowed' : 'pointer', 
                    marginRight: '8px', 
                    fontWeight: 'bold', 
                    backgroundColor: isRunning ? '#ff9800' : (isSyncing ? '#666' : 'rgb(74, 144, 226)'), 
                    color: 'white'
                }} 
                onClick={toggleGeneration}
                disabled={isSyncing}
              >
                {isRunning ? '停止自动后台生成' : '开始自动后台生成'}
              </button>
              <button style={{...BUTTON_STYLE, backgroundColor: '#f44336'}} onClick={handleClear}>清空图片</button>
            </div>
            
            <div style={LOG_STYLE}>
              {logs.map((l, i) => <div key={i}>{l}</div>)}
              <div ref={logEndRef} />
            </div>
          </>
        )}

        {activeTab === 'text' && <TaskSettingsPanel task="TEXT" title="普通文本思考配置" onLog={addLog} />}
        {activeTab === 'scene' && <SceneGameSettingsPanel onLog={addLog} />}
      </div>
    </div>
  );
};
// ----------------------------------------------------------------
// Scene Fusion Game — non-sensitive controls only.
// All LLM keys live server-side (SCENE_DESIGN_* / SCENE_VISION_* secrets);
// ② render reuses PRIMARY_IMAGE_GEN_*. The panel exposes only the ③ vision
// ON/OFF toggle (stored client-side) and a "测试连接" button that probes the
// server-side SCENE_DESIGN_* secret via the edge function's probe branch.
// ----------------------------------------------------------------
const SceneGameSettingsPanel: React.FC<{ onLog: (m: string) => void }> = ({ onLog }) => {
  const [visionEnabled, setVisionEnabled] = useState<boolean>(() => SceneGameSettings.load().visionEnabled);
  const [probeBusy, setProbeBusy] = useState(false);
  const [probeResult, setProbeResult] = useState<SceneDirectorProbeResult | null>(null);
  const [migrateBusy, setMigrateBusy] = useState(false);
  const [migrateProgress, setMigrateProgress] = useState<string>('');
  const [cleanupBusy, setCleanupBusy] = useState(false);

  const handleToggleVision = (enabled: boolean) => {
    setVisionEnabled(enabled);
    SceneGameSettings.save({ visionEnabled: enabled });
  };

  const handleClear = () => {
    if (!confirm('重置场景游戏的视觉精修开关？(将恢复默认关闭)')) return;
    SceneGameSettings.clear();
    setVisionEnabled(false);
    onLog('Cleared scene-game settings.');
  };

  const handleProbe = async () => {
    setProbeBusy(true);
    setProbeResult(null);
    onLog('Probing scene director connection…');
    const result = await probeSceneDirector();
    setProbeResult(result);
    setProbeBusy(false);
    if (result.ok) {
      onLog(`Scene director OK: ${result.model} (${result.latencyMs}ms) @ ${result.baseUrl}`);
    } else {
      onLog(`Scene director probe failed: ${result.error}`);
    }
  };

  const handleCleanupOrphans = async () => {
    if (!confirm('清理孤儿场景图？\n\n将删除所有没有 sentence 信息（即玩家无法玩 cloze）的 scene_assets 记录和对应的 PNG 文件。先做 dry-run 看看会删什么。')) return;
    setCleanupBusy(true);
    onLog('Orphan cleanup: dry-run…');
    const dry = await cleanupOrphanSceneAssets(true);
    if (!dry.ok) { onLog(`dry-run failed: ${dry.error}`); setCleanupBusy(false); return; }
    onLog(`Orphan dry-run: ${dry.count} row(s) would be deleted.`);
    if (!dry.count || (dry.rows || []).length === 0) {
      onLog('No orphans — nothing to delete.');
      setCleanupBusy(false);
      return;
    }
    if (!confirm(`确认删除 ${dry.count} 条孤儿记录 + 对应 PNG 文件？此操作不可撤销。`)) {
      setCleanupBusy(false);
      return;
    }
    onLog('Orphan cleanup: deleting…');
    const real = await cleanupOrphanSceneAssets(false);
    if (!real.ok) { onLog(`cleanup failed: ${real.error}`); setCleanupBusy(false); return; }
    onLog(`Orphan cleanup: deleted ${real.count} row(s) + their PNG files. ids=${(real.deletedIds || []).join(',').slice(0, 120)}`);
    alert(`清理完成：删除 ${real.count} 条孤儿记录。`);
    setCleanupBusy(false);
  };

  const handleMigrate = async () => {
    if (!confirm('把所有 PNG 场景图迁移为 WebP？\n\n浏览器内下载每张 PNG → Canvas 转 WebP → 上传 → 删除 PNG。已 .webp 的不处理。建议夜间或网络稳定时执行。')) return;
    setMigrateBusy(true);
    setMigrateProgress('');
    onLog('Scene PNG→WebP migration: starting…');
    const result = await migrateScenePngsToWebp((done, total, cur) => {
      const msg = cur.status === 'ok'
        ? `[${done}/${total}] ✓ ${cur.oldPath} (${cur.oldBytes || 0}B → ${cur.newBytes || 0}B)`
        : `[${done}/${total}] ✗ ${cur.oldPath}: ${cur.error}`;
      setMigrateProgress(msg);
      onLog(msg);
    });
    if (result.error) {
      onLog(`Migration aborted: ${result.error}`);
    } else {
      const summary = `Migration done: ${result.migrated}/${result.total} migrated, ${result.failed} failed.`;
      onLog(summary);
      setMigrateProgress(summary);
      alert(summary);
    }
    setMigrateBusy(false);
  };

  return (
    <div style={{ maxWidth: '520px', margin: '0 auto' }}>
      <h4 style={{ marginBottom: '12px' }}>场景融合游戏 · 配置</h4>
      <p style={{ fontSize: '11px', color: '#aaa', marginBottom: '18px', lineHeight: 1.6 }}>
        场景导演 ①、视觉精修 ③ 的 BASE_URL/API_KEY/MODEL 一律在 Supabase Edge Secret 配置（<code>SCENE_DESIGN_*</code> / <code>SCENE_VISION_*</code>），浏览器不再保存或发送密钥。② 出图复用 <code>PRIMARY_IMAGE_GEN_*</code>。
      </p>

      <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
        <button
          style={{ ...BUTTON_STYLE, opacity: probeBusy ? 0.6 : 1 }}
          onClick={handleProbe}
          disabled={probeBusy}
        >
          {probeBusy ? '测试中…' : '测试导演连接'}
        </button>
        <div style={{ fontSize: '11px', color: '#999', marginTop: '8px' }}>
          验证服务端 <code>SCENE_DESIGN_*</code> Secret 是否可用。不发图、不写库。
        </div>
        {probeResult && (
          <div style={{ marginTop: '10px', fontSize: '12px', color: probeResult.ok ? '#7CFC8A' : '#FF8A8A' }}>
            {probeResult.ok
              ? `✓ ${probeResult.model} · ${probeResult.latencyMs}ms · ${probeResult.baseUrl}`
              : `✗ ${probeResult.error}`}
          </div>
        )}
      </div>

      <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
        <button
          style={{ ...BUTTON_STYLE, opacity: migrateBusy ? 0.6 : 1 }}
          onClick={handleMigrate}
          disabled={migrateBusy}
        >
          {migrateBusy ? '迁移中…' : 'PNG → WebP 迁移'}
        </button>
        <div style={{ fontSize: '11px', color: '#999', marginTop: '8px' }}>
          浏览器内 Canvas 转 WebP（与常规模式同款）。新图自动走 WebP；这个按钮只迁移历史 PNG。
        </div>
        {migrateProgress && (
          <div style={{ marginTop: '8px', fontSize: '11px', color: '#7CFC8A', wordBreak: 'break-all' }}>{migrateProgress}</div>
        )}
      </div>

      <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
        <button
          style={{ ...BUTTON_STYLE, backgroundColor: '#8a4444', opacity: cleanupBusy ? 0.6 : 1 }}
          onClick={handleCleanupOrphans}
          disabled={cleanupBusy}
        >
          {cleanupBusy ? '清理中…' : '清理孤儿场景图'}
        </button>
        <div style={{ fontSize: '11px', color: '#999', marginTop: '8px' }}>
          删除没有 sentence 信息的 scene_assets 记录和对应 PNG 文件。先 dry-run 看影响。
        </div>
      </div>

      <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '14px', marginBottom: '12px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={visionEnabled}
            onChange={(e) => handleToggleVision(e.target.checked)}
            style={{ width: '16px', height: '16px' }}
          />
          ③ 启用视觉精修（默认关闭）
        </label>
        <div style={{ fontSize: '11px', color: '#999', marginTop: '6px', marginLeft: '24px' }}>
          开启后，出图会用多模态 LLM 回扫，把高亮框收紧到元素实际位置；失败自动回退到位置区域。省钱省时建议保持关闭。
        </div>
      </div>

      <div style={{ marginTop: '12px', display: 'flex', gap: '10px' }}>
        <button style={{ ...BUTTON_STYLE, flex: 1 }} onClick={() => { SceneGameSettings.save({ visionEnabled }); onLog('Saved scene-game settings.'); alert('已保存场景游戏设置！'); }}>保存设置</button>
        <button style={{ ...BUTTON_STYLE, backgroundColor: '#666' }} onClick={handleClear}>重置</button>
      </div>
    </div>
  );
};

const TaskSettingsPanel: React.FC<{ task: AITask, title: string, onLog: (m: string) => void }> = ({ task, title, onLog }) => {
  const [provider, setProvider] = useState<AEServiceProvider>(AISettings.getTaskProvider(task));
  const [config, setConfig] = useState(AISettings.getConfig(provider, task));

  useEffect(() => {
    setConfig(AISettings.getConfig(provider, task));
  }, [provider, task]);

  const handleSave = () => {
    AISettings.setTaskProvider(task, provider);
    AISettings.setConfig(provider, config, task);
    onLog(`Saved ${task} settings.`);
    alert(`已保存 ${title}！`);
  };

  const handleReset = () => {
    if (confirm("清空当前任务的所有配置？")) {
      AISettings.setConfig(provider, { apiKey: '', endpoint: '', modelName: '' }, task);
      setConfig({ apiKey: '', endpoint: '', modelName: '' });
      onLog(`Reset ${task} settings.`);
    }
  };

  return (
    <div style={{ maxWidth: '400px', margin: '0 auto' }}>
      <h4 style={{ marginBottom: '16px' }}>{title}</h4>
      <p style={{ fontSize: '11px', color: '#aaa', marginBottom: '20px' }}>
        配置此任务专用的 AI 密钥。若为空则回退到系统默认或全局配置。
      </p>

      <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px' }}>AI 服务商</label>
      <select 
        style={{ ...INPUT_STYLE }} 
        value={provider} 
        onChange={(e) => setProvider(e.target.value as AEServiceProvider)}
      >
        <option value="gemini">Gemini (Google)</option>
        <option value="openai">OpenAI (或 兼容 API)</option>
        <option value="custom">大模型 (如 智谱AI, 深度求索)</option>
      </select>

      <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px' }}>API Key</label>
      <input 
        type="password" 
        style={INPUT_STYLE} 
        placeholder="sk-..." 
        value={config.apiKey}
        onChange={e => setConfig({ ...config, apiKey: e.target.value })}
      />

      <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px' }}>Endpoint URL (可选)</label>
      <input 
        type="text" 
        style={INPUT_STYLE} 
        placeholder={provider === 'openai' ? "https://api.openai.com/v1" : "API 接口地址"} 
        value={config.endpoint}
        onChange={e => setConfig({ ...config, endpoint: e.target.value })}
      />
      
      <label style={{ display: 'block', marginBottom: '8px', fontSize: '12px' }}>模型名称 (可选)</label>
      <input 
        type="text" 
        style={INPUT_STYLE} 
        placeholder={task === 'IMAGE_GEN' ? "dall-e-3" : "gpt-4o"} 
        value={config.modelName}
        onChange={e => setConfig({ ...config, modelName: e.target.value })}
      />

      <div style={{ marginTop: '20px', display: 'flex', gap: '10px' }}>
        <button style={{ ...BUTTON_STYLE, flex: 1 }} onClick={handleSave}>保存配置</button>
        <button style={{ ...BUTTON_STYLE, backgroundColor: '#666' }} onClick={handleReset}>清空</button>
      </div>
    </div>
  );
};
