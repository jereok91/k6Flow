export type ToastType = "success" | "error" | "info" | "warning";
export interface Toast { id: string; key?: string; type: ToastType; message: string }
export function addToast(stack: Toast[], toast: Toast): Toast[] {
  if (toast.key && stack.some(item => item.key === toast.key)) return stack;
  return [...stack, toast].slice(-3);
}
