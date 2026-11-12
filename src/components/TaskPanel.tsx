import { useState } from 'react';
import { cancelGeneration, resumeGeneration, useGeneration, type GenerationTask } from '../lib/generation';
import { useCanvas } from '../store';
import Icon from './Icon';
import { AssetPreview } from './Panels';

const statuses = { running: '生成中', completed: '已完成', failed: '失败', cancelled: '已停止等待' };

export default function TaskPanel({ onClose, onLocate, onPlace }: {
  onClose: () => void;
  onLocate: (id: string) => void;
  onPlace: (assetId: string) => void;
}) {
  const tasks = useGeneration(s => s.tasks);
  const { assets, nodes, projectId } = useCanvas();
  const [filter, setFilter] = useState<GenerationTask['status'] | 'all'>('all');
  const [previewId, setPreviewId] = useState('');
  const [resuming, setResuming] = useState('');
  const [resumeError, setResumeError] = useState('');
  const current = tasks.filter(task => task.projectId === projectId);
  const visible = filter === 'all' ? current : current.filter(task => task.status === filter);
  const preview = assets.find(asset => asset.id === previewId);
  return <aside className="assistant-panel" aria-label="生成任务">
    <header className="assistant-head">
      <strong><Icon name="list" size={17} /> 生成任务</strong>
      <button className="icon-btn" aria-label="关闭生成任务" onClick={onClose}><Icon name="close" size={16} /></button>
    </header>
    {current.length > 0 && <div className="task-filters">
      <select aria-label="筛选生成任务" value={filter} onChange={event => setFilter(event.target.value as typeof filter)}>
        <option value="all">全部状态</option>
        {Object.entries(statuses).map(([status, label]) => <option key={status} value={status}>{label}</option>)}
      </select>
    </div>}
    <div className="assistant-scroll task-panel">
      {resumeError && <p className="tone-err" role="alert">{resumeError}</p>}
      {!visible.length && <p>{current.length ? '没有符合条件的任务' : '当前项目暂无生成任务'}</p>}
      {visible.map(task => <article className="task-item" key={task.id}>
        <div><strong>{task.name}</strong><span className={task.status === 'failed' ? 'tone-err' : ''}>{statuses[task.status]}</span></div>
        <p>{task.message}</p>
        {task.deliveredResolution && <p>实际交付规格 {task.deliveredResolution}</p>}
        {task.remoteId && <code>任务编号：{task.remoteId}</code>}
        {task.status === 'running' && <button className="mini-btn" onClick={() => cancelGeneration(task.id)}>停止等待</button>}
        {task.remoteId && task.resume && (task.status === 'failed' || task.status === 'cancelled') &&
          <button className="mini-btn" disabled={resuming === task.id} onClick={() => {
            setResumeError(''); setResuming(task.id);
            void resumeGeneration(task.id)
              .catch(error => setResumeError(error instanceof Error ? error.message : String(error)))
              .finally(() => setResuming(''));
          }}>{resuming === task.id ? '正在续查' : '续查远端产物'}</button>}
        {task.remoteId && !task.resume && task.status !== 'completed' &&
          <button className="mini-btn" onClick={() => void navigator.clipboard?.writeText(task.remoteId!).catch(() => {})}>复制任务编号</button>}
        {task.status === 'failed' && nodes.some(node => node.id === task.nodeId) &&
          <button className="mini-btn" onClick={() => onLocate(task.nodeId)}>查看生成节点</button>}
        {task.assetIds.map(assetId => {
          const result = nodes.find(node => 'assetId' in node && node.assetId === assetId);
          const asset = assets.find(item => item.id === assetId);
          if (!result && !asset) return null;
          return <div className="task-result" key={assetId}>
            <span title={asset?.name ?? result?.name}>{asset?.name ?? result?.name}</span>
            {asset && <button className="mini-btn" onClick={() => setPreviewId(assetId)}>预览</button>}
            <button className="mini-btn" onClick={() => result ? onLocate(result.id) : onPlace(assetId)}>
              {result ? '定位结果' : '添加到画布'}
            </button>
          </div>;
        })}
      </article>)}
    </div>
    {preview && <AssetPreview meta={preview} onClose={() => setPreviewId('')} />}
  </aside>;
}
