import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { Badge } from "@/components/ui/badge";

describe("components/ui/badge", () => {
  it("renders children inside a span", () => {
    render(<Badge>NEW</Badge>);
    const el = screen.getByText("NEW");
    expect(el.tagName).toBe("SPAN");
  });

  it.each([
    ["neutral"],
    ["bull"],
    ["bear"],
    ["warning"],
    ["info"],
    ["outline"],
  ] as const)("renders the %s variant", (variant) => {
    const { container } = render(<Badge variant={variant}>{variant}</Badge>);
    const el = container.firstChild as HTMLElement;
    expect(el).toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(
      <Badge variant="bull" className="custom-x">
        Hi
      </Badge>,
    );
    expect(screen.getByText("Hi")).toHaveClass("custom-x");
  });

  it("forwards extra HTML attributes", () => {
    render(<Badge data-testid="b">Yo</Badge>);
    expect(screen.getByTestId("b")).toBeInTheDocument();
  });
});
