// Sheet — bottom sheet on mobile, centered modal on desktop.
import { JSX, Show, onMount, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

export function Sheet(props: {
  open: boolean;
  onClose: () => void;
  title?: string;
  dark?: boolean;
  children: JSX.Element;
  width?: number;
}) {
  let el: HTMLDivElement | undefined;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));
  return (
    <Show when={props.open}>
      <Portal>
        <div class="sheet-dim" onClick={props.onClose} />
        <div
          ref={el}
          class={`sheet ${props.dark ? "sheet--dark" : ""}`}
          style={{ "max-width": `${props.width ?? 560}px` }}
          role="dialog"
          aria-modal="true"
        >
          <div class="sheet__grabber" onClick={props.onClose} />
          <Show when={props.title}>
            <div class="sheet__title">{props.title}</div>
          </Show>
          {props.children}
        </div>
      </Portal>
    </Show>
  );
}

// Row inside a sheet — label left, value/chevron right.
export function SheetRow(props: {
  icon?: JSX.Element;
  label: JSX.Element;
  sub?: string;
  right?: JSX.Element;
  onClick?: () => void;
  danger?: boolean;
}) {
  return (
    <button
      class={`sheet-row ${props.danger ? "sheet-row--danger" : ""}`}
      onClick={() => props.onClick?.()}
      disabled={!props.onClick}
      type="button"
    >
      <Show when={props.icon}>
        <span class="sheet-row__icon">{props.icon}</span>
      </Show>
      <span class="sheet-row__body">
        <span class="sheet-row__label">{props.label}</span>
        <Show when={props.sub}>
          <span class="sheet-row__sub">{props.sub}</span>
        </Show>
      </span>
      <Show when={props.right}>
        <span class="sheet-row__right">{props.right}</span>
      </Show>
    </button>
  );
}
