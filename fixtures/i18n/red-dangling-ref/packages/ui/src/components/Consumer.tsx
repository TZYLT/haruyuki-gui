// Every declared key is referenced here, so only the dangling reference in
// Thing.tsx can fire. Without this file I6 would also (correctly, but for the
// wrong reason) report `common.action.save` as declared-but-never-referenced.
export const consumer = {
  "common.action.save": t("common.action.save"),
};
