import { useState } from 'react';
import { useCanvas } from '../store';
import { listAssets, putAsset } from '../lib/db';
import { detectAssetKind, guessMime, uid } from '../lib/utils';
import { ROLE_KINDS, type AssetMeta, type ReferenceRole } from '../types';
import { useAssetUrl } from './useAssetUrl';
import Icon from './Icon';
import WorkflowDialog from './WorkflowDialog';

function AssetChoice({ asset, onSelect, disabled }: { asset: AssetMeta; onSelect: (asset: AssetMeta) => void; disabled: boolean }) {
  const url = useAssetUrl(asset.id);
  return <button className="reference-choice" disabled={disabled} onClick={() => onSelect(asset)}>
    {asset.kind === 'image' && url
      ? <img src={url} alt="" />
      : <Icon name={asset.kind} size={18} />}
    <span>{asset.name}</span>
  </button>;
}

export default function ReferencePicker({ roles, attached, onSelect, onClose }: {
  roles: ReferenceRole[];
  attached: string[];
  onSelect: (asset: AssetMeta) => void;
  onClose: () => void;
}) {
  const assets = useCanvas(s => s.assets);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const kinds = new Set(roles.map(role => ROLE_KINDS[role]));
  const matches = assets.filter(asset => kinds.has(asset.kind) && !attached.includes(asset.id)
    && asset.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));

  const upload = async (file: File) => {
    const kind = detectAssetKind(file);
    if (!kind || !kinds.has(kind)) { setError('当前模型不支持该素材类型'); return; }
    setBusy(true);
    setError('');
    try {
      const meta = { id: uid('asset'), name: file.name, mime: guessMime(file, kind), kind, size: file.size, createdAt: Date.now() };
      await putAsset({ meta, blob: file });
      useCanvas.getState().setAssets(await listAssets());
      onSelect(meta);
    } catch {
      setError('素材保存失败，请检查本机存储后重试');
    } finally {
      setBusy(false);
    }
  };

  return <WorkflowDialog title="添加参考素材" onClose={onClose} busy={busy}>
    <div className="workflow-fields">
      <input className="dialog-input" aria-label="搜索素材" placeholder="搜索素材库" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="reference-choices">
        {matches.map(asset => <AssetChoice key={asset.id} asset={asset} onSelect={onSelect} disabled={busy} />)}
        {!matches.length && <p className="workflow-muted">{query.trim() ? '没有匹配的素材' : '素材库里暂无可添加的素材'}</p>}
      </div>
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
    <footer className="dialog-foot">
      <label className="ghost-btn reference-upload">
        <Icon name="upload" size={15} />{busy ? '正在上传…' : '上传本地文件'}
        <input type="file" accept={[...kinds].map(kind => kind + '/*').join(',')} disabled={busy}
          onChange={event => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      </label>
    </footer>
  </WorkflowDialog>;
}
