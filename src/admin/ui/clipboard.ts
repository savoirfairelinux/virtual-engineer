function copyTextWithExecCommand(text: string): void {
  const previouslyFocusedElement = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);

  try {
    textarea.focus();
    textarea.select();
    if (typeof document.execCommand !== "function" || !document.execCommand("copy")) {
      throw new Error("Copy command was rejected");
    }
  } finally {
    textarea.remove();
    if (previouslyFocusedElement?.isConnected) previouslyFocusedElement.focus();
  }
}

export async function copyText(text: string): Promise<void> {
  try {
    const clipboard = navigator.clipboard;
    if (typeof clipboard?.writeText === "function") {
      await clipboard.writeText(text);
      return;
    }
  } catch {
    return copyTextWithExecCommand(text);
  }
  copyTextWithExecCommand(text);
}