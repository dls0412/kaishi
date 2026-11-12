import { useEffect, useState, type ReactNode } from 'react';
import type { ProjectSummary } from '../types';
import { getProject } from '../lib/db';
import Icon from './Icon';
import { useAssetUrl } from './useAssetUrl';

export type DesktopPage = 'home' | 'projects' | 'assets' | 'settings';
export type Starter = 'image' | 'video';

const navigation = [
  ['home', 'home', '首页'],
  ['projects', 'folder', '项目'],
  ['assets', 'image', '资产'],
  ['settings', 'sliders', '模型配置'],
] as const;

function ProjectPreview({ project }: { project: ProjectSummary }) {
  const [assetId, setAssetId] = useState('');
  useEffect(() => {
    let active = true;
    void getProject(project.id).then(record => {
      const image = record?.data.nodes.find(node => node.type === 'image' && node.assetId);
      if (active) setAssetId(image && 'assetId' in image ? image.assetId : '');
    }).catch(() => { if (active) setAssetId(''); });
    return () => { active = false; };
  }, [project.id, project.updatedAt]);
  const url = useAssetUrl(assetId || undefined);
  return <span className="desktop-project-preview">
    {url ? <img src={url} alt="" loading="lazy" /> : <Icon name={project.nodeCount ? 'flow' : 'layers'} size={25} />}
  </span>;
}

function ProjectCard({ project, onOpen, onRename, onDelete }: {
  project: ProjectSummary; onOpen: () => void; onRename?: () => void; onDelete?: () => void;
}) {
  const date = new Date(project.updatedAt);
  return <article className="desktop-project">
    <button className="desktop-project-open" onClick={onOpen}>
      <ProjectPreview project={project} />
      <span className="desktop-project-copy">
        <strong title={project.name}>{project.name}</strong>
        <small>{date.toLocaleDateString('zh-CN')} · {project.nodeCount} 个节点</small>
      </span>
      <Icon className="desktop-project-arrow" name="arrowRight" size={16} />
    </button>
    {onRename && <button className="icon-btn" title={'重命名项目「' + project.name + '」'} onClick={onRename}><Icon name="edit" size={15} /></button>}
    {onDelete && <button className="icon-btn desktop-project-delete" title={'删除项目「' + project.name + '」'} onClick={onDelete}><Icon name="trash" size={15} /></button>}
  </article>;
}

export default function DesktopShell({ page, projects, children, onPage, onNew, onImport, onOpen, onRename, onDelete, onAssistant }: {
  page: DesktopPage; projects: ProjectSummary[]; children?: ReactNode;
  onPage: (page: DesktopPage) => void;
  onNew: (starter?: Starter) => void;
  onImport: () => void;
  onOpen: (id: string) => void;
  onRename: (project: ProjectSummary) => void;
  onDelete: (project: ProjectSummary) => void;
  onAssistant: () => void;
}) {
  const [query, setQuery] = useState('');
  const visible = projects.filter(project => project.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="desktop-shell">
    <aside className="desktop-sidebar">
      <button className="desktop-brand brand" title="开视首页" onClick={() => onPage('home')}><img className="brand-mark" src="/kaishi.svg" alt="" /><span>开视</span></button>
      <button className="desktop-new" title="新建项目" onClick={() => onNew()}><Icon name="plus" size={18} /><span>新建项目</span></button>
      <nav aria-label="客户端导航">
        {navigation.map(([id, icon, label]) => <button key={id} aria-current={page === id ? 'page' : undefined}
          title={label} onClick={() => onPage(id)}><Icon name={icon} size={18} /><span>{label}</span></button>)}
      </nav>
      <div className="desktop-sidebar-foot"><Icon name="database" size={15} /><span>本机工作区</span></div>
    </aside>
    <main key={page} className={'desktop-main desktop-' + page}>
      <div className="desktop-content">
        {page === 'home' && <>
          <header className="desktop-page-head">
            <h1>首页</h1>
            <button className="ghost-btn" onClick={onImport}><Icon name="upload" size={15} /> 导入项目</button>
          </header>
          <button className="desktop-create" onClick={() => onNew()}>
            <span className="desktop-create-icon"><Icon name="plus" size={28} /></span>
            <strong>新建画布</strong>
          </button>
          <div className="desktop-shortcuts" aria-label="创作入口">
            <button onClick={() => onNew('video')}><span><Icon name="video" size={22} /></span><strong>视频生成</strong></button>
            <button onClick={() => onNew('image')}><span><Icon name="image" size={22} /></span><strong>图片生成</strong></button>
            <button onClick={onAssistant}><span><Icon name="sparkles" size={22} /></span><strong>AI 助手</strong></button>
          </div>
          <section className="desktop-recents">
            <div className="desktop-section-head"><h2>最近项目</h2><button onClick={() => onPage('projects')}>查看全部 <Icon name="arrowRight" size={15} /></button></div>
            <div className="desktop-project-grid">
              {projects.slice(0, 4).map(project => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)} />)}
              {!projects.length && <p className="desktop-empty">还没有项目。</p>}
            </div>
          </section>
        </>}
        {page === 'projects' && <>
          <header className="desktop-page-head"><h1>项目 <small>{projects.length}</small></h1>
            <button className="ghost-btn" onClick={onImport}><Icon name="upload" size={15} /> 导入项目</button>
          </header>
          <label className="desktop-search"><Icon name="search" size={16} /><input aria-label="搜索项目" placeholder="搜索项目名称" value={query} onChange={e => setQuery(e.target.value)} /></label>
          <div className="desktop-project-grid">
            {visible.map(project => <ProjectCard key={project.id} project={project} onOpen={() => onOpen(project.id)}
              onRename={() => onRename(project)} onDelete={() => onDelete(project)} />)}
            {!visible.length && <p className="desktop-empty">{projects.length ? '没有匹配的项目。' : '还没有项目。'}</p>}
          </div>
        </>}
        {children}
      </div>
    </main>
  </div>;
}
