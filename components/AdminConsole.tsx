import React, { useState, useEffect, useRef } from 'react';
import { adminService, AdminStats } from '../services/adminService';
import { AISettings, AEServiceProvider, AITask } from '../services/ai/settings';

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
    try {
      addLog("Starting Dictionary Sync...");
      await adminService.seedAllDictionaries((msg) => addLog(msg));
      loadStats();
      onDataChange?.();
    } catch (e: any) {
      addLog(`Error: ${e.message}`);
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
      adminService.stopGeneration();
      setIsRunning(false);
      addLog("Stopping generation...");
    } else {
      setIsRunning(true);
      addLog("Starting Background Generation Loop...");
      adminService.startBackgroundGeneration(
        (status) => {
          if (status.status === "Done") {
            addLog(`✓ Generated: ${status.currentWord}`);
            if (Math.random() > 0.9) loadStats(); 
          } else if (status.status.includes("Rate Limited")) {
            addLog(`! Rate Limit: ${status.currentWord} - Waiting...`);
          } else if (status.status === "Generating...") {
            // Noise reduction
          } else {
            addLog(`Status: ${status.status} (${status.currentWord})`);
          }
        },
        (err) => {
          addLog(`Generate Error: ${err}`);
          setIsRunning(false);
        }
      );
    }
  };

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <h3>🛠️ Vibe Admin Console</h3>
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
                <div style={{ fontSize: '12px', color: '#888' }}>Total Words</div>
                <div style={{ fontSize: '24px' }}>{stats?.totalWords || 0}</div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}>Coverage</div>
                <div style={{ fontSize: '24px' }}>{stats?.coverageRate.toFixed(1)}% <span style={{fontSize: '12px'}}>({stats?.wordsWithImages} imgs)</span></div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px' }}>
                <div style={{ fontSize: '12px', color: '#888' }}>Est. Storage</div>
                <div style={{ fontSize: '24px' }}>{stats?.storageUsageMB.toFixed(2)} MB</div>
              </div>
              <div style={{ background: '#252525', padding: '10px', borderRadius: '8px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                 <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: isRunning ? '#0f0' : '#555', marginRight: '8px' }}></div>
                 {isRunning ? 'RUNNING' : 'IDLE'}
              </div>
            </div>

            <div style={{ marginBottom: '20px' }}>
              <button style={{...BUTTON_STYLE, backgroundColor: '#4caf50'}} onClick={handleSync}>同步词典</button>
              <button style={BUTTON_STYLE} onClick={toggleGeneration}>{isRunning ? '停止生成' : '开始自动后台生成'}</button>
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
