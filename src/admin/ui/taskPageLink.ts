export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

/** Copy the task URL already maintained in the browser hash by TasksView. */
export function copyTaskPageLink(href: string, clipboard: ClipboardWriter): Promise<void> {
  return clipboard.writeText(href);
}