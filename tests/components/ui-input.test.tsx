import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { Input } from "@/components/ui/input";

describe("components/ui/input", () => {
  it("defaults type to 'text'", () => {
    render(<Input data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("type", "text");
  });

  it("accepts and forwards a custom type", () => {
    render(<Input type="password" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveAttribute("type", "password");
  });

  it("calls onChange as the user types", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Input onChange={onChange} data-testid="input" />);
    await user.type(screen.getByTestId("input"), "abc");
    expect(onChange).toHaveBeenCalled();
  });

  it("renders the placeholder", () => {
    render(<Input placeholder="Email" />);
    expect(screen.getByPlaceholderText("Email")).toBeInTheDocument();
  });

  it("supports the disabled prop", () => {
    render(<Input disabled data-testid="input" />);
    expect(screen.getByTestId("input")).toBeDisabled();
  });

  it("merges custom className", () => {
    render(<Input className="ring-red-500" data-testid="input" />);
    expect(screen.getByTestId("input")).toHaveClass("ring-red-500");
  });
});
