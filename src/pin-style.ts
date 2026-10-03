export const pinIcons = ['pin', 'star', 'bookmark', 'flag', 'bulb', 'check', 'clock', 'code', 'tag', 'target', 'chat', 'annotation'] as const;
export const pinColors = ['default', 'violet', 'blue', 'green', 'amber', 'rose', 'white', 'indigo', 'cyan', 'lime', 'orange', 'pink'] as const;
export type PinStyle = { symbol: string; color: typeof pinColors[number] };
export function isPinIcon(value: string): value is typeof pinIcons[number] {
  return pinIcons.some(icon => icon === value);
}
export function isPinStyle(value: unknown): value is PinStyle {
  return typeof value === 'object' && value !== null && 'symbol' in value && typeof value.symbol === 'string'
    && (isPinIcon(value.symbol) || /^[A-Z0-9]$/.test(value.symbol))
    && 'color' in value && pinColors.some(color => color === value.color);
}
