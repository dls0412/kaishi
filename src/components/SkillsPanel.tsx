import { useEffect, useRef, useState } from 'react';
import { downloadBlob, uid } from '../lib/utils';
import {
  parseSkillFile,
  skillReadiness,
  skillToMarkdown,
} from '../lib/skills';
import { firstTextService } from '../lib/skills';
import { codexStatus, useCodexAccount } from '../lib/codexAccount';
import type { AppSettings, CanvasSkill } from '../types';
import Icon from './Icon';

interface Props {
  form: AppSettings;
  setForm: (next: AppSettings) => void;
  onOpenAgent: () => void;
  onNotice: (text: string, kind?: 'ok' | 'err' | 'info') => void;
}

const REQUIRE_LABEL: Record<CanvasSkill['requires'], string> = {
  none: '纯文字', 'text-model': '文本模型', 'image-model': '图片模型', 'video-model': '视频模型',
};
const APPLY_LABEL: Record<CanvasSkill['appliesTo'], string> = {
  text: '文字节点', image: '图片节点', video: '视频节点', audio: '音频节点', canvas: '整个画布', any: '不限',
};

/**
 * 本机技能库。
 * 对标 BeefTV「我的技能」：查看文件、启用停用、检查能力条件、复制为私人改写、导入导出。
 * 没有联网市场与版本回退，因为本工具不连账号；版本字段保留，便于以后接入。
 */
export default function SkillsPanel({ form, setForm, onOpenAgent, onNotice }: Props) {
  const [openId, setOpenId] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const skills = form.skills ?? [];
  const channel = firstTextService(form);
  const codexAccount = useCodexAccount(state => state.status?.account);
  useEffect(() => { void codexStatus().catch(() => {}); }, []);

  const patchSkills = (next: CanvasSkill[]) => setForm({ ...form, skills: next });

  const importFiles = async (files: File[]) => {
    let added = 0;
    const next = [...skills];
    for (const file of files) {
      try {
        const skill = parseSkillFile(file.name, await file.text());
        next.push({ ...skill, id: `skill-${uid('').replace(/^_/, '')}` });
        added += 1;
      } catch (err) {
        onNotice(`「${file.name}」导入失败：${err instanceof Error ? err.message : String(err)}`, 'err');
      }
    }
    if (added) {
      patchSkills(next);
      onNotice(`已导入 ${added} 个技能到本机技能库`, 'ok');
    }
  };

  const copySkill = (skill: CanvasSkill) => {
    const now = Date.now();
    patchSkills([...skills, {
      ...skill, id: `skill-${now}`, name: `${skill.name} · 私人改写`, builtin: false,
      origin: '私人改写', version: skill.version, createdAt: now, updatedAt: now,
    }]);
    onNotice(`已复制为私人版本：${skill.name}`, 'ok');
  };

  const removeSkill = (skill: CanvasSkill) => {
    if (skill.builtin) { onNotice('内置技能不能删除，可以停用或复制为私人版本', 'info'); return; }
    patchSkills(skills.filter((s) => s.id !== skill.id));
    onNotice(`已移除技能「${skill.name}」`, 'ok');
  };

  const exportSkill = (skill: CanvasSkill) => {
    downloadBlob(new Blob([skillToMarkdown(skill)], { type: 'text/markdown;charset=utf-8' }), `${skill.name}.md`);
    onNotice(`已导出技能文件「${skill.name}.md」`, 'ok');
  };

  return (
    <section className="settings-section skills-section">
      <div className="skills-summary" data-testid="skills-summary">
        <span>本机技能 <strong data-testid="skills-count">{skills.length}</strong> 个，启用 <strong data-testid="skills-enabled-count">{skills.filter((s) => s.enabled).length}</strong> 个</span>
        <span className={channel || codexAccount ? 'agent-channel ok' : 'agent-channel off'} data-testid="agent-text-channel">
          {channel ? `${channel.service.name} / ${channel.modelId}` : codexAccount ? 'Codex 已登录' : '请配置文本模型或登录 Codex'}
        </span>
      </div>

      <div className="skills-actions">
        <input ref={fileRef} type="file" hidden multiple accept=".md,.markdown,.json,.txt,text/markdown,application/json,text/plain"
          data-testid="skill-import-input"
          onChange={(e) => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <button className="mini-btn" data-testid="skill-import" onClick={() => fileRef.current?.click()}><Icon name="upload" size={12} /> 导入技能文件</button>
        <button className="mini-btn" data-testid="open-agent" onClick={onOpenAgent}><Icon name="sparkles" size={12} /> 打开创作助手</button>
      </div>

      <div className="skill-list" data-testid="skill-list">
        {skills.map((skill) => {
          const ready = skillReadiness(skill, form, Boolean(codexAccount));
          const open = openId === skill.id;
          return (
            <div key={skill.id} className={`skill-row${skill.enabled ? '' : ' disabled'}`} data-testid="skill-row" data-skill-id={skill.id}>
              <div className="skill-row-main">
                <label className="skill-toggle" title={skill.enabled ? '停用技能' : '启用技能'}>
                  <input type="checkbox" checked={skill.enabled} data-testid="skill-enabled"
                    onChange={(e) => patchSkills(skills.map((s) => (s.id === skill.id ? { ...s, enabled: e.target.checked } : s)))} />
                </label>
                <div className="skill-row-text">
                  <strong>{skill.name}</strong>
                  <span>{skill.description}</span>
                </div>
                <div className="skill-row-tags">
                  <em className="skill-tag">{skill.origin}</em>
                  <em className="skill-tag">v{skill.version}</em>
                  <em className="skill-tag">{APPLY_LABEL[skill.appliesTo]}</em>
                  <em className={`skill-tag ${ready.met ? 'ok' : 'warn'}`} data-testid="skill-readiness" title={ready.reason}>
                    {REQUIRE_LABEL[skill.requires]}{ready.met ? '' : ' · 未满足'}
                  </em>
                </div>
                <div className="skill-row-ops">
                  <button className="mini-btn" data-testid="skill-view" title="查看技能文件" onClick={() => setOpenId(open ? '' : skill.id)}>{open ? '收起' : '查看'}</button>
                  <button className="mini-btn" data-testid="skill-copy" title="复制为私人改写" onClick={() => copySkill(skill)}>复制</button>
                  <button className="mini-btn" data-testid="skill-export" title="导出为 Markdown" onClick={() => exportSkill(skill)}>导出</button>
                  <button className="mini-btn" data-testid="skill-delete" title={skill.builtin ? '内置技能不可删除' : '移除技能'} onClick={() => removeSkill(skill)}>移除</button>
                </div>
              </div>
              {open && (
                <div className="skill-detail" data-testid="skill-detail">
                  <div className="skill-detail-meta">所需能力：{ready.label} · {ready.reason} · 适用：{APPLY_LABEL[skill.appliesTo]}</div>
                  <h5>方法与要求</h5>
                  <pre>{skill.body}</pre>
                  <h5>方案模板</h5>
                  <pre>{skill.template}</pre>
                </div>
              )}
            </div>
          );
        })}
        {!skills.length && <div className="list-empty">技能库还是空的。可以导入 Markdown 或 JSON 技能文件。</div>}
      </div>

      <div className="settings-note">
        <Icon name="info" size={15} />
        支持导入单个技能文件的正文，不会自动导入该文件引用的其他资料或运行脚本。需要配套资料的技能，请将必要内容一并写进正文。
      </div>
    </section>
  );
}
