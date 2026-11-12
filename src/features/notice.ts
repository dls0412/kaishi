/**
 * 工作台统一通知口径。
 *
 * 各功能模块可以用自己语义化的语气词（warn / danger / err），
 * App 在生成 toast 时统一归一化成 ok / info / err 三种实际展示状态。
 * 所有模块共用这一个函数类型，避免函数参数逆变导致 onNotice 传不进来。
 */
export type NoticeTone = 'ok' | 'info' | 'err' | 'warn' | 'danger';

export type NoticeFn = (message: string, tone?: NoticeTone) => void;

/** 把模块语气词映射成实际 toast 状态 */
export function toastTone(tone: NoticeTone | undefined): 'ok' | 'info' | 'err' {
  if (tone === 'warn' || tone === 'danger' || tone === 'err') return 'err';
  if (tone === 'info') return 'info';
  return 'ok';
}
