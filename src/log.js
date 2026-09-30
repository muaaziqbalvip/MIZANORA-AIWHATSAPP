export const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const log = (...a) => console.log(`[${ts()}]`, ...a);
export const warn = (...a) => console.warn(`[${ts()}] WARN`, ...a);
export const err = (...a) => console.error(`[${ts()}] ERROR`, ...a);
