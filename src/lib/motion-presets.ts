import type { MotionProps, Transition } from "framer-motion";

export const SPRING_FAST: Transition = {
  type: "spring",
  stiffness: 600,
  damping: 35,
};

export const SPRING_DEFAULT: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 28,
};

export const SPRING_GENTLE: Transition = {
  type: "spring",
  stiffness: 240,
  damping: 24,
};

export const SPRING_MICRO: Transition = {
  type: "spring",
  stiffness: 800,
  damping: 40,
};

/**
 * Returns Framer Motion transition props for staggered list animations.
 * @param count     - Number of children to stagger (used for documentation; not consumed internally).
 * @param baseDelay - Delay between each child in seconds. Default 0.04s (40ms).
 */
export function stagger(
  count: number,
  baseDelay = 0.04,
): Pick<MotionProps, "transition"> {
  return {
    transition: {
      staggerChildren: baseDelay,
      delayChildren: 0,
    },
  };
}
