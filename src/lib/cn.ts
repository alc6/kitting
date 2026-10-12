import { twMerge } from "tailwind-merge";

export type ClassValue = string | false | null | undefined | 0;

/**
 * Joins class names, dropping falsy values, and resolves Tailwind conflicts so a caller's
 * class wins over a component's default (`cn("px-4", "px-2")` → `"px-2"`). Same role as
 * shadcn/ui's `cn()`.
 */
export function cn(...classes: ClassValue[]): string {
	return twMerge(classes.filter(Boolean).join(" "));
}
