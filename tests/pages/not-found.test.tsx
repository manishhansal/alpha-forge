import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import NotFound from "@/app/not-found";

describe("page /not-found", () => {
  it("renders the 404 badge and headline", () => {
    render(<NotFound />);
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByText("Off the chart")).toBeInTheDocument();
  });

  it("links back to the home page", () => {
    render(<NotFound />);
    const link = screen.getByText(/Back to dashboard/i).closest("a");
    expect(link).toHaveAttribute("href", "/");
  });
});
