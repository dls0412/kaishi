import { useState } from 'react';
import { useCanvas } from '../store';
import { capabilityTemplate, newServiceFromPreset, SERVICE_PRESETS, suggestedTemplate } from '../lib/modelCatalog';
import { listRemoteModels, makeModelKey, testServiceConnection, type RemoteModel } from '../lib/models';
import { uid } from '../lib/utils';
import { MODEL_TYPE_LABELS, type AppSettings, type ConnectionState, type ModelService, type ModelType, type ServiceProtocol } from '../types';
import WorkflowDialog from './WorkflowDialog';

export type SetupModelType = ModelType;
const NEW = 'new';

export default function QuickModelSetup({ type, initialKey, presetId, draftSettings, onDraft, onClose, onApply }: {
  type: SetupModelType;
  initialKey?: string;
  presetId?: string;
  draftSettings?: AppSettings;
  onDraft?: (settings: AppSettings) => void;
  onClose: () => void;
  onApply: (key: string) => void;
}) {
  const savedSettings = useCanvas(s => s.settings);
  const settings = draftSettings ?? savedSettings;
  const label = MODEL_TYPE_LABELS[type];
  const preset = SERVICE_PRESETS.find(p => p.protocol !== 'openai' && p.models.some(m => m.type === type));
  const chosenPreset = SERVICE_PRESETS.find(p => p.id === presetId && p.models.some(m => m.type === type));
  const configureCustom = presetId === 'custom';
  const services = settings.services.filter(s => s.protocol === 'openai' || s.protocol === preset?.protocol);
  const [serviceId, setServiceId] = useState(() => {
    const current = services.find(s => initialKey?.startsWith(s.id + '::'));
    if (configureCustom) return NEW;
    if (chosenPreset) return services.find(s => s.protocol === chosenPreset.protocol && s.baseUrl.replace(/\/+$/, '') === chosenPreset.baseUrl)?.id ?? NEW;
    const preferred = type === 'video' ? services.find(s => s.protocol === 'compshare-h3') : services[0];
    return current?.id ?? preferred?.id ?? NEW;
  });
  const [newServiceId] = useState(() => uid('svc'));
  const existing = services.find(s => s.id === serviceId);
  const [protocol, setProtocol] = useState<ServiceProtocol>(chosenPreset?.protocol ?? (type === 'video' && !configureCustom ? 'compshare-h3' : 'openai'));
  const [serviceName, setServiceName] = useState('');
  const [manual, setManual] = useState(configureCustom);
  const [address, setAddress] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [replaceKey, setReplaceKey] = useState(false);
  const [reuseKey, setReuseKey] = useState(false);
  const [modelId, setModelId] = useState('');
  const [makeDefault, setMakeDefault] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState<{ connection: ConnectionState; models: RemoteModel[] }>();
  const selectedProtocol = existing?.protocol ?? protocol;
  const currentPreset = chosenPreset && selectedProtocol === chosenPreset.protocol
    && (!existing || existing.baseUrl.replace(/\/+$/, '') === chosenPreset.baseUrl) ? chosenPreset
    : selectedProtocol === preset?.protocol ? preset : undefined;
  const knownModels = [...new Map([...(currentPreset?.models ?? []), ...(existing?.models ?? [])]
    .filter(model => model.type === type).map(model => [model.id, model])).values()];
  const preferredKey = initialKey || settings.defaults[type];
  const preferredModel = knownModels.find(model => existing && makeModelKey(existing.id, model.id) === preferredKey);
  const selectedModel = modelId.trim() || (!manual ? preferredModel?.id || knownModels[0]?.id : '') || '';
  const simplePreset = !!(currentPreset || existing) && !!knownModels.length;
  const serviceAddress = address.trim() || existing?.baseUrl || currentPreset?.baseUrl || '';
  const savedKey = (() => {
    if (!existing?.apiKey) return '';
    if (!address.trim()) return existing.apiKey;
    try { return new URL(existing.baseUrl).origin === new URL(serviceAddress).origin ? existing.apiKey : ''; }
    catch { return ''; }
  })();
  const sameProviderKey = selectedProtocol.startsWith('compshare-') && serviceAddress.replace(/\/+$/, '') === 'https://cp.compshare.cn'
    ? settings.services.find(s => s.protocol.startsWith('compshare-') && s.baseUrl.replace(/\/+$/, '') === 'https://cp.compshare.cn' && s.apiKey.trim())?.apiKey : '';
  const serviceKey = apiKey.trim() || savedKey || (reuseKey ? sameProviderKey : '') || '';
  const resetCheck = () => { setVerified(undefined); setError(''); };
  const choices = [...new Map([...(verified?.models ?? []), ...knownModels].map(model => [model.id, model])).values()];

  const draft = (): ModelService => {
    const now = Date.now();
    const id = existing?.id ?? newServiceId;
    const base = existing ?? (currentPreset ? newServiceFromPreset(currentPreset, id) : {
      id, name: 'OpenAI 兼容服务', protocol: 'openai' as const, baseUrl: '', apiKey: '',
      enabled: true, models: [], note: '', createdAt: now,
      connection: { status: 'unverified' as const, checkedAt: 0, endpoint: '', message: '' },
    });
    return { ...base, name: serviceName.trim() || base.name, protocol: selectedProtocol, baseUrl: serviceAddress, apiKey: serviceKey, enabled: true };
  };

  const validate = () => {
    let url: URL;
    try { url = new URL(serviceAddress); } catch { return '请填写完整的接口地址'; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      return '请填写不含凭据、查询参数或片段的 HTTP(S) 接口地址';
    }
    return serviceKey ? '' : '请填写 API Key';
  };

  const check = async (service: ModelService) => {
    const connection = await testServiceConnection(service);
    if (connection.status !== 'ok') throw new Error(connection.message);
    return connection;
  };

  const test = async () => {
    resetCheck();
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    setBusy(true);
    try {
      const service = draft();
      if (currentPreset?.id === 'minimax-h3-image') {
        setError('MiniMax 官方图片接口没有已确认的免费验证方式；请保存配置后通过生成图片验证。');
        return;
      }
      if (service.protocol === 'openai') {
        const result = await listRemoteModels(service);
        if (result.error) { setError(result.error); return; }
        setVerified({ connection: { status: 'ok', checkedAt: Date.now(), endpoint: result.endpoint, message: '模型目录已读取' }, models: result.models });
      } else {
        const connection = await check(service);
        setVerified({ connection, models: [] });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接测试失败');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    const invalid = validate();
    if (invalid) { setError(invalid); return; }
    if (!selectedModel) return;
    setBusy(true);
    setError('');
    try {
      const service = draft();
      const model = service.models.find(m => m.id === selectedModel);
      if (model && model.type !== type) { setError('该模型 ID 已用于其他模型类型，请选择另一个模型'); return; }
      const name = choices.find(m => m.id === selectedModel)?.name || selectedModel;
      service.models = [
        ...service.models.filter(m => m.id !== selectedModel),
        model ? { ...model, enabled: true } : { id: selectedModel, name, type, enabled: true, capabilities: capabilityTemplate(suggestedTemplate(service.protocol, type)) },
      ];
      const savedConnection = existing?.baseUrl === service.baseUrl && existing.apiKey === service.apiKey
        && existing.connection.status === 'ok' ? existing.connection : undefined;
      const shouldCheckPreset = simplePreset && currentPreset
        && currentPreset.id !== 'minimax-h3-image'
        && (service.protocol !== 'openai' || service.baseUrl.replace(/\/+$/, '') === currentPreset.baseUrl);
      service.connection = verified?.connection ?? savedConnection ?? (shouldCheckPreset ? await check(service) : {
        status: 'unverified', checkedAt: 0, endpoint: '', message: '手动配置，尚未测试连接',
      });
      const state = useCanvas.getState();
      const baseSettings = draftSettings ?? state.settings;
      const savedServices = baseSettings.services.some(item => item.id === service.id)
        ? baseSettings.services.map(item => item.id === service.id ? service : item)
        : [...baseSettings.services, service];
      const key = makeModelKey(service.id, selectedModel);
      const next: AppSettings = {
        ...baseSettings, services: savedServices,
        defaults: makeDefault ? { ...baseSettings.defaults, [type]: key } : baseSettings.defaults,
        ...(makeDefault && type === 'text' ? { assistantSource: 'api' } : {}),
      };
      if (onDraft) onDraft(next);
      else await state.setSettings(next);
      onApply(key);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败，请检查本机存储后重试');
    } finally {
      setBusy(false);
    }
  };

  const addressField = <label>接口地址<input className="dialog-input" data-dialog-focus={!simplePreset || undefined}
    type="url" name="kaishi-service-url" autoComplete="off" value={address} disabled={busy}
    placeholder={existing?.baseUrl || currentPreset?.baseUrl || 'https://你的服务地址/v1'}
    onChange={event => { setAddress(event.target.value); setReuseKey(false); resetCheck(); }} /></label>;
  const modelField = <label>模型 ID<input className="dialog-input" value={modelId} disabled={busy}
    placeholder="填写服务商提供的模型 ID" onChange={event => { setManual(true); setModelId(event.target.value); }} /></label>;

  return <WorkflowDialog title={`配置${label}模型`} onClose={onClose} busy={busy}>
    <form noValidate onSubmit={event => { event.preventDefault(); if (!busy) void save(); }}>
    <div className="workflow-fields">
      {simplePreset ? <div className="workflow-model-summary">
        <strong>{choices.find(model => model.id === selectedModel)?.name || selectedModel || '选择模型'}</strong>
        <span>{serviceName.trim() || existing?.name || currentPreset?.serviceName}</span>
      </div> : addressField}
      {currentPreset?.id === 'minimax-h3-image' && <p>请填写 MiniMax 开放平台的 API Key；优云智算的 Key 不能用于此服务。</p>}
      {(!savedKey || replaceKey) && !reuseKey
        ? <label>API Key<input className="dialog-input" data-dialog-focus={simplePreset || undefined} autoFocus={replaceKey}
          type="password" name="kaishi-service-key" autoComplete="new-password" value={apiKey} disabled={busy}
          placeholder="输入服务商提供的 API Key" onChange={event => { setApiKey(event.target.value); resetCheck(); }} /></label>
        : !reuseKey && <div className="workflow-key-saved"><span>使用已保存的 API Key</span>
          <button className="ghost-btn" type="button" disabled={busy} onClick={() => setReplaceKey(true)}>更换 Key</button>
        </div>}
      {sameProviderKey && !apiKey && !savedKey && <label className="workflow-check">
        <input type="checkbox" checked={reuseKey} disabled={busy} onChange={event => { setReuseKey(event.target.checked); resetCheck(); }} />
        使用已保存的共绩算力 API Key
      </label>}
      {!simplePreset && modelField}
      <details className="workflow-advanced">
        <summary>高级设置</summary>
        <div className="workflow-fields">
          {!!services.length && <label>模型服务<select className="dialog-input" value={serviceId} disabled={busy}
            onChange={event => { setServiceId(event.target.value); setServiceName(''); setAddress(''); setApiKey(''); setReuseKey(false); setReplaceKey(false); setModelId(''); setManual(false); resetCheck(); }}>
            {services.map(service => <option key={service.id} value={service.id}>{service.name}</option>)}
            <option value={NEW}>添加新服务</option>
          </select></label>}
          {!existing && <label>服务协议<select className="dialog-input" value={protocol} disabled={busy}
            onChange={event => { setProtocol(event.target.value as ServiceProtocol); setAddress(''); setReuseKey(false); setModelId(''); setManual(false); resetCheck(); }}>
            {preset && <option value={preset.protocol}>{preset.label}</option>}
            <option value="openai">{type === 'video' ? '兼容 /videos 接口' : 'OpenAI 兼容'}</option>
          </select></label>}
          <label>服务名称<input className="dialog-input" value={serviceName} disabled={busy} autoComplete="off"
            placeholder={existing?.name || currentPreset?.serviceName || '我的模型服务'}
            onChange={event => setServiceName(event.target.value)} /></label>
          {simplePreset && addressField}
          {choices.length > 0 && <label>从服务中选择模型<select className="dialog-input" disabled={busy}
            value={choices.some(model => model.id === selectedModel) ? selectedModel : ''} onChange={event => { setModelId(event.target.value); setManual(false); }}>
            <option value="">选择模型</option>
            {choices.map(model => <option key={model.id} value={model.id}>{model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}</option>)}
          </select></label>}
          {simplePreset && (manual ? modelField : <button className="ghost-btn workflow-option" type="button" disabled={busy}
            onClick={() => { setManual(true); setModelId(selectedModel); }}>手动添加模型</button>)}
          <label className="workflow-check"><input type="checkbox" checked={makeDefault} disabled={busy}
            onChange={event => setMakeDefault(event.target.checked)} />设为默认{label}模型</label>
          <button className="ghost-btn workflow-option" type="button" disabled={busy} onClick={() => void test()}>测试连接</button>
        </div>
      </details>
      {verified && <span className="workflow-ok" role="status">服务连接通过</span>}
      {error && <p className="chat-error" role="alert">{error}</p>}
    </div>
    <footer className="dialog-foot">
      <button className="primary-btn" type="submit" disabled={busy || !selectedModel}>{busy ? '正在处理…' : onDraft ? '加入设置' : '保存并使用'}</button>
    </footer>
    </form>
  </WorkflowDialog>;
}
