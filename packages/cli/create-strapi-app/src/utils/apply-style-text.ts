import { styleText } from 'node:util';

const supportedStyles = [
  'magentaBright',
  'blueBright',
  'yellowBright',
  'green',
  'red',
  'bold',
  'italic',
] as const;

export default function applyStyleText(template: string) {
  let result = template;

  for (const style of supportedStyles) {
    const regex = new RegExp(`{${style}}(.*?){/${style}}`, 'g');
    result = result.replace(regex, (_, p1) => styleText(style, p1.trim()));
  }

  return result;
}
