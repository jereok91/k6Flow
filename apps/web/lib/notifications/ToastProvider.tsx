"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { addToast, type Toast } from "./toast-state";

type Notify = (toast: Omit<Toast, "id">) => void;
const ToastContext = createContext<Notify | null>(null);

function ToastItem({ toast, close }: { toast: Toast; close: (id: string) => void }) {
  useEffect(() => {
    const timer = setTimeout(() => close(toast.id), toast.type === "error" ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [toast.id, toast.type, close]);
  const color = toast.type === "error" ? "text-danger" : toast.type === "success" ? "text-success" : toast.type === "warning" ? "text-warning" : "text-primary";
  return <li className="flex items-center gap-3 rounded-xl border border-outline-variant bg-surface-container-high p-4 text-on-surface shadow-lg">
    <span className={`material-symbols-outlined text-[18px] ${color}`} aria-hidden="true">{toast.type === "error" ? "error" : toast.type === "success" ? "check_circle" : toast.type === "warning" ? "warning" : "info"}</span>
    <span className="flex-1 text-sm">{toast.message}</span>
    <button type="button" aria-label="Cerrar notificación" onClick={() => close(toast.id)} className="rounded p-1 text-on-surface-variant focus-visible:outline focus-visible:outline-primary">×</button>
  </li>;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const sequence = useRef(0);
  const notify = useCallback<Notify>(toast => {
    const id = String(++sequence.current);
    setToasts(stack => addToast(stack, { ...toast, id }));
  }, []);
  const close = useCallback((id: string) => setToasts(stack => stack.filter(toast => toast.id !== id)), []);
  return <ToastContext.Provider value={notify}>
    {children}
    <section aria-label="Notificaciones" aria-live="polite" aria-atomic="false" role="status" className="fixed bottom-4 right-4 z-[100] w-[min(24rem,calc(100vw-2rem))]">
      <ul className="flex flex-col gap-2">{toasts.map(toast => <ToastItem key={toast.id} toast={toast} close={close} />)}</ul>
    </section>
  </ToastContext.Provider>;
}

export function useToast(): Notify {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error("useToast requires ToastProvider");
  return notify;
}
