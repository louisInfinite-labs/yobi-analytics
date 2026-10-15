/** Test helper: what the member drawer's reminder dropdown shows when CLOSED. A member with no reminder has nothing selected (selectedIndex -1) and
 * the prompt 開播時 laid over the control; otherwise it is the selected option's text. */
export function closedReminderText(select: HTMLElement): string {
  const element = select as HTMLSelectElement
  if (element.selectedIndex === -1) return element.parentElement?.querySelector(".topic-creator-drawer__reminder-select-prompt")?.textContent ?? ""
  return element.options[element.selectedIndex].textContent ?? ""
}
