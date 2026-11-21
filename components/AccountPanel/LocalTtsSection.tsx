import React, { useState } from 'react';
import { ToggleSwitch } from '../ToggleSwitch';
import { HoverTranslationText } from '../HoverTranslationText';
import { isLocalTtsPreferred, setLocalTtsPreferred, warmUpLocalTts } from '../../services/localTtsService';

/**
 * AccountPanel toggle for preferring the vendored tiny-voca on-device TTS
 * over the MiniMax-backed online pipeline. Enabling pre-warms the model so
 * the first playback is not delayed by the ~8 MB load.
 */
export const LocalTtsSection: React.FC = () => {
  const [preferred, setPreferred] = useState<boolean>(() => isLocalTtsPreferred());

  const handleToggle = () => {
    const next = !preferred;
    setPreferred(next);
    setLocalTtsPreferred(next);
    if (next) void warmUpLocalTts();
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
    </div>
  );
};
