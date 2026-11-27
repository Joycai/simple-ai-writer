import type { KeyboardEvent, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ stateIndex: 0, close: vi.fn() }));
vi.mock("react", async original => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => [hooks.stateIndex++ === 1 ? true : initial, vi.fn()],
  useRef: (current: unknown) => ({ current }),
  useId: () => "permission-dialog",
  useEffect: () => {},
  useLayoutEffect: () => {},
  useCallback: (callback: unknown) => callback,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("../../common/ModalShell", () => ({ ModalShell: () => null, useModalClose: () => hooks.close }));
import { SessionPermissionsMenu } from "../SessionPermissionsMenu";
import { matchesCombo } from "../../../lib/shortcuts";

type ConfirmationProps = {
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
};

function renderConfirmation() {
  const onChange = vi.fn();
  const tree = SessionPermissionsMenu({ enabled: false, onChange });
  const shell = tree.props.children[2];
  const child = shell.props.children;
  const dialog = (child.type as (props: typeof child.props) => ReactElement<ConfirmationProps>)(child.props);
  return { props: dialog.props, onChange };
}

// Exercise the actual JSX handler. The window-level closeOverlays shortcut
// only receives the event if the component allows it to bubble.
function dispatch(props: ConfirmationProps, key: string, nativeEvent = {}) {
  let stopped = false;
  const closeDrawer = vi.fn();
  const event = {
    key, nativeEvent,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(() => { stopped = true; }),
  };
  props.onKeyDown(event as unknown as KeyboardEvent<HTMLDivElement>);
  if (!stopped && matchesCombo(event as unknown as globalThis.KeyboardEvent, { key: "Escape" })) closeDrawer();
  return { event, closeDrawer };
}

beforeEach(() => { hooks.stateIndex = 0; hooks.close.mockClear(); });

describe("session permission confirmation keyboard isolation", () => {
  it("Escape closes only the confirmation and never enables permission or reaches the drawer shortcut", () => {
    const { props, onChange } = renderConfirmation();
    const { event, closeDrawer } = dispatch(props, "Escape");
    expect(hooks.close).toHaveBeenCalledOnce();
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(closeDrawer).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it.each([{ isComposing: true }, { keyCode: 229 }])("preserves IME Escape without closing either surface (%j)", nativeEvent => {
    const { props } = renderConfirmation();
    const { event, closeDrawer } = dispatch(props, "Escape", nativeEvent);
    expect(hooks.close).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalledOnce();
    expect(closeDrawer).not.toHaveBeenCalled();
  });

  it("honors composition state and the post-composition grace period", () => {
    const { props } = renderConfirmation();
    props.onCompositionStart();
    dispatch(props, "Escape");
    props.onCompositionEnd();
    dispatch(props, "Escape");
    expect(hooks.close).not.toHaveBeenCalled();
  });

  it("does not consume other keys or dismiss the confirmation", () => {
    const { props } = renderConfirmation();
    const { event } = dispatch(props, "Enter");
    expect(hooks.close).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
