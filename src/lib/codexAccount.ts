import { create } from 'zustand';
import { localRequest } from './modelTransport';

interface CodexStatus {
  account: { email: string; plan: string | null } | null;
  pending: boolean;
  error: string;
}

interface QuotaWindow {
  used: number;
  minutes: number | null;
  resetsAt: number | null;
}

export const CODEX_ACCOUNT = 'kaishi:codex-account';
export const CODEX_IMAGE = 'kaishi:codex-image';
export const useCodexAccount = create<{ status: CodexStatus | null }>(() => ({ status: null }));
const sourceKey = 'kaishi:codex-account-source';
export const usesInstalledCodex = () => localStorage.getItem(sourceKey) === 'installed';
const accountSource = () => usesInstalledCodex() ? { source: 'installed' } : {};

export async function codexStatus() {
  const status = await localRequest<CodexStatus>('codex/status', accountSource());
  useCodexAccount.setState({ status });
  return status;
}

export async function connectInstalledCodex() {
  const status = await localRequest<CodexStatus>('codex/status', { source: 'installed' });
  if (!status.account) throw new Error('本机 Codex 尚未使用 ChatGPT 登录。');
  localStorage.setItem(sourceKey, 'installed');
  useCodexAccount.setState({ status });
}

export async function codexAccountAction(action: 'cancel' | 'logout') {
  if (action === 'logout' && usesInstalledCodex()) {
    localStorage.removeItem(sourceKey);
    await codexStatus();
    return;
  }
  const status = await localRequest<CodexStatus>('codex/' + action);
  useCodexAccount.setState({ status });
}

export const startCodexLogin = () => localRequest<{ authUrl: string }>('codex/login');
export const codexQuota = () => localRequest<{ limits: QuotaWindow[] }>('codex/quota', accountSource());

export async function codexReply(messages: { role: string; content: string }[], signal: AbortSignal, images: string[] = []) {
  const response = await localRequest<{ text: string }>('codex/reply', { ...accountSource(), messages, images }, signal);
  return response.text;
}

export async function codexImage(prompt: string, signal: AbortSignal, images: string[] = []) {
  return (await localRequest<{ image: string }>('codex/image', { ...accountSource(), prompt, images }, signal)).image;
}
