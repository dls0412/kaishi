import { useEffect, useState } from 'react';
import { getAssetUrl } from '../lib/db';

/**
 * reloadKey 变化会重新读取素材（配合 invalidateAssetUrl 可做「加载失败重新加载」）。
 * 现有调用只传 assetId，行为不变。
 */
export function useAssetUrl(assetId: string | null | undefined, reloadKey = 0): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (!assetId) return () => { alive = false; };
    getAssetUrl(assetId)
      .then((value) => { if (alive) setUrl(value); })
      .catch(() => { if (alive) setUrl(null); });
    return () => { alive = false; };
  }, [assetId, reloadKey]);
  return url;
}
