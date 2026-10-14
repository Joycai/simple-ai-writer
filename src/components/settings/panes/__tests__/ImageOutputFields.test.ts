import type { ChangeEvent } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the input's real handlers and parent value round-trip without a DOM.
// The component has one state cell; renders after a prop reset are repeated,
// as React does for a render-time state adjustment.
const state = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: () => unknown) => {
    state.value ??= initial();
    return [state.value, (next: unknown) => { state.value = next; }];
  },
}));
import { ImageOutputMenuInput } from "../ImageOutputFields";

beforeEach(() => { state.value = undefined; });

describe("image output menu editing", () => {
  it.each([
    ["aspects", "3:2", "16:9"],
    ["resolutions", "1K", "2K"],
    ["qualities", "low", "high"],
  ])("preserves delimiters while appending a %s choice character by character", (label, first, second) => {
    let values = [first];
    const onChange = vi.fn((next: string[]) => { values = next; });
    const render = () => ImageOutputMenuInput({ label, values, onChange });
    let input = render();
    for (const char of `, ${second}`) {
      const text = input.props.value + char;
      input.props.onChange({ target: { value: text } } as ChangeEvent<HTMLInputElement>);
      input = render();
      expect(input.props.value).toBe(text);
    }
    expect(values).toEqual([first, second]);
    expect(onChange).toHaveBeenLastCalledWith([first, second]);
  });

  it("publishes cleared and pasted values immediately, and resets for replacement configuration", () => {
    let values: string[] | undefined = ["3:2"];
    const render = () => ImageOutputMenuInput({ label: "aspects", values, onChange: (next) => { values = next; } });
    let input = render();
    input.props.onChange({ target: { value: "" } } as ChangeEvent<HTMLInputElement>);
    expect(values).toEqual([]);
    input = render();
    expect(input.props.value).toBe("");
    input.props.onChange({ target: { value: " 3:2, 16:9, 3:2, " } } as ChangeEvent<HTMLInputElement>);
    expect(values).toEqual(["3:2", "16:9"]);
    expect(render().props.value).toBe(" 3:2, 16:9, 3:2, ");
    values = ["1:1"];
    render();
    expect(render().props.value).toBe("1:1");
    values = undefined;
    render();
    expect(render().props.value).toBe("");
  });
});
