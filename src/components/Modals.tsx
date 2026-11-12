import AgentConnection from './AgentConnection';
import { useEffect, useId, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { useCanvas } from '../store';
import {
  EMPTY_CAPABILITIES,
  MODEL_TYPE_LABELS,
  ROLE_LABELS,
  type AppSettings,
  type ModelCapabilities,
  type ModelService,
  type ModelType,
  type ReferenceRole,
  type ServiceModel,
  type ServiceProtocol,
} from '../types';
import {
  CAPABILITY_TEMPLATES,
  PROTOCOLS,
  SERVICE_PRESETS,
  capabilityTemplate,
  suggestedTemplate,
  protocolSpec,
} from '../lib/modelCatalog';
import { availableModels, findBinding, listRemoteModels, makeModelKey, testServiceConnection, verifyTextChat, type ChatCheckResult, type RemoteModel } from '../lib/models';
import { CODEX_ACCOUNT, codexStatus, useCodexAccount } from '../lib/codexAccount';
import QuickModelSetup, { type SetupModelType } from './QuickModelSetup';
import { getAsset } from '../lib/db';
import { mergeBuiltinSkills } from '../lib/skillCatalog';
import { uid } from '../lib/utils';
import { useAssetUrl } from './useAssetUrl';
import SkillsPanel from './SkillsPanel';
import Icon from './Icon';
import WorkflowDialog from './WorkflowDialog';

/* ------------------------------ 通用输入弹窗 ------------------------------ */
export function PromptDialog({ title, label, defaultValue = '', placeholder, confirmText = '确定', onConfirm, onCancel }: {
  title: string;
  label: string;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = useId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !value.trim()) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm(value.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
      setBusy(false);
    }
  };
  return (
    <WorkflowDialog title={title} onClose={onCancel} className="compact-dialog" closeOnBackdrop busy={busy}>
      <form onSubmit={submit}>
        <div className="dialog-body">
          <label className="dialog-label" htmlFor={inputId}>{label}</label>
          <input
            className="dialog-input"
            id={inputId}
            data-dialog-focus
            type="text"
            value={value}
            placeholder={placeholder}
            readOnly={busy}
            onFocus={event => event.currentTarget.select()}
            onChange={(e) => { setValue(e.target.value); setError(''); }}
            onKeyDown={event => {
              if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault();
            }}
          />
          {error && <p className="chat-error" role="alert">{error}</p>}
        </div>
        <div className="dialog-foot">
          <button className="ghost-btn" type="button" disabled={busy} onClick={onCancel}>取消</button>
          <button className="primary-btn" type="submit" disabled={busy || !value.trim()}>{busy ? '处理中…' : confirmText}</button>
        </div>
      </form>
    </WorkflowDialog>
  );
}

/* ------------------------------ 确认弹窗 ------------------------------ */
export function ConfirmDialog({ title, message, confirmText = '确定', danger = false, onConfirm, onCancel }: {
  title: string;
  message: string;
  confirmText?: string;
  danger?: boolean;
  onConfirm: () => void | Promise<void>;
  onCancel: () => void;
}) {
  const descriptionId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败，请重试');
      setBusy(false);
    }
  };
  return (
    <WorkflowDialog title={title} onClose={onCancel} className="compact-dialog" closeOnBackdrop busy={busy} descriptionId={descriptionId}>
      <div className="dialog-body">
        <p id={descriptionId} className="dialog-message">{message}</p>
        {error && <p className="chat-error" role="alert">{error}</p>}
      </div>
      <div className="dialog-foot">
        <button className="ghost-btn" data-dialog-focus disabled={busy} onClick={onCancel}>取消</button>
        <button className={`primary-btn${danger ? ' danger' : ''}`} disabled={busy} onClick={confirm}>{busy ? '处理中…' : confirmText}</button>
      </div>
    </WorkflowDialog>
  );
}

/* ==================== 设置 ==================== */
type SettingsTab = 'defaults' | 'canvas' | 'skills' | 'external';
const settingsTabs = [
  ['defaults', 'sliders', '模型配置'],
  ['external', 'character', 'Agent 账号'],
  ['skills', 'sparkles', '技能库'],
  ['canvas', 'grid', '画布偏好'],
] as const;
const modelUses = [
  { type: 'text', title: 'Agent 文本', presets: ['openai-text', 'deepseek-text'] },
  { type: 'image', title: '图片生成', presets: ['qwen-image', 'minimax-h3-image', 'openai-image'] },
  { type: 'video', title: '视频生成', presets: ['h3-video'] },
  { type: 'audio', title: '语音生成', presets: [] },
] as const;
const MODEL_TYPES: ModelType[] = ['image', 'video', 'text', 'audio'];
const ALL_ROLES: ReferenceRole[] = ['first-frame', 'last-frame', 'reference-image', 'reference-video', 'reference-audio'];

function parseList(raw: string): string[] {
  return raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
}

/** 模型能力编辑器：能力一律显式编辑，绝不按模型名称推断 */
function CapabilityEditor({ caps, onChange }: { caps: ModelCapabilities; onChange: (c: ModelCapabilities) => void }) {
  const [ratios, setRatios] = useState(caps.ratios.join(', '));
  const [resolutions, setResolutions] = useState(caps.resolutions.join(', '));
  const [durations, setDurations] = useState(caps.durations.join(', '));
  const [audio, setAudio] = useState(caps.audioOptions.map((o) => `${o.id}|${o.label}`).join('\n'));
  const [source, setSource] = useState(caps.source);
  const [note, setNote] = useState(caps.note);
  const [template, setTemplate] = useState('');

  useEffect(() => {
    setRatios(caps.ratios.join(', '));
    setResolutions(caps.resolutions.join(', '));
    setDurations(caps.durations.join(', '));
    setAudio(caps.audioOptions.map((o) => `${o.id}|${o.label}`).join('\n'));
    setSource(caps.source);
    setNote(caps.note);
  }, [caps]);

  const commit = (patch: Partial<ModelCapabilities>) => onChange({ ...caps, ...patch });

  const applyTemplate = (id: string) => {
    setTemplate(id);
    if (id) onChange(capabilityTemplate(id));
  };

  const commitAudio = () => {
    const options = audio.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [id, ...rest] = line.split('|');
      return { id: id.trim(), label: (rest.join('|') || id).trim() };
    }).filter((o) => o.id);
    commit({ audioOptions: options });
  };

  return (
    <div className="cap-editor">
      <label className="settings-field"><span>能力模板（按公开文档，不按模型名猜）</span>
        <select value={template} onChange={(e) => applyTemplate(e.target.value)}>
          <option value="">选择模板覆盖当前能力…</option>
          {CAPABILITY_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
      </label>
      <div className="settings-grid">
        <label className="settings-field"><span>比例（逗号分隔）</span>
          <input value={ratios} placeholder="16:9, 1:1" onChange={(e) => setRatios(e.target.value)} onBlur={() => commit({ ratios: parseList(ratios) })} />
        </label>
        <label className="settings-field"><span>分辨率档位</span>
          <input value={resolutions} placeholder="1K, 1080P" onChange={(e) => setResolutions(e.target.value)} onBlur={() => commit({ resolutions: parseList(resolutions) })} />
        </label>
      </div>
      <div className="settings-grid">
        <label className="settings-field"><span>时长（秒，逗号分隔；图片留空）</span>
          <input value={durations} placeholder="4, 5, 6" onChange={(e) => setDurations(e.target.value)}
            onBlur={() => commit({ durations: parseList(durations).map(Number).filter((n) => Number.isFinite(n) && n > 0) })} />
        </label>
        <label className="settings-field"><span>单次最多张数</span>
          <input type="number" min={1} max={16} value={caps.maxCount}
            onChange={(e) => commit({ maxCount: Math.max(1, Number(e.target.value) || 1) })} />
        </label>
      </div>
      <div className="settings-field"><span>支持的参考素材用途（按模型真实能力勾选）</span>
        <div className="role-checks">
          {ALL_ROLES.map((role) => (
            <label key={role} className={caps.roles.includes(role) ? 'on' : ''}>
              <input type="checkbox" checked={caps.roles.includes(role)} onChange={(e) => {
                const roles = e.target.checked ? [...caps.roles, role] : caps.roles.filter((r) => r !== role);
                const roleLimits = { ...caps.roleLimits };
                if (!e.target.checked) delete roleLimits[role];
                commit({ roles, roleLimits });
              }} />
              {ROLE_LABELS[role]}
            </label>
          ))}
        </div>
      </div>
      <div className="settings-grid">
        <label className="settings-field"><span>参考素材总数上限</span>
          <input type="number" min={0} max={64} value={caps.maxReferences}
            onChange={(e) => commit({ maxReferences: Math.max(0, Number(e.target.value) || 0) })} />
        </label>
        <label className="settings-field"><span>声音选项（每行 id|显示名）</span>
          <textarea rows={2} value={audio} placeholder="keep|保留成片音轨" onChange={(e) => setAudio(e.target.value)} onBlur={commitAudio} />
        </label>
      </div>
      {caps.advancedFields.length > 0 && (
        <div className="advanced-fields-note">高级参数：{caps.advancedFields.map((f) => `${f.label}（默认 ${String(f.defaultValue)}）`).join('；')}</div>
      )}
      <label className="settings-field"><span>能力依据（文档名 / URL）</span>
        <input value={source} onChange={(e) => setSource(e.target.value)} onBlur={() => commit({ source })} />
      </label>
      <label className="settings-field"><span>能力说明</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => commit({ note })} />
      </label>
    </div>
  );
}

interface RemoteState {
  serviceId: string;
  endpoint: string;
  models: RemoteModel[];
  error?: string;
  addType: ModelType;
  query: string;
}

export function SettingsModal({ onClose, onNotice, onOpenAgent, initialTab = 'defaults', page, onDirtyChange }: {
  initialTab?: SettingsTab | 'services';
  page?: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  onClose: () => void;
  onNotice: (msg: string) => void;
  /** 从技能库跳到创作助手：先关设置弹窗，避免两个遮罩叠在一起 */
  onOpenAgent?: () => void;
}) {
  const saved = useCanvas((s) => s.settings);
  const [form, setForm] = useState<AppSettings>(() => JSON.parse(JSON.stringify(saved)) as AppSettings);
  const [tab, setTab] = useState<SettingsTab>(initialTab === 'services' ? 'defaults' : initialTab);
  const [showServices, setShowServices] = useState(initialTab === 'services');
  const [setup, setSetup] = useState<{ type: SetupModelType; presetId: string; draft: boolean } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [activeId, setActiveId] = useState<string>(() => saved.services[0]?.id ?? '');
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err' | 'info'; text: string } | null>(null);
  const [addingModel, setAddingModel] = useState(false);
  const [newModel, setNewModel] = useState({ id: '', name: '', type: 'image' as ModelType, template: 'custom' });
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [chatCheck, setChatCheck] = useState<Record<string, ChatCheckResult>>({});
  const latestForm = useRef(form);
  latestForm.current = form;

  const active = form.services.find((s) => s.id === activeId) ?? form.services[0];
  const spec = active ? protocolSpec(active.protocol) : null;
  const codexAccount = useCodexAccount(state => state.status?.account);
  useEffect(() => { if (tab === 'defaults') void codexStatus().catch(() => {}); }, [tab]);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const title = settingsTabs.find(([id]) => id === tab)?.[2];
  const remoteQuery = remote?.query.trim().toLowerCase() || '';
  const remoteMatches = remote?.models.filter(model => model.id.toLowerCase().includes(remoteQuery)
    || model.name?.toLowerCase().includes(remoteQuery)) ?? [];
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  const patchService = (id: string, patch: Partial<ModelService>) => {
    const changesConnection = patch.protocol !== undefined || patch.baseUrl !== undefined || patch.apiKey !== undefined;
    if (changesConnection) {
      setRemote(null);
      setChatCheck(checks => Object.fromEntries(Object.entries(checks).filter(([key]) => key !== id)));
      setMessage(null);
    }
    setForm(f => ({ ...f, services: f.services.map(s => s.id === id ? {
      ...s, ...patch,
      ...(changesConnection ? { connection: { status: 'unverified' as const, checkedAt: 0, message: '', endpoint: '' } } : {}),
    } : s) }));
  };

  const connectionUnchanged = (service: ModelService) => latestForm.current.services.some(current =>
    current.id === service.id && current.protocol === service.protocol && current.baseUrl === service.baseUrl && current.apiKey === service.apiKey);

  const patchModel = (serviceId: string, modelId: string, patch: Partial<ServiceModel>) => setForm((f) => ({
    ...f,
    services: f.services.map((s) => s.id === serviceId
      ? { ...s, models: s.models.map((m) => (m.id === modelId ? { ...m, ...patch } : m)) }
      : s),
  }));

  const addService = () => {
    const id = uid('svc');
    const service: ModelService = {
      id, name: '新建模型服务', protocol: 'openai', baseUrl: '', apiKey: '',
      enabled: false, models: [], note: '', createdAt: Date.now(),
      connection: { status: 'unverified', checkedAt: 0, message: '', endpoint: '' },
    };
    setForm((f) => ({ ...f, services: [...f.services, service] }));
    setActiveId(id);
    setShowKey(false);
    setAddingModel(false);
    setPendingDelete(null);
    setRemote(null);
    setMessage(null);
  };

  const removeService = (id: string) => {
    const service = form.services.find((s) => s.id === id);
    const keys = new Set((service?.models ?? []).map((m) => makeModelKey(id, m.id)));
    setForm((f) => ({
      ...f,
      services: f.services.filter((s) => s.id !== id),
      defaults: Object.fromEntries(Object.entries(f.defaults).filter(([, key]) => !keys.has(key))) as AppSettings['defaults'],
    }));
    if (activeId === id) setActiveId('');
    setPendingDelete(null);
    setMessage({ tone: 'info', text: `服务已移除。绑定到它的节点会显示「不可用」，原内容与参数仍保留。` });
  };

  const doTest = async (service: ModelService) => {
    setBusy(`test:${service.id}`);
    setMessage(null);
    const result = await testServiceConnection(service);
    setBusy('');
    if (!connectionUnchanged(service)) return;
    patchService(service.id, { connection: result });
    setMessage({
      tone: result.status === 'ok' ? 'ok' : result.status === 'failed' ? 'err' : 'info',
      text: result.message,
    });
  };

  /** 文本对话验证与 /models 列表验证分开：目录里出现模型不代表对话可用 */
  const doChatTest = async (service: ModelService) => {
    const model = (service.models ?? []).find((m) => m.type === 'text' && m.enabled);
    if (!model) { setMessage({ tone: 'info', text: '这个服务下还没有启用的文本模型' }); return; }
    setBusy(`chat:${service.id}`);
    const result = await verifyTextChat(service, model.id);
    setBusy('');
    if (!connectionUnchanged(service)) return;
    setChatCheck((c) => ({ ...c, [service.id]: result }));
    setMessage({ tone: result.ok ? 'ok' : 'err', text: `${result.endpoint || '（未适配端点）'} → ${result.message}` });
  };

  const doList = async (service: ModelService) => {
    setBusy(`list:${service.id}`);
    const result = await listRemoteModels(service);
    setBusy('');
    if (!connectionUnchanged(service)) return;
    setRemote({ serviceId: service.id, endpoint: result.endpoint, models: result.models, error: result.error, addType: service.models[0]?.type ?? 'text', query: '' });
    if (result.error) setMessage({ tone: 'info', text: `${spec?.testLabel ?? '读取模型列表'}：${result.error}` });
  };

  const addRemoteModel = (serviceId: string, rm: RemoteModel, type: ModelType) => {
    const service = form.services.find((s) => s.id === serviceId);
    if (!service) return;
    if (service.models.some((m) => m.id === rm.id)) {
      setMessage({ tone: 'info', text: `模型 ${rm.id} 已在该服务下，没有重复添加。` });
      return;
    }
    const model: ServiceModel = {
      id: rm.id, name: rm.name || rm.id, type, enabled: true,
      // 从 /models 只能拿到 ID，拿不到真实能力：显式标记「未确认」，不按名称猜
      capabilities: {
        ...EMPTY_CAPABILITIES,
        source: `${protocolSpec(service.protocol).label} /models 返回；能力未经接口文档确认`,
        note: '只读取到模型 ID，比例 / 分辨率 / 参考类型等能力尚未确认，请按服务文档补全后再使用。',
      },
    };
    setForm((f) => ({ ...f, services: f.services.map((s) => (s.id === serviceId ? { ...s, models: [...s.models, model] } : s)) }));
    setMessage({ tone: 'ok', text: `已添加 ${rm.id}（${MODEL_TYPE_LABELS[type]}），能力标记为未确认，请补全。` });
  };

  const addManualModel = (serviceId: string) => {
    const id = newModel.id.trim();
    if (!id) { setMessage({ tone: 'err', text: '请先填写实际模型 ID' }); return; }
    const service = form.services.find((s) => s.id === serviceId);
    if (service?.models.some((m) => m.id === id)) { setMessage({ tone: 'err', text: '该服务下已有相同模型 ID' }); return; }
    const model: ServiceModel = {
      id, name: newModel.name.trim() || id, type: newModel.type, enabled: true,
      capabilities: capabilityTemplate(newModel.template),
    };
    setForm((f) => ({ ...f, services: f.services.map((s) => (s.id === serviceId ? { ...s, models: [...s.models, model] } : s)) }));
    setNewModel({ id: '', name: '', type: newModel.type, template: newModel.template });
    setAddingModel(false);
    setMessage({ tone: 'ok', text: `已手动添加模型 ${id}（${MODEL_TYPE_LABELS[newModel.type]}）` });
  };

  const removeModel = (serviceId: string, modelId: string) => {
    const key = makeModelKey(serviceId, modelId);
    setForm((f) => ({
      ...f,
      services: f.services.map((s) => (s.id === serviceId ? { ...s, models: s.models.filter((m) => m.id !== modelId) } : s)),
      defaults: Object.fromEntries(Object.entries(f.defaults).filter(([, k]) => k !== key)) as AppSettings['defaults'],
    }));
    setMessage({ tone: 'info', text: `模型 ${modelId} 已移除，绑定它的节点会显示「不可用」。` });
  };

  const save = async () => {
    // 内置技能在读取时补齐，保存时也补一次：旧项目 / 手工清空后不会永久丢技能
    await useCanvas.getState().setSettings(mergeBuiltinSkills(form));
    setForm(useCanvas.getState().settings);
    onNotice('设置已保存到本机');
    if (!page) onClose();
  };

  /** 技能页跳助手前先把当前表单落盘，避免切换弹窗时丢失启用状态 */
  const openAgent = async () => {
    if (!onOpenAgent) return;
    await useCanvas.getState().setSettings(mergeBuiltinSkills(form));
    onClose();
    onOpenAgent();
  };

  const requestClose = () => { if (dirty) setConfirmDiscard(true); else onClose(); };
  const content = (
    <>
        <div className="settings-workspace">
        <nav className="settings-tabs" aria-label="设置导航">
          {settingsTabs.map(([id, icon, label]) => <button key={id} data-testid={'settings-tab-' + id}
            className={tab === id ? 'active' : ''} aria-current={tab === id ? 'page' : undefined}
            onClick={() => { if (tab !== id) { setTab(id); setMessage(null); } }}>
            <Icon name={icon} size={16} /> {label}
          </button>)}
        </nav>

        <div className="dialog-body settings-body" key={tab}>
          <h2 className="settings-page-title">{title}</h2>
          {message && <div className={`settings-message tone-${message.tone}`}><Icon name={message.tone === 'ok' ? 'check' : 'info'} size={14} />{message.text}</div>}

          {tab === 'defaults' && (
            <>
              <div className="settings-intro">
                选择助手和新建生成节点默认使用的模型。已有节点保留原来的模型绑定。
              </div>
              <div className="defaults-grid">
                {modelUses.map(({ type: t, title, presets }) => {
                  const options = availableModels(form, t).filter(option => {
                    if (t !== 'text') return true;
                    const service = findBinding(form, option.key)?.service;
                    return service?.protocol === 'openai' && service.baseUrl.trim() && service.apiKey.trim();
                  });
                  const current = t === 'text' && form.assistantSource === 'codex' ? CODEX_ACCOUNT : form.defaults[t] || '';
                  const unavailable = current && current !== CODEX_ACCOUNT && !options.some(option => option.key === current);
                  const label = t === 'text' ? 'Agent 文本模型' : MODEL_TYPE_LABELS[t] + '默认模型';
                  return (
                    <section className="default-card" key={t} aria-label={title}>
                      <h4><Icon name={t} size={16} />{title}</h4>
                      {(options.length > 0 || current || (t === 'text' && codexAccount)) ? <select aria-label={label} data-testid={`default-${t}`} value={current}
                        onChange={(e) => {
                          const value = e.target.value;
                          setForm(f => value === CODEX_ACCOUNT ? { ...f, assistantSource: 'codex' } : {
                            ...f, defaults: { ...f.defaults, [t]: value },
                            ...(t === 'text' ? { assistantSource: value ? 'api' : undefined } : {}),
                          });
                        }}>
                        <option value="">{t === 'text' ? '自动选择可用来源' : options.length ? '未设置' : '暂无已启用的模型'}</option>
                        {t === 'text' && <option value={CODEX_ACCOUNT}>{codexAccount ? 'Codex（ChatGPT）' : 'Codex（待登录）'}</option>}
                        {unavailable && <option value={current}>当前绑定不可用</option>}
                        {options.map((o) => <option key={o.key} value={o.key}>{o.modelName} · {o.serviceName}</option>)}
                      </select> : <p className="model-use-empty">{t === 'text' ? '登录 Codex 或选择一个模型服务' : '选择下方一个服务'}</p>}
                      <div className="model-use-actions">
                        {presets.map(id => <button key={id} className="ghost-btn" onClick={() => setSetup({ type: t, presetId: id, draft: dirty })}>
                          {SERVICE_PRESETS.find(preset => preset.id === id)?.label}
                        </button>)}
                        <button className="ghost-btn" onClick={() => setSetup({ type: t, presetId: 'custom', draft: dirty })}><Icon name="plus" size={13} />自定义</button>
                      </div>
                      {t === 'text' && <button className="settings-link" onClick={() => setTab('external')}>{codexAccount ? '管理 Codex 账号' : '登录 Codex'} <Icon name="arrowRight" size={13} /></button>}
                    </section>
                  );
                })}
              </div>
            </>
          )}

          {tab === 'defaults' && (
            <details className="settings-services" open={showServices}
              onToggle={event => setShowServices(event.currentTarget.open)}>
              <summary>管理模型服务</summary>
              <div className="preset-row">
                <button className="preset-btn" onClick={addService}><Icon name="plus" size={12} /> 添加服务</button>
              </div>

              <div className="models-layout">
                <div className="service-list" data-testid="service-list">
                  <div className="list-head">模型服务 <em>{form.services.length}</em></div>
                  {form.services.length === 0 && <div className="list-empty">还没有模型服务。</div>}
                  {form.services.map((s) => (
                    <button key={s.id} className={`service-item${s.id === active?.id ? ' active' : ''}`} onClick={() => {
                      setActiveId(s.id); setShowKey(false); setRemote(null); setAddingModel(false); setPendingDelete(null); setMessage(null);
                    }}>
                      <span className={`svc-dot${s.enabled ? ' on' : ''}`} />
                      <span className="svc-item-main">
                        <strong>{s.name}</strong>
                        <small>{protocolSpec(s.protocol).label} · {s.models.length} 个模型</small>
                      </span>
                      <span className={`conn-mini c-${s.connection.status}`} title={s.connection.message}>
                        {s.connection.status === 'ok' ? '已验证' : s.connection.status === 'failed' ? '验证失败' : '未验证'}
                      </span>
                    </button>
                  ))}
                </div>

                <div className="service-editor">
                  {!active && <div className="editor-empty"><Icon name="sliders" size={27} /><strong>{form.services.length ? '选择一个服务' : '还没有模型服务'}</strong></div>}
                  {active && spec && (
                    <>
                      <div className="svc-head">
                        <strong>服务信息</strong>
                        <label className="switch-row"><input data-testid="service-enabled" type="checkbox" checked={active.enabled}
                          onChange={(e) => patchService(active.id, { enabled: e.target.checked })} /> 启用服务</label>
                        <button className={`mini-btn danger${pendingDelete === active.id ? ' confirm' : ''}`}
                          onClick={() => pendingDelete === active.id ? removeService(active.id) : setPendingDelete(active.id)}>
                          {pendingDelete === active.id ? '再次点击确认删除' : '删除服务'}
                        </button>
                      </div>

                      <div className="settings-grid">
                        <label className="settings-field"><span>服务名称</span>
                          <input data-testid="service-name-input" value={active.name} onChange={(e) => patchService(active.id, { name: e.target.value })} />
                        </label>
                        <label className="settings-field"><span>接口协议</span>
                          <select data-testid="service-protocol-select" value={active.protocol}
                            onChange={(e) => patchService(active.id, { protocol: e.target.value as ServiceProtocol })}>
                            {PROTOCOLS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                          </select>
                        </label>
                      </div>
                      <label className="settings-field"><span>接口地址</span>
                        <input data-testid="service-base-url-input" type="url" name="kaishi-service-url" autoComplete="off" value={active.baseUrl} placeholder={spec.baseUrlHint}
                          onChange={(e) => patchService(active.id, { baseUrl: e.target.value })} />
                      </label>
                      <label className="settings-field"><span>API Key</span>
                        <span className="key-row">
                          <input data-testid="service-api-key-input" name="kaishi-service-key" autoComplete="new-password" type={showKey ? 'text' : 'password'} value={active.apiKey}
                            placeholder={spec.keyHint} onChange={(e) => patchService(active.id, { apiKey: e.target.value })} />
                          <button className="ghost-btn" onClick={() => setShowKey(!showKey)}>{showKey ? '隐藏' : '显示'}</button>
                        </span>
                      </label>

                      <div className="test-row">
                        <button className="ghost-btn" data-testid="service-test-btn" disabled={Boolean(busy)} onClick={() => doTest(active)}>
                          <Icon name={busy === `test:${active.id}` ? 'refresh' : 'link'} size={14} />
                          {busy === `test:${active.id}` ? '测试中…' : '测试连接'}
                        </button>
                        <span className={`conn-badge c-${active.connection.status}`} data-testid="service-connection-status"
                          title={active.connection.status === 'failed' ? active.connection.message : undefined}>
                          {active.connection.status === 'ok' ? '连接正常' : active.connection.status === 'failed' ? '连接验证失败' : '连接未验证'}
                        </span>
                      </div>

                      {spec.chatEndpoint && (
                        <div className="chat-check" data-testid="chat-check">
                          <span className="chat-check-label">创作助手文本渠道</span>
                          <button className="ghost-btn" data-testid="chat-verify-btn" disabled={Boolean(busy)}
                            title="会向该服务发起一次真实的最小文本对话请求"
                            onClick={() => doChatTest(active)}>
                            <Icon name="link" size={14} /> {busy === `chat:${active.id}` ? '验证中…' : spec.chatLabel}
                          </button>
                          <span className={`chat-check-result ${chatCheck[active.id] ? (chatCheck[active.id].ok ? 'ok' : 'err') : 'off'}`}
                            data-testid="chat-check-result">
                            {chatCheck[active.id]?.message ?? '未验证 · 目录里有文本模型不等于对话可用'}
                          </span>
                        </div>
                      )}

                      <div className="svc-subhead">
                        <strong>服务下的模型</strong><em>{active.models.length} 个</em>
                        {spec.supportsListModels && <button className="mini-btn" disabled={Boolean(busy)}
                          onClick={() => doList(active)}>
                          <Icon name="refresh" size={12} /> 读取模型列表
                        </button>}
                        <button className="mini-btn" data-testid="model-add-manual" onClick={() => { if (!addingModel) { const type = active.protocol === 'compshare-h3' ? 'video' : active.protocol === 'compshare-image' ? 'image' : active.models[0]?.type || 'text'; setNewModel({ id: '', name: '', type, template: suggestedTemplate(active.protocol, type) }); } setAddingModel(!addingModel); }}><Icon name="plus" size={12} /> 手动添加模型</button>
                      </div>

                      {remote && remote.serviceId === active.id && (
                        <div className="remote-box">
                          {remote.error
                            ? <div className="remote-error">无法读取模型列表：{remote.error}</div>
                            : <>
                                <div className="remote-head">从 <code>{remote.endpoint}</code> 读取到 {remote.models.length} 个模型，选择类型后加入：</div>
                                <div className="remote-type">
                                  加入为
                                  <select value={remote.addType} onChange={(e) => setRemote({ ...remote, addType: e.target.value as ModelType })}>
                                    {MODEL_TYPES.map((t) => <option key={t} value={t}>{MODEL_TYPE_LABELS[t]}</option>)}
                                  </select>
                                  <span>/models 只返回 ID，能力会标记为「未确认」</span>
                                </div>
                                <input type="search" className="dialog-input remote-search" aria-label="搜索远程模型" placeholder="搜索模型名称或 ID"
                                  value={remote.query} onChange={e => setRemote({ ...remote, query: e.target.value })} />
                                <div className="remote-list">
                                  {remoteMatches.length === 0 && <span className="list-empty compact">没有匹配的模型</span>}
                                  {remoteMatches.map((m) => (
                                    <button key={m.id} onClick={() => addRemoteModel(active.id, m, remote.addType)}><Icon name="plus" size={11} /> {m.name || m.id} <code>{m.id}</code></button>
                                  ))}
                                </div>
                              </>}
                        </div>
                      )}

                      {addingModel && (
                        <div className="add-model-box">
                          <div className="settings-grid">
                            <label className="settings-field"><span>实际模型 ID</span>
                              <input data-testid="new-model-id" value={newModel.id} placeholder="服务商提供的模型 ID" onChange={(e) => setNewModel({ ...newModel, id: e.target.value })} />
                            </label>
                            <label className="settings-field"><span>显示名称</span>
                              <input value={newModel.name} placeholder="与模型 ID 相同则可留空" onChange={(e) => setNewModel({ ...newModel, name: e.target.value })} />
                            </label>
                          </div>
                          <div className="settings-grid">
                            <label className="settings-field"><span>模型类型</span>
                              <select data-testid="new-model-type" value={newModel.type} onChange={(e) => { const type = e.target.value as ModelType; setNewModel({ ...newModel, type, template: suggestedTemplate(active.protocol, type) }); }}>
                                {MODEL_TYPES.map((t) => <option key={t} value={t}>{MODEL_TYPE_LABELS[t]}</option>)}
                              </select>
                            </label>
                            <label className="settings-field"><span>能力（来自公开文档）</span>
                              <select data-testid="new-model-template" value={newModel.template} onChange={(e) => setNewModel({ ...newModel, template: e.target.value })}>
                                {CAPABILITY_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
                              </select>
                            </label>
                          </div>
                          <div className="add-model-foot">
                            <span>同 ID 在不同服务下是不同绑定，互不冲突。</span>
                            <button className="primary-btn" data-testid="model-add-confirm" onClick={() => addManualModel(active.id)}>添加模型</button>
                          </div>
                        </div>
                      )}

                      {active.models.length === 0 && <div className="list-empty compact">
                        {spec.supportsListModels ? '读取模型列表，或手动添加模型。' : '请手动添加模型。'}
                      </div>}
                      {active.models.map((m) => (
                        <div className="model-row" key={m.id} data-model-row={m.id}>
                          <div className="model-row-main">
                            <span className={`type-badge t-${m.type}`}>{MODEL_TYPE_LABELS[m.type]}</span>
                            <div className="model-row-id">
                              <strong>{m.name}</strong>
                              <code>{m.id}</code>
                            </div>
                            <span className={`model-cap-tag${m.capabilities.ratios.length ? '' : ' empty'}`}>
                              {m.capabilities.ratios.length ? `${m.capabilities.ratios.length} 比例 · ${m.capabilities.roles.length} 用途` : '能力未确认'}
                            </span>
                            <label className="switch-row"><input type="checkbox" checked={m.enabled}
                              onChange={(e) => patchModel(active.id, m.id, { enabled: e.target.checked })} /> 启用</label>
                            <button className="mini-btn" disabled={!active.enabled || !m.enabled}
                              aria-pressed={form.defaults[m.type] === makeModelKey(active.id, m.id)}
                              onClick={() => setForm(previous => ({ ...previous, defaults: { ...previous.defaults, [m.type]: makeModelKey(active.id, m.id) } }))}>
                              {form.defaults[m.type] === makeModelKey(active.id, m.id) ? '默认模型' : '设为默认'}
                            </button>
                            <button className="mini-btn" onClick={() => setExpandedModel(expandedModel === m.id ? null : m.id)}>能力</button>
                            <button className="mini-btn danger" title="移除模型" onClick={() => removeModel(active.id, m.id)}><Icon name="close" size={11} /></button>
                          </div>
                          {expandedModel === m.id && (
                            <CapabilityEditor caps={m.capabilities} onChange={(c) => patchModel(active.id, m.id, { capabilities: c })} />
                          )}
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

            </details>
          )}

          {tab === 'canvas' && (
            <section className="settings-section">
              <label className="check-row"><input type="checkbox" checked={form.showGrid} onChange={(e) => setForm({ ...form, showGrid: e.target.checked })} /><span>显示点阵网格</span></label>
              <label className="check-row"><input type="checkbox" checked={form.snapToGrid} onChange={(e) => setForm({ ...form, snapToGrid: e.target.checked })} /><span>拖动时吸附到 20px 网格</span></label>
              <label className="check-row"><input type="checkbox" checked={form.wheelZoom} onChange={(e) => setForm({ ...form, wheelZoom: e.target.checked })} /><span>滚轮直接缩放（关闭后滚轮平移，Ctrl+滚轮缩放）</span></label>
            </section>
          )}

          {tab === 'external' && <AgentConnection />}
          {tab === 'skills' && (
            <SkillsPanel
              form={form}
              setForm={setForm}
              onOpenAgent={() => void openAgent()}
              onNotice={(text, kind) => {
                setMessage({ tone: kind === 'err' ? 'err' : kind === 'info' ? 'info' : 'ok', text });
              }}
            />
          )}
        </div>
        </div>

        {(!page || dirty) && <div className="dialog-foot">
          {dirty && <span className="settings-unsaved">有未保存的修改</span>}
          <button className="ghost-btn" onClick={page ? () => { setForm(saved); setMessage(null); } : onClose}>取消</button>
          {(tab !== 'external' || dirty) && <button className="primary-btn" onClick={save} disabled={!dirty}><Icon name="check" size={15} /> 保存设置</button>}
        </div>}
    </>
  );

  return (<>
    {page ? <div className="settings-page"><div className="settings-dialog settings-embedded">
      <div className="dialog-head"><h1>设置</h1></div>
      {content}
    </div></div> : <WorkflowDialog title="设置" className="dialog settings-dialog settings-wide"
      onClose={requestClose} closeOnBackdrop={!dirty}>
      {content}
    </WorkflowDialog>}
    {confirmDiscard && <ConfirmDialog title="放弃未保存的设置？" message="关闭后，本次修改会丢失。"
      confirmText="放弃修改" onCancel={() => setConfirmDiscard(false)} onConfirm={onClose} />}
    {setup && <QuickModelSetup type={setup.type} presetId={setup.presetId}
      draftSettings={setup.draft ? form : undefined} onDraft={setup.draft ? setForm : undefined}
      onClose={() => setSetup(null)} onApply={() => {
        if (!setup.draft) { setForm(useCanvas.getState().settings); onNotice('模型已保存'); }
        setSetup(null);
      }} />}
  </>);
}

/* ------------------------------ 图片放大查看 ------------------------------ */
export function ImageLightbox({ assetId, onClose }: { assetId: string; onClose: () => void }) {
  const url = useAssetUrl(assetId);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [name, setName] = useState('图片');

  useEffect(() => {
    getAsset(assetId).then((rec) => { if (rec) setName(rec.meta.name); }).catch(() => undefined);
  }, [assetId]);

  // onClose 由父组件内联传入，父级重渲染时不能卸载本次派发中的监听，
  // 否则画布 Esc 先清选中态会让放大视图收不到同一次按键。
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy });
  };
  const onPointerUp = () => { dragRef.current = null; };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setScale((s) => Math.min(8, Math.max(0.2, s * Math.pow(1.0015, -e.deltaY))));
  };
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  return (
    <div className="lightbox" onWheel={onWheel} onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="lightbox-bar" onPointerDown={(e) => e.stopPropagation()}>
        <span className="lightbox-name" title={name}>{name}</span>
        <div className="lightbox-ops">
          <button title="缩小" onClick={() => setScale((s) => Math.max(0.2, s / 1.25))}><Icon name="zoomOut" size={17} /></button>
          <button className="zoom-label" onClick={reset} title="恢复原始大小">{Math.round(scale * 100)}%</button>
          <button title="放大" onClick={() => setScale((s) => Math.min(8, s * 1.25))}><Icon name="zoomIn" size={17} /></button>
          <button onClick={reset} title="复原"><Icon name="fit" size={17} /></button>
          <span className="lightbox-sep" />
          <button title="关闭 (Esc)" onClick={onClose}><Icon name="close" size={18} /></button>
        </div>
      </div>
      <div className="lightbox-stage" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onDoubleClick={reset}>
        {url
          ? <img src={url} alt={name} draggable={false} style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }} />
          : <div className="media-placeholder">图片加载中…</div>}
      </div>
      <div className="lightbox-tip">滚轮缩放 · 拖动平移 · 双击复原 · Esc 关闭</div>
    </div>
  );
}

/* ------------------------------ 消息提示 ------------------------------ */
export interface ToastItem { id: number; text: string; kind: 'ok' | 'err' | 'info' }

export function ToastStack({ items }: { items: ToastItem[] }) {
  return (
    <div className="toast-stack">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <Icon name={t.kind === 'ok' ? 'check' : t.kind === 'err' ? 'close' : 'info'} size={16} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
