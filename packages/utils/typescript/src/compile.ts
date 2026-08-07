import * as compilers from './compilers';
import { getConfigPath } from './utils/get-config-path';
import type { ConfigOptions } from './compilers/basic';

export const compile = async (
  srcDir: string,
  { configOptions = {}, tsConfigPath }: { configOptions?: ConfigOptions; tsConfigPath?: string }
): Promise<void> => {
  const configPath = getConfigPath(srcDir, { filename: tsConfigPath });

  compilers.basic.run(configPath as string, configOptions);
};
