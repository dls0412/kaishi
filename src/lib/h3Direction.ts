import type { CanvasSkill } from '../types';
import { H3_DIRECTOR, H3_DIRECTOR_ID, h3ResourcePaths, h3Skills, readH3Resource } from './h3SkillLibrary';
const screenplayRefs = import.meta.glob<string>('./screenwriting-skill/references/*.md', { query: '?raw', import: 'default' });

export async function h3Direction(
  selection: string,
  skills: CanvasSkill[],
  brief: string,
  route: (prompt: string) => Promise<string>,
): Promise<{ guidance: string; skillName?: string }> {
  const automatic = selection === H3_DIRECTOR_ID;
  const named = skills.find(skill => skill.id === selection);
  if (selection === 'screenwriting-master' && named) {
    const format = /剧集|连续剧|短剧.{0,5}[集季]|多集|分集/.test(brief) ? 'format-series'
      : /长片|电影|90\s*分钟/.test(brief) ? 'format-feature'
      : /(?:5|6|7|8|9|10)\s*[-到至~～]?\s*(?:10)?\s*分钟|叙事短片/.test(brief) ? 'format-short'
      : /超短|概念片|(?:1|2|3)\s*[-到至~～]?\s*(?:3)?\s*分钟/.test(brief) ? 'format-ultrashort' : '';
    const paths = ['core-methodology', ...(format ? [format] : [])];
    const refs = await Promise.all(paths.map(name => screenplayRefs[`./screenwriting-skill/references/${name}.md`]()));
    return { guidance: ['用户本次明确的交付和互动要求优先。需要落画布时使用分镜脚本节点。', named.body, ...refs].join('\n\n'), skillName: named.name };
  }
  const bundled = h3Skills.some(skill => skill.id === selection);
  if (!automatic && !bundled) return { guidance: named?.body ?? '', skillName: named?.name };

  const choices = automatic ? skills.filter(skill => h3Skills.some(entry => entry.id === skill.id)) : named ? [named] : [];
  const candidates = choices.map(skill => ({
    id: skill.id, name: skill.name, description: skill.description, resources: h3ResourcePaths(skill.id),
  }));
  let selected = named;
  let resources: string[] = [];
  if (candidates.length && (automatic || candidates[0].resources.length)) {
    const raw = await route(`从可用列表选择一项最适合创作目标的 Skill。动态视觉技法需要区分字体包装、TD 追踪、真人手绘；知识视频、广告和短剧按交付物判断。若候选仅有一项，保留它。只选择当前镜头或阶段实际需要的参考文件，最多两个。没有匹配 Skill 时 skillId 留空。仅返回 JSON {"skillId":"","resources":[]}。\n可用列表：${JSON.stringify(candidates)}\n创作目标：${brief}`);
    try {
      const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
      if (automatic) selected = choices.find(skill => skill.id === result.skillId);
      const allowed = new Set(selected ? h3ResourcePaths(selected.id) : []);
      if (Array.isArray(result.resources)) {
        const returned: unknown[] = result.resources;
        resources = [...new Set(returned.filter((file): file is string => typeof file === 'string' && allowed.has(file)))].slice(0, 2);
      }
    } catch {
      // The director can still plan with its base guidance when no valid route was returned.
    }
  }
  const references = selected ? await Promise.all(resources.map(async resource => {
    const body = await readH3Resource(selected.id, resource);
    return `参考文件 ${resource}\n${body}`;
  })) : [];
  const guidance = [H3_DIRECTOR, selected?.body, ...references].filter(Boolean).join('\n\n');
  return { guidance, skillName: selected?.name ?? (automatic ? 'H3 导演' : undefined) };
}
