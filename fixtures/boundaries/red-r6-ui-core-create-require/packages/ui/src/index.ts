declare function createRequire(url: string): (id: string) => unknown;
export const value = createRequire(import.meta.url)("@haruyuki/core");
