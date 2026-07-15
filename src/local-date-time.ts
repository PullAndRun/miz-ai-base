/** Parses a local wall-clock time without accepting Date's overflow normalization. */
export const parseStrictLocalDateTime = (date: string, time: string): Date | undefined => {
  const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const timeParts = /^(\d{2}):(\d{2})$/.exec(time);
  if (!dateParts || !timeParts) {
    return undefined;
  }

  const value = new Date(`${date}T${time}:00`);
  if (
    Number.isNaN(value.getTime()) ||
    value.getFullYear() !== Number(dateParts[1]) ||
    value.getMonth() + 1 !== Number(dateParts[2]) ||
    value.getDate() !== Number(dateParts[3]) ||
    value.getHours() !== Number(timeParts[1]) ||
    value.getMinutes() !== Number(timeParts[2])
  ) {
    return undefined;
  }

  return value;
};
