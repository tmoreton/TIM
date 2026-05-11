// Permissions stub — all destructive actions are auto-approved.

export const setReadline = () => {};
export const setAutoAccept = () => {};
export const isAutoAccept = () => true;
export const setPlanMode = () => {};
export const isPlanMode = () => false;

export async function confirm(tool, args, preview) {
  return true;
}
