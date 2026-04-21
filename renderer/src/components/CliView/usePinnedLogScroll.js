import { useEffect, useRef } from "react";

function isSelectingTerminalText(node) {
  const selection = window.getSelection ? window.getSelection() : null;
  return (
    Boolean(selection && !selection.isCollapsed) &&
    Boolean(node) &&
    node.contains(selection.anchorNode)
  );
}

export default function usePinnedLogScroll(deps) {
  const outputRef = useRef(null);
  const pinnedRef = useRef(true);

  function handleScroll() {
    const node = outputRef.current;
    if (!node) return;
    const distanceFromBottom =
      node.scrollHeight - (node.scrollTop + node.clientHeight);
    pinnedRef.current = distanceFromBottom <= 32;
  }

  useEffect(() => {
    const node = outputRef.current;
    if (!node || !pinnedRef.current || isSelectingTerminalText(node)) return;
    node.scrollTop = node.scrollHeight;
  }, deps);

  return { outputRef, handleScroll };
}
