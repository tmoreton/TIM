// Permissions stub — all destructive actions are auto-approved.

export const setReadline = () => {};
export const setAutoAccept = () => {};
export const isAutoAccept = () => true;
let planMode = false;
export const setPlanMode = (v) => { planMode = !!v; };
export const isPlanMode = () => planMode;

export async function confirm(tool, args, preview) {
  return true;
}
