import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Button } from "@/components/ui/button";

describe("components/ui/button", () => {
  it("renders the children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("defaults to type=button (so it doesn't accidentally submit forms)", () => {
    render(<Button>Default</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "button");
  });

  it("forwards an explicit type", () => {
    render(<Button type="submit">Send</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("type", "submit");
  });

  it("calls onClick when clicked", async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Press</Button>);
    await user.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire onClick when disabled", () => {
    const onClick = vi.fn();
    render(
      <Button onClick={onClick} disabled>
        Press
      </Button>,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole("button")).toBeDisabled();
  });

  it.each([
    ["primary"],
    ["secondary"],
    ["ghost"],
    ["danger"],
    ["link"],
  ] as const)("renders the %s variant", (variant) => {
    render(<Button variant={variant}>Variant {variant}</Button>);
    expect(screen.getByRole("button", { name: `Variant ${variant}` })).toBeInTheDocument();
  });

  it("merges custom className with variant classes", () => {
    render(<Button className="custom-class">Hi</Button>);
    expect(screen.getByRole("button")).toHaveClass("custom-class");
  });

  it("forwards arbitrary props (aria-label, data-*)", () => {
    render(
      <Button aria-label="close" data-testid="x-btn">
        ✕
      </Button>,
    );
    const btn = screen.getByLabelText("close");
    expect(btn).toHaveAttribute("data-testid", "x-btn");
  });
});
