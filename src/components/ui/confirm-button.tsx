"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "./button";

/**
 * 两步确认按钮:第一次点击进入待确认态(3 秒后自动复位),再次点击才真正执行。
 * 用于覆盖式 AI 重新生成、删除等破坏性操作。
 */
export function ConfirmButton({
  onConfirm,
  children,
  confirmLabel = "确认执行?",
  variant = "secondary",
  size = "sm",
  className = "",
  disabled,
}: {
  onConfirm: () => void;
  children: ReactNode;
  confirmLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(timer);
  }, [armed]);

  return (
    <Button
      variant={armed ? "danger" : variant}
      size={size}
      className={className}
      disabled={disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          onConfirm();
        } else {
          setArmed(true);
        }
      }}
    >
      {armed ? confirmLabel : children}
    </Button>
  );
}
