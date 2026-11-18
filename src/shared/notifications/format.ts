export function formatNotificationNumber(
  value: number,
  fractionDigits = 0,
): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatNotificationUsd(
  value: number,
  fractionDigits = 2,
): string {
  return `$${formatNotificationNumber(value, fractionDigits)}`;
}
