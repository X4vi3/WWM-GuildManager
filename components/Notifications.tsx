import React, { useEffect, useState } from 'react';
import { localize } from '../services/i18n';

// Лёгкая система уведомлений: тосты (toast) и диалог подтверждения (confirm),
// в едином стиле приложения. Можно звать из любого места без проброса пропсов.

type ToastType = 'success' | 'error' | 'info';
// Кнопка прямо в тосте — для действий с коротким окном (например «Отменить импорт»)
export interface ToastAction { label: string; onClick: () => void; }
interface ToastItem { id: number; type: ToastType; message: string; action?: ToastAction; }
// Диалог может быть на два ответа (confirm) или на три (choose) — например
// «сохранить бэкап и продолжить / продолжить без бэкапа / отмена».
export type ChoiceResult = 'primary' | 'secondary' | 'cancel';
interface ConfirmItem {
  id: number;
  message: string;
  confirmLabel: string;
  secondaryLabel?: string;
  cancelLabel: string;
  danger: boolean;
  resolve: (v: ChoiceResult) => void;
}

let toasts: ToastItem[] = [];
let confirms: ConfirmItem[] = [];
let seq = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());

export function toast(message: string, type: ToastType = 'info', ttl = 3500, action?: ToastAction) {
  const id = seq++;
  toasts = [...toasts, { id, type, message, action }];
  emit();
  if (ttl > 0) window.setTimeout(() => dismissToast(id), ttl);
}
function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

// Диалог на три ответа. Возвращает, какую кнопку нажали.
export function choose(
  message: string,
  opts: { primaryLabel: string; secondaryLabel: string; cancelLabel?: string; danger?: boolean }
): Promise<ChoiceResult> {
  return new Promise(resolve => {
    confirms = [...confirms, {
      id: seq++,
      message,
      confirmLabel: opts.primaryLabel,
      secondaryLabel: opts.secondaryLabel,
      cancelLabel: opts.cancelLabel ?? localize('Отмена'),
      danger: opts.danger ?? false,
      resolve
    }];
    emit();
  });
}

export function confirm(
  message: string,
  opts?: { confirmLabel?: string; cancelLabel?: string; danger?: boolean }
): Promise<boolean> {
  return new Promise(resolve => {
    confirms = [...confirms, {
      id: seq++,
      message,
      confirmLabel: opts?.confirmLabel ?? localize('Подтвердить'),
      cancelLabel: opts?.cancelLabel ?? localize('Отмена'),
      danger: opts?.danger ?? false,
      resolve: v => resolve(v === 'primary')
    }];
    emit();
  });
}
function resolveConfirm(id: number, value: ChoiceResult) {
  const c = confirms.find(x => x.id === id);
  if (c) c.resolve(value);
  confirms = confirms.filter(x => x.id !== id);
  emit();
}

const TOAST_STYLE: Record<ToastType, { icon: string; cls: string }> = {
  success: { icon: 'fa-circle-check', cls: 'border-emerald-600/50 text-emerald-300' },
  error:   { icon: 'fa-circle-exclamation', cls: 'border-red-600/50 text-red-300' },
  info:    { icon: 'fa-circle-info', cls: 'border-amber-600/50 text-amber-300' }
};

const ToastCard: React.FC<{ item: ToastItem; onClose: () => void }> = ({ item, onClose }) => {
  const st = TOAST_STYLE[item.type];
  return (
    <div className={`flex items-start gap-2.5 bg-slate-900/95 backdrop-blur-sm border rounded-lg shadow-lg px-3.5 py-2.5 animate-in slide-in-from-right-4 fade-in duration-200 ${st.cls}`}>
      <i className={`fa-solid ${st.icon} mt-0.5`}></i>
      <div className="flex-1">
        <span className="text-xs font-semibold text-slate-100 leading-snug">{item.message}</span>
        {item.action && (
          <button
            onClick={() => { item.action!.onClick(); onClose(); }}
            className="block mt-2 text-[11px] font-semibold text-amber-300 hover:text-amber-100 border border-amber-800/60 hover:border-amber-600 rounded-lg px-2.5 py-1.5 transition-colors"
          >
            {item.action.label}
          </button>
        )}
      </div>
      <button onClick={onClose} className="text-slate-500 hover:text-slate-200 transition-colors shrink-0">
        <i className="fa-solid fa-xmark text-xs"></i>
      </button>
    </div>
  );
};

const ConfirmModal: React.FC<{ item: ConfirmItem }> = ({ item }) => (
  <div
    className="fixed inset-0 z-[310] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm animate-in fade-in duration-200"
    onClick={() => resolveConfirm(item.id, 'cancel')}
  >
    <div
      onClick={e => e.stopPropagation()}
      className="w-full max-w-sm bg-slate-900 border border-slate-700 rounded-2xl shadow-lg overflow-hidden animate-in zoom-in-95 duration-200"
    >
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${item.danger ? 'bg-red-600/15 border border-red-500/30 text-red-400' : 'bg-amber-600/15 border border-amber-500/30 text-amber-400'}`}>
            <i className={`fa-solid ${item.danger ? 'fa-triangle-exclamation' : 'fa-circle-question'}`}></i>
          </div>
          {/* whitespace-pre-line — чтобы переносы строк в сообщении сохранялись:
              у опасных подтверждений последствия перечислены списком */}
          <p className="text-sm text-slate-200 leading-relaxed pt-1.5 whitespace-pre-line">{item.message}</p>
        </div>
        {/* На три ответа кнопки ставим в столбик — иначе подписи не помещаются */}
        <div className={`pt-5 ${item.secondaryLabel ? 'flex flex-col gap-2' : 'flex gap-2'}`}>
          <button
            autoFocus
            onClick={() => resolveConfirm(item.id, 'primary')}
            className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-colors text-white ${item.danger ? 'bg-red-600 hover:bg-red-500' : 'bg-amber-600 hover:bg-amber-500'}`}
          >
            {item.confirmLabel}
          </button>
          {item.secondaryLabel && (
            <button
              onClick={() => resolveConfirm(item.id, 'secondary')}
              className="py-2.5 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-400 text-sm font-semibold transition-colors"
            >
              {item.secondaryLabel}
            </button>
          )}
          <button
            onClick={() => resolveConfirm(item.id, 'cancel')}
            className={`py-2.5 rounded-lg border border-slate-700 text-slate-400 hover:text-white text-sm font-semibold transition-colors ${item.secondaryLabel ? '' : 'px-4'}`}
          >
            {item.cancelLabel}
          </button>
        </div>
      </div>
    </div>
  </div>
);

export const NotificationHost: React.FC = () => {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force(n => n + 1);
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);

  const topConfirm = confirms[0];
  return (
    <>
      <div className="fixed top-4 right-4 z-[300] flex flex-col gap-2 w-80 max-w-[calc(100vw-2rem)] pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className="pointer-events-auto">
            <ToastCard item={t} onClose={() => dismissToast(t.id)} />
          </div>
        ))}
      </div>
      {topConfirm && <ConfirmModal item={topConfirm} />}
    </>
  );
};
