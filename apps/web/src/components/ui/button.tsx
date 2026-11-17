import type * as React from "react";
import { cn } from "@/lib/utils";

const variants = {
  default: "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90",
  accent: "bg-accent text-accent-foreground shadow-sm hover:bg-accent/90",
  outline: "border border-border bg-transparent text-foreground hover:bg-secondary",
  secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
  ghost: "text-muted-foreground hover:bg-secondary hover:text-foreground",
  destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
  link: "text-accent underline-offset-4 hover:underline",
} as const;

const sizes = {
  sm: "h-8 rounded-lg px-3 text-xs",
  default: "h-10 rounded-xl px-4 text-sm",
  lg: "h-12 rounded-xl px-6 text-base",
  icon: "size-10 rounded-xl",
} as const;

export type ButtonVariant = keyof typeof variants;
export type ButtonSize = keyof typeof sizes;

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  asChild?: boolean;
}

export const buttonClassName = ({
  variant = "default",
  size = "default",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
} = {}) =>
  cn(
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-semibold transition-colors",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    variants[variant],
    sizes[size],
  );

export function Button({
  className,
  variant = "default",
  size = "default",
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button type={type} className={cn(buttonClassName({ variant, size }), className)} {...props} />
  );
}
