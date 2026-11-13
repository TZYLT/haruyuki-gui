declare const module: { require: (id: string) => unknown };
export const value = module.require("@haruyuki/core");
