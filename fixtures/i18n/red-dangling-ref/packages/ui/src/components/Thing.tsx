export function Thing(t: (k: string) => string) {
  return t("common.action.missing");
}
