"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { SPRING_GENTLE } from "@/lib/motion-presets";
import { cn } from "@/lib/utils";

export interface PageTransitionProps {
  children: React.ReactNode;
  className?: string;
}

/**
 * Wraps page content in a fade-from-below entrance animation.
 * Used in each page's default export — NOT in the layout file —
 * so only the content animates, not the shell.
 *
 * Respects prefers-reduced-motion: uses instant (0ms) transition when active.
 */
export function PageTransition({ children, className }: PageTransitionProps) {
  const reducedMotion = useReducedMotion();

  return (
    <motion.div
      initial={{ opacity: 0, y: reducedMotion ? 0 : 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={reducedMotion ? { duration: 0 } : SPRING_GENTLE}
      className={cn("w-full", className)}
    >
      {children}
    </motion.div>
  );
}
