import React, { useState } from 'react';
import { ToggleSwitch } from '../ToggleSwitch';
import { HoverTranslationText } from '../HoverTranslationText';
import {
  isLocalTtsPreferred,
  setLocalTtsPreferred,
  warmUpLocalTts,
  getLocalTtsSpeed,
  setLocalTtsSpeed,
  LOCAL_TTS_MIN_SPEED,
  LOCAL_TTS_MAX_SPEED,
  LOCAL_TTS_DEFAULT_SPEED,
} from '../../services/localTtsService';

/**
 * AccountPanel controls for the vendored tiny-voca on-device TTS: the
 * "prefer local" toggle plus a speech-rate slider (0.5x–1x, default 0.8x).
 * Enabling pre-warms the model so the first playback is not delayed by the
 * ~8 MB load; slider changes persist immediately and re-synthesize on the
 * next playback (per-speed session cache).
 */
export const LocalTtsSection: React.FC = () => {
  const [preferred, setPreferred] = useState<boolean>(() => isLocalTtsPreferred());
  const [speed, setSpeed] = useState<number>(() => getLocalTtsSpeed());

  const handleToggle = () => {
    const next = !preferred;
    setPreferred(next);
    setLocalTtsPreferred(next);
    if (next) void warmUpLocalTts();
  };

  const handleSpeed = (value: number) => {
    setSpeed(value);
    setLocalTtsSpeed(value);
  };

  return (
    <div className="space-y-4">
      <h3 className="font-headline text-lg text-text-dark tracking-[0.2em] uppercase"><HoverTranslationText text="Pronunciation" translation="发音" /></h3>
      <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30 flex items-center justify-between">
        <div>
          <div className="text-white font-mono text-sm mb-1"><HoverTranslationText text="Prefer Offline Local Voice (Tiny-Voca)" translation="优先使用本地离线语音 (Tiny-Voca)" /></div>
          <div className="text-[10px] text-text-light font-mono max-w-[220px] leading-tight">
            <HoverTranslationText
              text="On-device synthesized English audio, tried first when enabled and automatically when MiniMax is unavailable. First use loads an ~8 MB model."
              translation="设备端合成的英文发音：开启后优先生成，MiniMax 在线服务不可用时也会自动启用。首次使用需加载约 8MB 模型。"
            />
          </div>
        </div>
        <ToggleSwitch
          checked={preferred}
          onChange={handleToggle}
          ariaLabel="Toggle local TTS preference"
        />
      </div>

      {preferred && (
        <div className="bg-dark-charcoal p-5 rounded-3xl border border-mid-charcoal/30">
          <div className="flex items-center justify-between mb-3">
            <div className="text-white font-mono text-sm"><HoverTranslationText text="Local Voice Speech Rate" translation="本地语音朗读速度" /></div>
            <span className="text-electric-blue font-mono text-xs px-2 py-0.5 rounded bg-electric-blue/10 border border-electric-blue/30" data-testid="local-tts-speed-value">
              {speed.toFixed(2)}x
            </span>
          </div>
          <input
            type="range"
            min={LOCAL_TTS_MIN_SPEED}
            max={LOCAL_TTS_MAX_SPEED}
            step={0.05}
            value={speed}
            onChange={event => handleSpeed(Number(event.currentTarget.value))}
            aria-label="Local TTS speech rate"
            className="w-full accent-electric-blue cursor-pointer"
            data-testid="local-tts-speed"
          />
          <div className="flex justify-between mt-1 text-[10px] text-text-light font-mono">
            <span><HoverTranslationText text="Slower" translation="较慢" /></span>
            <span><HoverTranslationText text="Faster" translation="较快" /></span>
          </div>
          {speed !== LOCAL_TTS_DEFAULT_SPEED && (
            <button
              onClick={() => handleSpeed(LOCAL_TTS_DEFAULT_SPEED)}
              className="mt-2 text-[10px] font-mono uppercase tracking-widest text-electric-blue hover:text-white transition-colors"
            >
              <HoverTranslationText text="Reset to 0.80x" translation="恢复默认 0.80x" />
            </button>
          )}
        </div>
      )}
    </div>
  );
};
