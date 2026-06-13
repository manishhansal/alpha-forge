import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

describe("components/ui/card", () => {
  it("renders the full card composition", () => {
    render(
      <Card data-testid="card">
        <CardHeader>
          <CardTitle>Title</CardTitle>
          <CardDescription>Subtitle</CardDescription>
        </CardHeader>
        <CardContent>Body</CardContent>
        <CardFooter>Footer</CardFooter>
      </Card>,
    );

    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Subtitle")).toBeInTheDocument();
    expect(screen.getByText("Body")).toBeInTheDocument();
    expect(screen.getByText("Footer")).toBeInTheDocument();
  });

  it("CardTitle uses an h3 tag for a11y", () => {
    render(<CardTitle>Heading</CardTitle>);
    const h = screen.getByText("Heading");
    expect(h.tagName).toBe("H3");
  });

  it("CardDescription uses a p tag", () => {
    render(<CardDescription>Lorem</CardDescription>);
    expect(screen.getByText("Lorem").tagName).toBe("P");
  });

  it("forwards refs (Card)", () => {
    let captured: HTMLDivElement | null = null;
    render(
      <Card
        ref={(el) => {
          captured = el;
        }}
      >
        ref-target
      </Card>,
    );
    expect(captured).not.toBeNull();
  });
});
