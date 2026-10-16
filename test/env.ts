import type { PathEnv } from '../src/paths.ts';

/** A Windows machine, whatever machine runs the tests. */
export const win: PathEnv = { home: 'C:/Users/me', temp: 'C:/Users/me/AppData/Local/Temp', windows: true, caseInsensitive: true };

export const posix: PathEnv = { home: '/home/me', temp: '/tmp', windows: false, caseInsensitive: false };
