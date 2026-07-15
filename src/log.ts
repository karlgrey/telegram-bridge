// Log-Helper (#198): Beim Debuggen des 14.07.-Ausfalls fehlten Zeitstempel in
// bridge.log — ohne die lässt sich nicht rekonstruieren, WANN der Bot zuletzt
// gelebt hat. Alle console-Ausgaben laufen deshalb hierüber.

const stamp = () => new Date().toISOString();

export const log = (...args: unknown[]): void => console.log(stamp(), ...args);
export const logError = (...args: unknown[]): void => console.error(stamp(), ...args);
