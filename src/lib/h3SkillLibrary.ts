/// <reference types="vite/client" />
import type { CanvasSkill } from '../types';

const core = import.meta.glob<string>('./h3-skills/*/SKILL.md', { eager: true, query: '?raw', import: 'default' });
const resources = import.meta.glob<string>(['./h3-skills/*/**/*.md', '!./h3-skills/*/SKILL.md'], { query: '?raw', import: 'default' });

const titles = [
  ['h3-visual-design', 'H3 视觉设计', '动态字体、TD 追踪和真人手绘融合'],
  ['brand-ad', '品牌广告', '产品镜头、材质表现和商业叙事'],
  ['cinematic-title-sequence', '电影片头', '空间字体、镜头调度和标题呈现'],
  ['cool-music-video', '音乐视觉', '音乐、节拍、镜头和转场'],
  ['education-studio', '知识视频', '解释型内容、视觉隐喻和分镜'],
  ['koc-video', 'KOC 视频', '体验分享、真人口播和补拍镜头'],
  ['anime-game-pv', '动漫游戏 PV', '角色、动作和宣传片结构'],
  ['ui-motion', 'UI 动效', '界面演示和产品交互动效'],
  ['video-deconstruct', '视频拆解', '依据可见素材拆镜头、节奏和构图'],
] as const;

export const H3_DIRECTOR_ID = 'h3-director';
export const H3_DIRECTOR = `你正在开视中以 H3 导演身份工作。根据用户完整目标判断交付物和画布现状。单条独立镜头直接准备可执行提示词；多镜头共享角色、场景或声音时，先明确镜头顺序、共同参考和依赖。只使用用户确认的信息和画布中真实存在的素材。不能观察的画面或声音，明确需要用户提供描述或证据。
每轮只应用一个匹配的创作 Skill。以传入的 Skill 正文和本次选中的参考文档编写分镜和提示词。原 Skill 中的 Hub、插件、下载、外部账号及子 Agent 调用是旧工具环境的描述。在开视中，用当前可用的画布操作表达计划。先在回复里给出用户能审核的改动，并用 actions 表达要应用的节点、连线和参数。
用户选择的模型优先。H3 视频优先选当前已配置的 compshare-h3 模型，依据模型支持的时长、分辨率和比例设置节点。多模态参考与首尾帧分开使用。保持提示词中的素材顺序和节点连线一致。成型的 H3 结构化提示词要完整落入节点，不在下游二次改写；通过 set_video_params 将 useContextIr 设为 false 以原样发送。生成由画布按钮或用户明确调用的外部 Agent 工具触发。`;

export const h3Skills: CanvasSkill[] = titles.map(([id, title, description]) => ({
  id: `minimax-${id}`,
  name: title,
  description,
  body: core[`./h3-skills/${id}/SKILL.md`],
  template: '创作目标：{goal}\n按当前 Skill 的规则整理镜头、素材引用和可直接应用到画布的提示词。',
  appliesTo: 'video',
  requires: 'text-model',
  origin: 'MiniMax 创作技能',
  builtin: true,
  enabled: true,
  version: '2.0.0',
  createdAt: 0,
  updatedAt: 0,
}));

export function h3ResourcePaths(skillId: string): string[] {
  if (!h3Skills.some(skill => skill.id === skillId)) return [];
  const prefix = `./h3-skills/${skillId.slice('minimax-'.length)}/`;
  return Object.keys(resources).filter(path => path.startsWith(prefix)).map(path => path.slice(prefix.length));
}

export async function readH3Resource(skillId: string, resource: string): Promise<string> {
  if (!h3ResourcePaths(skillId).includes(resource)) throw new Error('该 Skill 没有这份参考文件');
  return resources[`./h3-skills/${skillId.slice('minimax-'.length)}/${resource}`]();
}
