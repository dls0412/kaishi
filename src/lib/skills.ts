import { modelFetch } from './modelTransport';
/**
 * 技能执行：把技能变成「节点与连线」方案，确认后落到画布。
 * 纯数据部分在 skillCatalog.ts，避免设置加载阶段与 store 形成循环依赖。
 */
import { nodeDisplayName, type AppSettings, type CanvasNode, type CanvasSkill, type NodeType } from '../types';
import { useCanvas } from '../store';
import { canvasApi } from './canvasApi';
import {
  firstTextService,
  type CanvasPlan,
  type PlanStep,
} from './skillCatalog';

export {
  BUILTIN_SKILLS,
  mergeBuiltinSkills,
  parseSkillFile,
  skillToMarkdown,
  skillReadiness,
  firstTextService,
} from './skillCatalog';
export type { CanvasPlan, PlanStep, SkillReadiness } from './skillCatalog';

function trimGoal(goal: string): string {
  return goal.trim().slice(0, 200) || '未填写创作目标';
}

function localPlan(skill: CanvasSkill, goal: string, nodes: CanvasNode[]): CanvasPlan {
  const g = trimGoal(goal);
  const fill = (t: string) => t.replace(/\{goal\}/g, g);
  const notes: string[] = ['方案由本技能的本机模板生成，没有调用大模型'];
  let steps: PlanStep[] = [];

  if (skill.id === 'builtin-asset-audit') {
    const media = nodes.filter((n) => n.type !== 'group' && n.type !== 'text' && 'assetId' in n && !!n.assetId);
    const groups = (['image', 'video', 'audio'] as const).map((kind) => ({
      kind,
      items: media.filter((n) => n.type === kind).map((n) => n.name || nodeDisplayName(n)),
    }));
    const summary = groups.map((x) => `${x.kind === 'image' ? '图片' : x.kind === 'video' ? '视频' : '音频'} ${x.items.length} 项：${x.items.join('、') || '（无）'}`).join('\n');
    steps = [
      { key: 'audit', type: 'text', name: '素材清单', text: `${fill(skill.template)}\n\n${summary}\n\n缺口：时长、声音、授权记录待用户确认。` },
      ...groups.filter((x) => x.items.length).map((x) => ({
        key: `group-${x.kind}`, type: 'text' as NodeType,
        name: `${x.kind === 'image' ? '图片' : x.kind === 'video' ? '视频' : '音频'}清单`,
        text: x.items.map((n, i) => `${i + 1}. ${n}`).join('\n'), connectTo: ['audit'],
      })),
    ];
    if (!media.length) notes.push('画布上还没有素材节点，清单为空，没有凭空补充素材');
  } else if (skill.id === 'builtin-interview') {
    steps = [
      { key: 'goal', type: 'text', name: '采访提纲', text: fill(skill.template) },
      { key: 'questions', type: 'text', name: '开放问题', text: `采访目标：${g}\n\n1. 请讲讲最初是怎么开始的？\n2. 过程中最难的一次是怎么过去的？\n3. 现在回看，最想保留下来的是什么？`, connectTo: ['goal'] },
      { key: 'followup', type: 'text', name: '条件追问与授权', text: `条件追问\n若提到人：当时谁在场，后来还有联系吗？\n若提到时间：那段时间大概持续多久？\n若提到结果：这件事后来怎么收尾的？\n\n补拍与授权清单\n补拍：空镜、工作台、门头\n肖像授权：被访者签字\n场地授权：场地负责人\n素材使用范围：待确认`, connectTo: ['goal'] },
    ];
  } else if (skill.id === 'builtin-shot-visual') {
    const story = nodes.filter((n) => n.type === 'text' && (n.text || '').trim());
    const shotTexts: string[] = story.length
      ? story.slice(0, 4).map((n) => String((n as { text?: string }).text ?? ''))
      : [`镜头一：${g}`, `镜头二：${g} 的后续`];
    steps = shotTexts.map((text, i) => ({
      key: `shot-${i}`, type: 'video' as NodeType,
      name: `镜头 ${i + 1}`, prompt: `${g}\n${text.slice(0, 180)}`,
      ...(i > 0 ? { connectTo: [`shot-${i - 1}`] } : {}),
    }));
    if (!story.length) notes.push('画布上还没有分镜文本，已按目标建立两个占位镜头，请补充画面描述');
  } else {
    steps = [
      { key: 'outline', type: 'text', name: '双镜分镜表', text: fill(skill.template) },
      { key: 'shot1', type: 'text', name: '镜头一 · 4 秒', text: `镜头一（4 秒）\n画面：${g}，先建立环境\n动作：主体进入画面\n声音：环境底噪\n待确认：场景、光线、主体`, connectTo: ['outline'] },
      { key: 'shot2', type: 'text', name: '镜头二 · 4 秒', text: `镜头二（4 秒）\n画面：承接镜头一，推进到细节\n动作：主体完成一个明确动作\n声音：动作声与音乐进入\n待确认：动作、配音、音乐`, connectTo: ['outline'] },
      { key: 'video', type: 'video', name: '两镜合成目标', prompt: `${g}，两镜各 4 秒，分镜见上游节点`, connectTo: ['shot1', 'shot2'] },
    ];
  }

  return { skillId: skill.id, skillName: skill.name, goal: g, source: 'template', sourceDetail: '本机技能模板', steps, notes };
}

/** 有真实文本模型渠道时调用模型生成方案，失败或未配置一律如实回落本地模板 */
export async function buildPlan(skill: CanvasSkill, goal: string, settings: AppSettings, nodes: CanvasNode[]): Promise<CanvasPlan> {
  const fallback = localPlan(skill, goal, nodes);
  const channel = firstTextService(settings);
  if (!channel) {
    return { ...fallback, notes: [...fallback.notes, '未配置可用的文本模型渠道，助手没有调用大模型'] };
  }
  // 端点取自该服务的协议规格，不把 /chat/completions 硬塞给任何未适配协议
  const url = `${channel.service.baseUrl.replace(/\/+$/, '')}${channel.endpoint}`;
  const system = [
    '你在本地无限画布创作工具里工作。只输出 JSON，不要输出解释文字。',
    '输出格式：{"steps":[{"key":"s1","type":"text|image|video|audio","name":"名称","text":"文本节点内容","prompt":"媒体节点提示词","connectTo":["上游 key"]}]}',
    'type 只能是 text / image / video / audio。connectTo 用步骤的 key 表达真实输入关系，不要引用不存在的 key。',
    `技能说明：${skill.body}`,
    `技能模板：${skill.template}`,
  ].join('\n');
  try {
    const res = await modelFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${channel.service.apiKey}` },
      body: JSON.stringify({
        model: channel.modelId,
        messages: [{ role: 'system', content: system }, { role: 'user', content: `创作目标：${trimGoal(goal)}` }],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { choices?: { message?: { content?: string } }[] };
    const raw = data.choices?.[0]?.message?.content ?? '';
    const json = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, '')) as { steps?: PlanStep[] };
    const steps = (json.steps ?? []).filter((s) => s && typeof s.key === 'string'
      && ['text', 'image', 'video', 'audio'].includes(s.type)).slice(0, 24);
    if (!steps.length) throw new Error('模型没有返回可用步骤');
    return {
      skillId: skill.id, skillName: skill.name, goal: trimGoal(goal),
      source: 'model', sourceDetail: `${channel.service.name} / ${channel.modelId}`,
      steps, notes: [`方案由真实文本模型生成：${url}`],
    };
  } catch (err) {
    return {
      ...fallback,
      notes: [...fallback.notes, `文本模型调用失败（${err instanceof Error ? err.message : String(err)}），已回落本机模板，没有伪装成模型生成`],
    };
  }
}

/* ==================== 方案落到画布 ==================== */

export interface ApplyResult { nodeIds: string[]; edgeCount: number }

export function applyPlanToCanvas(plan: CanvasPlan): ApplyResult {
  const st = useCanvas.getState();
  const view = canvasApi.viewportSize();
  const anchor = {
    x: (view.w / 2 - st.viewport.x) / st.viewport.zoom,
    y: (view.h / 2 - st.viewport.y) / st.viewport.zoom,
  };
  // 整批走 store 的单次提交，撤销一次就能回到方案落画布之前
  return st.applyAgentPlan(plan.steps, anchor);
}
