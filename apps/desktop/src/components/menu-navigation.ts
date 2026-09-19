import type { KeyboardEvent } from "react";

const MENU_ITEM_SELECTOR = [
  'button[role="menuitem"]:not(:disabled)',
  'button[role="menuitemradio"]:not(:disabled)',
  'button[data-menu-item="true"]:not(:disabled)',
].join(",");

function menuItems(root: HTMLElement) {
  return Array.from(root.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR));
}

export function focusFirstMenuItem(root: HTMLElement | null) {
  const first = root ? menuItems(root)[0] : null;
  first?.focus();
}

export function handleMenuNavigation(event: KeyboardEvent<HTMLElement>) {
  if (
    event.key !== "ArrowDown" &&
    event.key !== "ArrowUp" &&
    event.key !== "Home" &&
    event.key !== "End"
  ) {
    return;
  }
  const items = menuItems(event.currentTarget);
  if (!items.length) return;
  event.preventDefault();
  const active = document.activeElement as HTMLButtonElement | null;
  const currentIndex = active ? items.indexOf(active) : -1;
  const nextIndex =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : event.key === "ArrowDown"
          ? (currentIndex + 1) % items.length
          : (currentIndex - 1 + items.length) % items.length;
  items[nextIndex].focus();
}
