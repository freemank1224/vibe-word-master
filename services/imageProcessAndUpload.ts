import { supabase } from '../lib/supabaseClient';
import { compressToWebP } from '../utils/imageUtils';

const BUCKET = 'word-images';

const normalizeWord = (text: string): string =>
  text.toLowerCase().trim().replace(/\s+/g, ' ');

export type ProcessAndUploadResult = {
  publicUrl: string;
  assetId: string;
  sizeBytes: number;
};

/**
 * 在前端浏览器中：把 base64 PNG/JPEG 转 WebP → 上传 storage → 写 image_assets → 关联 words。
 *
 * 返回最终 publicUrl。任何步骤失败抛错，调用方可回退到内存 dataUrl 显示并重试。
 */
export const processAndUploadImage = async (params: {
  dataUrl: string;
  displayWord: string;
  language?: string;
  model?: string | null;
}): Promise<ProcessAndUploadResult> => {
  const { dataUrl, displayWord } = params;
  const language = (params.language || 'en').trim();
  const model = params.model || 'codex-gpt-image-2';
  const normalizedWord = normalizeWord(displayWord);

  // 1. 浏览器 Canvas 转 WebP（工业级可靠）
  const webpBlob = await compressToWebP(dataUrl, 1024, 1024, 0.82);

  // 校验确实是 WebP（RIFF....WEBP），compressToWebP 在极旧浏览器可能返回 png
  const head = new Uint8Array(await webpBlob.slice(0, 12).arrayBuffer());
  const isWebp = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50;
  const contentType = isWebp ? 'image/webp' : (webpBlob.type || 'image/webp');

  // 2. 上传 storage（路径恒 .webp：Supabase Storage public URL 对 .webp 路径稳定）
  const storagePath = `images/${language}/${encodeURIComponent(normalizedWord)}.webp`;
  const { error: ulErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, webpBlob, {
      contentType,
      cacheControl: '31536000',
      upsert: true,
    });
  if (ulErr) throw new Error(`storage upload failed: ${ulErr.message}`);

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;

  // 3. 写 image_assets（upsert 按 normalized_word + language 去重，全局共享）
  const { data: asset, error: iaErr } = await supabase
    .from('image_assets')
    .upsert(
      {
        normalized_word: normalizedWord,
        display_word: displayWord,
        language,
        model,
        storage_bucket: BUCKET,
        storage_path: storagePath,
        public_url: publicUrl,
        file_size_bytes: webpBlob.size,
        status: 'ready',
        error_message: null,
      },
      { onConflict: 'normalized_word,language' },
    )
    .select('id')
    .single();
  if (iaErr) throw new Error(`image_assets upsert failed: ${iaErr.message}`);

  // 4. 关联当前用户已激活的同名 words
  const { data: matchingWords } = await supabase
    .from('words')
    .select('id')
    .or('deleted.is.false,deleted.is.null')
    .ilike('text', displayWord)
    .eq('language', language);
  if (matchingWords && matchingWords.length > 0) {
    await supabase
      .from('words')
      .update({ image_asset_id: asset.id })
      .in('id', matchingWords.map(w => w.id));
  }

  return { publicUrl, assetId: asset.id, sizeBytes: webpBlob.size };
};
