/**
 * 读取当前页面的文本选区。
 * @returns {{ text: string, position: {x: number, y: number} } | null}
 */
export function getSelection() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.toString().trim()) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  return {
    text: sel.toString().trim(),
    position: {
      x: rect.left,
      y: rect.bottom + 8, // 浮窗出现在选区正下方 8px
    },
  };
}
