type Services = typeof import('../services');

export declare function getService<TName extends keyof Services>(
  name: TName
): ReturnType<Services[TName]>;

export declare function isUsernameTaken(username: string): Promise<boolean>;

export declare function findValidUsername(basename: string): Promise<string>;

export declare const sanitize: typeof import('./sanitize');
