import * as React from "react";

/**
 * Minimal `next/link` replacement for unit tests. Renders a plain `<a>`
 * tag that mirrors the public Link contract (`href`, children, common
 * anchor props). Aliased into the test build via `vitest.config.ts` so
 * components rendered with `@testing-library/react` don't pull in the
 * real implementation (which expects Next's app-router context).
 */
type AnchorProps = React.AnchorHTMLAttributes<HTMLAnchorElement>;
interface NextLinkShimProps extends Omit<AnchorProps, "href"> {
  href: string | { pathname: string };
  prefetch?: boolean;
  scroll?: boolean;
  replace?: boolean;
  shallow?: boolean;
  passHref?: boolean;
  legacyBehavior?: boolean;
  locale?: string | false;
}

const NextLinkShim = React.forwardRef<HTMLAnchorElement, NextLinkShimProps>(
  function NextLinkShim(
    {
      href,
      prefetch: _prefetch,
      scroll: _scroll,
      replace: _replace,
      shallow: _shallow,
      passHref: _passHref,
      legacyBehavior: _legacyBehavior,
      locale: _locale,
      children,
      ...rest
    },
    ref,
  ) {
    const url = typeof href === "string" ? href : href.pathname;
    return (
      <a ref={ref} href={url} {...rest}>
        {children}
      </a>
    );
  },
);

export default NextLinkShim;
