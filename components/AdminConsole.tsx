import React, { useState, useEffect, useRef } from 'react';
import { adminService, AdminStats } from '../services/adminService';
import { AISettings, AEServiceProvider, AITask } from '../services/ai/settings';
import { generateImagesForMissingWords, cancelGeneration } from '../services/imageGenerationTask';
import { getCurrentUserId } from '../services/dataService';
import { HoverTranslationText } from './HoverTranslationText';

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

export const AdminConsole: React.FC<{ onClose: () => void, onDataChange?: () => void }> = ({ onClose, onDataChange }) => {
  const [activeTab, setActiveTab] = useState<'dashboard' | 'image' | 'vision' | 'text'>('dashboard');
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
        <button style={TAB_BUTTON_STYLE(activeTab === 'image')} onClick={() => setActiveTab('image')}>图像生成</button>
        <button style={TAB_BUTTON_STYLE(activeTab === 'vision')} onClick={() => setActiveTab('vision')}>图像识别</button>
        <button style={TAB_BUTTON_STYLE(activeTab === 'text')} onClick={() => setActiveTab('text')}>普通文本</button>
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
            </div>

            <div style={{ background: '#202020', border: '1px solid #333', borderRadius: '8px', padding: '10px 12px', marginBottom: '16px', fontSize: '12px', color: '#bdbdbd', lineHeight: 1.6 }}>
              <HoverTranslationText
                text="Dashboard metrics are calculated from the active deduplicated global word set. Words no longer referenced by any user are removed from the shared pronunciation and meaning libraries."
                translation="以上统计均以活跃去重总词库为基准。只要某个单词不再被任何用户引用，它就会从共享语音库和中文释义库中自动移除。"
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

        {activeTab === 'image' && <TaskSettingsPanel task="IMAGE_GEN" title="图像生成配置" onLog={addLog} />}
        {activeTab === 'vision' && <TaskSettingsPanel task="VISION" title="图像识别配置" onLog={addLog} />}
        {activeTab === 'text' && <TaskSettingsPanel task="TEXT" title="普通文本思考配置" onLog={addLog} />}
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
