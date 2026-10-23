import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "../src/App";

it("renders the OpenBus heading", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "OpenBus" })).toBeInTheDocument();
});
