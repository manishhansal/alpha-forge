import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";

import { Skeleton } from "@/components/ui/skeleton";

describe("components/ui/skeleton", () => {
  it("renders a single div", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstChild as HTMLElement;
    expect(el.tagName).toBe("DIV");
  });

  it("merges custom className", () => {
    const { container } = render(<Skeleton className="h-10 w-32" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveClass("h-10");
    expect(el).toHaveClass("w-32");
  });

  it("forwards arbitrary props", () => {
    const { container } = render(<Skeleton data-testid="sk" aria-busy="true" />);
    const el = container.firstChild as HTMLElement;
    expect(el).toHaveAttribute("data-testid", "sk");
    expect(el).toHaveAttribute("aria-busy", "true");
  });
});
