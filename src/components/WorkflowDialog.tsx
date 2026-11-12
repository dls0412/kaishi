import { useLayoutEffect, useId, useRef, type PointerEvent, type ReactNode } from 'react';
import Icon from './Icon';

export default function WorkflowDialog({ title, onClose, children, busy = false, className, testId,
  descriptionId, closeOnBackdrop = false }: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  busy?: boolean;
  className?: string;
  testId?: string;
  descriptionId?: string;
  closeOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const pressedBackdrop = useRef(false);
  const titleId = useId();
  useLayoutEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-dialog-focus]')?.focus();
    return () => dialog.close();
  }, []);
  const isBackdrop = (event: PointerEvent<HTMLDialogElement> | React.MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return false;
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left || event.clientX > box.right
      || event.clientY < box.top || event.clientY > box.bottom;
  };
  return (
    <dialog ref={ref} className={className ? `workflow-dialog ${className}` : 'workflow-dialog'} data-testid={testId}
      role={descriptionId ? 'alertdialog' : undefined} aria-labelledby={titleId} aria-describedby={descriptionId}
      onCancel={event => { event.preventDefault(); if (!busy) onClose(); }}
      onPointerDown={event => { event.stopPropagation(); pressedBackdrop.current = isBackdrop(event); }}
      onClick={event => {
        event.stopPropagation();
        if (closeOnBackdrop && !busy && pressedBackdrop.current && isBackdrop(event)) onClose();
      }}
      onKeyDown={event => event.stopPropagation()}>
      <header className="dialog-head">
        <h3 id={titleId}>{title}</h3>
        <button className="icon-btn small" type="button" aria-label="关闭" disabled={busy} onClick={onClose}><Icon name="close" size={16} /></button>
      </header>
      {children}
    </dialog>
  );
}
