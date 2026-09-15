const localTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export const localTime = (iso: string) => localTimeFormatter.format(new Date(iso));
export const labeledLocalTime = (iso: string) => `${localTime(iso)} local`;
