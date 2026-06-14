import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApiKeysForm } from "@/components/settings/api-keys-form";

describe("components/settings/ApiKeysForm", () => {
  it("shows the API secret field for a crypto exchange (default)", () => {
    render(<ApiKeysForm encryptionAvailable stored={[]} />);
    expect(screen.getByLabelText("API secret")).toBeInTheDocument();
    expect(screen.queryByLabelText("Client code")).not.toBeInTheDocument();
  });

  it("lists Angel One in the exchange dropdown", () => {
    render(<ApiKeysForm encryptionAvailable stored={[]} />);
    const select = screen.getByLabelText("Exchange") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(options.some((o) => /angel one/i.test(o))).toBe(true);
  });

  it("swaps to Angel One credential fields when Angel One is selected", async () => {
    const user = userEvent.setup();
    render(<ApiKeysForm encryptionAvailable stored={[]} />);

    await user.selectOptions(screen.getByLabelText("Exchange"), "angel");

    expect(screen.getByLabelText("Client code")).toBeInTheDocument();
    expect(screen.getByLabelText("PIN")).toBeInTheDocument();
    expect(screen.getByLabelText("TOTP secret")).toBeInTheDocument();
    // The two-field crypto "API secret" input is not used for Angel One.
    expect(screen.queryByLabelText("API secret")).not.toBeInTheDocument();
  });
});
